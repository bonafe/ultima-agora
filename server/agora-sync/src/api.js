//HTTP API v1 (docs/especificacao/09, 9.7): recordings and the transcript export. One error format, always
//{ error: { code, message } } (R-API-2). The token is the same short-lived JWT the WebSocket uses, in `Authorization: Bearer`.
//
//  POST /v1/workspaces/:ws/recordings                       start (the person consents; they only ever record themselves)
//  PUT  /v1/workspaces/:ws/recordings/:id/parts/:n          one piece (idempotent), sent while the call is going on
//  POST /v1/workspaces/:ws/recordings/:id/complete          join the pieces into the file
//  GET  /v1/workspaces/:ws/recordings                       the list (metadata + a signed link for each finished one)
//  GET  /v1/workspaces/:ws/recordings/:id/media?exp&sig     the file (signed link, so <audio src> works; supports Range)
//  GET  /v1/workspaces/:ws/transcript?format=jsonl|json|txt|vtt|srt[&session=<id>]
import { randomUUID } from 'node:crypto';
import { verifyToken } from './auth.js';
import { FileStoreError } from './files.js';

const WRITERS = new Set(['owner', 'editor', 'participant']);         //viewers listen: they do not record
const KINDS = new Set(['audio', 'video', 'screen']);
const MIME = /^(audio|video)\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"' +-]+)?$/i;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f-]{36}$/;
const MEDIA_TTL_SECONDS = 3600;

