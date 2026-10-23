import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { issueToken, verifyToken, checkSecret, ROLES } from './auth.js';
import { mayWrite } from './permissions.js';
import { ChatLog, ChatError } from './chat.js';
import { EventBus, webhookSink, logSink } from './events.js';
import { DiskFileStore } from './files.js';
import { RecordSet } from './records.js';
import { createApi } from './api.js';

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_CONTROL = 3, MSG_CHAT = 4, MSG_SIGNAL = 5, MSG_TRANSCRIPT = 6, MSG_CALL = 7;
const CHAT_WRITERS = new Set(['owner', 'editor', 'participant']);        // viewers read the chat, they do not write (D-30)
const CHAT_RATE = { perWindow: 20, windowMs: 10_000 };
const CHAT_HISTORY = 100;
const SIGNAL_RATE = { perWindow: 300, windowMs: 10_000 };      // ICE candidates come in bursts; this only stops a runaway client
const SIGNAL_MAX_BYTES = 32 * 1024;
const TRANSCRIPT_RATE = { perWindow: 30, windowMs: 10_000 };
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,80}$/;
//Close codes (4xxx are ours). The client does not retry 4400/4401/4403/4404, and does retry 4408.
export const CLOSE = { BAD_REQUEST: 4400, UNAUTHORIZED: 4401, FORBIDDEN: 4403, EXPIRED: 4408, TOO_BIG: 1009 };

class Room {
    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(this.doc);
    connections = new Set();
    #file; #timer = null; #idleTimer = null;

    chat;
    transcript;
    sessions;                       //call sessions (docs: a call has a start, an end and the people in it)
    recordings;                     //what each person recorded of their own side
    call = { session: null, members: new Map() };     //the call going on now: userId -> { name, connections }

    constructor(id, dataDir, onIdle, log, chatRetentionDays = 0, transcriptRetentionDays = 0) {
        this.id = id;
        this.log = log;
        this.#file = dataDir ? join(dataDir, `${id}.bin`) : null;
        this.chat = new ChatLog({ file: dataDir ? join(dataDir, `${id}.chat.jsonl`) : null, retentionDays: chatRetentionDays });
        this.transcript = new ChatLog({ file: dataDir ? join(dataDir, `${id}.transcript.jsonl`) : null, retentionDays: transcriptRetentionDays });
        this.sessions = new RecordSet({ file: dataDir ? join(dataDir, `${id}.sessions.jsonl`) : null, log });
        this.recordings = new RecordSet({ file: dataDir ? join(dataDir, `${id}.recordings.jsonl`) : null, log });
        //A call that was going on when the process stopped has no one left in it now
        for (const open of this.sessions.list(session => !session.endedAt)) this.sessions.upsert({ ...open, endedAt: new Date().toISOString(), interrupted: true });
        this.onIdle = onIdle;
        if (this.#file && existsSync(this.#file)) Y.applyUpdate(this.doc, readFileSync(this.#file), 'disk');
        this.awareness.setLocalState(null);                      //the server itself is not a participant

        this.doc.on('update', (update, origin) => {
            this.#broadcast(MSG_SYNC, e => syncProtocol.writeUpdate(e, update), origin);
            if (origin !== 'disk') this.#scheduleSave();
        });
        this.awareness.on('update', ({ added, updated, removed }, origin) => {
            if (origin?.clientIds) for (const id of [...added, ...updated]) origin.clientIds.add(id);
            const changed = [...added, ...updated, ...removed];
            this.#broadcast(MSG_AWARENESS, e => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)), origin);
        });
    }

    //Sends a chat event to everyone connected to this workspace
    chatBroadcast(event) { for (const connection of this.connections) connection.chat(event); }
    transcriptBroadcast(event) { for (const connection of this.connections) connection.transcript(event); }

    #broadcast(type, write, except) {
        for (const connection of this.connections) {
            if (connection === except) continue;
            const message = encoding.createEncoder();
            encoding.writeVarUint(message, type);
            write(message);
            connection.send(encoding.toUint8Array(message));
        }
    }

    #scheduleSave() {
        if (!this.#file) return;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.save(), 300);
    }

