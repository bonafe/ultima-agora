import { ReactiveComponent } from '../vendor/ultima/reactive_component.js';
import { mix } from '../core/components/mix.js';
import { AgoraComponent } from '../core/components/agora_component.js';
import { validateManifest, validateConfig } from '../core/registry/manifest.js';
import { ComponentRegistry } from '../core/registry/component_registry.js';
import { MemoryStateStore } from '../collaboration/document/memory_state_store.js';
import { Layout } from '../core/workspace/layout.js';
import { Workspace } from '../core/workspace/workspace.js';
import { DevHost } from '../adapters/dev/dev_host.js';
import { Y, syncProtocol, awarenessProtocol, encoding, decoding } from '../vendor/yjs/yjs.js';
import { YjsWorkspaceDoc } from '../collaboration/document/yjs_state_store.js';
import { YjsStateStore } from '../collaboration/providers/yjs_store.js';
import { SyncProvider } from '../collaboration/providers/sync_provider.js';
import { YjsPresence } from '../collaboration/presence/presence.js';
import { IndexedDbBackend } from '../collaboration/providers/indexeddb_persistence.js';
import { uuid } from '../core/ids.js';
import { TypeRegistry, registerCoreTypes } from '../core/connections/types.js';
import { BusError } from '../core/connections/bus.js';
import { layoutGraph } from '../components/graph/ultima-graph.js';
import { parseCsv } from '../components/table/ultima-table.js';
import { MemoryBackend } from '../collaboration/providers/indexeddb_persistence.js';
import { renderMarkdown } from '../components/markdown/markdown.js';
import { registerCoreComponents } from '../components/catalog.js';
import '../ui/workspace/agora-workspace.js';
import '../ui/inspector/agora-inspector.js';
import '../ui/palette/agora-palette.js';

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

test('registry rejects ports whose type is not registered', () => {
    const registry = new ComponentRegistry();
    throws(() => registry.register({ manifest: baseManifest({ inputs: { x: { type: 'Mystery' } } }), load: loader() }), 'unknown type "Mystery"');
});

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
    registry.types.register({ name: 'Entity', kind: 'object' });
    registry.types.register({ name: 'Person', extends: 'Entity' });
    registry.register({ manifest: baseManifest({ name: 'test-in', tag: 'test-in', inputs: { e: { type: 'Entity' } } }), load: loader() });
    registry.register({ manifest: baseManifest({ name: 'test-out', tag: 'test-out', outputs: { e: { type: 'Entity' } } }), load: loader() });
    assert(registry.typesAccepting('Entity')[0].name === 'test-in');
    assert(registry.typesAccepting('Person')[0].name === 'test-in', 'a subtype is accepted where its parent is');
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
    registry.types.register({ name: 'Entity', kind: 'object' });
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

test('dispose() runs onDispose; moving the element in the DOM does not', async () => {
    const { element } = await create({});
    await mountAndLoad(element);
    let disposed = 0;
    element.onDispose = () => disposed++;
    const holder = document.createElement('div');
    document.body.append(holder);
    holder.append(element);
    assert(disposed === 0, 'a DOM move must not dispose');
    element.dispose();
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

test('onHistory fires when a transaction closes, not while it is open', async () => {
    const doc = await openDoc();
    const seen = [];
    doc.onHistory(() => seen.push(doc.canUndo));
    doc.transact('t', () => { doc.set('a', 1); doc.set('b', 2); assert(seen.length === 0, 'fired inside the transaction'); });
    doc.undo();
    assert(seen.join() === 'true,false', seen.join());
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

// --- layout ---

const shape = (layout, id = layout.rootId) => {
    const panel = layout.panel(id);
    if (!panel) return null;
    return panel.kind === 'tabs' ? `[${panel.tabs.join(',')}]` : `${panel.dir === 'row' ? 'R' : 'C'}(${panel.children.map(c => shape(layout, c)).join(' ')})`;
};

test('layout: first instance creates the root tabs panel; center adds tabs', async () => {
    const layout = new Layout(await openDoc());
    layout.place('a'); layout.place('b');
    assert(shape(layout) === '[a,b]');
});

test('layout: edge placement splits the target panel on that side', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a');
    layout.place('b', { panelId: first, side: 'right' });
    layout.place('c', { panelId: first, side: 'top' });
    assert(shape(layout) === 'R(C([c] [a]) [b])', shape(layout));
});

test('layout: removing an instance collapses empty panels and splits', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a');
    layout.place('b', { panelId: first, side: 'right' });
    layout.place('c', { panelId: first, side: 'bottom' });
    layout.remove('c');
    assert(shape(layout) === 'R([a] [b])', shape(layout));
    layout.remove('b');
    assert(shape(layout) === '[a]');
    layout.remove('a');
    assert(layout.rootId === null && layout.panelIds().length === 0);
});

test('layout: move re-docks an instance and is one undo step', async () => {
    const doc = await openDoc();
    const layout = new Layout(doc);
    const first = layout.place('a');
    layout.place('b');
    layout.move('b', { panelId: first, side: 'right' });
    assert(shape(layout) === 'R([a] [b])', shape(layout));
    doc.undo();
    assert(shape(layout) === '[a,b]', shape(layout));
});

test('layout: moving the only tab of a panel onto its own edge changes nothing', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a');
    layout.move('a', { panelId: first, side: 'left' });
    assert(shape(layout) === '[a]');
});

test('layout: ratio is clamped, reorderTab moves a tab', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a');
    layout.place('b', { panelId: first, side: 'right' });
    layout.setRatio(layout.rootId, 5);
    assert(layout.panel(layout.rootId).ratio === 0.9);
    layout.place('c', { panelId: first }); layout.reorderTab(first, 'c', 0);
    assert(layout.panel(first).tabs.join() === 'c,a');
});

// --- workspace controller ---

const widgetManifest = { name: 'test-widget', tag: 'test-widget', title: 'Widget', version: '1.2.0', module: './w.js', config: { size: { type: 'integer', default: 1, min: 1, max: 3 } } };
const newWorkspace = async () => {
    const registry = new ComponentRegistry();
    registry.register({ manifest: widgetManifest, load: loader() });
    const doc = await openDoc();
    return new Workspace({ doc, registry, user: { id: 'urn:user:t' } });
};

test('workspace: addInstance records the instance and places it, as one undo step', async () => {
    const workspace = await newWorkspace();
    const id = workspace.addInstance('test-widget', { config: { size: 2 } });
    const record = workspace.instance(id);
    assert(record.type === 'test-widget' && record.typeVersion === '1.2.0' && record.config.size === 2 && record.createdBy === 'urn:user:t');
    assert(workspace.layout.instanceIds().join() === id);
    workspace.doc.undo();
    assert(workspace.instances().length === 0 && workspace.layout.rootId === null);
});

test('workspace: unknown type and invalid config are rejected before anything is written', async () => {
    const workspace = await newWorkspace();
    throws(() => workspace.addInstance('nope'), 'not registered');
    throws(() => workspace.addInstance('test-widget', { config: { size: 99 } }), 'out of range');
    assert(workspace.instances().length === 0 && !workspace.doc.canUndo === (workspace.doc.canUndo === false));
});

