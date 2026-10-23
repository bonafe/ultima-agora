//The transcript of the workspace's calls on the client (D-37). Transport-agnostic, like the chat client: it talks to a
//SyncProvider through send() and receives events through receive().
//
//  - Each person's speech is transcribed on THEIR device and sent here; the server stamps the author from the token.
//  - Segments waiting for the connection stay in an OUTBOX (sent once; the server deduplicates by clientId).
//  - Live captions: the latest segment of each person stays visible for a few seconds.
import { uuid } from '../../core/ids.js';

const OUTBOX_MAX = 100;                 // an hour offline of continuous talk would otherwise grow without limit

export class TranscriptClient {
    #me; #send; #canWrite; #captionMs; #now;
    #segments = [];                     // confirmed by the server, ordered by seq
    #outbox = [];                       // { clientId, body, startedAt, language, durationMs, createdAt }
    #received = new Map();              // segment id -> local time it arrived (captions fade by it)
    #hasMore = false;
    #listeners = new Set();
    #timer = null;
    lastError = null;

    constructor({ me, send = () => false, canWrite = () => true, available = () => true, captionMs = 8000, now = () => Date.now() }) {
        this.#me = me; this.#send = send; this.#canWrite = canWrite; this.available = available;
        this.#captionMs = captionMs; this.#now = now;
    }

    get me() { return this.#me; }
    get canWrite() { return this.#canWrite(); }
    get hasMore() { return this.#hasMore; }
    get pending() { return this.#outbox.length; }

    //Confirmed segments, then my own still waiting to go out
    get segments() {
        return [...this.#segments, ...this.#outbox.map(o => ({ id: `local:${o.clientId}`, clientId: o.clientId, author: this.#me, body: o.body, createdAt: new Date(o.createdAt).toISOString(), pending: true }))];
    }

    onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #changed() { for (const fn of [...this.#listeners]) { try { fn(); } catch (error) { console.error('[transcript] listener error:', error); } } }

    //What the person just said, for the caption under their tile; null once it is old
    captionOf(userId) {
        const now = this.#now();
        const mine = userId === this.#me.id ? this.#outbox.at(-1) : null;
        if (mine && now - mine.createdAt < this.#captionMs) return mine.body;
        for (let i = this.#segments.length - 1; i >= 0; i--) {
            const segment = this.#segments[i];
            if (segment.author.id !== userId) continue;
            const arrived = this.#received.get(segment.id);
            return arrived !== undefined && now - arrived < this.#captionMs ? segment.body : null;
        }
        return null;
    }

    //Queues a segment of MY speech and sends it if connected
    send(body, { startedAt = this.#now(), language = null, durationMs = null } = {}) {
        const text = String(body ?? '').trim();
        if (!text) return null;
        if (!this.canWrite) throw new Error('Seu papel não permite transcrever.');
        const entry = { clientId: uuid(), body: text, startedAt, language, durationMs, createdAt: this.#now() };
        this.#outbox.push(entry);
        if (this.#outbox.length > OUTBOX_MAX) this.#outbox.shift();
        this.#flush();
        this.#fade(this.#captionMs);
        this.#changed();
        return entry.clientId;
    }

    #flush() {
        for (const entry of this.#outbox) {
            if (!this.#send({ type: 'send', clientId: entry.clientId, body: entry.body, startedAt: entry.startedAt, language: entry.language, durationMs: entry.durationMs })) return;
        }
    }

    //The connection is (back): resend what waits and ask for the history
    onConnected() {
        this.#flush();
        this.#send({ type: 'history', limit: 100 });
    }

    loadOlder() { if (this.#segments.length) this.#send({ type: 'history', before: this.#segments[0].seq, limit: 100 }); }

    receive(event) {
        if (event.type === 'history') {
            const known = new Set(this.#segments.map(s => s.id));
            const older = event.messages.filter(m => !known.has(m.id));
            this.#segments = [...this.#segments, ...older].sort((a, b) => a.seq - b.seq);
            this.#hasMore = event.hasMore;
            this.#settle();
        } else if (event.type === 'segment') {
            const segment = event.segment;
            if (!this.#segments.some(s => s.id === segment.id)) {
                this.#segments.push(segment);
                this.#segments.sort((a, b) => a.seq - b.seq);
                this.#received.set(segment.id, this.#now());
                this.#fade(this.#captionMs);
            }
            this.#settle();
        } else if (event.type === 'error') {
            this.lastError = event.message;
            //A refused segment will not be accepted on retry (role, size): do not resend it forever
            this.#outbox = this.#outbox.filter(o => o.clientId !== event.ref || event.code === 'rate');
        }
        this.#changed();
    }

    //Confirmed segments leave the outbox
    #settle() {
        const confirmed = new Set(this.#segments.filter(s => s.author.id === this.#me.id).map(s => s.clientId));
        this.#outbox = this.#outbox.filter(o => !confirmed.has(o.clientId));
    }

    //Repaint when the caption expires
    #fade(ms) {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#changed(), ms + 50);
    }

    //Plain text, one line per segment: "[14:03] Ana: ..."
    export() {
        const clock = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return this.segments.map(s => `[${clock(s.createdAt)}] ${s.author.name}: ${s.body}`).join('\n');
    }
}
