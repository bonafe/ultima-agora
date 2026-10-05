import { ReactiveComponent } from '../vendor/ultima/reactive_component.js';
import { mix } from '../core/components/mix.js';
import { AgoraComponent } from '../core/components/agora_component.js';
import { validateManifest, validateConfig } from '../core/registry/manifest.js';
import { ComponentRegistry } from '../core/registry/component_registry.js';
import { MemoryStateStore } from '../collaboration/document/memory_state_store.js';

//Zero-dependency test runner (same shape as the UltimaJS one): each test throws (via assert) on failure.

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (condition, message = 'assertion failed') => { if (!condition) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const settleOrTimeout = (promise, ms = 2000) => Promise.race([promise.then(() => true), wait(ms).then(() => false)]);
const throws = (fn, fragment) => {
    try { fn(); } catch (error) { assert(!fragment || error.message.includes(fragment), `wrong error: ${error.message}`); return; }
    throw new Error('expected an exception');
};

const baseManifest = (overrides = {}) => ({
    name: 'test-widget', tag: 'test-widget', title: 'Widget', version: '1.0.0', module: './widget.js', ...overrides,
});

// --- mix ---

test('mix applies mixins in order and keeps ReactiveComponent state working', async () => {
    const A = Base => class extends Base { a() { return 'a'; } };
    const B = Base => class extends Base { b() { return this.a() + 'b'; } };
    class Mixed extends mix(ReactiveComponent).with(A, B) {
        constructor() { super({ templateUrl: 'fixtures/basic.html', shadowDom: false }, import.meta.url); }
    }
    customElements.define('t-mixed', Mixed);
    const element = document.createElement('t-mixed');
    document.body.append(element);
    assert(await settleOrTimeout(element.whenLoaded()), 'never loaded');
    element.state = { x: 1 };
    assert(element.state.x === 1 && element.b() === 'ab');
});

test('mix rejects a mixin that is not a class factory', () => {
    throws(() => mix(HTMLElement).with(42), 'must be a function');
    throws(() => mix(HTMLElement).with(() => 1), 'must return a subclass');
});

// --- manifest ---

test('a minimal manifest is valid', () => {
    assert(validateManifest(baseManifest()).length === 0);
});

test('manifest errors name the offending field', () => {
    const errors = validateManifest(baseManifest({
        name: 'NoHyphen', version: '1',
        inputs: { entities: {} },
        actions: { go: { title: 'Go', effect: 'create' } },
        config: { mode: { type: 'enum' } },
        capabilities: ['teleport'],
    }));
    for (const field of ['name:', 'version:', 'inputs.entities:', 'actions.go.produces:', 'config.mode.values:', 'capabilities:']) {
        assert(errors.some(e => e.startsWith(field)), `no error for ${field}: ${errors.join(' | ')}`);
    }
});

test('config values are checked against the manifest schema', () => {
    const manifest = baseManifest({ config: { depth: { type: 'integer', min: 1, max: 5 }, layout: { type: 'enum', values: ['force', 'tree'] } } });
    assert(validateConfig(manifest, { depth: 2, layout: 'tree' }).length === 0);
    assert(validateConfig(manifest, { depth: 9 }).length === 1);
    assert(validateConfig(manifest, { depth: 1.5 }).length === 1);
    assert(validateConfig(manifest, { layout: 'radial' }).length === 1);
    assert(validateConfig(manifest, { unknown: 1 }).length === 1);
});

// --- registry ---

const loader = () => async () => ({ default: class extends AgoraComponent { constructor() { super({ templateUrl: 'fixtures/basic.html', shadowDom: false }, import.meta.url); } } });

test('registry rejects an invalid manifest with the field in the message', () => {
    const registry = new ComponentRegistry();
    throws(() => registry.register({ manifest: baseManifest({ version: 'x' }), load: loader() }), 'version');
});

test('registry refuses duplicates unless replaces names the current version', () => {
    const registry = new ComponentRegistry();
    registry.register({ manifest: baseManifest(), load: loader() });
    throws(() => registry.register({ manifest: baseManifest(), load: loader() }), 'already registered');
    registry.register({ manifest: baseManifest({ version: '1.1.0' }), load: loader(), replaces: '1.0.0' });
    assert(registry.getManifest('test-widget').version === '1.1.0');
});

test('registry lists by category and search without loading component code', () => {
    const registry = new ComponentRegistry();
    let loaded = 0;
    const counting = () => async () => { loaded++; return loader()(); };
    registry.register({ manifest: baseManifest({ name: 'test-graph', tag: 'test-graph', title: 'Grafo', category: 'viz', description: 'Network' }), load: counting() });
    registry.register({ manifest: baseManifest({ name: 'test-notes', tag: 'test-notes', title: 'Notas', category: 'text' }), load: counting() });
    assert(registry.list().length === 2 && registry.list({ category: 'viz' }).length === 1);
    assert(registry.list({ search: 'network' })[0].name === 'test-graph');
    assert(loaded === 0, 'listing must not load component code');
});

test('registry finds components by port type', () => {
    const registry = new ComponentRegistry();
    registry.register({ manifest: baseManifest({ name: 'test-in', tag: 'test-in', inputs: { e: { type: 'Entity' } } }), load: loader() });
    registry.register({ manifest: baseManifest({ name: 'test-out', tag: 'test-out', outputs: { e: { type: 'Entity' } } }), load: loader() });
    assert(registry.typesAccepting('Entity')[0].name === 'test-in');
    assert(registry.typesProducing('Entity')[0].name === 'test-out');
});

test('registry load() defines the custom element once', async () => {
    const registry = new ComponentRegistry();
    registry.register({ manifest: baseManifest({ name: 'test-lazy', tag: 'test-lazy' }), load: loader() });
    const first = await registry.load('test-lazy');
    assert(customElements.get('test-lazy') === first && (await registry.load('test-lazy')) === first);
});

// --- AgoraComponent ---

let counter = 0;
const create = async (manifestOverrides, { config, services, attach = true } = {}) => {
    const registry = new ComponentRegistry();
    const tag = `t-agora-${++counter}`;
    const manifest = baseManifest({ name: tag, tag, ...manifestOverrides });
    registry.register({ manifest, load: loader() });
    await registry.load(tag);
    const element = document.createElement(tag);
    if (attach) element.attach({ instanceId: `cmp-${counter}`, manifest, config, services });
    return { element, manifest };
};
const mountAndLoad = async element => {
    document.body.append(element);
    assert(await settleOrTimeout(element.whenLoaded()), 'never loaded');
};

test('attach applies manifest defaults and the config is read-only', async () => {
    const { element } = await create({ config: { depth: { type: 'integer', default: 2 } } }, { config: {} });
    assert(element.config.depth === 2 && element.instanceId.startsWith('cmp-'));
    throws(() => { 'use strict'; element.config.depth = 3; });
});

test('using a component before attach() fails clearly', async () => {
    const { element } = await create({}, { attach: false });
    throws(() => element.config, 'before attach()');
});

test('a capability that the manifest does not declare is refused with its name', async () => {
    const { element } = await create({ capabilities: ['connectable'] });
    throws(() => element.shared, '"shared-content"');
    throws(() => element.domain, '"domain-data"');
});

test('a declared capability exposes the injected service', async () => {
    const shared = { marker: true };
    const { element } = await create({ capabilities: ['shared-content'] }, { services: { shared } });
    assert(element.shared === shared);
});

test('emit only publishes ports declared as outputs', async () => {
    const sent = [];
    const { element } = await create({ capabilities: ['connectable'], outputs: { picked: { type: 'String' } } }, { services: { emit: (port, value) => sent.push([port, value]), ports: {} } });
    element.emit('picked', 'x');
    element.emit('undeclared', 'y');
    assert(sent.length === 1 && sent[0][0] === 'picked');
});

test('inputs that arrive before load are delivered after onLoad, last value per port', async () => {
    const { element } = await create({ capabilities: ['connectable'], inputs: { entity: { type: 'Entity' } } });
    const received = [];
    element.onInput = (port, value) => received.push([port, value]);
    element.deliverInput('entity', 1);
    element.deliverInput('entity', 2);
    assert(received.length === 0, 'delivered before load');
    await mountAndLoad(element);
    assert(received.length === 1 && received[0][1] === 2, JSON.stringify(received));
    element.deliverInput('entity', 3);
    assert(received.length === 2 && received[1][1] === 3);
});

test('an exception in onInput does not break delivery to the component', async () => {
    const { element } = await create({ capabilities: ['connectable'], inputs: { entity: { type: 'Entity' } } });
    await mountAndLoad(element);
    element.onInput = () => { throw new Error('boom'); };
    element.deliverInput('entity', 1);
    assert(element.isConnected);
});

test('invokeAction rejects actions missing from the manifest', async () => {
    const { element } = await create({ actions: { center: { title: 'Center', effect: 'self' } } });
    let called = null;
    element.onAction = (name, args) => { called = [name, args]; return 'ok'; };
    assert(element.invokeAction('center', 7) === 'ok' && called[1] === 7);
    throws(() => element.invokeAction('nope'), 'unknown action');
});

test('onDispose runs when the element is removed', async () => {
    const { element } = await create({});
    await mountAndLoad(element);
    let disposed = 0;
    element.onDispose = () => disposed++;
    element.remove();
    assert(disposed === 1);
});

// --- MemoryStateStore ---

const openDoc = async () => (await new MemoryStateStore().open('w1'));

test('doc get/set by path returns copies, not live references', async () => {
    const doc = await openDoc();
    doc.set('instances.a.config', { depth: 2 });
    const config = doc.get('instances.a.config');
    config.depth = 99;
    assert(doc.get('instances.a.config.depth') === 2 && doc.get('instances.zzz') === undefined);
});

test('onChange fires for changes at, under and above the watched path', async () => {
    const doc = await openDoc();
    const seen = [];
    doc.onChange('instances.a', path => seen.push(path));
    doc.set('instances.a.config.depth', 1);
    doc.set('instances.b.config.depth', 1);
    doc.set('instances', {});
    assert(seen.length === 2, JSON.stringify(seen));
});

test('transact groups changes into one undo/redo step', async () => {
    const doc = await openDoc();
    doc.transact('create', () => { doc.set('instances.a', { type: 'x' }); doc.set('connections.c1', { from: 'a' }); });
    doc.set('meta.title', 'T');
    assert(doc.undo() && doc.get('meta.title') === undefined && doc.get('instances.a'));
    assert(doc.undo() && doc.get('instances.a') === undefined && doc.get('connections.c1') === undefined);
    assert(!doc.undo() && doc.canRedo);
    doc.redo();
    assert(doc.get('instances.a').type === 'x' && doc.get('connections.c1').from === 'a');
});

test('a new change after undo clears the redo stack', async () => {
    const doc = await openDoc();
    doc.transact('a', () => doc.set('x', 1));
    doc.undo();
    doc.transact('b', () => doc.set('x', 2));
    assert(!doc.canRedo && !doc.redo());
});

test('nested transact joins the outer operation', async () => {
    const doc = await openDoc();
    doc.transact('outer', () => { doc.set('a', 1); doc.transact('inner', () => doc.set('b', 2)); });
    doc.undo();
    assert(doc.get('a') === undefined && doc.get('b') === undefined && !doc.canUndo);
});

test('snapshot and restore round-trip the document', async () => {
    const doc = await openDoc();
    doc.set('meta.title', 'T');
    const snapshot = doc.snapshot();
    doc.set('meta.title', 'Other');
    doc.restore(snapshot);
    assert(doc.get('meta.title') === 'T' && !doc.canUndo);
});

// --- runner ---

const originalConsoleLog = console.log;
console.log = () => {};
const originalConsoleError = console.error;
console.error = () => {};                                //failure paths log on purpose

const lines = [];
let failed = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        lines.push(`PASS ${name}`);
    } catch (error) {
        failed++;
        lines.push(`FAIL ${name}\n     ${error.message}`);
    }
}
console.log = originalConsoleLog;
console.error = originalConsoleError;

const summary = `${tests.length - failed}/${tests.length} passed`;
document.getElementById('results').textContent = lines.join('\n');
document.getElementById('summary').textContent = summary;
document.title = (failed ? 'FAIL ' : 'PASS ') + summary;
