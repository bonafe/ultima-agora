//Records a stream in pieces and sends each piece to the server while the call goes on (docs/especificacao/06, 09).
//Only this module touches MediaRecorder (like only the providers touch RTCPeerConnection).
//
//  - A piece is cut every few seconds, kept locally ONLY as a buffer, and sent at once; it leaves the buffer when the server
//    confirms. No network: the buffer grows and empties, in order, when it is back. A tab that dies loses only the unsent
//    tail of what it recorded; what already went up is safe, and `resume()` sends the rest the next time the app opens.
//  - It never starts without `consented: true` (the person's own choice, shown to everyone through the presence flag).
//  - Stopping joins the pieces on the server (`complete`); a recording nobody finishes is closed by the server's janitor.
const PART_MS = 5000;
const RETRY_MS = [1000, 3000, 10_000, 30_000];
const INDEX_KEY = 'recordings:index';
const metaKey = id => `recording:${id}`;
const partKey = (id, n) => `recording:${id}:${n}`;

export class RecorderError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

//The best container the browser can record: WebM/Opus where it can, else whatever it prefers (Safari: MP4/AAC)
const PREFERRED = { audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'], video: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] };
export const pickMime = (kind, isTypeSupported = type => globalThis.MediaRecorder?.isTypeSupported?.(type)) => (PREFERRED[kind] ?? []).find(type => isTypeSupported(type)) ?? null;

export class Recorder {
    #api; #storage; #createRecorder; #isTypeSupported; #partMs; #retryMs; #now; #setTimer; #clearTimer;
    #current = null;                    // the recording in progress: { record, mediaRecorder, total, startedAt, stream }
    #jobs = new Map();                  // id -> meta { id, total, sent, stopped, durationMs, failed? }; what still has to reach the server
    #memory = new Map();                // piece buffers when there is no storage (tests, private windows)
    #draining = false; #retryTimer = null; #attempt = 0; #listeners = new Set();
    lastError = null;

    constructor({ api, storage = null, createMediaRecorder = (stream, options) => new MediaRecorder(stream, options), isTypeSupported, partMs = PART_MS, retryMs = RETRY_MS, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
        this.#api = api; this.#storage = storage; this.#createRecorder = createMediaRecorder;
        this.#isTypeSupported = isTypeSupported ?? (type => globalThis.MediaRecorder?.isTypeSupported?.(type));
        this.#partMs = partMs; this.#retryMs = retryMs; this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    }

    get supported() { return Boolean(pickMime('audio', this.#isTypeSupported)); }
    get recording() { return Boolean(this.#current) && !this.#current.stopping; }
    get current() { return this.#current?.record ?? null; }
    get pending() { let n = 0; for (const job of this.#jobs.values()) n += job.total - job.sent; return n; }       //pieces not yet on the server
    get busy() { return Boolean(this.#current) || this.#jobs.size > 0; }

    onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #emit() { for (const fn of [...this.#listeners]) { try { fn(this); } catch (error) { console.error('[recorder] listener failed:', error); } } }

    // ---- storage of the buffer ----

    async #putBlob(key, blob) { if (this.#storage) { try { await this.#storage.putLocal(key, blob); return; } catch { /* falls back to memory */ } } this.#memory.set(key, blob); }
    async #getBlob(key) { return this.#memory.get(key) ?? (this.#storage ? await this.#storage.getLocal(key).catch(() => null) : null); }
    async #dropBlob(key) { this.#memory.delete(key); if (this.#storage) await this.#storage.deleteLocal(key).catch(() => {}); }

    async #saveMeta(job) {
        if (!this.#storage) return;
        try {
            await this.#storage.putLocal(metaKey(job.id), job);
            const index = new Set((await this.#storage.getLocal(INDEX_KEY)) ?? []);
            if (!index.has(job.id)) { index.add(job.id); await this.#storage.putLocal(INDEX_KEY, [...index]); }
        } catch { /* the buffer is then in memory only: still works while the tab lives */ }
    }
    async #forget(job) {
        this.#jobs.delete(job.id);
        if (!this.#storage) return;
        try {
            await this.#storage.deleteLocal(metaKey(job.id));
            const index = ((await this.#storage.getLocal(INDEX_KEY)) ?? []).filter(id => id !== job.id);
            await this.#storage.putLocal(INDEX_KEY, index);
        } catch { /* nothing to clean */ }
    }

    // ---- recording ----

    //stream: what to record (see mic_source.js). consented: the person said yes, for THEIR OWN side of the call.
    async start({ stream, kind = 'audio', consented = false }) {
        if (consented !== true) throw new RecorderError('consent_required', 'A gravação só começa com o seu consentimento.');
        if (this.#current) throw new RecorderError('busy', 'Já há uma gravação em andamento.');
        const mime = pickMime(kind, this.#isTypeSupported);
        if (!mime) throw new RecorderError('unsupported', 'Este navegador não consegue gravar.');
        let record;
        try { record = await this.#api.start({ kind, mime }); }
        catch (error) { throw new RecorderError(error.code ?? 'error', error.message); }

        const mediaRecorder = this.#createRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
        const current = this.#current = { record, mediaRecorder, total: 0, startedAt: this.#now(), stopping: false, stopped: null };
        current.stopped = new Promise(resolve => { current.markStopped = resolve; });
        const job = { id: record.id, total: 0, sent: 0, stopped: false, durationMs: null };
        this.#jobs.set(record.id, job);
        await this.#saveMeta(job);

        //Pieces are queued in order: each one waits for the previous to be stored, so a slow disk never reorders them
        let chain = Promise.resolve();
        mediaRecorder.ondataavailable = event => {
            if (!event.data?.size) return;
            const n = current.total++;
            chain = chain.then(async () => { await this.#putBlob(partKey(record.id, n), event.data); job.total = Math.max(job.total, n + 1); await this.#saveMeta(job); this.#drain(); });
        };
        mediaRecorder.onstop = () => {
            chain = chain.then(async () => {
                job.stopped = true; job.durationMs = this.#now() - current.startedAt;
                await this.#saveMeta(job);
                if (this.#current === current) this.#current = null;
                current.markStopped();
                this.#emit();
                this.#drain();
            });
        };
        mediaRecorder.onerror = event => { this.lastError = event?.error ?? new Error('recorder error'); mediaRecorder.state !== 'inactive' && mediaRecorder.stop(); this.#emit(); };
        mediaRecorder.start(this.#partMs);
        this.#emit();
        return record;
    }

    //Ends the recording: the last piece is cut, sent, and the server joins them. Resolves when the recording has stopped
    //(the upload may still be finishing: see `pending`).
    async stop() {
        const current = this.#current;
        if (!current || current.stopping) return current?.stopped;
        current.stopping = true;
        this.#emit();
        if (current.mediaRecorder.state === 'inactive') current.mediaRecorder.onstop?.(); else current.mediaRecorder.stop();
        await current.stopped;                                      //the last piece is stored and the recording is closed locally
    }

    // ---- sending ----

    //Sends what is waiting, one piece at a time and in order, then closes the recordings that were stopped.
    async #drain() {
        if (this.#draining) return;
        this.#draining = true;
        this.#clearTimer(this.#retryTimer); this.#retryTimer = null;
        try {
            for (const job of [...this.#jobs.values()]) {
                try {
                    while (job.sent < job.total) {
                        const blob = await this.#getBlob(partKey(job.id, job.sent));
                        if (!blob) { job.sent++; continue; }                              //lost with a cleared buffer: the server closes it truncated
                        await this.#api.putPart(job.id, job.sent, blob);
                        await this.#dropBlob(partKey(job.id, job.sent));
                        job.sent++;
                        await this.#saveMeta(job);
                        this.#attempt = 0; this.lastError = null;
                        this.#emit();
                    }
                    if (job.stopped && job.sent >= job.total) {
                        await this.#api.complete(job.id, { parts: job.total, durationMs: job.durationMs });
                        await this.#forget(job);
                        this.#emit();
                    }
                } catch (error) {
                    this.lastError = error;
                    if (error.retryable === false) { await this.#abandon(job); continue; }      //the server will not take it: waiting changes nothing
                    this.#retryLater();
                    break;                                                                  //order matters: nothing after this waits for it, but nothing jumps ahead either
                } finally { this.#emit(); }
            }
        } finally { this.#draining = false; }
    }

    //A recording the server refuses (closed, not ours, too big): stop trying and free its buffer
    async #abandon(job) {
        for (let n = job.sent; n < job.total; n++) await this.#dropBlob(partKey(job.id, n));
        if (this.#current?.record.id === job.id) {
            const { mediaRecorder } = this.#current;
            this.#current = null;
            try { if (mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch { /* already stopped */ }
        }
        await this.#forget(job);
    }

    #retryLater() {
        const delay = this.#retryMs[Math.min(this.#attempt++, this.#retryMs.length - 1)];
        this.#retryTimer = this.#setTimer(() => { this.#retryTimer = null; this.#drain(); }, delay);
    }

    //After a reload: continue what an earlier page left in the buffer. A recording that was still going when the tab died is
    //closed with the pieces it had (the stretch that was never recorded is gone).
    async resume() {
        if (!this.#storage) return 0;
        const index = (await this.#storage.getLocal(INDEX_KEY).catch(() => null)) ?? [];
        let resumed = 0;
        for (const id of index) {
            if (this.#jobs.has(id)) continue;
            const job = await this.#storage.getLocal(metaKey(id)).catch(() => null);
            if (!job) continue;
            job.stopped = true;
            this.#jobs.set(id, job);
            resumed++;
        }
        if (resumed) { this.#emit(); this.#drain(); }
        return resumed;
    }

    //Used by tests and by "send now" after the network is back
    retryNow() { return this.#drain(); }
}
