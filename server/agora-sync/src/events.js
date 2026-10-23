//Outbound events (docs/especificacao/09, 9.2 EventSink and 9.6): what the host system hears about.
//
//  { id, type, at, workspaceId, data }     id is stable across retries, so a receiver can be idempotent.
//
//Events carry ids, types, sizes and offsets, NEVER content (R-AUD-1); the content is fetched by reference (a signed URL).
//Delivery is at-least-once: an event is written to the outbox file first, then handed to every sink; a sink that fails is
//retried with a growing delay, and what was still pending when the process stopped is replayed on the next start.
//`emit` never throws: an unreachable host must not take a call down.
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const RETRY_MS = [1_000, 5_000, 30_000, 120_000, 600_000];       //then it is given up on (a note in the log)

//A sink is { name, deliver(event) -> Promise } (rejects to ask for a retry).
export function webhookSink({ url, secret, fetchImpl = fetch, timeoutMs = 10_000 }) {
    return {
        name: 'webhook',
        async deliver(event) {
            const body = JSON.stringify(event);
            const timestamp = String(Math.floor(Date.now() / 1000));
            //The receiver recomputes HMAC-SHA256(secret, `${timestamp}.${body}`) and compares: it proves the sender and bounds replays
            const signature = secret ? createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') : '';
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-agora-event-id': event.id, 'x-agora-event-type': event.type, 'x-agora-timestamp': timestamp, ...(signature ? { 'x-agora-signature': `sha256=${signature}` } : {}) },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) throw new Error(`webhook answered ${response.status}`);
        },
    };
}

export const logSink = log => ({ name: 'log', async deliver(event) { log(`event ${event.type} ${event.id}`); } });

export class EventBus {
    #sinks; #file; #log; #now; #retryMs; #pending = new Map(); #timers = new Set(); #closed = false;

    //file: the outbox (JSONL of {t:'event'} and {t:'done'}); null keeps it in memory only
    constructor({ sinks = [], file = null, log = () => {}, now = () => Date.now(), retryMs = RETRY_MS } = {}) {
        this.#sinks = sinks; this.#file = file; this.#log = log; this.#now = now; this.#retryMs = retryMs;
        if (file && existsSync(file)) this.#replay(readFileSync(file, 'utf8'));
    }

    get pending() { return this.#pending.size; }

    #replay(text) {
        const open = new Map();
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line);
                if (row.t === 'event') open.set(row.event.id, { event: row.event, sinks: new Set(this.#sinks.map(s => s.name)) });
                else if (row.t === 'done' && open.has(row.id)) { open.get(row.id).sinks.delete(row.sink); if (!open.get(row.id).sinks.size) open.delete(row.id); }
            } catch { /* a torn last line must not lose the rest */ }
        }
        for (const [id, entry] of open) { this.#pending.set(id, entry); for (const sink of this.#sinks) this.#deliver(entry, sink, 0); }
        this.#compact();
    }

    #append(row) {
        if (!this.#file) return;
        try { appendFileSync(this.#file, `${JSON.stringify(row)}\n`); } catch (error) { this.#log(`outbox write failed: ${error.message}`); }
    }

    //Rewrites the outbox with only what is still pending (when it goes quiet, so the file does not grow forever)
    #compact() {
        if (!this.#file) return;
        try {
            const temporary = `${this.#file}.tmp`;
            const rows = [];
            for (const { event, sinks } of this.#pending.values()) {
                rows.push({ t: 'event', event });
                for (const sink of this.#sinks) if (!sinks.has(sink.name)) rows.push({ t: 'done', id: event.id, sink: sink.name });
            }
            writeFileSync(temporary, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
            renameSync(temporary, this.#file);
        } catch (error) { this.#log(`outbox compaction failed: ${error.message}`); }
    }

    emit(type, workspaceId, data = {}) {
        try {
            const event = { id: randomUUID(), type, at: new Date(this.#now()).toISOString(), workspaceId, data };
            if (!this.#sinks.length) return event;
            const entry = { event, sinks: new Set(this.#sinks.map(s => s.name)) };
            this.#pending.set(event.id, entry);
            this.#append({ t: 'event', event });
            for (const sink of this.#sinks) this.#deliver(entry, sink, 0);
            return event;
        } catch (error) { this.#log(`could not emit ${type}: ${error.message}`); return null; }
    }

    #deliver(entry, sink, attempt) {
        if (this.#closed || !entry.sinks.has(sink.name)) return;
        Promise.resolve().then(() => sink.deliver(entry.event)).then(() => {
            entry.sinks.delete(sink.name);
            this.#append({ t: 'done', id: entry.event.id, sink: sink.name });
            if (!entry.sinks.size) { this.#pending.delete(entry.event.id); if (!this.#pending.size) this.#compact(); }
        }, error => {
            const delay = this.#retryMs[attempt];
            if (this.#closed) return;
            if (delay === undefined) { this.#log(`gave up delivering ${entry.event.type} ${entry.event.id} to ${sink.name}: ${error.message}`); return; }
            const timer = setTimeout(() => { this.#timers.delete(timer); this.#deliver(entry, sink, attempt + 1); }, delay);
            timer.unref?.();
            this.#timers.add(timer);
        });
    }

    close() { this.#closed = true; for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear(); }
}
