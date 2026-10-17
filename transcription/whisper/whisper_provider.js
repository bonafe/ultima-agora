//Whisper running IN the browser (D-37): the runtime comes from vendor/whisper/ and the model from models/, both from
//our own origin, so it works offline and no audio ever leaves the device. Decoding runs in a worker.
//
//  provider.supported / provider.unsupportedReason
//  await provider.load(onProgress)       downloads the model files into the browser cache and starts the engine (idempotent)
//  provider.start(track, { language, onSegment, onState }) -> { stop() }
//     onSegment({ text, startedAt, durationMs })     once per utterance, after a pause (Whisper does not stream)
//     onState('listening' | 'transcribing' | 'behind')
import { Resampler, Segmenter, cleanTranscript, WHISPER_RATE } from './speech.js';

const MAX_BACKLOG = 3;            // utterances waiting for the engine; beyond this the oldest are dropped (a slow CPU must not fall minutes behind)

export class TranscriptionError extends Error {
    constructor(code, message) { super(message); this.name = 'TranscriptionError'; this.code = code; }
}

export class WhisperProvider {
    #o;
    #worker = null;
    #loading = null;
    #nextId = 1;
    #waiting = new Map();           // request id -> { resolve, reject }
    #onProgress = new Set();

    //size: 'tiny' | 'base' | 'small'.  threads: > 1 only helps when the page is cross-origin isolated (SharedArrayBuffer).
    constructor({ size = 'base', modelBase = new URL('../../models/', import.meta.url).pathname, runtimeBase = new URL('../../vendor/whisper/', import.meta.url).href, createWorker = null, AudioContext = globalThis.AudioContext, threads = null } = {}) {
        this.#o = { size, modelBase, runtimeBase, AudioContext, createWorker: createWorker ?? (() => new Worker(new URL('./whisper_worker.js', import.meta.url), { type: 'module' })) };
        this.#o.threads = threads ?? (globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)) : 1);
    }

    get size() { return this.#o.size; }
    get supported() { return this.unsupportedReason === null; }
    get unsupportedReason() {
        if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return 'Este navegador não consegue rodar o modelo de transcrição (Worker/WebAssembly).';
        if (!this.#o.AudioContext?.prototype || !('audioWorklet' in this.#o.AudioContext.prototype)) {
            return globalThis.isSecureContext === false
                ? 'A transcrição precisa de conexão segura (HTTPS) ou localhost.'
                : 'Este navegador não consegue processar o áudio para a transcrição (AudioWorklet).';
        }
        return null;
    }

    async load(onProgress = () => {}) {
        this.#onProgress.add(onProgress);
        try {
            this.#loading ??= this.#boot().catch(error => { this.#loading = null; this.#worker?.terminate(); this.#worker = null; throw error; });
            await this.#loading;
        } finally { this.#onProgress.delete(onProgress); }
    }

    async #boot() {
        if (!this.supported) throw new TranscriptionError('unsupported', this.unsupportedReason);
        const probe = await fetch(`${this.#o.modelBase}whisper-${this.#o.size}/config.json`, { method: 'HEAD' }).catch(() => null);
        if (!probe?.ok) throw new TranscriptionError('no_model', `O modelo de transcrição (whisper-${this.#o.size}) não está instalado neste servidor. Rode tools/baixar_modelo_whisper.py ${this.#o.size}.`);

        const worker = this.#worker = this.#o.createWorker();
        await new Promise((resolve, reject) => {
            worker.onerror = event => reject(new TranscriptionError('failed', `Falha ao iniciar o modelo: ${event.message ?? 'erro no worker'}`));
            worker.onmessage = ({ data }) => {
                if (data.type === 'progress') for (const fn of this.#onProgress) fn(data.total ? data.loaded / data.total : 0);
                else if (data.type === 'ready') resolve();
                else if (data.type === 'error') reject(new TranscriptionError('failed', `Falha ao carregar o modelo: ${data.message}`));
            };
            worker.postMessage({ type: 'load', size: this.#o.size, modelBase: this.#o.modelBase, runtimeBase: this.#o.runtimeBase, threads: this.#o.threads });
        });
        worker.onerror = null;
        worker.onmessage = ({ data }) => {
            const waiting = this.#waiting.get(data.id);
            if (!waiting) return;
            this.#waiting.delete(data.id);
            if (data.type === 'result') waiting.resolve(data.text); else waiting.reject(new Error(data.message));
        };
    }

    #transcribe(audio, language) {
        return new Promise((resolve, reject) => {
            const id = this.#nextId++;
            this.#waiting.set(id, { resolve, reject });
            this.#worker.postMessage({ type: 'transcribe', id, audio, language }, [audio.buffer]);
        });
    }

    //Listens to one microphone track until stop(). The engine must be loaded (await load()).
    start(track, { language = 'pt', onSegment = () => {}, onState = () => {} } = {}) {
        if (!this.#worker) throw new TranscriptionError('not_loaded', 'O modelo ainda não foi carregado.');
        let stopped = false;
        let context = null;
        const queue = [];
        let busy = false;
        const startedAtWall = Date.now();

        const pump = async () => {
            if (busy) return;
            busy = true;
            while (queue.length) {                                // after stop(), the last utterance is still transcribed
                const utterance = queue.shift();
                onState('transcribing');
                try {
                    const text = cleanTranscript(await this.#transcribe(utterance.audio, language));
                    if (text) onSegment({ text, startedAt: startedAtWall + utterance.startedAt, durationMs: utterance.durationMs });
                } catch (error) { console.warn('[transcription] could not transcribe an utterance:', error.message); }
            }
            busy = false;
            if (!stopped) onState('listening');
        };

        const segmenter = new Segmenter({
            onUtterance: utterance => {
                queue.push(utterance);
                if (queue.length > MAX_BACKLOG) { queue.splice(0, queue.length - MAX_BACKLOG); onState('behind'); }
                pump();
            },
        });

        (async () => {
            try {
                context = new this.#o.AudioContext();
                await context.audioWorklet.addModule(new URL('./pcm_worklet.js', import.meta.url));
                if (stopped) { context.close().catch(() => {}); return; }
                await context.resume?.().catch(() => {});
                const resampler = new Resampler(context.sampleRate, WHISPER_RATE);
                const tap = new AudioWorkletNode(context, 'agora-pcm-tap');
                tap.port.onmessage = ({ data }) => { if (!stopped) segmenter.feed(resampler.process(data)); };
                const mute = context.createGain();
                mute.gain.value = 0;                                          // the tap must be part of the graph to run, but nothing is played
                context.createMediaStreamSource(new MediaStream([track])).connect(tap);
                tap.connect(mute).connect(context.destination);
                onState('listening');
            } catch (error) {
                console.warn('[transcription] could not listen to the microphone:', error.message);
                onState('error');
            }
        })();

        return {
            stop: () => {
                if (stopped) return;
                segmenter.flush();
                stopped = true;
                context?.close?.().catch(() => {});
            },
        };
    }

    destroy() { this.#worker?.terminate(); this.#worker = null; this.#loading = null; for (const w of this.#waiting.values()) w.reject(new Error('closed')); this.#waiting.clear(); }
}
