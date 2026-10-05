//Integration tests: the real server against the browser app's own SyncProvider and YjsWorkspaceDoc
//(the client code runs unchanged in Node), including clients that bypass the UI's own checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createSyncServer, CLOSE } from '../src/server.js';
import { issueToken, verifyToken, checkSecret } from '../src/auth.js';
import { YjsWorkspaceDoc } from '../../../collaboration/document/yjs_state_store.js';
import { YjsPresence } from '../../../collaboration/presence/presence.js';
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

const socketTransport = (url, token) => {
    const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    socket.binaryType = 'arraybuffer';
    const transport = { onopen: null, onmessage: null, onclose: null, send: bytes => { if (socket.readyState === 1) socket.send(bytes); }, close: (code, reason) => socket.close(code, reason) };
    socket.on('error', () => {});                                    //a refused connection is reported through onclose
    socket.on('open', () => transport.onopen?.());
    socket.on('message', data => transport.onmessage?.(new Uint8Array(data)));
    socket.on('close', (code, reason) => transport.onclose?.({ code, reason: reason.toString() }));
    return transport;
};

const connect = ({ server, url }, { workspace = 'ws1', user = 'maria', role = 'owner', token = null }) => {
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    doc.presence = new YjsPresence(awareness);
    doc.presence.setLocal({ user: { id: user, name: user } });
    const events = { control: [], statuses: [] };
    const provider = new SyncProvider({
        ydoc: doc.ydoc, awareness, minDelayMs: 30, maxDelayMs: 60,
        openTransport: async () => socketTransport(`${url}/${workspace}`, token ?? server.issueToken({ sub: user, name: user, workspace, role }, 60)),
        onStatus: status => events.statuses.push(status),
        onControl: message => events.control.push(message),
    });
    provider.connect();
    return { doc, provider, events, awareness, stop: () => { provider.destroy(); awareness.destroy(); } };
};
const synced = c => until(() => c.provider.status === 'synced');
const serverState = (ctx, workspace = 'ws1') => ctx.server.rooms.get(workspace)?.doc.getMap('instances').toJSON() ?? {};

test('two clients converge through the server, shared text included', async () => {
    const ctx = await startServer();
    const a = connect(ctx, { user: 'a' }), b = connect(ctx, { user: 'b' });
    await Promise.all([synced(a), synced(b)]);
    a.doc.set('instances.i1', { type: 'ultima-text', label: 'Texto' });
    a.doc.text('content.i1.text').setText('olá');
    assert.ok(await until(() => b.doc.get('instances.i1.label') === 'Texto' && b.doc.text('content.i1.text').getText() === 'olá'));
    a.stop(); b.stop();
});

test('auth: no token, a forged token, a token for another workspace and an expired token are all refused', async () => {
    const ctx = await startServer();
    const refusal = async token => {
        const t = socketTransport(`${ctx.url}/ws1`, token);
        return new Promise(resolve => { t.onclose = ({ code }) => resolve(code); });
    };
    assert.equal(await refusal(''), CLOSE.UNAUTHORIZED);
    assert.equal(await refusal(issueToken({ sub: 'x', workspace: 'ws1', role: 'owner' }, 'another-secret-another-secret-12345')), CLOSE.UNAUTHORIZED);
    assert.equal(await refusal(ctx.server.issueToken({ sub: 'x', workspace: 'other', role: 'owner' }, 60)), CLOSE.UNAUTHORIZED);
    assert.equal(await refusal(ctx.server.issueToken({ sub: 'x', workspace: 'ws1', role: 'owner' }, -5)), CLOSE.UNAUTHORIZED);
    const bad = socketTransport(`${ctx.url}/..%2Fetc`, ctx.server.issueToken({ sub: 'x', workspace: 'ws1', role: 'owner' }, 60));
    assert.equal(await new Promise(resolve => { bad.onclose = ({ code }) => resolve(code); }), CLOSE.BAD_REQUEST);
    assert.equal(ctx.server.connectionCount, 0);
});