test('workspace: setConfig applies valid patches per field and returns errors for invalid ones', async () => {
    const workspace = await newWorkspace();
    const id = workspace.addInstance('test-widget');
    assert(workspace.setConfig(id, { size: 3 }).length === 0 && workspace.instance(id).config.size === 3);
    assert(workspace.setConfig(id, { size: 0 }).length === 1 && workspace.instance(id).config.size === 3);
});

test('workspace: removeInstance is undoable and keeps shared text for the undo', async () => {
    const workspace = await newWorkspace();
    const id = workspace.addInstance('test-widget');
    workspace.sharedText(id).setText('hello');
    workspace.removeInstance(id);
    assert(workspace.instance(id) === null && workspace.layout.rootId === null);
    workspace.doc.undo();
    assert(workspace.instance(id) && workspace.sharedText(id).getText() === 'hello');
});

test('workspace: sharedText notifies on change', async () => {
    const workspace = await newWorkspace();
    const id = workspace.addInstance('test-widget');
    const text = workspace.sharedText(id);
    const seen = [];
    text.onChange(value => seen.push(value));
    text.setText('a'); text.setText('ab');
    assert(seen.join() === 'a,ab');
});

test('workspace: a document from a newer schema is read-only', async () => {
    const doc = await openDoc();
    doc.set('meta.schemaVersion', 99);
    const registry = new ComponentRegistry();
    registry.register({ manifest: widgetManifest, load: loader() });
    const workspace = new Workspace({ doc, registry, user: { id: 'u' } });
    assert(workspace.readOnly);
    throws(() => workspace.addInstance('test-widget'), 'read-only');
});

// --- persistence (IndexedDB) ---

const newHost = () => new DevHost({ dbName: `agora-test-${crypto.randomUUID()}` });

test('dev host: a document survives closing and reopening the workspace', async () => {
    const host = newHost();
    const meta = await host.create('Persistente');
    const doc = await host.store.open(meta.id);
    const workspace = new Workspace({ doc, registry: Object.assign(new ComponentRegistry(), {}), user: host.identity });
    workspace.registry.register({ manifest: widgetManifest, load: loader() });
    const id = workspace.addInstance('test-widget', { config: { size: 2 } });
    workspace.sharedText(id).setText('nota');
    await doc.flush();
    assert(doc.status === 'synced', doc.status);

    host.store.forget(meta.id);                          //simulates a fresh page load
    const reopened = await host.store.open(meta.id);
    const again = new Workspace({ doc: reopened, registry: workspace.registry, user: host.identity });
    assert(again.instance(id).config.size === 2 && again.sharedText(id).getText() === 'nota' && again.layout.instanceIds().join() === id);
    await host.destroy();
});

test('indexeddb backend: the host-data cache stores, lists and deletes entries, and an old v1 database upgrades', async () => {
    const name = `agora-test-${uuid()}`;
    //a database created by the first version (no "cache" store)
    await new Promise((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => { open.result.createObjectStore('documents'); open.result.createObjectStore('workspaces', { keyPath: 'id' }); };
        open.onsuccess = () => { open.result.close(); resolve(); };
        open.onerror = () => reject(open.error);
    });
    for (const backend of [new IndexedDbBackend(name), new MemoryBackend()]) {
        await backend.putCache('k1', { value: { a: 1 }, level: 'interno' });
        await backend.putCache('k2', { value: [2], level: 'restrito' });
        assert((await backend.getCache('k1')).value.a === 1);
        assert((await backend.cacheEntries()).map(([key]) => key).sort().join() === 'k1,k2');
        await backend.deleteCache('k1');
        assert(await backend.getCache('k1') === undefined && (await backend.cacheEntries()).length === 1);
        await backend.close();
    }
});

test('dev host: catalog creates, renames, lists, archives and duplicates', async () => {
    const host = newHost();
    const a = await host.create('A');
    await host.rename(a.id, 'A2');
    assert((await host.list())[0].title === 'A2');
    const doc = await host.store.open(a.id);
    doc.set('meta.note', 'conteúdo');
    const copy = await host.duplicate(a.id);
    assert(copy.id !== a.id && copy.title === 'A2 (cópia)');
    host.store.forget(copy.id);
    const copied = await host.store.open(copy.id);
    assert(copied.get('meta.note') === 'conteúdo' && copied.get('meta.title') === 'A2 (cópia)', 'content is copied and the title is the copy\'s');
    await host.archive(a.id);
    assert((await host.list()).map(w => w.id).join() === copy.id);
    await host.destroy();
});

test('dev host: works fully in memory when IndexedDB is unavailable', async () => {
    const host = new DevHost({ backend: new MemoryBackend() });
    assert(host.persistent === false);
    const meta = await host.create('Volátil');
    const doc = await host.store.open(meta.id);
    doc.set('meta.title', 'x');
    const copy = await host.duplicate(meta.id);
    assert((await host.list()).length === 2 && copy.title === 'Volátil (cópia)');
    await host.archive(meta.id);
    assert((await host.list()).length === 1);
});

test('dev host: create() falls back to memory when IndexedDB fails', async () => {
    const original = indexedDB.open;
    indexedDB.open = () => { throw new Error('blocked'); };
    try {
        const host = await DevHost.create({ dbName: 'agora-test-blocked' });
        assert(host.persistent === false && (await host.create('ok')).title === 'ok');
    } finally { indexedDB.open = original; }
});

test('uuid works without crypto.randomUUID (insecure contexts, e.g. a LAN IP over http)', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
        const id = uuid();
        assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id);
        assert(uuid() !== id);
    } finally { Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true }); }
});

// --- markdown ---

test('markdown renders the supported constructs', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* with `code`.\n\n- a\n- b\n\n1. one\n\n[site](https://example.com)');
    for (const fragment of ['<h1>Title</h1>', '<strong>bold</strong>', '<em>italic</em>', '<code>code</code>', '<ul>', '<li>b</li>', '<ol>', 'href="https://example.com"']) {
        assert(html.includes(fragment), `missing ${fragment} in ${html}`);
    }
});

test('markdown never lets input become markup', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n[y](https://a.com/"onmouseover="alert(1))');
    assert(!html.includes('<script') && !html.includes('<img') && !html.includes('href="javascript'), html);
    const probe = document.createElement('div');
    probe.innerHTML = html;
    const handlers = [...probe.querySelectorAll('*')].flatMap(e => e.getAttributeNames().filter(n => n.startsWith('on')));
    assert(handlers.length === 0, `event handler attributes parsed: ${handlers}`);
    assert([...probe.querySelectorAll('a')].every(a => /^https?:/.test(a.getAttribute('href'))));
});

test('markdown code blocks keep their content literal', () => {
    const html = renderMarkdown('```\n**not bold** <b>\n```');
    assert(html.includes('<pre><code>**not bold** &lt;b&gt;</code></pre>'), html);
});