class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const clock = ms => {
    const t = Math.max(0, Math.round(ms));
    return { h: Math.floor(t / 3_600_000), m: Math.floor(t / 60_000) % 60, s: Math.floor(t / 1000) % 60, ms: t % 1000 };
};
const stamp = (ms, comma) => { const { h, m, s, ms: milli } = clock(ms); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(milli, 3)}`; };

//Turns segments into the export formats. `base` is the time (ms since the epoch) that cue 0 corresponds to.
export function formatTranscript(segments, format, base) {
    const timing = segment => {
        const at = Number.isFinite(segment.startedAt) ? segment.startedAt : Date.parse(segment.createdAt);
        const start = Math.max(0, at - base);
        return { start, end: start + (Number.isFinite(segment.durationMs) && segment.durationMs > 0 ? segment.durationMs : 2000) };
    };
    const live = segments.filter(s => !s.deletedAt);
    if (format === 'json') return JSON.stringify({ segments: live }, null, 2);
    if (format === 'jsonl') return live.map(s => JSON.stringify(s)).join('\n') + (live.length ? '\n' : '');
    if (format === 'txt') return live.map(s => `[${new Date(Number.isFinite(s.startedAt) ? s.startedAt : Date.parse(s.createdAt)).toISOString().slice(11, 19)}] ${s.author.name}: ${s.body}`).join('\n') + (live.length ? '\n' : '');
    if (format === 'vtt') return `WEBVTT\n\n${live.map(s => { const t = timing(s); return `${stamp(t.start)} --> ${stamp(t.end)}\n<v ${s.author.name}>${s.body}`; }).join('\n\n')}\n`;
    if (format === 'srt') return live.map((s, i) => { const t = timing(s); return `${i + 1}\n${stamp(t.start, true)} --> ${stamp(t.end, true)}\n${s.author.name}: ${s.body}`; }).join('\n\n') + (live.length ? '\n' : '');
    return null;
}
const CONTENT_TYPES = { json: 'application/json', jsonl: 'application/x-ndjson', txt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8', srt: 'application/x-subrip; charset=utf-8' };

export function createApi({ key, files, events, roomFor, listWorkspaces = () => [], log = () => {}, maxPartBytes = 8 * 1024 * 1024, maxRecordingBytes = 2 * 1024 ** 3, idleMs = 120_000, now = () => Date.now() }) {
    const json = (response, status, body, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };

    const authorize = (request, workspace) => {
        let claims;
        try { claims = verifyToken((request.headers.authorization ?? '').replace(/^Bearer /, ''), key); }
        catch { throw new ApiError(401, 'unauthorized', 'Token inválido ou expirado.'); }
        if (claims.workspace !== workspace) throw new ApiError(401, 'unauthorized', 'O token é de outro workspace.');
        return claims;
    };
    const needWriter = claims => { if (!WRITERS.has(claims.role)) throw new ApiError(403, 'forbidden', 'Seu papel não permite gravar.'); };

    const readBody = (request, limit) => new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        //Past the limit the rest is read and dropped (not stored): closing the socket mid-upload would hide the 413 from the client
        request.on('data', chunk => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
        request.on('end', () => size > limit ? reject(new ApiError(413, 'too_large', `O pedido passa de ${limit} bytes.`)) : resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
    const readJson = async request => { try { return JSON.parse((await readBody(request, 10_000)).toString('utf8') || '{}'); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'bad_request', 'JSON inválido.'); } };

    //What a client may see of a recording: no storage internals. A finished one carries a signed, temporary link to the file.
    const view = (record, workspace) => {
        const { uploadId, lastPartAt, ...rest } = record;
        if (record.status !== 'complete') return rest;
        const { exp, sig } = files.signDownload(record.id, MEDIA_TTL_SECONDS, now());
        return { ...rest, mediaUrl: `/v1/workspaces/${workspace}/recordings/${record.id}/media?exp=${exp}&sig=${sig}` };
    };

    const find = (room, id) => {
        const record = UUID.test(id) ? room.recordings.get(id) : null;
        if (!record) throw new ApiError(404, 'not_found', 'Gravação não encontrada.');
        return record;
    };
    const own = (record, claims) => {
        if (record.userId !== claims.sub && claims.role !== 'owner') throw new ApiError(403, 'forbidden', 'Só quem gravou (ou o dono do workspace) pode fazer isso.');
    };

    async function start(request, response, workspace) {
        const claims = authorize(request, workspace); needWriter(claims);
        const body = await readJson(request);
        if (body.consent !== true) throw new ApiError(400, 'consent_required', 'A gravação só começa com o consentimento da pessoa.');
        if (!KINDS.has(body.kind)) throw new ApiError(400, 'bad_request', 'Tipo de gravação inválido.');
        if (typeof body.mime !== 'string' || !MIME.test(body.mime)) throw new ApiError(400, 'bad_request', 'Tipo de mídia inválido.');
        const room = roomFor(workspace);
        const session = room.call.session;
        const at = now();
        const record = {
            id: randomUUID(), workspaceId: workspace, sessionId: session?.id ?? null, userId: claims.sub, userName: claims.name ?? claims.sub,
            kind: body.kind, source: 'client-track', mime: body.mime,
            startOffsetMs: session ? Math.max(0, at - Date.parse(session.startedAt)) : 0,       //where this track starts on the call's timeline
            status: 'recording', createdAt: new Date(at).toISOString(), consent: { at: new Date(at).toISOString(), by: claims.sub },
            uploadId: await files.beginUpload(), lastPartAt: at,
        };
        room.recordings.upsert(record);
        events.emit('recording.started', workspace, { recordingId: record.id, sessionId: record.sessionId, userId: record.userId, kind: record.kind, mime: record.mime });
        room.recordingChanged?.(record);
        json(response, 201, view(record, workspace));
    }

    async function putPart(request, response, workspace, id, n) {
        const claims = authorize(request, workspace);
        const room = roomFor(workspace);
        const record = find(room, id);
        own(record, claims);
        if (record.status !== 'recording') throw new ApiError(409, 'closed', 'Esta gravação já foi encerrada.');
        const index = Number(n);
        if (!Number.isInteger(index)) throw new ApiError(400, 'bad_request', 'Número de parte inválido.');
        const bytes = await readBody(request, maxPartBytes);
        if (!bytes.length) throw new ApiError(400, 'bad_request', 'Parte vazia.');
        if ((record.bytes ?? 0) + bytes.length > maxRecordingBytes) throw new ApiError(413, 'quota', 'A gravação passou do limite de tamanho.');
        await files.putPart(record.uploadId, index, bytes);
        room.recordings.upsert({ ...record, lastPartAt: now(), bytes: (record.bytes ?? 0) + bytes.length });     //a re-sent part counts again: an upper bound is enough for the quota
        response.writeHead(204); response.end();
    }

    //Joins the pieces and finishes the record. `auto` is the janitor closing a recording nobody finished (the tab died).
    async function finish(room, record, { parts = null, durationMs = null, auto = false } = {}) {
        if (record.status !== 'recording') return record;
        const done = await files.complete(record.uploadId, { parts });
        const finished = {
            ...record, status: 'complete', blobId: done.blobId, sizeBytes: done.sizeBytes, sha256: done.sha256, partsJoined: parts ?? undefined,
            truncated: done.truncated || auto, durationMs: Number.isFinite(durationMs) ? durationMs : null, completedAt: new Date(now()).toISOString(),
        };
        delete finished.uploadId;
        room.recordings.upsert(finished);
        events.emit('recording.completed', room.id, { recordingId: record.id, sessionId: record.sessionId, userId: record.userId, kind: record.kind, mime: record.mime, sizeBytes: finished.sizeBytes, durationMs: finished.durationMs, startOffsetMs: record.startOffsetMs, sha256: finished.sha256, truncated: finished.truncated });
        room.recordingChanged?.(finished);
        return finished;
    }

    async function complete(request, response, workspace, id) {
        const claims = authorize(request, workspace);
        const room = roomFor(workspace);
        const record = find(room, id);
        own(record, claims);
        const body = await readJson(request);
        const finished = await finish(room, record, { parts: Number.isInteger(body.parts) && body.parts >= 0 ? body.parts : null, durationMs: Number(body.durationMs) });
        json(response, 200, view(finished, workspace));
    }

    async function list(request, response, workspace) {
        authorize(request, workspace);
        const records = roomFor(workspace).recordings.list().sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
        json(response, 200, { recordings: records.map(r => view(r, workspace)) });
    }

    async function media(request, response, workspace, id, url) {
        const record = find(roomFor(workspace), id);
        if (record.status !== 'complete' || !files.verifyDownload(record.id, url.searchParams.get('exp'), url.searchParams.get('sig'), now())) throw new ApiError(403, 'forbidden', 'Link inválido ou vencido.');
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
        const probe = await files.open(record.blobId);
        if (!probe) throw new ApiError(404, 'not_found', 'O arquivo não está mais disponível.');
        probe.stream.destroy();
        const size = probe.size;
        let start = 0, end = size - 1, status = 200;
        if (range && (range[1] || range[2])) {
            if (range[1] === '') { start = Math.max(0, size - Number(range[2])); }                 //bytes=-N: the last N bytes
            else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
            if (start > end || start >= size) { response.writeHead(416, { 'content-range': `bytes */${size}` }); return response.end(); }
            status = 206;
        }
        const file = await files.open(record.blobId, { start, end });
        response.writeHead(status, {
            'content-type': record.mime, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300',
            ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
        });
        file.stream.pipe(response);
        response.on('close', () => file.stream.destroy());
    }

    async function transcript(request, response, workspace, url) {
        authorize(request, workspace);
        const format = url.searchParams.get('format') ?? 'jsonl';
        if (!CONTENT_TYPES[format]) throw new ApiError(400, 'bad_request', 'Formato desconhecido (jsonl, json, txt, vtt ou srt).');
        const room = roomFor(workspace);
        const sessionId = url.searchParams.get('session');
        const session = sessionId ? room.sessions.get(sessionId) : null;
        if (sessionId && !session) throw new ApiError(404, 'not_found', 'Chamada não encontrada.');
        const segments = room.transcript.all().filter(s => !sessionId || s.sessionId === sessionId);
        const first = segments.map(s => Number.isFinite(s.startedAt) ? s.startedAt : Date.parse(s.createdAt)).reduce((a, b) => Math.min(a, b), Infinity);
        const base = session ? Date.parse(session.startedAt) : (Number.isFinite(first) ? first : now());
        response.writeHead(200, { 'content-type': CONTENT_TYPES[format], 'content-disposition': `attachment; filename="transcricao.${format}"` });
        response.end(formatTranscript(segments, format, base));
    }

    //Recordings nobody finished (the tab died, the person's network never came back) are closed with what arrived
    async function sweep() {
        const stale = [];
        for (const id of new Set([...listWorkspaces()])) {
            const room = roomFor(id);
            for (const record of room.recordings.list(r => r.status === 'recording' && now() - (r.lastPartAt ?? 0) > idleMs)) stale.push([room, record]);
        }
        for (const [room, record] of stale) {
            try { await finish(room, record, { auto: true }); } catch (error) { log(`could not close ${record.id}: ${error.message}`); }
        }
        return stale.length;
    }

    //true when the request was ours
    async function handle(request, response, url) {
        const match = /^\/v1\/workspaces\/([^/]+)\/(.*)$/.exec(url.pathname);
        if (!match) return false;
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, range');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        response.setHeader('Access-Control-Expose-Headers', 'content-range, accept-ranges, content-length');
        if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true; }
        try {
            const workspace = decodeURIComponent(match[1]);
            if (!WORKSPACE_ID.test(workspace)) throw new ApiError(400, 'bad_request', 'Workspace inválido.');
            const rest = match[2], method = request.method;
            let parts;
            if (rest === 'recordings' && method === 'POST') await start(request, response, workspace);
            else if (rest === 'recordings' && method === 'GET') await list(request, response, workspace);
            else if ((parts = /^recordings\/([^/]+)\/parts\/(\d+)$/.exec(rest)) && method === 'PUT') await putPart(request, response, workspace, parts[1], parts[2]);
            else if ((parts = /^recordings\/([^/]+)\/complete$/.exec(rest)) && method === 'POST') await complete(request, response, workspace, parts[1]);
            else if ((parts = /^recordings\/([^/]+)\/media$/.exec(rest)) && method === 'GET') await media(request, response, workspace, parts[1], url);
            else if (rest === 'transcript' && method === 'GET') await transcript(request, response, workspace, url);
            else throw new ApiError(404, 'not_found', 'Rota desconhecida.');
        } catch (error) {
            if (response.headersSent) { response.destroy(); return true; }
            if (error instanceof ApiError) json(response, error.status, { error: { code: error.code, message: error.message } });
            else if (error instanceof FileStoreError) json(response, error.code === 'bad_request' ? 400 : 500, { error: { code: error.code, message: error.message } });
            else { log(`api error: ${error.message}`); json(response, 500, { error: { code: 'internal', message: 'Erro interno.' } }); }
        }
        return true;
    }

    return { handle, sweep, finish };
}