test('auth: tokens carry exactly the claims that matter; a tampered payload fails the signature', () => {
    const token = issueToken({ sub: 'u', workspace: 'w', role: 'viewer' }, SECRET, 60);
    assert.equal(verifyToken(token, SECRET).role, 'viewer');
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'u', workspace: 'w', role: 'owner', exp: 9999999999 })).toString('base64url')}.${s}`;
    assert.throws(() => verifyToken(forged, SECRET), /bad signature/);
    assert.throws(() => issueToken({ sub: 'u', workspace: 'w', role: 'god' }, SECRET), /invalid role/);
});

test('a viewer that bypasses the UI cannot change the document: refused, closed, and nobody else sees it', async () => {
    const ctx = await startServer();
    const owner = connect(ctx, { user: 'owner' });
    await synced(owner);
    owner.doc.set('instances.i1', { label: 'original' });
    await until(() => serverState(ctx).i1);

    const viewer = connect(ctx, { user: 'v', role: 'viewer' });
    await synced(viewer);
    assert.equal(viewer.doc.get('instances.i1.label'), 'original', 'a viewer can read');
    await wait(300);
    assert.equal(viewer.provider.status, 'synced', 'a viewer stays connected: reading is allowed, the handshake is not a write');
    viewer.doc.set('instances.i1.label', 'vandalized');                                     //nothing in the client stops this write
    viewer.doc.set('instances.evil', { label: 'injected' });
    assert.ok(await until(() => viewer.provider.status === 'error'), 'the server must drop the connection');
    await wait(100);
    assert.equal(serverState(ctx).i1.label, 'original');
    assert.equal(serverState(ctx).evil, undefined);
    assert.equal(owner.doc.get('instances.i1.label'), 'original');
    assert.ok(viewer.events.control.some(m => m.type === 'closed' && m.code === CLOSE.FORBIDDEN));
    assert.ok(owner.doc.presence.peers().every(p => p.user.id !== 'v'), 'and its presence is gone');
    owner.stop(); viewer.stop();
});

test('a participant may edit authored content but not the composition', async () => {
    const ctx = await startServer();
    const owner = connect(ctx, { user: 'owner' });
    await synced(owner);
    owner.doc.set('instances.i1', { label: 'notes' });
    owner.doc.text('content.i1.text').setText('a');
    await until(() => serverState(ctx).i1);

    const guest = connect(ctx, { user: 'p', role: 'participant' });
    await synced(guest);
    guest.doc.text('content.i1.text').setText('a + guest');
    assert.ok(await until(() => owner.doc.text('content.i1.text').getText() === 'a + guest'), 'content edits go through');
    assert.equal(guest.provider.status, 'synced', 'still connected after a legitimate edit');

    guest.doc.set('instances.i1.label', 'renamed by a participant');
    assert.ok(await until(() => guest.provider.status === 'error'));
    await wait(100);
    assert.equal(serverState(ctx).i1.label, 'notes');
    owner.stop(); guest.stop();
});

test('a role change applies to the open connection at once, without reconnecting', async () => {
    const ctx = await startServer();
    const user = connect(ctx, { user: 'edit', role: 'editor' });
    await synced(user);
    user.doc.set('instances.i1', { label: 'ok while editor' });
    assert.ok(await until(() => serverState(ctx).i1));
    assert.ok(user.events.control.some(m => m.type === 'role' && m.role === 'editor'));

    assert.equal(ctx.server.setRole('ws1', 'edit', 'viewer'), true);
    assert.ok(await until(() => user.events.control.some(m => m.type === 'role' && m.role === 'viewer')), 'the client is told');
    await wait(200);
    assert.equal(user.provider.status, 'synced', 'demotion alone does not disconnect');
    user.doc.set('instances.i1.label', 'after demotion');
    assert.ok(await until(() => user.provider.status === 'error'));
    assert.equal(serverState(ctx).i1.label, 'ok while editor');
    assert.equal(ctx.server.setRole('ws1', 'nobody', 'viewer'), false);
    user.stop();
});

test('presence reaches the others and disappears when someone leaves', async () => {
    const ctx = await startServer();
    const a = connect(ctx, { user: 'a' }), b = connect(ctx, { user: 'b' });
    await Promise.all([synced(a), synced(b)]);
    a.doc.presence.setLocal({ focus: 'cmp-1' });
    assert.ok(await until(() => b.doc.presence.peers().some(p => p.user.id === 'a' && p.focus === 'cmp-1')));
    a.provider.disconnect();
    assert.ok(await until(() => b.doc.presence.peers().length === 0), 'the server announces the departure');
    a.stop(); b.stop();
});

test('documents persist across a server restart (atomic file per workspace)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agora-sync-'));
    try {
        const first = await startServer({ dataDir });
        const a = connect(first, { user: 'a' });
        await synced(a);
        a.doc.set('instances.i1', { label: 'sobrevive' });
        a.doc.text('content.i1.text').setText('texto salvo');
        await until(() => serverState(first).i1);
        a.stop();
        await first.server.close();

        const second = await startServer({ dataDir });
        const b = connect(second, { user: 'b' });
        await synced(b);
        assert.ok(await until(() => b.doc.get('instances.i1.label') === 'sobrevive' && b.doc.text('content.i1.text').getText() === 'texto salvo'));
        b.stop();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a client that goes offline keeps working locally and merges on reconnect', async () => {
    const ctx = await startServer();
    const a = connect(ctx, { user: 'a' }), b = connect(ctx, { user: 'b' });
    await Promise.all([synced(a), synced(b)]);
    a.doc.set('instances.i1', { config: { size: 1, mode: 'x' } });
    await until(() => b.doc.get('instances.i1'));

    //cut a's connection from the server side; a keeps editing
    for (const room of ctx.server.rooms.values()) for (const c of room.connections) if (c.userId === 'a') c.socket.terminate();
    assert.ok(await until(() => a.provider.status !== 'synced'));
    a.doc.set('instances.i1.config.size', 5);
    b.doc.set('instances.i1.config.mode', 'y');
    assert.ok(await until(() => a.provider.status === 'synced'), 'it reconnects by itself, with a fresh token');
    assert.ok(await until(() => a.doc.get('instances.i1.config.mode') === 'y' && b.doc.get('instances.i1.config.size') === 5));
    a.stop(); b.stop();
});

test('oversized messages are refused', async () => {
    const ctx = await startServer({ maxMessageBytes: 2048 });
    const a = connect(ctx, { user: 'a' });
    await synced(a);
    a.doc.set('instances.big', { blob: 'x'.repeat(10_000) });
    assert.ok(await until(() => a.events.statuses.at(-1) !== 'synced'));
    assert.equal(serverState(ctx).big, undefined);
    a.stop();
});

test('configuration: a weak secret is refused unless dev auth is on; dev endpoints do not exist in production', async () => {
    assert.throws(() => checkSecret('short', false), /at least 32/);
    assert.throws(() => checkSecret(undefined, false), /at least 32/);
    assert.ok(checkSecret(undefined, true));
    const prod = await startServer();
    const port = prod.url.split(':').at(-1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/dev/token`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);

    const dev = await startServer({ devAuth: true, secret: undefined });
    const devPort = dev.url.split(':').at(-1);
    const issued = await (await fetch(`http://127.0.0.1:${devPort}/dev/token`, { method: 'POST', body: JSON.stringify({ workspace: 'ws1', user: { id: 'u', name: 'U' }, role: 'viewer' }) })).json();
    assert.equal(issued.role, 'viewer');
    assert.equal((await fetch(`http://127.0.0.1:${devPort}/dev/token`, { method: 'POST', body: JSON.stringify({ workspace: '../x', user: { id: 'u' } }) })).status, 400);
});