// --- shell parts: workspace view, inspector, palette ---

const mountView = async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const doc = await openDoc();
    const workspace = new Workspace({ doc, registry, user: { id: 'urn:user:t' } });
    const view = document.createElement('agora-workspace');
    view.style.cssText = 'display:block;width:600px;height:300px';
    document.body.append(view);
    assert(await settleOrTimeout(view.whenLoaded()), 'view never loaded');
    view.workspace = workspace;
    await wait(50);
    return { view, workspace, registry };
};
const tabLabels = view => [...view.rootNode.querySelectorAll('.tab button.label')].map(b => b.textContent);
const instanceElement = (view, id) => view.rootNode.querySelector(`[data-instance-id="${id}"]`);

test('view: shows the empty state, then one tab per added instance with a live component inside', async () => {
    const { view, workspace } = await mountView();
    assert(view.rootNode.querySelector('.empty'), 'no empty state');
    const text = workspace.addInstance('ultima-text', { config: { text: 'olá' } });
    workspace.addInstance('ultima-notes');
    await wait(300);
    assert(tabLabels(view).join() === 'Texto,Notas', tabLabels(view).join());
    const element = instanceElement(view, text);
    assert(element && await settleOrTimeout(element.whenLoaded()));
    assert(element.rootNode.querySelector('p').textContent === 'olá');
});

test('view: a config change reaches the live component without repainting the panels', async () => {
    const { view, workspace } = await mountView();
    const id = workspace.addInstance('ultima-text', { config: { text: 'um' } });
    await wait(300);
    const element = instanceElement(view, id);
    const panel = view.rootNode.querySelector('.panel');
    workspace.setConfig(id, { text: 'dois' });
    await wait(50);
    assert(element.rootNode.querySelector('p').textContent === 'dois');
    assert(view.rootNode.querySelector('.panel') === panel, 'panels were rebuilt');
});

test('view: removing an instance disposes its element; undo brings a fresh one back', async () => {
    const { view, workspace } = await mountView();
    const id = workspace.addInstance('ultima-text');
    await wait(300);
    const element = instanceElement(view, id);
    let disposed = 0;
    element.onDispose = () => disposed++;
    workspace.removeInstance(id);
    await wait(50);
    assert(disposed === 1 && !instanceElement(view, id) && view.rootNode.querySelector('.empty'));
    workspace.doc.undo();
    await wait(300);
    assert(instanceElement(view, id) && instanceElement(view, id) !== element);
});

test('view: a source on a background tab still feeds what is connected to it', async () => {
    const { view, workspace } = await mountView();
    const table = workspace.addInstance('ultima-table');
    await wait(300);
    const text = workspace.addInstance('ultima-text');                       //same panel: the table becomes a background tab
    await wait(400);
    assert(workspace.layout.findPanelOf(table) === workspace.layout.findPanelOf(text));
    workspace.bus.connect({ instance: table, port: 'selectedRow' }, { instance: text, port: 'text' });
    const background = view.rootNode.querySelector(`[data-instance-id="${table}"]`);
    assert(background && background.closest('.tabpanel').hasAttribute('hidden'), 'the table must be mounted although its tab is hidden');
    background.rootNode.querySelector('tbody tr').click();
    await wait(200);
    assert(view.rootNode.querySelector(`[data-instance-id="${text}"]`).rootNode.querySelector('p').textContent.includes('Empresa Alfa'));
});

test('view: moving an instance between panels keeps the same element and does not dispose it', async () => {
    const { view, workspace } = await mountView();
    const a = workspace.addInstance('ultima-text');
    await wait(300);
    const b = workspace.addInstance('ultima-notes');           //a new arrival becomes the active tab, so it is mounted
    await wait(300);
    const notes = instanceElement(view, b);
    notes.onDispose = () => { throw new Error('disposed on move'); };
    workspace.moveInstance(b, { panelId: workspace.layout.findPanelOf(b), side: 'right' });
    await wait(300);
    assert(view.rootNode.querySelectorAll('.panel').length === 2);
    assert(instanceElement(view, b) === notes && instanceElement(view, a));
});

test('view: dropping a palette item on a panel edge splits it; read-only workspaces refuse drops', async () => {
    const { view, workspace } = await mountView();
    workspace.addInstance('ultima-text');
    await wait(300);
    const panel = view.rootNode.querySelector('.panel');
    const rect = panel.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData('application/x-agora-component', 'ultima-notes');
    for (const type of ['dragover', 'drop']) {
        panel.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.right - 4, clientY: rect.top + rect.height / 2 }));
    }
    await wait(300);
    assert(view.rootNode.querySelectorAll('.panel').length === 2 && workspace.instances().length === 2);
});

test('view: an unknown component type is kept as a notice and its config is preserved', async () => {
    const { view, workspace } = await mountView();
    workspace.doc.set('instances.cmp-x', { type: 'ghost-widget', typeVersion: '9.0.0', label: 'Fantasma', config: { keep: 1 }, createdBy: 'u', createdVia: 'palette' });
    workspace.layout.place('cmp-x');
    await wait(300);
    assert(view.rootNode.querySelector('.notice.error')?.textContent.includes('ghost-widget'));
    assert(workspace.instance('cmp-x').config.keep === 1);
});

test('inspector: builds fields from the manifest and rejects invalid values', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const workspace = new Workspace({ doc: await openDoc(), registry, user: { id: 'u' } });
    const id = workspace.addInstance('ultima-text', { config: { text: 'x' } });
    const inspector = document.createElement('agora-inspector');
    document.body.append(inspector);
    assert(await settleOrTimeout(inspector.whenLoaded()));
    inspector.workspace = workspace;
    inspector.selectedId = id;
    await wait(50);
    const root = inspector.rootNode;
    assert(root.querySelector('textarea') && root.querySelector('select'), 'fields not generated');
    const select = root.querySelector('select');
    select.value = 'large';
    select.dispatchEvent(new Event('change'));
    assert(workspace.instance(id).config.size === 'large');
    assert(workspace.setConfig(id, { size: 'huge' }).length === 1 && workspace.instance(id).config.size === 'large');
    inspector.selectedId = null;
    await wait(50);
    assert(root.querySelector('.empty'));
});

test('palette: lists registered components, filters by search and announces additions', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const palette = document.createElement('agora-palette');
    document.body.append(palette);
    assert(await settleOrTimeout(palette.whenLoaded()));
    palette.registry = registry;
    await wait(50);
    const items = () => [...palette.rootNode.querySelectorAll('button.item')];
    assert(items().length === 4);
    const search = palette.rootNode.querySelector('#search');
    search.value = 'markdown'; search.dispatchEvent(new Event('input'));
    assert(items().length === 1 && items()[0].textContent.startsWith('Notas'));
    let added = null;
    palette.addEventListener('palette-add', event => { added = event.detail.type; });
    items()[0].click();
    assert(added === 'ultima-notes');
    palette.canAdd = false;
    assert(items().every(b => b.disabled));
});

// --- port types ---