    save() {
        if (!this.#file) return;
        clearTimeout(this.#timer);
        this.#timer = null;
        try {
            const temporary = `${this.#file}.tmp`;
            writeFileSync(temporary, Y.encodeStateAsUpdate(this.doc));
            renameSync(temporary, this.#file);                    //atomic: a crash never leaves a half-written document
        } catch (error) {
            //A full or missing disk must not take the live session down (nor stop shutdown halfway)
            this.log(`could not save ${this.id}: ${error.message}`);
        }
    }

    join(connection) { clearTimeout(this.#idleTimer); this.connections.add(connection); }

    leave(connection) {
        this.connections.delete(connection);
        awarenessProtocol.removeAwarenessStates(this.awareness, [...connection.clientIds], null);     //tell the others they left
        if (!this.connections.size) this.#idleTimer = setTimeout(() => { this.save(); this.onIdle(this.id); }, 10_000);
    }

    destroy() { clearTimeout(this.#timer); clearTimeout(this.#idleTimer); this.save(); this.awareness.destroy(); this.doc.destroy(); }
}

class Connection {
    clientIds = new Set();
    constructor(socket, claims) {
        this.socket = socket; this.claims = claims; this.role = claims.role;
        this.userId = claims.sub;
    }
    send(bytes) { if (this.socket.readyState === 1) this.socket.send(bytes); }
    control(message) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_CONTROL);
        encoding.writeVarString(e, JSON.stringify(message));
        this.send(encoding.toUint8Array(e));
    }
    chat(event) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_CHAT);
        encoding.writeVarString(e, JSON.stringify(event));
        this.send(encoding.toUint8Array(e));
    }
    transcript(event) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_TRANSCRIPT);
        encoding.writeVarString(e, JSON.stringify(event));
        this.send(encoding.toUint8Array(e));
    }
    allowTranscript(now = Date.now()) {
        this.transcripts = (this.transcripts ?? []).filter(t => now - t < TRANSCRIPT_RATE.windowMs);
        if (this.transcripts.length >= TRANSCRIPT_RATE.perWindow) return false;
        this.transcripts.push(now);
        return true;
    }
    signal(event) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SIGNAL);
        encoding.writeVarString(e, JSON.stringify(event));
        this.send(encoding.toUint8Array(e));
    }
    allowSignal(now = Date.now()) {
        this.signals = (this.signals ?? []).filter(t => now - t < SIGNAL_RATE.windowMs);
        if (this.signals.length >= SIGNAL_RATE.perWindow) return false;
        this.signals.push(now);
        return true;
    }
    //At most CHAT_RATE.perWindow sends per window: a runaway client cannot flood the log
    allowChatSend(now = Date.now()) {
        this.chatSends = (this.chatSends ?? []).filter(t => now - t < CHAT_RATE.windowMs);
        if (this.chatSends.length >= CHAT_RATE.perWindow) return false;
        this.chatSends.push(now);
        return true;
    }
    close(code, reason) { this.socket.close(code, reason); }
}

