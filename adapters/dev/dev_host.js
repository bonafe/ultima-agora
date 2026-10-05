//Development host: the HostAdapter contracts (docs/especificacao/09, 9.2) without a Django behind them.
//Identity and the workspace catalog live in this browser (IndexedDB + localStorage); documents are Yjs, saved
//locally, and synchronized when a sync server is configured (`sync: { url, http }`).
//
//The dev sync server issues tokens to anyone who asks (AGORA_DEV_AUTH=1): that is what this host's session()
//relies on, and why it must never be pointed at a production server.
import { IndexedDbBackend, MemoryBackend } from '../../collaboration/providers/indexeddb_persistence.js';
import { YjsStateStore } from '../../collaboration/providers/yjs_store.js';
import { colorFor } from '../../collaboration/presence/presence.js';
import { uuid } from '../../core/ids.js';

const IDENTITY_KEY = 'agora.dev.identity';

function loadIdentity(nameOverride) {
    let identity = null;
    try { identity = JSON.parse(localStorage.getItem(IDENTITY_KEY)); } catch { /* storage blocked: a fresh identity per page load */ }
    if (!identity?.id) {
        const suffix = uuid().slice(0, 4);
        identity = { id: `dev-${uuid().slice(0, 8)}`, name: `Participante ${suffix}`, kind: 'human' };
        try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch { /* see above */ }
    }
    if (nameOverride) identity = { ...identity, name: nameOverride };
    return { ...identity, color: colorFor(identity.id) };
}

export class DevHost {
    #backend;
    #dbName;
    #sync;
    #requestedRole;
    store;
    identity;
    domain = null;              //no application data in the dev host
    persistent = true;          //false when IndexedDB is unavailable and everything lives in memory

    //sync: { url: 'ws://host:8787', http: 'http://host:8787' } | null.  role: what to ask the dev server for.
    //identity: { id, name } overrides the one kept in localStorage (tests with several people in one page)
    constructor({ dbName = 'ultima-agora', backend = null, sync = null, role = null, name = null, identity = null } = {}) {
        this.#dbName = dbName;
        this.#backend = backend ?? new IndexedDbBackend(dbName);
        this.#sync = sync;
        this.#requestedRole = role;
        if (backend instanceof MemoryBackend) this.persistent = false;
        this.identity = identity ? { kind: 'human', ...identity, color: colorFor(identity.id) } : loadIdentity(name);
        this.store = new YjsStateStore({
            backend: this.#backend,
            sync: sync && { url: sync.url, session: id => this.#session(id) },
        });
    }

    get syncEnabled() { return this.#sync !== null; }

    //What the shell's settings dialog shows (see ui/settings/agora-settings.js)
    get settings() {
        return {
            account: { name: this.identity.name, detail: '(host de desenvolvimento)' },
            device: {
                describe: async () => ({ workspaces: (await this.list()).length, pending: 0, cacheEntries: (await this.#backend.cacheEntries()).length }),
                clear: async () => {
                    this.store.closeAll();
                    await this.#backend.destroy();
                    try { for (const key of Object.keys(localStorage).filter(k => k.startsWith('agora.'))) localStorage.removeItem(key); } catch { /* blocked */ }
                },
            },
        };
    }

    //Uses IndexedDB when it works and falls back to memory when it does not, so the app never opens "dead".
    static async create({ dbName = 'ultima-agora', probeTimeoutMs = 3000, ...options } = {}) {
        try {
            const backend = new IndexedDbBackend(dbName);
            await Promise.race([
                backend.listWorkspaces(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB did not answer')), probeTimeoutMs)),
            ]);
            return new DevHost({ dbName, backend, ...options });
        } catch (error) {
            console.warn('[DevHost] IndexedDB unavailable, working in memory:', error);
            return new DevHost({ backend: new MemoryBackend(), ...options });
        }
    }

    //TokenIssuer: asks the sync server for a short token for this user in this workspace
    async #session(workspaceId) {
        const meta = await this.#backend.getWorkspace(workspaceId);
        const response = await fetch(`${this.#sync.http}/dev/token`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: workspaceId, user: { id: this.identity.id, name: this.identity.name }, role: this.#requestedRole ?? meta?.role ?? 'owner' }),
        });
        if (!response.ok) throw new Error(`The sync server refused a token (HTTP ${response.status})`);
        return response.json();
    }

    //WorkspaceCatalog
    async list() {
        return (await this.#backend.listWorkspaces()).filter(w => !w.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    get(id) { return this.#backend.getWorkspace(id); }

    async create(title = 'Novo workspace') {
        const now = new Date().toISOString();
        const meta = { id: uuid(), title, ownerId: this.identity.id, role: 'owner', createdAt: now, updatedAt: now, archivedAt: null };
        await this.#backend.putWorkspace(meta);
        return meta;
    }

    //Opening a workspace someone shared (by its id) on a host that has a sync server: it is catalogued here
    //and its content arrives through the sync
    async adopt(id, title = 'Workspace compartilhado') {
        const now = new Date().toISOString();
        const meta = { id, title, ownerId: null, role: this.#requestedRole ?? 'editor', createdAt: now, updatedAt: now, archivedAt: null };
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

    openDocument(meta) { return this.store.open(meta.id, { role: meta.role ?? 'owner', me: { id: this.identity.id, name: this.identity.name } }); }

    discardLocal(id) { return this.store.discard(id); }

    //R-WS-6: copies composition and authored content (all of what the document holds).
    async duplicate(id) {
        const source = await this.#backend.getWorkspace(id);
        if (!source) throw new Error(`Unknown workspace "${id}"`);
        const doc = await this.openDocument(source);
        const copy = await this.create(`${source.title} (cópia)`);
        await this.store.importSnapshot(copy.id, { ...doc.snapshot(), meta: { ...(doc.get('meta') ?? {}), title: copy.title } });
        return copy;
    }

    //Test support: wipes everything this host stored.
    async destroy() { await this.#backend.close(); await new Promise(resolve => { const r = indexedDB.deleteDatabase(this.#dbName); r.onsuccess = r.onerror = r.onblocked = resolve; }); }
}
