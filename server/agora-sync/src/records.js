//A small persistent collection of records (call sessions, recordings) for one workspace: a JSONL file where every line is
//the latest snapshot of one record (last line of an id wins). Small, append-only while running, compacted on load.
//This is the file implementation of the SessionLog contract (an SQL one would replace it, same methods).
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export class RecordSet {
    #file; #byId = new Map(); #log;
    constructor({ file = null, log = () => {} } = {}) {
        this.#file = file; this.#log = log;
        if (file && existsSync(file)) {
            for (const line of readFileSync(file, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try { const record = JSON.parse(line); if (record?.id) this.#byId.set(record.id, record); } catch { /* a torn last line */ }
            }
            this.#compact();
        }
    }

    #compact() {
        if (!this.#file) return;
        try {
            const temporary = `${this.#file}.tmp`;
            writeFileSync(temporary, [...this.#byId.values()].map(r => JSON.stringify(r)).join('\n') + (this.#byId.size ? '\n' : ''));
            renameSync(temporary, this.#file);
        } catch (error) { this.#log(`could not compact ${this.#file}: ${error.message}`); }
    }

    get(id) { return this.#byId.get(id) ?? null; }

    //Writes first, then keeps in memory: if the disk refuses, nothing exists in memory either (same rule as the chat log)
    upsert(record) {
        if (this.#file) appendFileSync(this.#file, `${JSON.stringify(record)}\n`);
        this.#byId.set(record.id, record);
        return record;
    }

    list(filter = () => true) { return [...this.#byId.values()].filter(filter); }
    get size() { return this.#byId.size; }
}
