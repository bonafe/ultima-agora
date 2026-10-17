//Call transcript, end to end: the real server against the browser app's own SyncProvider and TranscriptClient (D-37).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createSyncServer } from '../src/server.js';
import { YjsWorkspaceDoc } from '../../../collaboration/document/yjs_state_store.js';
import { SyncProvider } from '../../../collaboration/providers/sync_provider.js';
import { TranscriptClient } from '../../../collaboration/providers/transcript_client.js';
import { awarenessProtocol } from '../../../vendor/yjs/yjs.js';

const SECRET = 'a-test-secret-that-is-long-enough-123456';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await condition()) return true; await wait(15); } return false; };

const openServers = [];
const startServer = async (options = {}) => {
    const server = createSyncServer({ secret: SECRET, ...options });
    const port = await server.listen(0);
    openServers.push(server);
    return { server, url: `ws://127.0.0.1:${port}` };
};
after(async () => { for (const server of openServers) await server.close().catch(() => {}); });

const transport = (url, token) => {
    const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    socket.binaryType = 'arraybuffer';
    const t = { onopen: null, onmessage: null, onclose: null, send: b => { if (socket.readyState === 1) socket.send(b); }, close: (c, r) => socket.close(c, r) };
    socket.on('error', () => {});
    socket.on('open', () => t.onopen?.());
    socket.on('message', d => t.onmessage?.(new Uint8Array(d)));
    socket.on('close', (c, r) => t.onclose?.({ code: c, reason: r.toString() }));
    return t;
};

const person = (ctx, { user, name = null, role = 'participant', workspace = 'ws1' }) => {
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    let provider;
    const transcript = new TranscriptClient({ me: { id: user, name: name ?? user }, send: request => provider.sendTranscript(request), canWrite: () => role !== 'viewer' });
    provider = new SyncProvider({
        ydoc: doc.ydoc, awareness, minDelayMs: 30, maxDelayMs: 60,
        openTransport: async () => transport(`${ctx.url}/${workspace}`, ctx.server.issueToken({ sub: user, name: name ?? user, workspace, role }, 60)),
        onStatus: status => { if (status === 'synced') transcript.onConnected(); },
        onTranscript: event => transcript.receive(event),
    });
    provider.connect();
    return { provider, transcript, stop: () => { provider.destroy(); awareness.destroy(); } };
};
const ready = p => until(() => p.provider.status === 'synced');
const bodies = p => p.transcript.segments.filter(s => !s.pending).map(s => `${s.author.id}: ${s.body}`);

test('transcript: what a person says reaches everyone, with the author taken from the token', async () => {
    const ctx = await startServer();
    const [ana, bia, leitor] = [person(ctx, { user: 'ana', name: 'Ana' }), person(ctx, { user: 'bia' }), person(ctx, { user: 'leitor', role: 'viewer' })];
    await Promise.all([ana, bia, leitor].map(ready));
    ana.transcript.send('bom dia a todos');
    assert.ok(await until(() => [ana, bia, leitor].every(p => bodies(p).length === 1)));
    assert.deepEqual(bodies(bia), ['ana: bom dia a todos']);
    assert.equal(bia.transcript.segments[0].author.name, 'Ana');
    assert.equal(ana.transcript.pending, 0, 'the sender sees it confirmed, not duplicated');
    [ana, bia, leitor].forEach(p => p.stop());
});

test('transcript: a viewer reads but cannot write; a refused segment is answered, not swallowed', async () => {
    const ctx = await startServer();
    const ana = person(ctx, { user: 'ana' });
    const leitor = person(ctx, { user: 'leitor', role: 'viewer' });
    await Promise.all([ana, leitor].map(ready));
    // the viewer's own client refuses; a client that bypasses it is refused by the server
    leitor.provider.sendTranscript({ type: 'send', clientId: 'x1', body: 'não deveria entrar' });
    assert.ok(await until(() => leitor.transcript.lastError?.includes('papel')));
    await wait(100);
    assert.deepEqual(bodies(ana), []);
    [ana, leitor].forEach(p => p.stop());
});

test('transcript: history for a late joiner, idempotent resend by clientId, and persistence across a server restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agora-transcript-'));
    try {
        let ctx = await startServer({ dataDir: dir });
        let ana = person(ctx, { user: 'ana' });
        await ready(ana);
        ana.transcript.send('primeiro');
        ana.transcript.send('segundo');
        assert.ok(await until(() => bodies(ana).length === 2));
        ana.provider.sendTranscript({ type: 'send', clientId: ana.transcript.segments[0].clientId, body: 'primeiro' });         // a retry after a flaky network
        await wait(100);
        assert.equal(bodies(ana).length, 2, 'the same clientId is the same segment');
        const bia = person(ctx, { user: 'bia' });
        await ready(bia);
        assert.ok(await until(() => bodies(bia).length === 2), 'a late joiner gets the history');
        [ana, bia].forEach(p => p.stop());
        await ctx.server.close();

        ctx = await startServer({ dataDir: dir });
        ana = person(ctx, { user: 'ana' });
        await ready(ana);
        assert.ok(await until(() => bodies(ana).length === 2), 'survived the restart');
        assert.deepEqual(bodies(ana), ['ana: primeiro', 'ana: segundo']);
        ana.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('transcript: bursts are rate limited', async () => {
    const ctx = await startServer();
    const ana = person(ctx, { user: 'ana' });
    await ready(ana);
    for (let i = 0; i < 40; i++) ana.provider.sendTranscript({ type: 'send', clientId: `burst${i}`, body: `trecho ${i}` });
    assert.ok(await until(() => ana.transcript.lastError?.includes('em pouco tempo')));
    assert.ok(bodies(ana).length <= 30, `${bodies(ana).length} accepted`);
    ana.stop();
});
