//Chat, end to end: the real server against the browser app's own SyncProvider and ChatClient (they run unchanged in Node).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createSyncServer } from '../src/server.js';
import { ChatLog, mentionsIn, MAX_BODY } from '../src/chat.js';
import { YjsWorkspaceDoc } from '../../../collaboration/document/yjs_state_store.js';
import { SyncProvider } from '../../../collaboration/providers/sync_provider.js';
import { ChatClient } from '../../../collaboration/providers/chat_client.js';
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

//A person: a document, a provider and a chat client wired like the app does it
const person = (ctx, { user = 'maria', name = null, role = 'participant', workspace = 'ws1' } = {}) => {
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    const me = { id: user, name: name ?? user };
    let provider;
    const chat = new ChatClient({ workspaceId: workspace, me, send: request => provider.sendChat(request), canWrite: () => doc.role !== 'viewer' });
    provider = new SyncProvider({
        ydoc: doc.ydoc, awareness, minDelayMs: 30, maxDelayMs: 60,
        openTransport: async () => transport(`${ctx.url}/${workspace}`, ctx.server.issueToken({ sub: user, name: me.name, workspace, role }, 60)),
        onStatus: status => { if (status === 'synced') chat.onConnected(); },
        onControl: message => { if (message.type === 'role') doc.role = message.role; },
        onChat: event => chat.receive(event),
    });
    provider.connect();
    return { doc, provider, chat, me, stop: () => { provider.destroy(); awareness.destroy(); } };
};
const ready = p => until(() => p.provider.status === 'synced');
const bodies = p => p.chat.messages.filter(m => !m.pending).map(m => m.body);

test('chat: a message reaches everyone in real time, with the author taken from the token', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a', name: 'Alice' }), b = person(ctx, { user: 'b', name: 'Bruno' });
    await Promise.all([ready(a), ready(b)]);
    a.chat.send('Olá, **pessoal**');
    assert.ok(await until(() => bodies(b).length === 1 && bodies(a).length === 1));
    const message = b.chat.messages[0];
    assert.equal(message.body, 'Olá, **pessoal**');
    assert.deepEqual(message.author, { id: 'a', name: 'Alice' });
    assert.ok(message.seq === 1 && message.id && message.createdAt);
    a.stop(); b.stop();
});

test('chat: the client cannot choose who it is (a forged author is ignored)', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a', name: 'Alice' });
    await ready(a);
    a.provider.sendChat({ type: 'send', clientId: 'forged-1', body: 'oi', author: { id: 'owner', name: 'Dono' } });
    assert.ok(await until(() => a.chat.messages.some(m => m.body === 'oi')));
    assert.equal(a.chat.messages.find(m => m.body === 'oi').author.id, 'a');
    a.stop();
});

test('chat: a person who joins later receives the history, and it survives a server restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agora-chat-'));
    try {
        const first = await startServer({ dataDir: dir });
        const a = person(first, { user: 'a' });
        await ready(a);
        a.chat.send('primeira'); a.chat.send('segunda');
        await until(() => bodies(a).length === 2);
        a.stop();
        await first.server.close();

        const second = await startServer({ dataDir: dir });
        const late = person(second, { user: 'z' });
        await ready(late);
        assert.ok(await until(() => bodies(late).join('|') === 'primeira|segunda'), bodies(late).join('|'));
        late.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chat: a viewer reads but cannot write, edit or delete; the refusal is explained and nothing changes', async () => {
    const ctx = await startServer();
    const writer = person(ctx, { user: 'w', role: 'editor' });
    const viewer = person(ctx, { user: 'v', role: 'viewer' });
    await Promise.all([ready(writer), ready(viewer)]);
    writer.chat.send('só leitura para quem vê');
    assert.ok(await until(() => bodies(viewer).length === 1), 'a viewer reads');

    assert.equal(viewer.chat.canWrite, false);
    assert.throws(() => viewer.chat.send('não deveria'), /só permite ler/);
    //a tampered client skips its own check
    viewer.provider.sendChat({ type: 'send', clientId: 'x1', body: 'forjada' });
    viewer.provider.sendChat({ type: 'edit', id: viewer.chat.messages[0].id, body: 'adulterada' });
    viewer.provider.sendChat({ type: 'delete', id: viewer.chat.messages[0].id });
    await wait(200);
    assert.deepEqual(bodies(writer), ['só leitura para quem vê']);
    assert.equal(writer.chat.messages[0].deletedAt, undefined);
    writer.stop(); viewer.stop();
});