export function createSyncServer({ secret, adminToken = null, dataDir = null, chatRetentionDays = 0, transcriptRetentionDays = 0, iceServers = null, devAuth = false, maxMessageBytes = 2 * 1024 * 1024, log = () => {},
    events = null, webhookUrl = null, webhookSecret = null, files = null, maxPartBytes, recordingIdleMs = 120_000, sweepEveryMs = 30_000 } = {}) {
    const key = checkSecret(secret, devAuth);
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    //What the host system hears about (the EventSink contract): an outbox on disk, a signed webhook when one is configured
    events ??= new EventBus({ sinks: webhookUrl ? [webhookSink({ url: webhookUrl, secret: webhookSecret })] : [], file: dataDir && webhookUrl ? join(dataDir, 'events.outbox.jsonl') : null, log });
    //Where the bytes of the recordings live (the FileStore contract); the host system may bring its own
    files ??= dataDir ? new DiskFileStore({ dir: join(dataDir, 'media'), secret: key }) : null;
    const rooms = new Map();
    const connections = new Set();
    const roomFor = id => {
        if (!rooms.has(id)) rooms.set(id, new Room(id, dataDir, roomId => { rooms.get(roomId)?.destroy(); rooms.delete(roomId); }, log, chatRetentionDays, transcriptRetentionDays));
        return rooms.get(id);
    };

    const listWorkspaces = () => {
        const ids = new Set(rooms.keys());
        if (dataDir) for (const name of readdirSync(dataDir)) if (name.endsWith('.recordings.jsonl')) ids.add(name.slice(0, -'.recordings.jsonl'.length));
        return [...ids].filter(id => WORKSPACE_ID.test(id));
    };
    const api = files ? createApi({ key, files, events, roomFor, listWorkspaces, log, maxPartBytes, idleMs: recordingIdleMs }) : null;
    const sweeper = api ? setInterval(() => { api.sweep().catch(error => log(`sweep failed: ${error.message}`)); }, sweepEveryMs) : null;
    sweeper?.unref();

    // ---- HTTP: health, the v1 API, and the dev token/role endpoints (never in production) ----
    const readJson = request => new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => { body += chunk; if (body.length > 10_000) { reject(new Error('too large')); request.destroy(); } });
        request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
    });
    const cors = response => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'content-type');
    };
    const http = createServer(async (request, response) => {
        const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
        if (request.url === '/health') return send(200, { ok: true, rooms: rooms.size, connections: connections.size });
        if (api && request.url.startsWith('/v1/') && await api.handle(request, response, new URL(request.url, 'http://localhost'))) return;

        //Server-to-server: the host tells us a role changed so it applies to open connections at once (R-PERM-4).
        //Off unless an admin token is configured; never reachable with the dev flag's open endpoints.
        if (request.url === '/admin/role' && request.method === 'POST' && adminToken) {
            const given = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
            const expected = Buffer.from(adminToken);
            if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(401, { error: 'unauthorized' });
            try {
                const { workspace, user, role } = await readJson(request);
                return send(200, { changed: server.setRole(workspace, user, role) });
            } catch (error) { return send(400, { error: error.message }); }
        }
        if (!devAuth || !request.url.startsWith('/dev/')) return send(404, { error: 'not found' });
        cors(response);
        if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
        try {
            const body = await readJson(request);
            if (request.url === '/dev/token' && request.method === 'POST') {
                const { workspace, user, role = 'owner' } = body;
                if (!WORKSPACE_ID.test(workspace ?? '') || !user?.id || !ROLES.includes(role)) return send(400, { error: 'workspace, user.id and a valid role are required' });
                return send(200, { token: issueToken({ sub: user.id, name: user.name ?? user.id, workspace, role }, key), role });
            }
            if (request.url === '/dev/role' && request.method === 'POST') {
                const changed = server.setRole(body.workspace, body.user, body.role);
                return send(changed ? 200 : 404, { changed });
            }
        } catch (error) { return send(400, { error: error.message }); }
        return send(404, { error: 'not found' });
    });

    // ---- WebSocket ----
    const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
    http.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, ws => handleConnection(ws, request));
    });

    //Auth failures are reported with a close code AFTER the upgrade: browsers cannot read the HTTP status of a failed WebSocket.
    function handleConnection(ws, request) {
        const url = new URL(request.url, 'http://localhost');
        const workspace = decodeURIComponent(url.pathname.slice(1));
        if (!WORKSPACE_ID.test(workspace)) return ws.close(CLOSE.BAD_REQUEST, 'invalid workspace id');
        let claims;
        try { claims = verifyToken(url.searchParams.get('token'), key); }
        catch (error) { log(`auth refused (${error.message})`); return ws.close(CLOSE.UNAUTHORIZED, 'invalid token'); }
        if (claims.workspace !== workspace) return ws.close(CLOSE.UNAUTHORIZED, 'token is for another workspace');

        const room = roomFor(workspace);
        const connection = new Connection(ws, claims);
        room.join(connection);
        connections.add(connection);

        const expiry = setTimeout(() => ws.close(CLOSE.EXPIRED, 'token expired'), Math.max(0, claims.exp * 1000 - Date.now()));
        ws.on('close', () => {
            clearTimeout(expiry); connections.delete(connection);
            try { callLeave(room, connection); } catch (error) { log(`could not close the call record of ${room.id}: ${error.message}`); }      //a full disk must not skip the rest
            room.leave(connection);
        });
        ws.on('error', error => log(`socket error: ${error.message}`));
        ws.on('message', data => {
            try { onMessage(room, connection, new Uint8Array(data)); }
            catch (error) { log(`bad message: ${error.message}`); ws.close(CLOSE.BAD_REQUEST, 'bad message'); }
        });

        //Greet: ask for what the client has, and tell it its role
        const hello = encoding.createEncoder();
        encoding.writeVarUint(hello, MSG_SYNC);
        syncProtocol.writeSyncStep1(hello, room.doc);
        connection.send(encoding.toUint8Array(hello));
        connection.control({ type: 'role', role: connection.role });
        if (iceServers) connection.control({ type: 'ice', iceServers });
        connection.chat({ type: 'history', ...room.chat.page({ limit: CHAT_HISTORY }) });
        connection.transcript({ type: 'history', ...room.transcript.page({ limit: CHAT_HISTORY }) });
        const states = awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]);
        if (room.awareness.getStates().size) {
            const presence = encoding.createEncoder();
            encoding.writeVarUint(presence, MSG_AWARENESS);
            encoding.writeVarUint8Array(presence, states);
            connection.send(encoding.toUint8Array(presence));
        }
    }

    function onMessage(room, connection, bytes) {
        const decoder = decoding.createDecoder(bytes);
        switch (decoding.readVarUint(decoder)) {
            case MSG_SYNC: {
                const kind = decoding.readVarUint(decoder);                            // 0 step1, 1 step2, 2 update
                if (kind === syncProtocol.messageYjsSyncStep1) {
                    const reply = encoding.createEncoder();
                    encoding.writeVarUint(reply, MSG_SYNC);
                    syncProtocol.writeSyncStep2(reply, room.doc, decoding.readVarUint8Array(decoder));
                    connection.send(encoding.toUint8Array(reply));
                    return;
                }
                const update = decoding.readVarUint8Array(decoder);
                if (!mayWrite(connection.role, room.doc, update)) {
                    log(`write refused: ${connection.userId} (${connection.role}) in ${room.id}`);
                    connection.close(CLOSE.FORBIDDEN, 'not allowed to change this');
                    return;
                }
                Y.applyUpdate(room.doc, update, connection);
                return;
            }
            case MSG_AWARENESS:
                awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), connection);
                return;
            case MSG_CHAT:
                onChat(room, connection, JSON.parse(decoding.readVarString(decoder)));
                return;
            case MSG_TRANSCRIPT:
                onTranscript(room, connection, JSON.parse(decoding.readVarString(decoder)));
                return;
            case MSG_SIGNAL:
                onSignal(room, connection, decoding.readVarString(decoder));
                return;
            case MSG_CALL:
                try { onCall(room, connection, JSON.parse(decoding.readVarString(decoder))); }
                catch (error) { log(`call error in ${room.id}: ${error.message}`); }              //never close the connection over a call record
                return;
            default:
                throw new Error('unknown message type');
        }
    }

    let closed = false;

    // ---- calls: the server learns when a call starts and ends from the people in it (not from guessing at presence) ----
    //Request: { type: 'join' } | { type: 'leave' }. The answer to the sender is control { type: 'call', sessionId, startedAt }.
    //A call is the time at least one person is in it; each person's recording and each transcript segment is stamped with it.
    function onCall(room, connection, request) {
        if (request.type === 'join') callJoin(room, connection);
        else if (request.type === 'leave') callLeave(room, connection);
    }

    function callJoin(room, connection) {
        if (connection.inCall) return;
        connection.inCall = true;
        const name = connection.claims.name ?? connection.userId;
        let member = room.call.members.get(connection.userId);
        if (!member) { member = { name, connections: new Set() }; room.call.members.set(connection.userId, member); }
        member.connections.add(connection);
        const at = new Date().toISOString();
        let session = room.call.session;
        if (!session) {
            session = room.call.session = { id: randomUUID(), workspaceId: room.id, startedAt: at, endedAt: null, participants: [] };
            events.emit('call.started', room.id, { sessionId: session.id, startedAt: at, by: connection.userId });
        }
        if (!session.participants.some(p => p.userId === connection.userId && !p.leftAt)) session.participants.push({ userId: connection.userId, name, joinedAt: at, leftAt: null });
        room.sessions.upsert(session);
        connection.control({ type: 'call', sessionId: session.id, startedAt: session.startedAt });
    }

    function callLeave(room, connection) {
        if (!connection.inCall) return;
        connection.inCall = false;
        const member = room.call.members.get(connection.userId);
        member?.connections.delete(connection);
        if (member?.connections.size) return;                    //another tab of the same person is still in the call
        room.call.members.delete(connection.userId);
        const session = room.call.session;
        if (!session) return;
        const at = new Date().toISOString();
        for (const p of session.participants) if (p.userId === connection.userId && !p.leftAt) p.leftAt = at;
        if (room.call.members.size) { room.sessions.upsert(session); return; }
        session.endedAt = at;
        session.durationMs = Date.parse(at) - Date.parse(session.startedAt);
        room.sessions.upsert(session);
        room.call.session = null;
        const segments = room.transcript.all().filter(m => m.sessionId === session.id).length;
        events.emit('call.ended', room.id, { sessionId: session.id, startedAt: session.startedAt, endedAt: at, durationMs: session.durationMs, participants: session.participants.map(p => p.userId) });
        if (segments) events.emit('transcript.finalized', room.id, { sessionId: session.id, segments });
    }

    //Only what the transcript keeps about a segment, and only if it is sane: the client is not trusted with the shape
    const segmentExtras = (room, request) => {
        const extra = { sessionId: room.call.session?.id ?? null };
        const at = Number(request.startedAt);
        if (Number.isFinite(at) && at > 0 && at < Date.now() + 60_000) extra.startedAt = at;
        const duration = Number(request.durationMs);
        if (Number.isFinite(duration) && duration > 0 && duration <= 10 * 60_000) extra.durationMs = Math.round(duration);
        if (typeof request.language === 'string' && /^[A-Za-z-]{2,16}$/.test(request.language)) extra.language = request.language;
        return extra;
    };

    //Conference signalling (offer / answer / ICE) between two people of the SAME workspace. The server does not read it:
    //it only checks who is talking to whom and stamps the sender, so a client cannot speak in someone else's name.
    //Request: { to: <awareness clientId>, from: <one of the sender's own clientIds>, data }.  Delivery: { type: 'signal', from, user, data }.
    function onSignal(room, connection, text) {
        if (text.length > SIGNAL_MAX_BYTES) return connection.signal({ type: 'error', code: 'too_big', message: 'Sinal grande demais.' });
        let request;
        try { request = JSON.parse(text); } catch { return connection.signal({ type: 'error', code: 'bad_request', message: 'Sinal inválido.' }); }
        if (!connection.allowSignal()) return connection.signal({ type: 'error', code: 'rate', ref: request.to ?? null, message: 'Sinais demais em pouco tempo.' });
        if (!connection.clientIds.has(request.from)) return connection.signal({ type: 'error', code: 'bad_request', ref: request.to ?? null, message: 'Remetente desconhecido.' });
        const target = [...room.connections].find(other => other.clientIds.has(request.to));
        if (!target || target === connection) return connection.signal({ type: 'error', code: 'gone', ref: request.to ?? null, message: 'Destinatário não está no workspace.' });
        target.signal({ type: 'signal', from: request.from, user: { id: connection.userId, name: connection.claims.name ?? connection.userId }, data: request.data });
    }

    //Transcript of the call (D-37): each person's own speech, transcribed on THEIR device and sent here. The author is
    //the token's, never the message's, so nobody can put words in another person's mouth. Same log machinery as the chat
    //(idempotent by clientId, retention, page), a separate file and its own rate limit. Viewers read; they do not speak.
    //Request: { type: 'send', clientId, body, startedAt?, language? } | { type: 'history', before?, limit? }
    function onTranscript(room, connection, request) {
        const fail = (code, message) => connection.transcript({ type: 'error', ref: request.clientId ?? null, code, message });
        try {
            if (request.type === 'history') {
                connection.transcript({ type: 'history', ...room.transcript.page({ beforeSeq: Number(request.before) || Infinity, limit: Number(request.limit) || CHAT_HISTORY }) });
                return;
            }
            if (request.type !== 'send') return fail('bad_request', 'Pedido de transcrição desconhecido.');
            if (!CHAT_WRITERS.has(connection.role)) return fail('forbidden', 'Seu papel não permite transcrever.');
            if (!connection.allowTranscript()) return fail('rate', 'Trechos demais em pouco tempo.');
            const author = { id: connection.userId, name: connection.claims.name ?? connection.userId };
            const { message, duplicate } = room.transcript.add(author, { body: request.body, clientId: request.clientId }, segmentExtras(room, request));
            if (duplicate) connection.transcript({ type: 'segment', segment: message });
            else room.transcriptBroadcast({ type: 'segment', segment: message });
        } catch (error) {
            if (error instanceof ChatError) return fail(error.code, error.message);
            log(`transcript error in ${room.id}: ${error.message}`);
            return fail('internal', 'Erro interno na transcrição.');
        }
    }

    //Chat requests. A refused or invalid one answers the SENDER with { type: 'error', ref, code, message } and changes nothing.
    function onChat(room, connection, request) {
        const fail = (code, message) => connection.chat({ type: 'error', ref: request.clientId ?? request.id ?? null, code, message });
        const author = { id: connection.userId, name: connection.claims.name ?? connection.userId };
        try {
            if (request.type === 'history') {
                connection.chat({ type: 'history', ...room.chat.page({ beforeSeq: Number(request.before) || Infinity, limit: Number(request.limit) || CHAT_HISTORY }) });
                return;
            }
            if (!CHAT_WRITERS.has(connection.role)) return fail('forbidden', 'Seu papel só permite ler o chat.');
            if (request.type === 'send') {
                if (!connection.allowChatSend()) return fail('rate', 'Muitas mensagens em pouco tempo. Aguarde um instante.');
                const { message, duplicate } = room.chat.add(author, request);
                if (duplicate) connection.chat({ type: 'message', message });          // a retry: tell the sender, do not repeat it to everyone
                else room.chatBroadcast({ type: 'message', message });
            } else if (request.type === 'edit') {
                room.chatBroadcast({ type: 'updated', message: room.chat.edit(request.id, connection.userId, request.body) });
            } else if (request.type === 'delete') {
                room.chatBroadcast({ type: 'deleted', message: room.chat.remove(request.id, connection.userId, { isOwner: connection.role === 'owner' }) });
            } else {
                fail('bad_request', 'Pedido de chat desconhecido.');
            }
        } catch (error) {
            if (error instanceof ChatError) return fail(error.code, error.message);
            log(`chat error in ${room.id}: ${error.message}`);                       // never close the connection over a chat problem
            return fail('internal', 'Erro interno no chat. Tente de novo.');
        }
    }

    const server = {
        http,
        rooms,
        events,
        api,
        get connectionCount() { return connections.size; },
        //R-PERM-4: a role change applies to open connections at once
        setRole(workspace, userId, role) {
            if (!ROLES.includes(role)) return false;
            let changed = false;
            for (const connection of connections) {
                if (connection.claims.workspace === workspace && connection.userId === userId) {
                    connection.role = role; connection.control({ type: 'role', role }); changed = true;
                }
            }
            return changed;
        },
        issueToken: (claims, ttl) => issueToken(claims, key, ttl),
        listen: (port = 0, host = '127.0.0.1') => new Promise(resolve => http.listen(port, host, () => resolve(http.address().port))),
        async close() {
            if (closed) return;                                     //idempotent: callers may close twice
            closed = true;
            for (const connection of connections) connection.close(1001, 'server shutting down');
            clearInterval(sweeper);
            for (const room of rooms.values()) room.destroy();
            rooms.clear();
            events.close();
            for (const socket of wss.clients) socket.terminate();   //includes sockets still mid-handshake or being refused
            wss.close();
            http.closeAllConnections();                       //keep-alive HTTP clients must not hold shutdown
            await new Promise(resolve => http.close(resolve));
        },
    };
    return server;
}
