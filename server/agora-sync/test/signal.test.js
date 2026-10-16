//Conference signalling relay: the real server against the browser app's own SyncProvider (they run unchanged in Node).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createSyncServer } from '../src/server.js';
import { YjsWorkspaceDoc } from '../../../collaboration/document/yjs_state_store.js';
import { SyncProvider } from '../../../collaboration/providers/sync_provider.js';
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

const person = (ctx, { user, role = 'participant', workspace = 'ws1' }) => {
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    awareness.setLocalState({ user: { id: user, name: user } });
    const signals = [], controls = [];
    const provider = new SyncProvider({
        ydoc: doc.ydoc, awareness, minDelayMs: 30, maxDelayMs: 60,
        openTransport: async () => transport(`${ctx.url}/${workspace}`, ctx.server.issueToken({ sub: user, name: user, workspace, role }, 60)),
        onControl: message => controls.push(message),
        onSignal: event => signals.push(event),
    });
    provider.connect();
    return { id: doc.ydoc.clientID, provider, signals, controls, awareness, stop: () => { provider.destroy(); awareness.destroy(); } };
};
const ready = p => until(() => p.provider.status === 'synced');

test('signal: reaches only the addressed peer, stamped with the sender (id taken from the token, not from the message)', async () => {
    const ctx = await startServer();
    const [ana, bia, caio] = ['ana', 'bia', 'caio'].map(user => person(ctx, { user }));
    await Promise.all([ana, bia, caio].map(ready));
    await wait(100);                                        // the server learns each client id from its first awareness message
    assert.ok(ana.provider.sendSignal({ to: bia.id, from: ana.id, data: { sdp: 'offer' } }));
    assert.ok(await until(() => bia.signals.length === 1));
    assert.deepEqual(bia.signals[0], { type: 'signal', from: ana.id, user: { id: 'ana', name: 'ana' }, data: { sdp: 'offer' } });
    await wait(100);
    assert.equal(caio.signals.length, 0, 'a third person never sees it');
    assert.equal(ana.signals.length, 0);
    [ana, bia, caio].forEach(p => p.stop());
});

test('signal: cannot speak as someone else, nor reach another workspace, nor oneself', async () => {
    const ctx = await startServer();
    const ana = person(ctx, { user: 'ana' }), bia = person(ctx, { user: 'bia' }), outro = person(ctx, { user: 'outro', workspace: 'ws2' });
    await Promise.all([ana, bia, outro].map(ready));
    await wait(100);
    ana.provider.sendSignal({ to: bia.id, from: outro.id, data: 'forged' });          // another person's client id as the sender
    ana.provider.sendSignal({ to: outro.id, from: ana.id, data: 'cross-workspace' });
    ana.provider.sendSignal({ to: ana.id, from: ana.id, data: 'self' });
    assert.ok(await until(() => ana.signals.length === 3));
    assert.ok(ana.signals.every(s => s.type === 'error'));
    assert.deepEqual(ana.signals.map(s => s.code), ['bad_request', 'gone', 'gone']);
    await wait(50);
    assert.equal(bia.signals.length, 0);
    assert.equal(outro.signals.length, 0);
    [ana, bia, outro].forEach(p => p.stop());
});

test('signal: oversized and malformed messages are answered with an error and do not drop the connection', async () => {
    const ctx = await startServer();
    const ana = person(ctx, { user: 'ana' }), bia = person(ctx, { user: 'bia' });
    await Promise.all([ana, bia].map(ready));
    await wait(100);
    ana.provider.sendSignal({ to: bia.id, from: ana.id, data: 'x'.repeat(40_000) });
    assert.ok(await until(() => ana.signals.some(s => s.code === 'too_big')));
    ana.provider.sendSignal({ to: bia.id, from: ana.id, data: 'ok' });
    assert.ok(await until(() => bia.signals.length === 1), 'still connected and relaying');
    [ana, bia].forEach(p => p.stop());
});

test('signal: viewers can signal (to listen), and the ICE servers of the operator reach every client', async () => {
    const iceServers = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];
    const ctx = await startServer({ iceServers });
    const ana = person(ctx, { user: 'ana' }), leitor = person(ctx, { user: 'leitor', role: 'viewer' });
    await Promise.all([ana, leitor].map(ready));
    await wait(100);
    assert.deepEqual(leitor.controls.find(c => c.type === 'ice')?.iceServers, iceServers);
    leitor.provider.sendSignal({ to: ana.id, from: leitor.id, data: 'hi' });
    assert.ok(await until(() => ana.signals.length === 1));
    [ana, leitor].forEach(p => p.stop());
});