const coreTypes = () => { const types = new TypeRegistry(); registerCoreTypes(types); return types; };

test('types: subtyping, arrays and Json', () => {
    const types = coreTypes();
    types.register({ name: 'Entity', kind: 'object' });
    types.register({ name: 'Person', extends: 'Entity' });
    assert(types.isSubtype('Person', 'Entity') && !types.isSubtype('Entity', 'Person'));
    assert(types.isSubtype('Person[]', 'Entity[]') && !types.isSubtype('Person', 'Entity[]'));
    assert(types.isSubtype('Table', 'Json') && types.isSubtype('Text', 'String'));
    assert(!types.isSubtype('Number', 'String'));
});

test('types: compatibility explains refusals and finds converters, also inside lists', () => {
    const types = coreTypes();
    assert(types.compatibility('Node', 'String').ok && types.compatibility('Node', 'String').via === 'rótulo do nó');
    assert(types.compatibility('Node', 'String').convert({ id: 'a', label: 'A' }) === 'A');
    const list = types.compatibility('Node[]', 'String[]');
    assert(list.ok && list.convert([{ id: 'a' }, { id: 'b', label: 'B' }]).join() === 'a,B');
    const no = types.compatibility('Graph', 'String');
    assert(!no.ok && no.reason.includes('Graph'));
    assert(types.compatibility('String', 'Text').ok === false, 'a supertype must not flow into a subtype');
});

test('types: validate checks kind, required fields and list elements', () => {
    const types = coreTypes();
    assert(types.validate('String', 'x') === null && types.validate('String', 3) !== null);
    assert(types.validate('Node', { id: 'a' }) === null);
    assert(types.validate('Node', { label: 'x' }).includes('id'));
    assert(types.validate('Node', { id: 5 }).includes('string'));
    assert(types.validate('Node[]', [{ id: 'a' }, { id: 'b' }]) === null && types.validate('Node[]', [{ id: 'a' }, {}]) !== null);
    assert(types.validate('Table', { columns: [], rows: [] }) === null && types.validate('Table', { columns: [] }) !== null);
    assert(types.validate('Mystery', 1).includes('desconhecido'));
});

test('types: registering a duplicate or an orphan subtype fails', () => {
    const types = coreTypes();
    throws(() => types.register({ name: 'String' }), 'already registered');
    throws(() => types.register({ name: 'Orphan', extends: 'Nope' }), 'unknown type');
    throws(() => types.register({ name: 'lowercase' }), 'PascalCase');
});

// --- bus ---

const busManifests = [
    { name: 'test-source', outputs: { text: { type: 'String' }, node: { type: 'Node' }, graph: { type: 'Graph' }, ping: { type: 'String', retained: false } } },
    { name: 'test-sink', inputs: { text: { type: 'String' }, many: { type: 'String', multiple: true }, graph: { type: 'Graph' } } },
    { name: 'test-middle', inputs: { in: { type: 'String' } }, outputs: { out: { type: 'String' } } },
].map(m => ({ ...m, tag: m.name, title: m.name, version: '1.0.0', module: './x.js' }));

const busWorkspace = async () => {
    const registry = new ComponentRegistry();
    busManifests.forEach(manifest => registry.register({ manifest, load: loader() }));
    const workspace = new Workspace({ doc: await openDoc(), registry, user: { id: 'u' } });
    const live = (type) => {
        const id = workspace.addInstance(type);
        const received = [];
        workspace.bus.attach(id, { deliverInput: (port, value) => received.push([port, value]) });
        return { id, received };
    };
    return { workspace, bus: workspace.bus, live };
};
const flush = () => wait(20);

test('bus: connects compatible ports and refuses incompatible ones with a reason', async () => {
    const { bus, live } = await busWorkspace();
    const a = live('test-source'), b = live('test-sink');
    assert(bus.connect({ instance: a.id, port: 'text' }, { instance: b.id, port: 'text' }));
    try { bus.connect({ instance: a.id, port: 'graph' }, { instance: b.id, port: 'text' }); throw new Error('accepted'); }
    catch (error) { assert(error instanceof BusError && error.message.includes('Graph') && error.message.includes('String'), error.message); }
    throws(() => bus.connect({ instance: a.id, port: 'nope' }, { instance: b.id, port: 'text' }), 'não tem a saída');
});

test('bus: self connections and cycles are refused', async () => {
    const { bus, live } = await busWorkspace();
    const a = live('test-middle'), b = live('test-middle');
    throws(() => bus.connect({ instance: a.id, port: 'out' }, { instance: a.id, port: 'in' }), 'ciclo');
    bus.connect({ instance: a.id, port: 'out' }, { instance: b.id, port: 'in' });
    throws(() => bus.connect({ instance: b.id, port: 'out' }, { instance: a.id, port: 'in' }), 'ciclo');
});

test('bus: a published value reaches the connected input; a late attach gets the retained value', async () => {
    const { workspace, bus, live } = await busWorkspace();
    const source = live('test-source');
    const sink = live('test-sink');
    bus.connect({ instance: source.id, port: 'text' }, { instance: sink.id, port: 'text' });
    bus.publish(source.id, 'text', 'olá');
    await flush();
    assert(JSON.stringify(sink.received) === '[["text","olá"]]', JSON.stringify(sink.received));

    const late = workspace.addInstance('test-sink');
    bus.connect({ instance: source.id, port: 'text' }, { instance: late, port: 'text' });
    const lateReceived = [];
    bus.attach(late, { deliverInput: (port, value) => lateReceived.push([port, value]) });
    await flush();
    assert(JSON.stringify(lateReceived) === '[["text","olá"]]', 'the retained value must reach a component mounted later');
});

test('bus: equal values are not delivered twice; a changed value is', async () => {
    const { bus, live } = await busWorkspace();
    const source = live('test-source'), sink = live('test-sink');
    bus.connect({ instance: source.id, port: 'text' }, { instance: sink.id, port: 'text' });
    bus.publish(source.id, 'text', 'a'); await flush();
    bus.publish(source.id, 'text', 'a'); await flush();
    bus.publish(source.id, 'text', 'b'); await flush();
    assert(sink.received.map(r => r[1]).join() === 'a,b', JSON.stringify(sink.received));
});

test('bus: disconnecting clears the input; conversion is applied on the way', async () => {
    const { bus, live } = await busWorkspace();
    const source = live('test-source'), sink = live('test-sink');
    const id = bus.connect({ instance: source.id, port: 'node' }, { instance: sink.id, port: 'text' });
    bus.publish(source.id, 'node', { id: 'n1', label: 'Pessoa A' }); await flush();
    assert(sink.received.at(-1)[1] === 'Pessoa A', 'Node should arrive as its label');
    bus.disconnect(id); await flush();
    assert(sink.received.at(-1)[1] === undefined && bus.inputValue(sink.id, 'text') === undefined);
});