test('chat: only the author edits; the author or the workspace owner delete; the text is redacted for good', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agora-chat-'));
    try {
        const ctx = await startServer({ dataDir: dir });
        const owner = person(ctx, { user: 'o', role: 'owner' });
        const guest = person(ctx, { user: 'g', role: 'participant' });
        const other = person(ctx, { user: 'p', role: 'participant' });
        await Promise.all([ready(owner), ready(guest), ready(other)]);
        guest.chat.send('versão um');
        await until(() => bodies(owner).length === 1);
        const onDisk = () => readFileSync(join(dir, 'ws1.chat.jsonl'), 'utf8');
        assert.ok(onDisk().includes('versão um'), 'sanity: the text is in the log before the deletion');
        const id = owner.chat.messages[0].id;

        guest.chat.edit(id, 'versão dois');
        assert.ok(await until(() => owner.chat.messages[0].body === 'versão dois' && owner.chat.messages[0].editedAt));
        owner.chat.edit(id, 'o dono não edita o texto de outra pessoa');
        other.chat.edit(id, 'nem outro participante');
        await wait(150);
        assert.equal(guest.chat.messages[0].body, 'versão dois');

        other.chat.remove(id);
        await wait(150);
        assert.equal(owner.chat.messages[0].deletedAt, undefined, 'a participant cannot delete someone else\'s message');

        owner.chat.remove(id);                                                  // moderation
        assert.ok(await until(() => guest.chat.messages[0].deletedAt));
        assert.equal(guest.chat.messages[0].body, '');
        assert.ok(!onDisk().includes('versão um') && !onDisk().includes('versão dois'), 'neither the original nor the edited text remains on disk');
        assert.ok(onDisk().includes('deletedAt'), 'the tombstone does');
        owner.stop(); guest.stop(); other.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chat: sending is idempotent: a retry with the same clientId never repeats the message', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a' }), b = person(ctx, { user: 'b' });
    await Promise.all([ready(a), ready(b)]);
    for (let i = 0; i < 3; i++) a.provider.sendChat({ type: 'send', clientId: 'same-id', body: 'uma vez só' });
    await wait(300);
    assert.deepEqual(bodies(b), ['uma vez só']);
    assert.deepEqual(bodies(a), ['uma vez só']);
    a.stop(); b.stop();
});

test('chat: limits: empty, too long, and a flood are refused with a reason', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a' });
    await ready(a);
    const errors = [];
    const original = a.chat.receive.bind(a.chat);
    a.chat.receive = event => { if (event.type === 'error') errors.push(event.code); original(event); };
    a.provider.sendChat({ type: 'send', clientId: 'e1', body: '   ' });
    a.provider.sendChat({ type: 'send', clientId: 'e2', body: 'x'.repeat(MAX_BODY + 1) });
    assert.ok(await until(() => errors.includes('empty') && errors.includes('too_long')));
    for (let i = 0; i < 30; i++) a.provider.sendChat({ type: 'send', clientId: `f${i}`, body: `m${i}` });
    assert.ok(await until(() => errors.includes('rate')), 'a flood is throttled');
    assert.ok(bodies(a).length <= 20, `only ${bodies(a).length} got through`);
    a.stop();
});

test('chat: a role change in session applies to the next message', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a', role: 'editor' });
    await ready(a);
    a.chat.send('antes');
    await until(() => bodies(a).length === 1);
    ctx.server.setRole('ws1', 'a', 'viewer');
    await until(() => a.doc.role === 'viewer');
    a.provider.sendChat({ type: 'send', clientId: 'late', body: 'depois do rebaixamento' });
    await wait(200);
    assert.deepEqual(bodies(a), ['antes']);
    a.stop();
});

