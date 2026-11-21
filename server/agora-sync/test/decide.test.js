//The decision-model relay: who may ask, what is validated, that nothing but the contract passes, and that the sentence is never logged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncServer } from '../src/server.js';
import { createDecide, validateQuestion, DecideError } from '../src/decide.js';

const SECRET = 'a-test-secret-that-is-long-enough-123456';
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

//A stand-in for server/agora-model: records what it was asked, answers `reply(body)` (or a status code)
const fakeModel = async reply => {
    const seen = [];
    const http = createServer((request, response) => {
        if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); return response.end('{"ok":true,"model":"fake-1"}'); }
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', async () => {
            seen.push({ auth: request.headers.authorization, body: JSON.parse(text) });
            const out = await reply(JSON.parse(text));
            if (typeof out === 'number') { response.writeHead(out); return response.end(); }
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(out));
        });
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => http.close(resolve)));
    return { url: `http://127.0.0.1:${http.address().port}`, seen };
};
const pick = id => body => ({ scores: body.options.map(o => ({ id: o.id, p: o.id === id ? 0.9 : 0.1 / (body.options.length - 1) })), ms: 12, model: 'fake-1' });

const start = async (options = {}) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agora-decide-'));
    const logs = [];
    const server = createSyncServer({ secret: SECRET, dataDir, log: line => logs.push(line), ...options });
    const port = await server.listen(0);
    cleanups.push(async () => { await server.close().catch(() => {}); rmSync(dataDir, { recursive: true, force: true }); });
    const token = (role = 'viewer', workspace = 'ws1', sub = 'ana') => server.issueToken({ sub, name: sub, workspace, role }, 120);
    const ask = (body, { tok = token(), workspace = 'ws1', method = 'POST' } = {}) => fetch(`http://127.0.0.1:${port}/v1/workspaces/${workspace}/decide`, {
        method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return { server, logs, token, ask };
};
const question = { options: [{ id: 'add', text: 'add: adicionar' }, { id: 'undo', text: 'undo: desfazer' }, { id: 'none', text: 'none: conversa' }], state: 'põe uma tabela aí' };

test('decide: relays the question to the model and returns its scores (any role may ask)', async () => {
    const model = await fakeModel(pick('add'));
    const { ask, token } = await start({ modelUrl: model.url, modelToken: 'secret-upstream' });
    for (const role of ['viewer', 'participant', 'owner']) {
        const response = await ask(question, { tok: token(role) });
        assert.equal(response.status, 200, role);
        const answer = await response.json();
        assert.equal(answer.scores.find(s => s.id === 'add').p, 0.9);
        assert.equal(answer.model, 'fake-1');
    }
    assert.equal(model.seen[0].auth, 'Bearer secret-upstream', 'the upstream token is the server\'s, never the browser\'s');
    assert.deepEqual(model.seen[0].body.options.map(o => o.id), ['add', 'undo', 'none']);
});

test('decide: needs a valid token for THIS workspace; answers 503 with no model, and tells the browser whether one is there', async () => {
    const none = await start();
    assert.equal((await none.ask(question)).status, 503);
    const probe = await none.ask(null, { method: 'GET' });
    assert.equal(probe.status, 200, 'asking WHETHER there is a model is not an error');
    assert.deepEqual(await probe.json(), { available: false });
    const model = await fakeModel(pick('add'));
    const { ask, token } = await start({ modelUrl: model.url });
    assert.equal((await ask(question, { tok: 'garbage' })).status, 401);
    assert.equal((await ask(question, { tok: token('owner', 'other') })).status, 401, 'a token of another workspace');
    assert.deepEqual(await (await ask(null, { method: 'GET' })).json(), { available: true, model: 'fake-1' });
});

test('decide: validates the question, and refuses what is not the contract', async () => {
    const model = await fakeModel(() => ({ scores: [{ id: 'invented', p: 1 }] }));
    const { ask } = await start({ modelUrl: model.url });
    for (const bad of [{ ...question, state: '' }, { ...question, state: 'x'.repeat(1001) }, { ...question, options: [question.options[0]] },
        { ...question, options: [question.options[0], question.options[0]] }, { options: question.options }, { ...question, options: [{ id: 'a' }, { id: 'b', text: 'b' }] }]) {
        assert.equal((await ask(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(model.seen.length, 0, 'a bad question never reaches the model');
    assert.equal((await ask(question)).status, 502, 'scores for options that were not asked');
    assert.throws(() => validateQuestion({ ...question, options: Array(41).fill(0).map((_, i) => ({ id: `o${i}`, text: 't' })) }), DecideError);
});

test('decide: limits how often a person asks, and survives a model that fails or is slow', async () => {
    const model = await fakeModel(pick('add'));
    const limited = await start({ modelUrl: model.url, modelPerMinute: 2 });
    assert.equal((await limited.ask(question)).status, 200);
    assert.equal((await limited.ask(question)).status, 200);
    assert.equal((await limited.ask(question)).status, 429);
    assert.equal((await limited.ask(question, { tok: limited.token('viewer', 'ws1', 'bia') })).status, 200, 'the limit is per person');
    const broken = await start({ modelUrl: (await fakeModel(() => 500)).url });
    assert.equal((await broken.ask(question)).status, 502);
    const slow = await start({ modelUrl: (await fakeModel(() => new Promise(resolve => setTimeout(() => resolve(pick('add')(question)), 400)))).url, modelTimeoutMs: 100 });
    assert.equal((await slow.ask(question)).status, 504);
    const down = await start({ modelUrl: 'http://127.0.0.1:1' });
    assert.equal((await down.ask(question)).status, 502);
});

test('decide: the sentence is forgotten: it appears in no log line', async () => {
    const model = await fakeModel(pick('add'));
    const { ask, logs } = await start({ modelUrl: model.url });
    await ask({ ...question, state: 'frase-secreta-do-usuario' });
    await ask({ ...question, state: 'frase-secreta-do-usuario', options: [question.options[0]] });         // the rejected one too
    assert.ok(logs.some(line => line.includes('decide:')), 'counts and timings are logged');
    assert.ok(!logs.some(line => line.includes('frase-secreta')), logs.join('\n'));
    const unit = createDecide({ url: model.url, fetchImpl: async () => { throw Object.assign(new Error('boom frase-secreta'), { name: 'TypeError' }); }, log: line => logs.push(line) });
    await assert.rejects(unit.choose({ sub: 'x' }, { ...question, state: 'frase-secreta' }), DecideError);
    assert.ok(!logs.some(line => line.includes('frase-secreta')), 'not even in error paths');
});

test('decide: a browser on another origin can call it (CORS preflight answers before any token is needed)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agora-decide-'));
    const server = createSyncServer({ secret: SECRET, dataDir });
    const port = await server.listen(0);
    cleanups.push(async () => { await server.close().catch(() => {}); rmSync(dataDir, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspaces/ws1/decide`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
});