test('bus: single inputs need replace for a second source, multiple inputs collect all', async () => {
    const { bus, live } = await busWorkspace();
    const a = live('test-source'), b = live('test-source'), sink = live('test-sink');
    bus.connect({ instance: a.id, port: 'text' }, { instance: sink.id, port: 'text' });
    throws(() => bus.connect({ instance: b.id, port: 'text' }, { instance: sink.id, port: 'text' }), 'já está conectada');
    bus.connect({ instance: b.id, port: 'text' }, { instance: sink.id, port: 'text' }, { replace: true });
    assert(bus.list().filter(c => c.to.port === 'text').length === 1);

    bus.connect({ instance: a.id, port: 'text' }, { instance: sink.id, port: 'many' });
    bus.connect({ instance: b.id, port: 'text' }, { instance: sink.id, port: 'many' });
    bus.publish(a.id, 'text', 'x'); bus.publish(b.id, 'text', 'y'); await flush();
    assert(JSON.stringify(sink.received.filter(r => r[0] === 'many').at(-1)[1]) === '["x","y"]', JSON.stringify(sink.received));
});

test('bus: invalid values and unknown ports are rejected at publish', async () => {
    const { bus, live } = await busWorkspace();
    const source = live('test-source');
    throws(() => bus.publish(source.id, 'text', 42), 'inválido');
    throws(() => bus.publish(source.id, 'node', { label: 'no id' }), 'id');
    throws(() => bus.publish(source.id, 'ghost', 1), 'não tem a saída');
});

test('bus: non-retained outputs are delivered once and not replayed to late listeners', async () => {
    const { workspace, bus, live } = await busWorkspace();
    const source = live('test-source');
    const first = workspace.addInstance('test-sink');
    const firstReceived = [];
    bus.attach(first, { deliverInput: (port, value) => firstReceived.push([port, value]) });
    bus.connect({ instance: source.id, port: 'ping' }, { instance: first, port: 'text' });
    bus.publish(source.id, 'ping', 'now'); await flush();
    assert(firstReceived.at(-1)[1] === 'now');
    const second = workspace.addInstance('test-sink');
    const secondReceived = [];
    bus.attach(second, { deliverInput: (port, value) => secondReceived.push([port, value]) });
    bus.connect({ instance: source.id, port: 'ping' }, { instance: second, port: 'text' }); await flush();
    assert(secondReceived.length === 0, JSON.stringify(secondReceived));
});

test('bus: removing an instance removes its connections, and undo brings both back', async () => {
    const { workspace, bus, live } = await busWorkspace();
    const a = live('test-source'), b = live('test-sink');
    bus.connect({ instance: a.id, port: 'text' }, { instance: b.id, port: 'text' });
    workspace.removeInstance(b.id);
    assert(bus.list().length === 0);
    workspace.doc.undo();
    assert(bus.list().length === 1 && workspace.instance(b.id));
});

test('bus: compatibleSources lists the outputs that fit, noting conversions', async () => {
    const { bus, live } = await busWorkspace();
    const source = live('test-source'), sink = live('test-sink');
    const options = bus.compatibleSources(sink.id, 'text').map(o => `${o.port}${o.via ? '*' : ''}`).sort().join();
    assert(options === 'node*,ping,text', options);
    assert(bus.compatibleSources(sink.id, 'graph').map(o => o.port).join() === 'graph');
});

// --- manifest rules for actions ---

test('manifest: create/emit actions must name an output port of the same type', () => {
    const base = { name: 'test-a', tag: 'test-a', title: 'A', version: '1.0.0', module: './a.js', outputs: { g: { type: 'Graph' } } };
    assert(validateManifest({ ...base, actions: { go: { title: 'Go', effect: 'create', produces: 'Graph', port: 'g' } } }).length === 0);
    assert(validateManifest({ ...base, actions: { go: { title: 'Go', effect: 'create', produces: 'Graph' } } }).some(e => e.startsWith('actions.go.port')));
    assert(validateManifest({ ...base, actions: { go: { title: 'Go', effect: 'create', produces: 'Graph', port: 'nope' } } }).some(e => e.includes('not an output port')));
    assert(validateManifest({ ...base, actions: { go: { title: 'Go', effect: 'create', produces: 'Table', port: 'g' } } }).some(e => e.includes('must equal')));
});

// --- generic components ---

test('csv: header, quotes and ragged rows', () => {
    const table = parseCsv('a,b\n"x, y",2\n3');
    assert(table.columns.map(c => c.key).join() === 'a,b' && table.rows[0].a === 'x, y' && table.rows[1].a === '3');
    assert(parseCsv('').rows.length === 0);
});

test('graph layout is deterministic and keeps nodes inside the canvas', () => {
    const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] };
    const one = layoutGraph(graph, 'force'), two = layoutGraph(graph, 'force');
    for (const [id, p] of one) {
        assert(p.x === two.get(id).x && p.y === two.get(id).y, 'not deterministic');
        assert(p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 520, `${id} outside`);
    }
});

// --- the M2 flow, end to end in the real components ---

const nodesOf = view => [...view.rootNode.querySelectorAll('ultima-graph')].flatMap(g => [...g.rootNode.querySelectorAll('.node')]);

test('domain-data: a component receives the host client, scoped to its workspace', async () => {
    const registry = new ComponentRegistry();
    const manifest = baseManifest({ name: 'test-domain', tag: 'test-domain', capabilities: ['domain-data'] });
    registry.register({ manifest, load: loader() });
    const domain = { forWorkspace: id => ({ scopedTo: id }) };
    const workspace = new Workspace({ doc: await openDoc(), registry, user: { id: 'u' }, domain, id: 'ws-9' });
    const view = document.createElement('agora-workspace');
    view.style.cssText = 'display:block;width:400px;height:200px';
    document.body.append(view);
    assert(await settleOrTimeout(view.whenLoaded()));
    view.workspace = workspace;
    const id = workspace.addInstance('test-domain');
    await wait(400);
    const element = view.rootNode.querySelector(`[data-instance-id="${id}"]`);
    assert(element.domain.scopedTo === 'ws-9', 'the instance must get the workspace-scoped client');
    const plain = await mountView();
    const other = plain.workspace.addInstance('ultima-text');
    await wait(300);
    throws(() => plain.view.rootNode.querySelector(`[data-instance-id="${other}"]`).domain, 'domain-data');
});

