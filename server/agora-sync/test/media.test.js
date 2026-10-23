//Calls, recordings and events (docs/especificacao/09): what a call leaves behind, and what the host system is told.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createSyncServer } from '../src/server.js';
import { EventBus, webhookSink } from '../src/events.js';
import { DiskFileStore, FileStoreError } from '../src/files.js';
import { formatTranscript } from '../src/api.js';
import { YjsWorkspaceDoc } from '../../../collaboration/document/yjs_state_store.js';
import { SyncProvider } from '../../../collaboration/providers/sync_provider.js';
import { CallClient } from '../../../collaboration/providers/call_client.js';
import { RecordingApi } from '../../../collaboration/providers/recording_api.js';
import { Recorder } from '../../../recording/recorder.js';
import { awarenessProtocol } from '../../../vendor/yjs/yjs.js';

const SECRET = 'a-test-secret-that-is-long-enough-123456';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await condition()) return true; await wait(15); } return false; };

const cleanups = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'agora-media-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
after(async () => { for (const fn of cleanups.reverse()) await fn(); });          //servers first, then their directories

const start = async (options = {}) => {
    const dataDir = options.dataDir ?? tempDir();
    const server = createSyncServer({ secret: SECRET, dataDir, ...options });
    const port = await server.listen(0);
    cleanups.push(() => server.close().catch(() => {}));
    return { server, dataDir, ws: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
};

//A bare client speaking the wire protocol: enough to say "I joined the call" and "I said this"
const connect = async (ctx, { user, role = 'participant', workspace = 'ws1' }) => {
    const token = ctx.server.issueToken({ sub: user, name: user, workspace, role }, 120);
    const socket = new WebSocket(`${ctx.ws}/${workspace}?token=${token}`);
    socket.binaryType = 'arraybuffer';
    const client = { token, controls: [], segments: [], socket };
    socket.on('message', data => {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(decoder);
        if (type === 3) client.controls.push(JSON.parse(decoding.readVarString(decoder)));
        if (type === 6) { const event = JSON.parse(decoding.readVarString(decoder)); if (event.type === 'segment') client.segments.push(event.segment); }
    });
    await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
    await until(() => client.controls.some(c => c.type === 'role'));
    const frame = (type, payload) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, type); encoding.writeVarString(e, JSON.stringify(payload)); socket.send(encoding.toUint8Array(e)); };
    client.join = () => frame(7, { type: 'join' });
    client.leave = () => frame(7, { type: 'leave' });
    client.say = payload => frame(6, { type: 'send', clientId: `c-${Math.random()}`, ...payload });
    client.close = () => socket.close();
    client.session = () => client.controls.findLast(c => c.type === 'call');
    return client;
};

