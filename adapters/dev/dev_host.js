//Development host: the HostAdapter contracts (docs/especificacao/09, 9.2) backed by IndexedDB, with no server.
//One local "user" who owns everything. Lets the generic components run without any backend (R-HOST-1).
import { IndexedDbBackend, MemoryBackend, PersistentStateStore } from '../../collaboration/providers/indexeddb_persistence.js';

import { uuid } from '../../core/ids.js';
const newId = () => uuid();

export class DevHost {
    #backend;
    #dbName;
    store;
    identity = { id: 'urn:user:dev', name: 'Você', kind: 'human' };

    persistent = true;          //false when IndexedDB is unavailable and everything lives in memory

    constructor({ dbName = 'ultima-agora', backend = null } = {}) {
        this.#dbName = dbName;
        this.#backend = backend ?? new IndexedDbBackend(dbName);
        if (backend instanceof MemoryBackend) this.persistent = false;
        this.store = new PersistentStateStore(this.#backend);
    }

    //Uses IndexedDB when it works and falls back to memory when it does not, so the app never opens "dead".
    static async create({ dbName = 'ultima-agora', probeTimeoutMs = 3000 } = {}) {
        try {
            const backend = new IndexedDbBackend(dbName);
            await Promise.race([
                backend.listWorkspaces(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB did not answer')), probeTimeoutMs)),
            ]);
            return new DevHost({ dbName, backend });
        } catch (error) {
            console.warn('[DevHost] IndexedDB unavailable, working in memory:', error);
            return new DevHost({ backend: new MemoryBackend() });
        }
    }

    //WorkspaceCatalog
    async list() {
        return (await this.#backend.listWorkspaces()).filter(w => !w.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id) { return this.#backend.getWorkspace(id); }

    async create(title = 'Novo workspace') {
        const now = new Date().toISOString();
        const meta = { id: newId(), title, ownerId: this.identity.id, role: 'owner', createdAt: now, updatedAt: now, archivedAt: null };
        await this.#backend.putWorkspace(meta);
        return meta;
    }

    async rename(id, title) { return this.#update(id, { title }); }
    async touch(id) { return this.#update(id, {}); }
    async archive(id) { return this.#update(id, { archivedAt: new Date().toISOString() }); }

    async #update(id, patch) {
        const meta = await this.#backend.getWorkspace(id);
        if (!meta) throw new Error(`Unknown workspace "${id}"`);
        const updated = { ...meta, ...patch, updatedAt: new Date().toISOString() };
        await this.#backend.putWorkspace(updated);
        return updated;
    }

    //R-WS-6: copies composition and authored content (all of what the document holds).
    async duplicate(id) {
        const source = await this.#backend.getWorkspace(id);
        if (!source) throw new Error(`Unknown workspace "${id}"`);
        const doc = await this.store.open(id);
        await doc.flush?.();
        const copy = await this.create(`${source.title} (cópia)`);
        await this.#backend.putDocument(copy.id, doc.snapshot());
        return copy;
    }

    //Test support: wipes everything this host stored.
    async destroy() { await this.#backend.close(); await new Promise(resolve => { const r = indexedDB.deleteDatabase(this.#dbName); r.onsuccess = r.onerror = r.onblocked = resolve; }); }
}