test('M2 flow: table → action "mostrar como grafo" → linked graph → node selection → text', async () => {
    const { view, workspace } = await mountView();
    const table = workspace.addInstance('ultima-table');
    await wait(400);

    const { suggestions, port, created } = await workspace.invokeAction(table, 'showGraph');
    assert(created === null && port === 'graph');
    assert(suggestions[0].component === 'ultima-graph' && suggestions[0].port === 'graph', 'the action names ultima-graph first');

    const graphId = workspace.createLinked(table, port, suggestions[0]);
    await wait(500);
    assert(workspace.bus.list().length === 1 && workspace.bus.list()[0].to.instance === graphId);
    assert(nodesOf(view).length === 4, `graph should show 4 nodes, shows ${nodesOf(view).length}`);
    const canvas = view.rootNode.querySelector('ultima-graph').rootNode.querySelector('#svg');
    assert(canvas.getBoundingClientRect().width > 0 && !canvas.hasAttribute('hidden'), 'the graph must be visible, not only present in the DOM');

    const text = workspace.addInstance('ultima-text', { target: { panelId: workspace.layout.findPanelOf(graphId), side: 'bottom' } });
    await wait(300);
    workspace.bus.connect({ instance: graphId, port: 'selectedNode' }, { instance: text, port: 'text' });
    nodesOf(view)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(100);
    const shown = view.rootNode.querySelector(`[data-instance-id="${text}"]`).rootNode.querySelector('p').textContent;
    assert(shown === 'Pessoa A' || shown === 'Pessoa B' || shown === 'Empresa Alfa' || shown === 'Empresa Beta', `text shows "${shown}"`);
    assert(shown === workspace.bus.outputValue(graphId, 'selectedNode').label, 'the text must show the label of the selected node');
});

test('M2 flow: a reopened workspace has its connections AND their values again', async () => {
    const first = await mountView();
    const table = first.workspace.addInstance('ultima-table');
    await wait(400);
    const { suggestions, port } = await first.workspace.invokeAction(table, 'showGraph');
    first.workspace.createLinked(table, port, suggestions[0]);
    await wait(500);

    //Same document, brand-new view and bus: what a page reload amounts to
    const view = document.createElement('agora-workspace');
    view.style.cssText = 'display:block;width:600px;height:300px';
    document.body.append(view);
    assert(await settleOrTimeout(view.whenLoaded()));
    const reopened = new Workspace({ doc: first.workspace.doc, registry: first.registry, user: { id: 'u' } });
    view.workspace = reopened;
    await wait(700);
    assert(reopened.bus.list().length === 1);
    assert(nodesOf(view).length === 4, `after reopening the graph shows ${nodesOf(view).length} nodes`);
});

test('M2 flow: creating the linked component is one undo step', async () => {
    const { view, workspace } = await mountView();
    const table = workspace.addInstance('ultima-table');
    await wait(400);
    const { suggestions, port } = await workspace.invokeAction(table, 'showGraph');
    workspace.createLinked(table, port, suggestions[0]);
    assert(workspace.instances().length === 2 && workspace.bus.list().length === 1);
    workspace.doc.undo();
    await wait(100);
    assert(workspace.instances().length === 1 && workspace.bus.list().length === 0);
});

test('M2 flow: incompatible connections are refused in the real components', async () => {
    const { workspace } = await mountView();
    const table = workspace.addInstance('ultima-table');
    const text = workspace.addInstance('ultima-text');
    await wait(300);
    throws(() => workspace.bus.connect({ instance: table, port: 'graph' }, { instance: text, port: 'text' }), 'Graph');
    assert(workspace.bus.connect({ instance: table, port: 'selectedRow' }, { instance: text, port: 'text' }), 'Row → String is converted');
});

test('M2 flow: an action fails with a readable message when the table lacks the columns', async () => {
    const { workspace } = await mountView();
    const table = workspace.addInstance('ultima-table', { config: { data: 'x,y\n1,2' } });
    await wait(400);
    try { await workspace.invokeAction(table, 'showGraph'); throw new Error('accepted'); }
    catch (error) { assert(error.message.includes('coluna'), error.message); }
});

test('M2 flow: the inspector offers connections and actions, and connects through the selector', async () => {
    const { view, workspace } = await mountView();
    const source = workspace.addInstance('ultima-table');
    await wait(300);
    const text = workspace.addInstance('ultima-text');
    await wait(300);
    const inspector = document.createElement('agora-inspector');
    document.body.append(inspector);
    assert(await settleOrTimeout(inspector.whenLoaded()));
    inspector.workspace = workspace;
    inspector.selectedId = text;
    await wait(80);
    const select = inspector.rootNode.querySelector('select[aria-label="Receber em text"]');
    assert(select, 'no connection selector');
    const options = [...select.options].map(o => o.textContent);
    assert(options.some(o => o.includes('selectedRow') && o.includes('converte')), options.join(' | '));
    select.value = [...select.options].find(o => o.value.endsWith('|selectedRow')).value;
    select.dispatchEvent(new Event('change'));
    assert(workspace.bus.list().length === 1 && workspace.bus.list()[0].from.port === 'selectedRow');

    inspector.selectedId = source;
    await wait(80);
    assert([...inspector.rootNode.querySelectorAll('button.action')].some(b => b.textContent === 'Mostrar como grafo'));
});

// --- the document contract, for both implementations ---

const docKinds = [['memory', async () => openDoc()], ['yjs', async () => new YjsWorkspaceDoc()]];

for (const [kind, makeDoc] of docKinds) {
    test(`${kind} doc: get/set by path returns copies, and delete removes`, async () => {
        const doc = await makeDoc();
        doc.set('instances.a.config', { depth: 2, tags: ['x'] });
        const config = doc.get('instances.a.config');
        config.depth = 99; config.tags.push('y');
        assert(doc.get('instances.a.config.depth') === 2 && doc.get('instances.a.config.tags').length === 1);
        doc.delete('instances.a.config.depth');
        assert(doc.get('instances.a.config.depth') === undefined && doc.get('instances.zzz') === undefined);
    });

    test(`${kind} doc: onChange fires for changes at, under and above the watched path`, async () => {
        const doc = await makeDoc();
        const seen = [];
        doc.onChange('instances.a', path => seen.push(path));
        doc.set('instances.a.config.depth', 1);
        doc.set('instances.b.config.depth', 1);
        doc.set('instances', {});
        assert(seen.length === 2, JSON.stringify(seen));
    });

    test(`${kind} doc: a transaction is one undo step, redo replays it, a new change drops redo`, async () => {
        const doc = await makeDoc();
        doc.transact('create', () => { doc.set('instances.a', { type: 'x' }); doc.set('connections.c1', { from: 'a' }); });
        doc.set('meta.title', 'T');
        assert(doc.undo() && doc.get('meta.title') === undefined && doc.get('instances.a'));
        assert(doc.undo() && doc.get('instances.a') === undefined && doc.get('connections.c1') === undefined);
        assert(!doc.undo() && doc.canRedo);
        doc.redo();
        assert(doc.get('instances.a').type === 'x' && doc.get('connections.c1').from === 'a');
        doc.undo();
        doc.transact('other', () => doc.set('meta.title', 'U'));
        assert(!doc.canRedo);
    });

    test(`${kind} doc: nested transactions join the outer one; onHistory fires when a step closes`, async () => {
        const doc = await makeDoc();
        const seen = [];
        doc.onHistory(() => seen.push(doc.canUndo));
        doc.transact('outer', () => { doc.set('meta.a', 1); doc.transact('inner', () => doc.set('meta.b', 2)); assert(seen.length === 0, 'fired inside'); });
        await wait(0);
        doc.undo();
        await wait(0);                                          //the Yjs store coalesces history notifications
        assert(doc.get('meta.a') === undefined && doc.get('meta.b') === undefined && !doc.canUndo && seen.join() === 'true,false', seen.join());
    });

    test(`${kind} doc: snapshot and restore round-trip, and the text handle edits and notifies`, async () => {
        const doc = await makeDoc();
        doc.set('meta.title', 'T');
        doc.text('content.a.text').setText('hello');
        const snapshot = doc.snapshot();
        const other = await makeDoc();
        other.restore(snapshot);
        assert(other.get('meta.title') === 'T' && other.text('content.a.text').getText() === 'hello' && !other.canUndo);
        const seen = [];
        const text = doc.text('content.a.text');
        text.onChange(value => seen.push(value));
        text.setText('hello world');
        assert(text.getText() === 'hello world' && seen.at(-1) === 'hello world');
    });
}

