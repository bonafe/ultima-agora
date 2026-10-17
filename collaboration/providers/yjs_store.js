//StateStore for the real application: Yjs document + IndexedDB persistence + optional sync server.
//Local-first (R-LF-1): open() answers from IndexedDB at once; the network connects in the background and
//everything merges when it does.
//
//sync: { url, session(workspaceId) -> Promise<{ token, role }> }   omit for a purely local store
import { Y, awarenessProtocol } from '../../vendor/yjs/yjs.js';
import { YjsWorkspaceDoc } from '../document/yjs_state_store.js';
import { YjsPresence } from '../presence/presence.js';
import { SyncProvider, webSocketTransport } from './sync_provider.js';
import { ChatClient } from './chat_client.js';
import { MeshProvider } from '../../conference/mesh/mesh_provider.js';
import { WhisperProvider } from '../../transcription/whisper/whisper_provider.js';
import { Transcriber } from '../../transcription/transcriber.js';
import { TranscriptClient } from './transcript_client.js';

const SAVE_DELAY_MS = 150;
const PERSISTENCE = 'persistence';

export class YjsStateStore {
    #backend;
    #sync;
    #transcription;
    #docs = new Map();

    //transcription: the engine for the call transcript (WhisperProvider by default; tests inject another)
    constructor({ backend, sync = null, transcription = null }) {
        this.#backend = backend;
        this.#sync = sync;
        this.#transcription = transcription;
    }

    get synced() { return this.#sync !== null; }

    async #load(workspaceId, ydoc, doc) {
        const stored = await this.#backend.getDocument(workspaceId);
        if (stored instanceof Uint8Array) Y.applyUpdate(ydoc, stored, PERSISTENCE);
        else if (stored) doc.restore(stored);                 //data saved by M1/M2, as a plain JSON snapshot
    }

    //role: what the catalog last knew about this user in this workspace (until the server says otherwise)
    //me: { id, name } of the person, for the chat (who "you" are; the server takes the author from the token anyway)
    async open(workspaceId, { role = 'owner', me = null } = {}) {
        if (this.#docs.has(workspaceId)) return this.#docs.get(workspaceId);
        const ydoc = new Y.Doc();
        const doc = new YjsWorkspaceDoc(ydoc);
        doc.role = role;
        await this.#load(workspaceId, ydoc, doc);

        const awareness = new awarenessProtocol.Awareness(ydoc);
        doc.presence = new YjsPresence(awareness);

        //The chat lives outside the document (own log on the server, own history here); it needs the provider to talk
        let provider = null;
        if (me) {
            doc.chat = new ChatClient({
                workspaceId, me, storage: this.#backend,
                send: request => provider?.sendChat(request) ?? false,
                canWrite: () => doc.role !== 'viewer',
                available: () => this.#sync !== null,
            });
        }

        //The conference (D-36): media goes straight between browsers, only the signalling uses the sync connection
        const signalListeners = new Set();
        if (me && this.#sync) {
            const signaling = {
                clientId: ydoc.clientID,
                send: (to, data) => provider?.sendSignal({ to, from: ydoc.clientID, data }) ?? false,
                onSignal: fn => { signalListeners.add(fn); return () => signalListeners.delete(fn); },
            };
            doc.conference = new MeshProvider().connect({ roomId: workspaceId, signaling, presence: doc.presence, me, canPublish: () => doc.role !== 'viewer' });
            //Transcription (D-37): each person's speech is transcribed on their own device (Whisper in the browser) and the
            //text goes to the workspace's transcript log, outside the document like the chat.
            doc.transcript = new TranscriptClient({
                me,
                send: request => provider?.sendTranscript(request) ?? false,
                canWrite: () => doc.role !== 'viewer',
                available: () => this.#sync !== null,
            });
            doc.transcriber = new Transcriber({ engine: this.#transcription ?? new WhisperProvider(), client: doc.transcript, room: doc.conference });
        }

        let timer = null;
        const refreshStatus = () => {
            doc.status = provider && provider.status !== 'synced' ? provider.status : (timer ? 'saving' : 'synced');
        };
        const flush = async () => {
            clearTimeout(timer); timer = null;
            try { await this.#backend.putDocument(workspaceId, Y.encodeStateAsUpdate(ydoc)); }
            catch (error) { doc.status = 'error'; console.error('[YjsStateStore] could not save:', error); return; }
            refreshStatus();
        };
        doc.flush = flush;
        ydoc.on('update', (update, origin) => {
            if (origin === PERSISTENCE) return;
            clearTimeout(timer);
            timer = setTimeout(flush, SAVE_DELAY_MS);
            refreshStatus();
        });
        addEventListener('pagehide', () => { if (timer) flush(); });

        if (this.#sync) {
            let session = null;
            provider = new SyncProvider({
                ydoc, awareness,
                openTransport: async () => {
                    session = await this.#sync.session(workspaceId);
                    if (session.role) doc.role = session.role;
                    return webSocketTransport(`${this.#sync.url}/${encodeURIComponent(workspaceId)}`, session.token);
                },
                onStatus: status => { refreshStatus(); if (status === 'synced') { doc.chat?.onConnected(); doc.transcript?.onConnected(); } },
                onChat: event => doc.chat?.receive(event),
                onTranscript: event => doc.transcript?.receive(event),
                onSignal: event => { for (const fn of [...signalListeners]) fn(event); },
                onControl: message => {
                    if (message.type === 'role') doc.role = message.role;
                    if (message.type === 'ice') doc.conference?.setIceServers(message.iceServers);
                    if (message.type === 'closed' && message.code === 4403) doc.role = 'viewer';
                    doc._control(message);
                },
            });
            doc.provider = provider;
            doc.status = 'connecting';
            provider.connect();
        }

        this.#docs.set(workspaceId, doc);
        return doc;
    }

    //Creates a workspace from a plain snapshot (duplicate, import of old data)
    async importSnapshot(workspaceId, snapshot) {
        const ydoc = new Y.Doc();
        new YjsWorkspaceDoc(ydoc).restore(snapshot);
        await this.#backend.putDocument(workspaceId, Y.encodeStateAsUpdate(ydoc));
    }

    //Throws away this device's copy of a workspace (local edits the server refused would otherwise be
    //re-sent, and refused, on every connection). The next open starts from what the server has.
    async discard(workspaceId) {
        this.forget(workspaceId);
        await this.#backend.deleteDocument(workspaceId);
    }

    //Stops every open document (their saves would recreate what is being wiped)
    closeAll() { for (const id of [...this.#docs.keys()]) this.forget(id); }

    forget(workspaceId) {
        this.#docs.get(workspaceId)?.transcriber?.destroy();
        this.#docs.get(workspaceId)?.conference?.destroy();
        this.#docs.get(workspaceId)?.provider?.destroy();
        this.#docs.delete(workspaceId);
    }
}