test('chat: offline messages wait in the outbox, keep their order, and go out once when the connection returns', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a' }), b = person(ctx, { user: 'b' });
    await Promise.all([ready(a), ready(b)]);
    for (const room of ctx.server.rooms.values()) for (const c of room.connections) if (c.userId === 'a') c.socket.terminate();
    await until(() => a.provider.status !== 'synced');
    a.chat.send('escrita offline 1');
    a.chat.send('escrita offline 2');
    assert.deepEqual(a.chat.messages.map(m => m.pending), ['pending', 'pending'], 'shown as pending');
    assert.ok(await until(() => a.provider.status === 'synced'));
    assert.ok(await until(() => bodies(b).length === 2));
    assert.deepEqual(bodies(b), ['escrita offline 1', 'escrita offline 2']);
    assert.ok(await until(() => a.chat.messages.every(m => !m.pending)), 'the pending copies become confirmed ones, not duplicates');
    assert.equal(a.chat.messages.length, 2);
    a.stop(); b.stop();
});

test('chat: mentions are recognised, and unread counts track what others wrote since you last read', async () => {
    assert.deepEqual(mentionsIn('oi @Maria e @maria.silva, veja (@João) e email a@b.com'), ['maria', 'maria.silva', 'joão']);
    const ctx = await startServer();
    const a = person(ctx, { user: 'a', name: 'Alice Souza' }), b = person(ctx, { user: 'b', name: 'Bruno' });
    await Promise.all([ready(a), ready(b)]);
    b.chat.send('bom dia');
    b.chat.send('@alice veja isto');
    b.chat.send('@bruno é comigo');
    await until(() => bodies(a).length === 3);
    assert.equal(a.chat.unread, 3);
    assert.equal(a.chat.unreadMentions, 1, 'only the message that mentions Alice');
    a.chat.markRead();
    assert.equal(a.chat.unread, 0);
    a.chat.send('minha própria mensagem');
    await until(() => bodies(a).length === 4);
    assert.equal(a.chat.unread, 0, 'your own messages are never unread');
    a.stop(); b.stop();
});

test('chat history: paging back through older messages', async () => {
    const ctx = await startServer();
    const a = person(ctx, { user: 'a' });
    await ready(a);
    const log = ctx.server.rooms.get('ws1').chat;
    for (let i = 1; i <= 130; i++) log.add({ id: 'seed', name: 'Seed' }, { body: `m${i}`, clientId: `s${i}` });
    a.provider.sendChat({ type: 'history', limit: 50 });
    assert.ok(await until(() => a.chat.messages.length >= 50));
    assert.equal(a.chat.messages.at(-1).body, 'm130');
    assert.equal(a.chat.hasMore, true);
    assert.ok(a.chat.loadOlder());
    assert.ok(await until(() => a.chat.messages.length >= 100));
    a.stop();
});

test('chat log: retention drops old messages and compacts the file; a torn last line does not lose the history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agora-chat-'));
    try {
        const file = join(dir, 'c.jsonl');
        let now = Date.parse('2026-01-01T00:00:00Z');
        const log = new ChatLog({ file, now: () => now });
        log.add({ id: 'a', name: 'A' }, { body: 'antiga', clientId: '1' });
        now += 40 * 86_400_000;
        log.add({ id: 'a', name: 'A' }, { body: 'recente', clientId: '2' });
        appendFileSync(file, '{"t":"msg","m":{"broken');                        // a crash in the middle of a write
        const reopened = new ChatLog({ file, now: () => now });
        assert.equal(reopened.size, 2, 'the torn line is skipped, the rest is kept');
        const pruned = new ChatLog({ file, retentionDays: 30, now: () => now });
        assert.deepEqual(pruned.page().messages.map(m => m.body), ['recente']);
        assert.equal(new ChatLog({ file, now: () => now }).size, 1, 'and the file was compacted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