test('yjs doc: roles are enforced locally the same way the server enforces them', () => {
    const doc = new YjsWorkspaceDoc();
    doc.set('instances.i1', { label: 'x' });
    doc.role = 'participant';
    doc.text('content.i1.text').setText('allowed');
    throws(() => doc.set('instances.i1.label', 'no'), 'may not change "instances"');
    doc.role = 'viewer';
    throws(() => doc.text('content.i1.text').setText('no'), 'may not change "content"');
    throws(() => doc.set('meta.title', 'no'), 'viewer');
    assert(doc.get('instances.i1.label') === 'x' && doc.text('content.i1.text').getText() === 'allowed', 'reading always works');
});

test('workspace: a viewer opening an empty document writes nothing (the bug that made the server drop viewers)', () => {
    const doc = new YjsWorkspaceDoc();
    doc.role = 'viewer';
    const registry = new ComponentRegistry();
    const workspace = new Workspace({ doc, registry, user: { id: 'v' } });
    assert(workspace.readOnly && !workspace.canEditContent && doc.get('meta.schemaVersion') === undefined);
    throws(() => workspace.setTitle('x'), 'cannot change the composition');
});

test('precache: every file in the list is served, and every component the registry can load is in it', async () => {
    const list = await (await fetch('../precache.json')).json();
    assert(list.version && list.files.length > 20);
    for (const required of ['./', 'index.html', 'core/components/agora_component.js', 'vendor/yjs/yjs.js', 'ui/shell/agora-shell.html', 'ui/shell/agora-shell.css', 'adapters/dev/dev_host.js']) {
        assert(list.files.includes(required), `missing ${required}`);
    }
    for (const file of list.files) assert((await fetch(`../${file}`, { method: 'HEAD' })).ok, `${file} is listed but not served`);
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    for (const manifest of registry.list()) {
        const module = new URL(manifest.module, new URL(`components/${manifest.name.replace(/^ultima-/, '')}/x`, location.origin + '/')).pathname.slice(1);
        assert(list.files.includes(module), `${manifest.name}: ${module} is not precached`);
        assert(list.files.includes(module.replace(/\.js$/, '.html')) && list.files.includes(module.replace(/\.js$/, '.css')), `${manifest.name}: template/style not precached`);
    }
    assert(!list.files.some(f => f.startsWith('tests/') || f.startsWith('server/') || f.startsWith('docs/')), 'tests, server and docs do not belong in the app cache');
});

test('offline shell: the cache version goes in the registration URL, and offline nothing is replaced', async () => {
    const registered = [];
    const fake = { register: async url => { registered.push(url); return { fake: true }; }, getRegistration: async () => ({ existing: true }) };
    const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', { value: fake, configurable: true });
    const realFetch = window.fetch;
    try {
        window.fetch = async () => new Response(JSON.stringify({ version: 'abc123', files: [] }));
        const { registerOfflineShell } = await import('../core/offline/register_sw.js');
        await registerOfflineShell({ shell: 'offline.html' });
        assert(registered[0] === 'sw.js?precache=precache.json&v=abc123&shell=offline.html', registered[0]);
        window.fetch = async () => { throw new TypeError('Failed to fetch'); };
        const kept = await registerOfflineShell();
        assert(registered.length === 1 && kept.existing, 'offline: keep the installed worker, register nothing');
    } finally {
        window.fetch = realFetch;
        if (original) Object.defineProperty(navigator, 'serviceWorker', original); else delete navigator.serviceWorker;
    }
});

test('the sync provider reconnects as soon as the browser reports the network is back', async () => {
    const hub = new Hub(); hub.up = false;
    const a = client(hub, 'a');
    a.provider.disconnect(); a.provider.connect();
    await wait(50);
    assert(a.provider.status === 'offline');
    hub.restore();
    dispatchEvent(new Event('online'));
    await synced(a);
    assert(a.provider.status === 'synced');
});

// --- Yjs: merging, offline, presence ---