const api = (ctx, token, path, init = {}) => fetch(`${ctx.http}/v1/workspaces/ws1/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
const post = (ctx, token, path, body) => api(ctx, token, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- events ----

test('events: a webhook gets a signed event, a failing one is retried with the SAME id, and the outbox survives a restart', async () => {
    const dir = tempDir(), file = join(dir, 'outbox.jsonl');
    const received = [];
    let failures = 2;
    const fetchImpl = async (url, init) => {
        if (failures-- > 0) return { ok: false, status: 503 };
        received.push({ headers: init.headers, body: init.body });
        return { ok: true, status: 200 };
    };
    const bus = new EventBus({ sinks: [webhookSink({ url: 'http://host.test/events', secret: 'shh', fetchImpl })], file, retryMs: [10, 10, 10] });
    const event = bus.emit('recording.completed', 'ws1', { recordingId: 'r1', sizeBytes: 5 });
    assert.ok(await until(() => received.length === 1), 'delivered after two failures');
    const { headers, body } = received[0];
    assert.equal(JSON.parse(body).id, event.id, 'a retry keeps the id: the receiver can be idempotent');
    assert.equal(headers['x-agora-signature'], `sha256=${createHmac('sha256', 'shh').update(`${headers['x-agora-timestamp']}.${body}`).digest('hex')}`);
    assert.ok(await until(() => bus.pending === 0));
    bus.close();

    //a host that was down while the process stopped still gets what was pending
    const down = new EventBus({ sinks: [{ name: 'webhook', deliver: async () => { throw new Error('down'); } }], file, retryMs: [] });
    const lost = down.emit('call.ended', 'ws1', { sessionId: 's1' });
    down.close();
    const later = [];
    const back = new EventBus({ sinks: [{ name: 'webhook', deliver: async e => { later.push(e); } }], file, retryMs: [10] });
    assert.ok(await until(() => later.some(e => e.id === lost.id)), 'replayed after a restart');
    assert.ok(!later.some(e => e.id === event.id), 'what was already delivered is not sent again');
    back.close();
});

test('events: emit never throws, even when a sink cannot be reached at all', () => {
    const bus = new EventBus({ sinks: [{ name: 'x', deliver: () => { throw new Error('boom'); } }], retryMs: [] });
    assert.doesNotThrow(() => bus.emit('a', 'ws1'));
    bus.close();
});

// ---- the file store ----

test('files: parts are joined in order, a hole stops the join, and signed links expire and cannot be forged', async () => {
    const store = new DiskFileStore({ dir: tempDir(), secret: SECRET });
    const id = await store.beginUpload();
    await store.putPart(id, 1, Buffer.from('WORLD'));
    await store.putPart(id, 0, Buffer.from('HELLO '));
    await store.putPart(id, 1, Buffer.from('WORLD'));                    //the same part twice is the same part
    await store.putPart(id, 3, Buffer.from('LOST'));                     //after a hole
    const done = await store.complete(id, {});
    assert.equal(done.sizeBytes, 11);
    assert.equal((await readStream(await store.open(done.blobId))), 'HELLO WORLD');
    assert.equal(done.truncated, true, 'a part after a hole is not joined and the file says so');

    const id2 = await store.beginUpload();
    await store.putPart(id2, 0, Buffer.from('A')); await store.putPart(id2, 2, Buffer.from('C'));
    const gap = await store.complete(id2, { parts: 3 });
    assert.deepEqual(gap.missing, [1]); assert.equal(gap.sizeBytes, 1);

    const { exp, sig } = store.signDownload(done.blobId, 60);
    assert.ok(store.verifyDownload(done.blobId, exp, sig));
    assert.ok(!store.verifyDownload(done.blobId, exp, sig.replace(/.$/, c => (c === '0' ? '1' : '0'))), 'forged');         //always a different last character
    assert.ok(!store.verifyDownload(done.blobId, exp, sig, Date.now() + 120_000), 'expired');
    await assert.rejects(() => store.putPart('../../etc', 0, Buffer.from('x')), FileStoreError);
});

const readStream = async ({ stream }) => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks).toString(); };

// ---- calls and the transcript ----

test('calls: a call starts with the first person and ends with the last; the transcript keeps when, how long and in what language, and says which call', async () => {
    const events = [];
    const ctx = await start({ events: { emit: (type, ws, data) => { events.push({ type, data }); }, close() {} } });
    const ana = await connect(ctx, { user: 'ana' }), bia = await connect(ctx, { user: 'bia' });
    ana.join();
    assert.ok(await until(() => ana.session()));
    bia.join();
    assert.ok(await until(() => bia.session()));
    assert.equal(ana.session().sessionId, bia.session().sessionId, 'one call for the workspace');
    assert.equal(events.filter(e => e.type === 'call.started').length, 1);

    const at = Date.now() - 4000;
    ana.say({ body: 'bom dia', startedAt: at, durationMs: 1800, language: 'pt' });
    ana.say({ body: 'lixo', startedAt: 'amanhã', durationMs: -5, language: '<script>' });
    assert.ok(await until(() => ana.segments.length === 2));
    const [good, bad] = ana.segments;
    assert.deepEqual([good.sessionId, good.startedAt, good.durationMs, good.language], [ana.session().sessionId, at, 1800, 'pt']);
    assert.equal(bad.startedAt, undefined); assert.equal(bad.durationMs, undefined); assert.equal(bad.language, undefined, 'a client is not trusted with the shape');

    ana.leave();
    await wait(60);
    assert.equal(events.filter(e => e.type === 'call.ended').length, 0, 'bia is still in it');
    bia.close();
    assert.ok(await until(() => events.some(e => e.type === 'call.ended')), 'the last one leaving (or dropping) ends it');
    const ended = events.find(e => e.type === 'call.ended').data;
    assert.deepEqual(ended.participants.sort(), ['ana', 'bia']);
    assert.ok(ended.durationMs >= 0);
    assert.equal(events.find(e => e.type === 'transcript.finalized').data.segments, 2);
    ana.close();
});

test('calls: a session left open by a crash is closed as interrupted when the workspace loads again, and the closed ones are kept', async () => {
    const dir = tempDir();
    const at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, 'ws1.sessions.jsonl'), [
        { id: '11111111-1111-1111-1111-111111111111', workspaceId: 'ws1', startedAt: at, endedAt: null, participants: [] },
        { id: '22222222-2222-2222-2222-222222222222', workspaceId: 'ws1', startedAt: at, endedAt: at, durationMs: 5, participants: [] },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const ctx = await start({ dataDir: dir });
    await connect(ctx, { user: 'ana' });
    const room = ctx.server.rooms.get('ws1');
    const open = room.sessions.get('11111111-1111-1111-1111-111111111111');
    assert.ok(open.endedAt && open.interrupted, 'closed, and marked as interrupted');
    assert.equal(room.sessions.get('22222222-2222-2222-2222-222222222222').interrupted, undefined, 'a finished one is left as it was');
});

test('transcript export: jsonl, json, txt, vtt and srt, timed against the call', () => {
    const t0 = Date.parse('2026-10-17T12:00:00Z');
    const segments = [
        { id: '1', author: { id: 'a', name: 'Ana' }, body: 'bom dia', startedAt: t0 + 1500, durationMs: 1200, createdAt: new Date(t0 + 3000).toISOString() },
        { id: '2', author: { id: 'b', name: 'Bia' }, body: 'oi', startedAt: t0 + 3725_000, createdAt: new Date(t0 + 3726_000).toISOString() },
        { id: '3', author: { id: 'b', name: 'Bia' }, body: '', deletedAt: 'x', createdAt: new Date(t0).toISOString() },
    ];
    const vtt = formatTranscript(segments, 'vtt', t0);
    assert.ok(vtt.startsWith('WEBVTT\n\n00:00:01.500 --> 00:00:02.700\n<v Ana>bom dia'), vtt);
    assert.ok(vtt.includes('01:02:05.000 --> 01:02:07.000'), 'an hour in, and a default length when none was kept');
    const srt = formatTranscript(segments, 'srt', t0);
    assert.ok(srt.startsWith('1\n00:00:01,500 --> 00:00:02,700\nAna: bom dia'), srt);
    assert.equal(formatTranscript(segments, 'jsonl', t0).trim().split('\n').length, 2, 'a removed message is not exported');
    assert.ok(formatTranscript(segments, 'txt', t0).includes('Ana: bom dia'));
    assert.equal(formatTranscript(segments, 'nope', t0), null);
});

// ---- recordings over HTTP ----

const recordOnce = async (ctx, token, { parts = ['aaa', 'bbb', 'ccc'], body = {} } = {}) => {
    const created = await post(ctx, token, 'recordings', { kind: 'audio', mime: 'audio/webm;codecs=opus', consent: true, ...body });
    assert.equal(created.status, 201);
    const record = await created.json();
    for (const [n, text] of parts.entries()) assert.equal((await api(ctx, token, `recordings/${record.id}/parts/${n}`, { method: 'PUT', body: text })).status, 204);
    return record;
};

test('recordings: consent is required, the pieces join into one file, the list carries a signed link, and the file supports Range', async () => {
    const events = [];
    const ctx = await start({ events: { emit: (type, ws, data) => { events.push({ type, data }); }, close() {} } });
    const ana = await connect(ctx, { user: 'ana' });
    ana.join();
    await until(() => ana.session());

    const noConsent = await post(ctx, ana.token, 'recordings', { kind: 'audio', mime: 'audio/webm' });
    assert.equal(noConsent.status, 400);
    assert.equal((await noConsent.json()).error.code, 'consent_required');
    assert.equal((await post(ctx, ana.token, 'recordings', { kind: 'audio', mime: 'text/html', consent: true })).status, 400, 'only audio and video');

    const record = await recordOnce(ctx, ana.token);
    assert.equal(record.sessionId, ana.session().sessionId);
    assert.equal(record.source, 'client-track');
    assert.ok(record.startOffsetMs >= 0);
    assert.equal(record.uploadId, undefined, 'storage internals are not exposed');

    const done = await (await post(ctx, ana.token, `recordings/${record.id}/complete`, { parts: 3, durationMs: 15000 })).json();
    assert.equal(done.status, 'complete'); assert.equal(done.sizeBytes, 9); assert.equal(done.truncated, false); assert.equal(done.durationMs, 15000);
    const completed = events.find(e => e.type === 'recording.completed').data;
    assert.deepEqual([completed.recordingId, completed.sizeBytes, completed.userId], [record.id, 9, 'ana']);
    assert.deepEqual(Object.keys(completed).sort(), ['durationMs', 'kind', 'mime', 'recordingId', 'sessionId', 'sha256', 'sizeBytes', 'startOffsetMs', 'truncated', 'userId'], 'ids, sizes and offsets only: no content (R-AUD-1)');

    const { recordings } = await (await api(ctx, ana.token, 'recordings')).json();
    assert.equal(recordings.length, 1);
    const media = await fetch(`${ctx.http}${recordings[0].mediaUrl}`);                  //no Authorization header: the link is the proof
    assert.equal(await media.text(), 'aaabbbccc');
    assert.equal(media.headers.get('content-type'), 'audio/webm;codecs=opus');
    const slice = await fetch(`${ctx.http}${recordings[0].mediaUrl}`, { headers: { range: 'bytes=3-5' } });
    assert.equal(slice.status, 206); assert.equal(await slice.text(), 'bbb'); assert.equal(slice.headers.get('content-range'), 'bytes 3-5/9');
    const tail = await fetch(`${ctx.http}${recordings[0].mediaUrl}`, { headers: { range: 'bytes=-2' } });
    assert.equal(await tail.text(), 'cc');
    assert.equal((await fetch(`${ctx.http}${recordings[0].mediaUrl.replace(/sig=(.)/, (m, c) => `sig=${c === '0' ? '1' : '0'}`)}`)).status, 403, 'a forged link');
    assert.equal((await fetch(`${ctx.http}${recordings[0].mediaUrl}`, { headers: { range: 'bytes=99-120' } })).status, 416);
});

test('recordings: only the person records themselves; a viewer cannot; a piece cannot be added after the end; the wrong token is refused', async () => {
    const ctx = await start();
    const ana = await connect(ctx, { user: 'ana' }), bia = await connect(ctx, { user: 'bia' }), leitor = await connect(ctx, { user: 'leitor', role: 'viewer' }), dono = await connect(ctx, { user: 'dono', role: 'owner' });
    assert.equal((await post(ctx, leitor.token, 'recordings', { kind: 'audio', mime: 'audio/webm', consent: true })).status, 403);
    assert.equal((await api(ctx, 'not-a-token', 'recordings')).status, 401);
    const other = ctx.server.issueToken({ sub: 'ana', name: 'ana', workspace: 'other', role: 'owner' }, 60);
    assert.equal((await api(ctx, other, 'recordings')).status, 401, 'a token for another workspace');

    const record = await recordOnce(ctx, ana.token, { parts: ['x'] });
    assert.equal((await api(ctx, bia.token, `recordings/${record.id}/parts/1`, { method: 'PUT', body: 'y' })).status, 403, 'not their recording');
    assert.equal((await post(ctx, bia.token, `recordings/${record.id}/complete`, {})).status, 403);
    assert.equal((await post(ctx, dono.token, `recordings/${record.id}/complete`, {})).status, 200, 'the workspace owner may close it');
    assert.equal((await api(ctx, ana.token, `recordings/${record.id}/parts/1`, { method: 'PUT', body: 'z' })).status, 409, 'closed');
    assert.equal((await api(ctx, leitor.token, 'recordings')).status, 200, 'a viewer can see that recordings exist');
});

test('recordings: size limits, and one nobody finished (the tab died) is closed with what arrived, marked truncated', async () => {
    const ctx = await start({ maxPartBytes: 4, recordingIdleMs: 50, sweepEveryMs: 20 });
    const ana = await connect(ctx, { user: 'ana' });
    const record = await recordOnce(ctx, ana.token, { parts: ['abcd', 'efgh'] });
    assert.equal((await api(ctx, ana.token, `recordings/${record.id}/parts/2`, { method: 'PUT', body: 'too long' })).status, 413);
    assert.equal((await api(ctx, ana.token, `recordings/${record.id}/parts/3`, { method: 'PUT', body: '' })).status, 400);
    assert.ok(await until(async () => (await (await api(ctx, ana.token, 'recordings')).json()).recordings[0].status === 'complete'), 'the janitor closed it');
    const closed = (await (await api(ctx, ana.token, 'recordings')).json()).recordings[0];
    assert.equal(closed.truncated, true); assert.equal(closed.sizeBytes, 8);
});

test('transcript over HTTP: formats, filtered by call, and only for people in the workspace', async () => {
    const ctx = await start();
    const ana = await connect(ctx, { user: 'ana' });
    ana.join(); await until(() => ana.session());
    ana.say({ body: 'primeira', startedAt: Date.now() - 2000, durationMs: 900, language: 'pt' });
    await until(() => ana.segments.length === 1);
    const vtt = await api(ctx, ana.token, `transcript?format=vtt&session=${ana.session().sessionId}`);
    assert.equal(vtt.status, 200);
    assert.match(vtt.headers.get('content-type'), /text\/vtt/);
    assert.match(await vtt.text(), /^WEBVTT[\s\S]*<v ana>primeira/);
    const lines = (await (await api(ctx, ana.token, 'transcript')).text()).trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].language, 'pt');
    assert.equal((await api(ctx, ana.token, 'transcript?format=exe')).status, 400);
    assert.equal((await api(ctx, ana.token, 'transcript?session=00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await api(ctx, 'nope', 'transcript')).status, 401);
    const preflight = await fetch(`${ctx.http}/v1/workspaces/ws1/recordings`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
});

test('recordings: the files are on disk, the document is not touched, and a restart keeps the list', async () => {
    const dir = tempDir();
    const first = await start({ dataDir: dir });
    const ana = await connect(first, { user: 'ana' });
    const record = await recordOnce(first, ana.token, { parts: ['one', 'two'] });
    await post(first, ana.token, `recordings/${record.id}/complete`, { parts: 2 });
    await first.server.close();
    const second = await start({ dataDir: dir });
    const again = await connect(second, { user: 'ana' });
    const { recordings } = await (await api(second, again.token, 'recordings')).json();
    assert.equal(recordings.length, 1);
    assert.equal(await (await fetch(`${second.http}${recordings[0].mediaUrl}`)).text(), 'onetwo');
    assert.ok(readFileSync(join(dir, 'ws1.recordings.jsonl'), 'utf8').includes(record.id));
});

// ---- the browser app's own clients against the real server ----

test('end to end: the app\'s CallClient and Recorder against the server: the call has a session, the recording joins into the file, and the list carries it', async () => {
    const events = [];
    const ctx = await start({ events: { emit: (type, ws, data) => { events.push({ type, data }); }, close() {} } });
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    const call = new CallClient({ send: request => provider.sendCall(request) });
    const socket = url => { const s = new WebSocket(url); s.binaryType = 'arraybuffer'; const t = { onopen: null, onmessage: null, onclose: null, send: b => { if (s.readyState === 1) s.send(b); }, close: (c, r) => s.close(c, r) }; s.on('error', () => {}); s.on('open', () => t.onopen?.()); s.on('message', d => t.onmessage?.(new Uint8Array(d))); s.on('close', (c, r) => t.onclose?.({ code: c, reason: r.toString() })); return t; };
    const issue = () => ctx.server.issueToken({ sub: 'ana', name: 'ana', workspace: 'ws1', role: 'participant' }, 120);
    const provider = new SyncProvider({
        ydoc: doc.ydoc, awareness, minDelayMs: 30, maxDelayMs: 60,
        openTransport: async () => socket(`${ctx.ws}/ws1?token=${issue()}`),
        onStatus: status => { if (status === 'synced') call.onConnected(); },
        onControl: message => call.receive(message),
    });
    provider.connect();
    assert.ok(await until(() => provider.status === 'synced'));
    call.join();
    assert.ok(await until(() => call.sessionId), 'the server answered with the call');

    class Fake { constructor() { this.state = 'inactive'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fim']) }); this.onstop?.(); } cut(t) { this.ondataavailable?.({ data: new Blob([t]) }); } }
    let fake;
    const api = new RecordingApi({ baseUrl: ctx.http, workspaceId: 'ws1', session: async () => ({ token: issue() }) });
    const recorder = new Recorder({ api, partMs: 100, isTypeSupported: () => true, createMediaRecorder: () => (fake = new Fake()) });
    const record = await recorder.start({ stream: {}, consented: true });
    assert.equal(record.sessionId, call.sessionId, 'the recording says which call it belongs to');
    fake.cut('ola-'); fake.cut('mundo-');
    await recorder.stop();
    assert.ok(await until(async () => (await api.list())[0]?.status === 'complete'), 'joined on the server');
    const [done] = await api.list();
    assert.equal(await (await fetch(api.mediaUrl(done))).text(), 'ola-mundo-fim');
    assert.equal(done.userName, 'ana');
    assert.equal(await api.transcript('txt'), '', 'no transcript yet, and the request works');
    call.leave();
    assert.ok(await until(() => events.some(e => e.type === 'call.ended')));
    assert.deepEqual(events.map(e => e.type).filter(t => t.startsWith('call.') || t.startsWith('recording.')), ['call.started', 'recording.started', 'recording.completed', 'call.ended']);
    provider.destroy(); awareness.destroy();
});