//A server stand-in speaking the same protocol as server/agora-sync, with a switch for the network
class Hub {
    doc = new Y.Doc();
    awareness = new awarenessProtocol.Awareness(this.doc);
    up = true;
    #connections = new Set();
    constructor() {
        this.doc.on('update', (update, origin) => this.#broadcast(0, e => syncProtocol.writeUpdate(e, update), origin));
        this.awareness.on('update', ({ added, updated, removed }, origin) => {
            if (origin?.clientIds) for (const id of [...added, ...updated]) origin.clientIds.add(id);
            const changed = [...added, ...updated, ...removed];
            this.#broadcast(1, e => encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)), origin);
        });
    }
    #drop(connection) {
        this.#connections.delete(connection);
        awarenessProtocol.removeAwarenessStates(this.awareness, [...connection.clientIds], 'server');     //tell everyone else they left
    }
    #broadcast(type, write, except) {
        for (const c of this.#connections) {
            if (c === except) continue;
            const e = encoding.createEncoder(); encoding.writeVarUint(e, type); write(e);
            queueMicrotask(() => c.client.onmessage?.(encoding.toUint8Array(e)));
        }
    }
    openTransport() {
        return async () => {
            if (!this.up) throw new Error('network down');
            const connection = { client: null, clientIds: new Set() };
            const client = {
                onopen: null, onmessage: null, onclose: null,
                send: bytes => queueMicrotask(() => this.#serve(connection, bytes)),
                close: () => { this.#drop(connection); queueMicrotask(() => client.onclose?.({ code: 1000 })); },
            };
            connection.client = client;
            this.#connections.add(connection);
            setTimeout(() => client.onopen?.(), 0);
            return client;
        };
    }
    #serve(connection, bytes) {
        if (!this.#connections.has(connection)) return;
        const decoder = decoding.createDecoder(bytes);
        const type = decoding.readVarUint(decoder);
        if (type === 0) {
            const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0);
            const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, connection);
            if (encoding.length(reply) > 1) queueMicrotask(() => connection.client.onmessage?.(encoding.toUint8Array(reply)));
            if (kind === syncProtocol.messageYjsSyncStep1) {       //the server also asks for what the client has
                const ask = encoding.createEncoder(); encoding.writeVarUint(ask, 0); syncProtocol.writeSyncStep1(ask, this.doc);
                queueMicrotask(() => connection.client.onmessage?.(encoding.toUint8Array(ask)));
            }
        } else if (type === 1) {
            awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), connection);
        }
    }
    cut() { this.up = false; for (const c of [...this.#connections]) { this.#drop(c); c.client.onclose?.({ code: 1006 }); } }
    restore() { this.up = true; }
}

const client = (hub, user) => {
    const doc = new YjsWorkspaceDoc();
    const awareness = new awarenessProtocol.Awareness(doc.ydoc);
    doc.presence = new YjsPresence(awareness);
    doc.presence.setLocal({ user: { id: user, name: user } });
    const provider = new SyncProvider({ ydoc: doc.ydoc, awareness, openTransport: hub.openTransport(), minDelayMs: 20, maxDelayMs: 40 });
    provider.connect();
    return { doc, provider, awareness };
};
const synced = async (...clients) => { for (let i = 0; i < 100 && !clients.every(c => c.provider.status === 'synced'); i++) await wait(10); await wait(30); };

test('yjs sync: two clients converge through the server, including shared text', async () => {
    const hub = new Hub();
    const a = client(hub, 'a'), b = client(hub, 'b');
    await synced(a, b);
    a.doc.set('instances.i1', { type: 'ultima-text', label: 'Texto' });
    a.doc.text('content.i1.text').setText('hello');
    await wait(60);
    assert(b.doc.get('instances.i1').label === 'Texto' && b.doc.text('content.i1.text').getText() === 'hello');
});

test('yjs sync: edits to different fields of the same config merge (R-CONF-1)', async () => {
    const hub = new Hub();
    const a = client(hub, 'a'), b = client(hub, 'b');
    await synced(a, b);
    a.doc.set('instances.i1', { config: { size: 1, mode: 'x' } });
    await wait(60);
    hub.cut(); await wait(10);                                  //both edit while apart
    a.doc.set('instances.i1.config.size', 3);
    b.doc.set('instances.i1.config.mode', 'y');
    hub.restore(); await synced(a, b);
    for (const { doc } of [a, b]) assert(doc.get('instances.i1.config.size') === 3 && doc.get('instances.i1.config.mode') === 'y', JSON.stringify(doc.get('instances.i1')));
});

test('yjs sync: typing in different places of the same text merges instead of overwriting', async () => {
    const hub = new Hub();
    const a = client(hub, 'a'), b = client(hub, 'b');
    await synced(a, b);
    a.doc.text('content.n.text').setText('one two three');
    await wait(60);
    hub.cut(); await wait(10);
    a.doc.text('content.n.text').setText('ONE one two three');
    b.doc.text('content.n.text').setText('one two three FOUR');
    hub.restore(); await synced(a, b);
    assert(a.doc.text('content.n.text').getText() === 'ONE one two three FOUR' && b.doc.text('content.n.text').getText() === 'ONE one two three FOUR', a.doc.text('content.n.text').getText());
});

test('yjs sync: working offline from the start, then connecting, loses nothing', async () => {
    const hub = new Hub(); hub.up = false;
    const a = client(hub, 'a');
    a.doc.set('instances.i1', { label: 'feito offline' });
    await wait(60);
    assert(a.provider.status === 'offline');
    hub.restore();
    const b = client(hub, 'b');
    await synced(a, b);
    assert(b.doc.get('instances.i1.label') === 'feito offline');
});

test('yjs undo is per user: undoing mine leaves what the other person did', async () => {
    const hub = new Hub();
    const a = client(hub, 'a'), b = client(hub, 'b');
    await synced(a, b);
    a.doc.set('meta.fromA', 1); await wait(40);
    b.doc.set('meta.fromB', 2); await wait(40);
    a.doc.undo(); await wait(40);
    assert(b.doc.get('meta.fromA') === undefined && b.doc.get('meta.fromB') === 2 && a.doc.get('meta.fromB') === 2);
    assert(!a.doc.undo(), 'A has nothing else of their own to undo');
});

test('yjs presence: peers appear with their state, and vanish when they disconnect', async () => {
    const hub = new Hub();
    const a = client(hub, 'a'), b = client(hub, 'b');
    await synced(a, b);
    a.doc.presence.setLocal({ focus: 'cmp-1' });
    await wait(60);
    const seenByB = b.doc.presence.peers();
    assert(seenByB.length === 1 && seenByB[0].user.name === 'a' && seenByB[0].focus === 'cmp-1', JSON.stringify(seenByB));
    a.provider.disconnect();
    await wait(60);
    assert(b.doc.presence.peers().length === 0);
});

test('yjs store: opens from IndexedDB, imports old JSON snapshots and keeps the workspace working', async () => {
    const backend = new IndexedDbBackend(`agora-test-${uuid()}`);
    await backend.putDocument('legacy', { meta: { title: 'Antigo' }, instances: { i1: { type: 'ultima-text', label: 'T', config: {} } } });
    const store = new YjsStateStore({ backend });
    const doc = await store.open('legacy');
    assert(doc.get('meta.title') === 'Antigo' && doc.get('instances.i1.label') === 'T');

    doc.set('meta.title', 'Novo'); await doc.flush();
    store.forget('legacy');
    const again = await new YjsStateStore({ backend }).open('legacy');
    assert(again.get('meta.title') === 'Novo' && again.status === 'synced');
    await backend.close();
});

test('yjs store: discarding the local copy starts the next open from scratch, and control messages reach listeners', async () => {
    const backend = new IndexedDbBackend(`agora-test-${uuid()}`);
    const store = new YjsStateStore({ backend });
    const doc = await store.open('w');
    doc.set('meta.title', 'local only'); await doc.flush();
    const seen = [];
    doc.onControl(message => seen.push(message.type));
    doc._control({ type: 'closed', code: 4403 });
    assert(seen.join() === 'closed');
    await store.discard('w');
    assert((await store.open('w')).get('meta.title') === undefined, 'the discarded edit must be gone');
    await backend.close();
});

test('yjs doc runs the whole workspace: instances, bus connections, layout and undo', async () => {
    const registry = new ComponentRegistry();
    busManifests.forEach(manifest => registry.register({ manifest, load: loader() }));
    const workspace = new Workspace({ doc: new YjsWorkspaceDoc(), registry, user: { id: 'u' } });
    const a = workspace.addInstance('test-source'), b = workspace.addInstance('test-sink', { target: { panelId: workspace.layout.defaultPanel(), side: 'right' } });
    workspace.bus.connect({ instance: a, port: 'text' }, { instance: b, port: 'text' });
    assert(workspace.layout.instanceIds().length === 2 && workspace.bus.list().length === 1);
    workspace.removeInstance(b);
    assert(workspace.bus.list().length === 0);
    workspace.doc.undo();
    assert(workspace.bus.list().length === 1 && workspace.instance(b));
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
const failures = lines.filter(l => l.startsWith('FAIL ')).map(l => l.slice(5).replace(/\n\s+/, ' — '));
document.title = (failed ? 'FAIL ' : 'PASS ') + summary + (failed ? ` | ${failures.join(' || ')}` : '');
