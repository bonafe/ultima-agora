import { ReactiveComponent } from '../vendor/ultima/reactive_component.js';
import { mix } from '../core/components/mix.js';
import { AgoraComponent } from '../core/components/agora_component.js';
import { validateManifest, validateConfig } from '../core/registry/manifest.js';
import { ComponentRegistry } from '../core/registry/component_registry.js';
import { MemoryStateStore } from '../collaboration/document/memory_state_store.js';
import { flattenTree, Layout } from '../core/workspace/layout.js';
import { Workspace } from '../core/workspace/workspace.js';
import { applyTemplate } from '../core/workspace/templates.js';
import { WELCOME } from '../ui/welcome/welcome_template.js';
import { DevHost } from '../adapters/dev/dev_host.js';
import { Y, syncProtocol, awarenessProtocol, encoding, decoding } from '../vendor/yjs/yjs.js';
import { YjsWorkspaceDoc } from '../collaboration/document/yjs_state_store.js';
import { YjsStateStore } from '../collaboration/providers/yjs_store.js';
import { SyncProvider } from '../collaboration/providers/sync_provider.js';
import { YjsPresence } from '../collaboration/presence/presence.js';
import { IndexedDbBackend } from '../collaboration/providers/indexeddb_persistence.js';
import { ChatClient } from '../collaboration/providers/chat_client.js';
import { MeshProvider } from '../conference/mesh/mesh_provider.js';
import { ConferenceError } from '../conference/conference_provider.js';
import { Resampler, Segmenter, cleanTranscript } from '../transcription/whisper/speech.js';
import { WhisperProvider } from '../transcription/whisper/whisper_provider.js';
import { Transcriber } from '../transcription/transcriber.js';
import { TranscriptClient } from '../collaboration/providers/transcript_client.js';
import { uuid } from '../core/ids.js';
import { TypeRegistry, registerCoreTypes } from '../core/connections/types.js';
import { BusError } from '../core/connections/bus.js';
import { layoutGraph } from '../components/graph/ultima-graph.js';
import { parseCsv } from '../components/table/ultima-table.js';
import { MemoryBackend } from '../collaboration/providers/indexeddb_persistence.js';
import { renderMarkdown } from '../components/markdown/markdown.js';
import { registerCoreComponents } from '../components/catalog.js';
import '../ui/workspace/agora-workspace.js';
import { boxSize } from '../core/components/box.js';
import '../ui/inspector/agora-inspector.js';
import '../ui/palette/agora-palette.js';
import '../ui/settings/agora-settings.js';
import '../ui/shell/agora-shell.js';
import { THEME_KEY } from '../ui/settings/agora-settings.js';

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

test('layout: a tab can be placed at a position, and dropped on its own panel at an index it is reordered', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a'); layout.place('b'); layout.place('c');
    layout.place('d', { panelId: first, index: 1 });
    assert(layout.panel(first).tabs.join() === 'a,d,b,c');
    layout.move('c', { panelId: first, side: 'center', index: 0 });
    assert(layout.panel(first).tabs.join() === 'c,a,d,b');
});

test('layout: dropping on the workspace edge wraps the whole tree, in one undo step', async () => {
    const doc = await openDoc();
    const layout = new Layout(doc);
    const first = layout.place('a');
    layout.place('b', { panelId: first, side: 'right' });
    layout.place('c', { root: true, side: 'bottom' });
    const root = layout.panel(layout.rootId);
    assert(root.kind === 'split' && root.dir === 'column', 'root is not a column split');
    assert(layout.tree().children[0].kind === 'split' && layout.tree().children[1].tabs.join() === 'c');
    layout.move('a', { root: true, side: 'left' });
    assert(layout.tree().children[0].tabs.join() === 'a' && layout.instanceIds().length === 3);
    doc.undo();
    assert(layout.findPanelOf('a') === first, 'undo did not restore the move');
});

test('layout: the only window of the workspace dropped on the workspace edge changes nothing', async () => {
    const layout = new Layout(await openDoc());
    layout.place('a');
    layout.move('a', { root: true, side: 'left' });
    assert(shape(layout) === '[a]');
});

test('bus: onDelivery tells who received a value, and stops when unsubscribed', async () => {
    const { bus, live } = await busWorkspace();
    const source = live('test-source'), sink = live('test-sink');
    bus.connect({ instance: source.id, port: 'text' }, { instance: sink.id, port: 'text' });
    const seen = [];
    const stop = bus.onDelivery((id, port) => seen.push(`${id === sink.id ? 'sink' : id}.${port}`));
    bus.publish(source.id, 'text', 'um');
    await flush();
    stop();
    bus.publish(source.id, 'text', 'dois');
    await flush();
    assert(seen.join() === 'sink.text', seen.join());
});

test('layout: flattenTree lists the instances in reading order, tabs in their order', async () => {
    const layout = new Layout(await openDoc());
    const first = layout.place('a'); layout.place('b');
    const right = layout.place('c', { panelId: first, side: 'right' });
    layout.place('d', { panelId: right, side: 'bottom' });
    assert(flattenTree(layout.tree()).join() === 'a,b,c,d', flattenTree(layout.tree()).join());
    assert(flattenTree(null).length === 0);
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

const mountView = async ({ width = 760 } = {}) => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const doc = await openDoc();
    const workspace = new Workspace({ doc, registry, user: { id: 'urn:user:t' } });
    const view = document.createElement('agora-workspace');
    view.style.cssText = `display:block;width:${width}px;height:300px`;
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

// --- detached windows: floating and other browser windows ---

const addTwo = async (view, workspace) => {
    const a = workspace.addInstance('ultima-text');
    await wait(300);
    const b = workspace.addInstance('ultima-notes');
    await wait(300);
    return { a, b };
};
const press = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y, ...extra }));

test('view: floating a window moves the SAME element to a floating frame; the tab says so; docking brings it back', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    const notes = instanceElement(view, b);
    notes.onDispose = () => { throw new Error('disposed while detaching'); };
    view.float(b);
    await wait(100);
    const frame = view.rootNode.querySelector('#floats .float');
    assert(frame && frame.contains(notes) && instanceElement(view, b) === notes, 'not in the floating frame');
    assert(view.rootNode.querySelector('.detached') && view.isDetached(b));
    assert(workspace.layout.findPanelOf(b), 'the shared layout must keep it in its panel');
    view.dock(b);
    await wait(100);
    assert(view.rootNode.querySelector('.tabpanel:not([hidden])').contains(instanceElement(view, b)) && !view.rootNode.querySelector('#floats .float') && !view.isDetached(b));
});

test('view: a window floated without a rect lies fully inside the workspace, so every edge can be grabbed', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    view.float(b);
    await wait(100);
    const layer = view.rootNode.querySelector('#floats').getBoundingClientRect(), f = view.rootNode.querySelector('#floats .float').getBoundingClientRect();
    assert(f.left >= layer.left - 1 && f.top >= layer.top - 1 && f.right <= layer.right + 1 && f.bottom <= layer.bottom + 1, `outside: ${[f.left, f.top, f.right, f.bottom]} vs ${[layer.left, layer.top, layer.right, layer.bottom]}`);
});

test('view: a floating window resizes from all four corners and four edges, the opposite side staying put', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    view.float(b, { x: 150, y: 10, w: 400, h: 200 });
    await wait(100);
    const frame = view.rootNode.querySelector('#floats .float');
    frame.scrollIntoView();
    const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: x, clientY: y }));
    for (const side of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
        const before = frame.getBoundingClientRect(), handle = frame.querySelector(`.float-handle.${side}`);
        assert(handle, `no ${side} handle`);
        const west = side.includes('w'), east = side.includes('e'), north = side.includes('n'), south = side.includes('s');
        const horizontal = west || east, vertical = north || south;
        const at = handle.getBoundingClientRect(), x0 = at.left + at.width / 2, y0 = at.top + at.height / 2;
        assert(frame.getRootNode().elementFromPoint(x0, y0) === handle, `${side}: something covers the handle`);
        fire(handle, 'pointerdown', x0, y0); fire(handle, 'pointermove', x0 + (west ? 20 : 30), y0 + (north ? 10 : 25)); fire(handle, 'pointerup', x0, y0);
        const after = frame.getBoundingClientRect();
        const dw = horizontal ? (west ? -20 : 30) : 0, dh = vertical ? (north ? -10 : 25) : 0;
        assert(Math.abs(after.width - (before.width + dw)) < 2 && Math.abs(after.height - (before.height + dh)) < 2, `${side}: size ${after.width}x${after.height}`);
        if (horizontal) assert(Math.abs((west ? after.right : after.left) - (west ? before.right : before.left)) < 2, `${side}: opposite side moved`);
        else assert(Math.abs(after.left - before.left) < 2, `${side}: x changed`);
        if (vertical) assert(Math.abs((north ? after.bottom : after.top) - (north ? before.bottom : before.top)) < 2, `${side}: opposite side moved`);
        else assert(Math.abs(after.top - before.top) < 2, `${side}: y changed`);
    }
});

test('view: closing an instance that is floating removes its frame', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    view.float(b);
    await wait(100);
    workspace.removeInstance(b);
    await wait(100);
    assert(!view.rootNode.querySelector('#floats .float'));
});

test('view: popping out moves the live element into the other window and docking brings it back; closing the window docks it', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    const frame = document.createElement('iframe');         //stands in for the browser window
    document.body.append(frame);
    view.openWindow = () => frame.contentWindow;
    const notes = instanceElement(view, b);
    assert(view.popout(b) === true);
    await wait(100);
    assert(notes.ownerDocument === frame.contentDocument && frame.contentDocument.title === 'Notas', `not moved: ${frame.contentDocument.title}`);
    assert(instanceElement(view, b) === null, 'still drawn in the main window');
    view.dock(b);
    await wait(100);
    assert(notes.ownerDocument === document && instanceElement(view, b) === notes);
    view.popout(b);
    await wait(100);
    frame.contentWindow.dispatchEvent(new Event('pagehide'));       //the person closes the window
    await wait(100);
    assert(!view.isDetached(b) && instanceElement(view, b) === notes && notes.ownerDocument === document);
    frame.remove();
});

test('view: Picture-in-Picture moves the live element in, docking brings it back, closing it docks; a refusal floats and tells the person', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    const frame = document.createElement('iframe');         //stands in for the PiP window
    document.body.append(frame);
    let asked = null;
    view.requestPip = async options => { asked = options; return frame.contentWindow; };
    assert(view.pipAvailable);
    const notes = instanceElement(view, b);
    assert(await view.pip(b) === true && asked.width > 0 && asked.height > 0);
    await wait(100);
    assert(notes.ownerDocument === frame.contentDocument && instanceElement(view, b) === null, 'not moved');
    view.dock(b);
    await wait(100);
    assert(notes.ownerDocument === document && instanceElement(view, b) === notes);
    await view.pip(b);
    await wait(100);
    frame.contentWindow.dispatchEvent(new Event('pagehide'));
    await wait(100);
    assert(!view.isDetached(b) && notes.ownerDocument === document, 'closing must dock');
    let notice = null;
    view.addEventListener('view-notice', event => { notice = event.detail.message; });
    view.requestPip = async () => { throw new Error('needs a gesture'); };
    assert(await view.pip(b) === false && notice && view.rootNode.querySelector('#floats .float'), 'a refusal must float and tell');
    frame.remove();
});

test('view: a blocked pop-up falls back to a floating window and tells the person', async () => {
    const { view, workspace } = await mountView();
    const { b } = await addTwo(view, workspace);
    let notice = null;
    view.addEventListener('view-notice', event => { notice = event.detail.message; });
    view.openWindow = () => null;
    assert(view.popout(b) === false);
    await wait(100);
    assert(notice?.includes('bloqueou') && view.rootNode.querySelector('#floats .float'));
});

test('view: dragging a tab by pointer onto another panel edge splits there; a click does not drag', async () => {
    const { view, workspace } = await mountView();
    const { a, b } = await addTwo(view, workspace);
    view.scrollIntoView();                                  //earlier tests leave views stacked below the window; "outside the window" is real here
    const tab = view.rootNode.querySelector(`.tab[data-id="${b}"]`);
    const t = tab.getBoundingClientRect();
    press(tab, 'pointerdown', t.left + 5, t.top + 5);
    press(tab, 'pointerup', t.left + 5, t.top + 5);
    assert(view.rootNode.querySelectorAll('.panel').length === 1, 'a click moved something');
    const area = view.rootNode.querySelector('#root').getBoundingClientRect();
    press(tab, 'pointerdown', t.left + 5, t.top + 5);
    press(tab, 'pointermove', t.left + 40, t.top + 40);
    press(tab, 'pointermove', area.left + area.width * 0.9, area.top + area.height * 0.5);
    const hint = view.rootNode.querySelector('#hint');
    assert(!hint.hidden && view.hasAttribute('dragging'), 'no drop highlight while dragging');
    press(tab, 'pointerup', area.left + area.width * 0.9, area.top + area.height * 0.5);
    await wait(300);
    assert(view.rootNode.querySelectorAll('.panel').length === 2 && !view.hasAttribute('dragging') && view.rootNode.querySelector('#hint').hidden);
    assert(workspace.layout.findPanelOf(a) !== workspace.layout.findPanelOf(b));
});

test('view: dragging a tab onto the tab bar of its own panel reorders; releasing outside the browser window pops it out', async () => {
    const { view, workspace } = await mountView();
    const { a, b } = await addTwo(view, workspace);
    view.scrollIntoView();
    const panelId = workspace.layout.findPanelOf(a);
    assert(workspace.layout.panel(panelId).tabs.join() === `${a},${b}`);
    const tab = view.rootNode.querySelector(`.tab[data-id="${b}"]`);
    const first = view.rootNode.querySelector(`.tab[data-id="${a}"]`).getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    press(tab, 'pointerdown', t.left + 5, t.top + 5);
    press(tab, 'pointermove', first.left + 2, first.top + 5);
    press(tab, 'pointerup', first.left + 2, first.top + 5);
    await wait(300);
    assert(workspace.layout.panel(panelId).tabs.join() === `${b},${a}`, workspace.layout.panel(panelId).tabs.join());

    const frame = document.createElement('iframe');
    document.body.append(frame);
    let features = null;
    view.openWindow = (url, name, f) => { features = f; return frame.contentWindow; };
    const moved = view.rootNode.querySelector(`.tab[data-id="${a}"]`);
    const m = moved.getBoundingClientRect();
    press(moved, 'pointerdown', m.left + 5, m.top + 5);
    press(moved, 'pointermove', -30, m.top + 5);
    assert(view.rootNode.querySelector('.ghost')?.textContent.includes('outra janela'));
    press(moved, 'pointerup', -30, m.top + 5, { screenX: 1500, screenY: 300 });
    await wait(200);
    assert(view.isDetached(a) && /left=1\d\d\d/.test(features ?? ''), `not popped out: ${features}`);
    frame.remove();
});

test('view: a personal window floats, goes to another window and hides without leaving the element behind; it is not an instance', async () => {
    const { view, workspace } = await mountView();
    const park = document.createElement('div');
    const element = document.createElement('div');
    element.textContent = 'chamada';
    park.append(element);
    const events = [];
    view.addEventListener('personal-change', event => events.push(event.detail.shown));
    view.showPersonal('shell:call', { title: 'Chamada', element, park });
    assert(view.isDetached('shell:call') && view.rootNode.querySelector('#floats .float .float-title').textContent === 'Chamada' && view.rootNode.querySelector('#floats').contains(element));
    assert(workspace.instances().length === 0 && view.selectedId === null, 'it is not part of the document');
    await wait(50);
    assert(view.rootNode.querySelector('#floats .float'), 'a repaint must not drop it');

    const frame = document.createElement('iframe');
    document.body.append(frame);
    view.openWindow = () => frame.contentWindow;
    assert(view.popout('shell:call') === true && element.ownerDocument === frame.contentDocument && !view.rootNode.querySelector('#floats .float'));
    frame.contentWindow.dispatchEvent(new Event('pagehide'));       //the person closes that window: the call is only hidden
    await wait(50);
    assert(!view.isDetached('shell:call') && park.contains(element) && element.ownerDocument === document, 'parked again');
    view.showPersonal('shell:call', { title: 'Chamada', element, park });
    view.hidePersonal('shell:call');
    assert(park.contains(element) && !view.isPersonalShown('shell:call') && !view.rootNode.querySelector('#floats .float'), 'hidden: parked, nothing left behind');
    frame.remove();
});

test('view: a personal window docks beside a panel as a tab or a split, only for this person, and never touches the document', async () => {
    const { view, workspace } = await mountView();
    const { a, b } = await addTwo(view, workspace);
    const panelId = workspace.layout.findPanelOf(a);
    const before = JSON.stringify(workspace.doc.get('layout'));
    const park = document.createElement('div');
    const element = document.createElement('div');
    element.textContent = 'chamada';
    park.append(element);
    view.showPersonal('shell:call', { title: 'Chamada', element, park });
    view.dockPersonal('shell:call', { panelId, side: 'center' });
    await wait(100);
    assert(!view.rootNode.querySelector('#floats .float') && view.rootNode.querySelector('.tabpanel:not([hidden])').contains(element), 'a tab of that panel, active');
    assert(tabLabels(view).includes('Chamada') && view.isPersonalShown('shell:call') && !view.isDetached('shell:call'));

    view.dockPersonal('shell:call', { panelId, side: 'right' });
    await wait(100);
    assert(view.rootNode.querySelectorAll('.panel').length === 2, 'a split of its own');
    assert(JSON.stringify(workspace.doc.get('layout')) === before && !workspace.doc.get('instances.shell:call'), 'the shared document is untouched');

    //dragging an instance onto the personal panel lands in the real panel it hangs from
    const tab = view.rootNode.querySelector(`.tab[data-id="${a}"]`);
    view.scrollIntoView();
    const personalPanel = [...view.rootNode.querySelectorAll('.panel')].find(p => p.contains(element));
    const r = personalPanel.getBoundingClientRect(), t = tab.getBoundingClientRect();
    press(tab, 'pointerdown', t.left + 5, t.top + 5);
    press(tab, 'pointermove', r.left + r.width / 2, r.top + r.height * 0.6);
    press(tab, 'pointerup', r.left + r.width / 2, r.top + r.height * 0.6);
    await wait(200);
    assert(workspace.layout.panel(panelId) && workspace.layout.findPanelOf(a) === panelId, 'no document change aimed at a panel that only exists for me');

    //its panel goes away from under it: it floats instead of vanishing
    workspace.removeInstance(a); workspace.removeInstance(b);
    await wait(200);
    assert(view.isPersonalShown('shell:call') && (view.isDetached('shell:call') || view.rootNode.contains(element) || view.rootNode.querySelector('.panel')), 'still shown');

    view.hidePersonal('shell:call');
    await wait(50);
    assert(park.contains(element) && !view.rootNode.querySelector('.panel'), 'hidden again');
});

test('call window: one window per person while I am in the call, composed with the same docking as the rest', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const call = newCall();
    const ana = call.join('Ana'), bia = call.join('Bia');
    const element = document.createElement('agora-call');
    element.style.cssText = 'display:block;width:520px;height:420px';
    document.body.append(element);
    await element.init({ parent: { conference: ana.room, transcript: null, transcriber: null, user: ana.user, id: 'w-call' }, registry });
    const view = element.rootNode.querySelector('agora-workspace');
    const people = () => element.workspace.instances().filter(i => i.type === 'ultima-call-person');
    assert(view.hidden && people().length === 0, `out of the call: no windows (${view.hidden} ${people().length})`);

    await ana.room.join({}); await bia.room.join({});
    await wait(100);
    assert(!view.hidden && people().length === 2 && people().map(i => i.label).sort().join() === 'Ana,Bia', people().map(i => i.label).join());
    assert(view.rootNode.querySelectorAll('.panel').length === 2, `each person in a panel of their own (${view.rootNode.querySelectorAll('.panel').length})`);
    const bob = view.rootNode.querySelector(`[data-instance-id="${people().find(i => i.label === 'Bia').id}"]`);
    assert(bob && await untilTrue(() => bob.rootNode?.querySelector('.tile')), `the tile is drawn (${!!bob})`);

    view.float(people().find(i => i.label === 'Bia').id);
    await wait(100);
    assert(view.rootNode.querySelector('#floats .float')?.contains(bob), 'a person can float out of the call window too');

    await bia.room.leave();
    await wait(100);
    assert(people().length === 1 && !view.rootNode.querySelector('#floats .float'), `whoever leaves loses their window (${people().length} ${!!view.rootNode.querySelector('#floats .float')})`);
    element.dispose(); element.remove();
    ana.room.destroy(); bia.room.destroy();
});

test('compact: a narrow workspace shows ONE window at a time with a bar; the same elements, not recreated, come back when it widens', async () => {
    const { view, workspace } = await mountView({ width: 760 });
    const { a, b } = await addTwo(view, workspace);
    const text = instanceElement(view, a), notes = instanceElement(view, b);
    text.onDispose = notes.onDispose = () => { throw new Error('disposed by a change of presentation'); };
    assert(!view.compact && !view.rootNode.querySelector('.compact-bar'), 'wide: the docking presentation');

    view.style.width = '390px';
    assert(await untilTrue(() => view.compact && view.rootNode.querySelector('.compact-bar')), 'narrow: compact');
    await wait(100);
    const visible = () => [...view.rootNode.querySelectorAll('.compact-stage > .tabpanel')].filter(p => !p.hidden).map(p => p.dataset.id);
    assert(visible().join() === b, `the newest window is the one shown (${visible()})`);
    assert(instanceElement(view, a) === text && instanceElement(view, b) === notes, 'the live elements were moved, not recreated');
    assert(view.rootNode.querySelectorAll('.compact-tab').length === 2 && view.rootNode.querySelector('.compact-tab[aria-selected="true"]').dataset.id === b);

    notes.dataset.mark = 'kept';
    view.rootNode.querySelector(`.compact-tab[data-id="${a}"]`).click();
    assert(visible().join() === a && instanceElement(view, b) === notes && notes.dataset.mark === 'kept', 'switching only flips what is visible');
    assert(view.selectedId === a, 'and tells the inspector');

    view.style.width = '760px';
    assert(await untilTrue(() => !view.compact && view.rootNode.querySelector('.panel')), 'wide again');
    await wait(100);
    assert(instanceElement(view, a) === text && instanceElement(view, b) === notes && view.rootNode.querySelectorAll('.panel').length === 1);
    view.remove();
});

test('compact: a floating window is shown in the list while narrow and floats again when wide; the document is never touched', async () => {
    const { view, workspace } = await mountView({ width: 760 });
    const { b } = await addTwo(view, workspace);
    view.float(b);
    await wait(100);
    const before = JSON.stringify(workspace.doc.get('layout'));
    view.style.width = '390px';
    assert(await untilTrue(() => view.compact));
    await wait(100);
    const notes = instanceElement(view, b);
    assert(view.rootNode.querySelector('.compact-stage').contains(notes), 'in the list while narrow');
    view.style.width = '760px';
    assert(await untilTrue(() => !view.compact && view.rootNode.querySelector('#floats .float')?.contains(instanceElement(view, b))), 'floating again');
    assert(JSON.stringify(workspace.doc.get('layout')) === before);
    view.remove();
});

test('compact: the sheet lists every window and renames, closes and asks to add; a viewer cannot change anything', async () => {
    const { view, workspace } = await mountView({ width: 390 });
    const { a, b } = await addTwo(view, workspace);
    let addAsked = 0;
    view.addEventListener('compact-add', () => addAsked++);
    assert(await untilTrue(() => view.compact && view.rootNode.querySelector('.compact-more')));
    view.rootNode.querySelector('.compact-more').click();
    await wait(50);
    const sheet = () => view.rootNode.querySelector('.sheet');
    assert(sheet() && sheet().querySelectorAll('li').length === 2, 'the list of all windows');

    sheet().querySelector('button[aria-label^="Renomear"]').click();
    await wait(50);
    const input = sheet().querySelector('input.rename');
    input.value = 'Minha anotação';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await wait(100);
    assert(workspace.instances().some(i => i.label === 'Minha anotação'), 'renamed in the document');

    view.rootNode.querySelector('.compact-more').click();
    await wait(50);
    sheet().querySelector('.add').click();
    await wait(50);
    assert(addAsked === 1 && !sheet(), 'asks the shell for the palette and closes');

    view.rootNode.querySelector('.compact-more').click();
    await wait(50);
    sheet().querySelector('button[aria-label^="Fechar "]:not([aria-label="Fechar lista"])').click();
    await wait(100);
    assert(workspace.instances().length === 1);

    workspace.doc.role = 'viewer';
    view.rootNode.querySelector('.compact-more').click();
    await wait(100);
    assert(!sheet()?.querySelector('.add') && !sheet()?.querySelector('button[aria-label^="Renomear"]'), 'read-only: no rename, close or add');
    view.remove();
});

test('compact: a window that receives a value while hidden gets a dot, cleared when looked at; windows never seen get none', async () => {
    const { view, workspace } = await mountView({ width: 390 });
    const table = workspace.addInstance('ultima-table');
    await wait(300);
    const graph = workspace.addInstance('ultima-graph');
    await wait(300);
    assert(await untilTrue(() => view.compact && view.rootNode.querySelector('.compact-tab')));
    const dot = id => !!view.rootNode.querySelector(`.compact-tab[data-id="${id}"] .activity`);
    workspace.bus.connect({ instance: table, port: 'graph' }, { instance: graph, port: 'graph' });
    workspace.bus.publish(table, 'graph', { nodes: [{ id: 'a', label: 'A' }], edges: [] });
    await wait(150);
    assert(!dot(table) && !dot(graph), 'the graph is the one shown; the table was never looked at');
    view.showWindow(table);
    view.showWindow(graph);                                 //both seen; the graph is now shown
    view.showWindow(table);                                 //the graph is hidden
    workspace.bus.publish(table, 'graph', { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] });
    await wait(150);
    assert(dot(graph), 'news in a hidden window');
    view.showWindow(graph);
    assert(!dot(graph), 'looking clears it');
    view.remove();
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

// --- the contract suite: every component of the catalog (acceptance criterion 19) ---

const servicesFor = (manifest, emitted) => {
    const capabilities = manifest.capabilities ?? [];
    const services = {};
    if (capabilities.includes('connectable')) { services.emit = (port, value) => emitted.push([port, value]); services.ports = { value: () => undefined }; }
    if (capabilities.includes('shared-content')) {
        let text = '';
        services.shared = { getText: () => text, setText: next => { text = next; }, onChange: () => () => {}, canEdit: true };
    }
    if (capabilities.includes('presence-aware')) services.presence = { setActivity: () => {} };
    if (capabilities.includes('domain-data')) services.domain = { get: async () => ({ results: [] }), forWorkspace() { return this; } };
    if (capabilities.includes('conference')) services.conference = new MeshProvider({ mediaDevices: null }).connect({ roomId: 'contract', me: { id: 'u', name: 'U' }, signaling: { clientId: 1, send: () => false, onSignal: () => () => {} }, presence: { local: {}, setLocal() {}, peers: () => [], onPeers: () => () => {} } });
    if (capabilities.includes('transcript')) {
        services.transcript = new TranscriptClient({ me: { id: 'u', name: 'U' } });
        services.transcriber = new Transcriber({ engine: { supported: true, load: async () => {}, start: () => ({ stop() {} }) }, client: services.transcript, storage: null,
            room: { on: () => () => {}, joined: false, localAudioTrack: null, setTranscribing() {} } });
    }
    if (capabilities.includes('chat')) services.chat = new ChatClient({ workspaceId: 'contract', me: { id: 'u', name: 'U' }, send: () => false });
    services.setConfig = () => [];
    return services;
};

test('contract: every component of the catalog honours the AgoraComponent contract', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const manifests = registry.list();
    for (const name of ['ultima-text', 'ultima-notes', 'ultima-table', 'ultima-graph', 'ultima-chat', 'ultima-conference', 'ultima-transcript']) assert(manifests.some(m => m.name === name), `the catalog lost ${name}`);

    for (const manifest of manifests) {
        const label = manifest.name;
        assert(validateManifest(manifest).length === 0, `${label}: manifest invalid`);
        assert(manifest.name === manifest.tag && /^\d+\.\d+\.\d+$/.test(manifest.version), `${label}: name/tag/version`);

        const Component = await registry.load(manifest.name);
        assert(customElements.get(manifest.tag) === Component, `${label}: custom element not defined by the registry`);

        const emitted = [];
        const element = document.createElement(manifest.tag);
        assert(element.attach && element.deliverInput && element.invokeAction && element.dispose, `${label}: is not an AgoraComponent`);
        element.attach({ instanceId: `contract-${label}`, manifest, config: {}, services: servicesFor(manifest, emitted) });
        element.style.cssText = 'display:block;width:400px;height:300px';
        document.body.append(element);
        assert(await settleOrTimeout(element.whenLoaded(), 3000), `${label}: never finished loading`);
        await wait(150);

        //Defaults come from the manifest, and nothing outside it
        const configKeys = Object.keys(element.config);
        assert(configKeys.every(key => key in (manifest.config ?? {})), `${label}: config has keys the manifest does not declare: ${configKeys}`);

        //It only emits what it declared, and what it emits is valid for the declared type
        for (const [port, value] of emitted) {
            assert(manifest.outputs?.[port], `${label}: emitted "${port}", which is not a declared output`);
            const problem = registry.types.validate(manifest.outputs[port].type, value);
            assert(!problem, `${label}.${port}: ${problem}`);
        }

        //Inputs tolerate "nothing" (a disconnected port) and every declared action exists
        for (const port of Object.keys(manifest.inputs ?? {})) { element.deliverInput(port, undefined); }
        for (const [name, spec] of Object.entries(manifest.actions ?? {})) {
            let result;
            try { result = await element.invokeAction(name); } catch (error) { assert(!(error instanceof TypeError), `${label}.${name}: ${error.message}`); continue; }
            if (spec.produces && result !== undefined) assert(!registry.types.validate(spec.produces, result), `${label}.${name}: result is not a ${spec.produces}`);
        }
        try { element.invokeAction('no-such-action'); throw new Error('accepted'); } catch (error) { assert(error.message.includes('unknown action'), `${label}: ${error.message}`); }

        //The agent context is small and plain JSON
        const context = element.describeContext();
        const json = JSON.stringify(context);
        assert(json !== undefined && json.length < 2000 && JSON.stringify(JSON.parse(json)) === json, `${label}: describeContext is not small, plain JSON`);

        //Capabilities it did not declare stay closed (R-CAP-1)
        for (const [service, capability] of [['shared', 'shared-content'], ['chat', 'chat'], ['conference', 'conference'], ['transcript', 'transcript'], ['transcriber', 'transcript'], ['domain', 'domain-data'], ['presence', 'presence-aware']]) {
            if (!(manifest.capabilities ?? []).includes(capability)) { try { void element[service]; throw new Error('open'); } catch (error) { assert(error.message.includes(capability), `${label}: "${service}" must need "${capability}"`); } }
        }

        element.dispose();
        element.remove();
    }
});

// --- chat ---

const msg = (seq, author, body, extra = {}) => ({ id: `m${seq}`, seq, clientId: `c${seq}`, author: { id: author, name: author }, body, mentions: [], createdAt: new Date(2026, 9, 5, 10, seq).toISOString(), ...extra });
const newChat = (over = {}) => {
    const sent = [];
    let connected = over.connected ?? true;
    const chat = new ChatClient({
        workspaceId: over.workspaceId ?? 'w1', me: { id: 'me', name: 'Maria Souza' }, storage: over.storage ?? null,
        send: request => { if (!connected) return false; sent.push(request); return true; }, canWrite: () => over.canWrite ?? true, available: () => over.available ?? true,
    });
    return { chat, sent, connect: value => { connected = value; } };
};

test('chat client: sending is optimistic, goes through an outbox, and the confirmation replaces the pending copy (no duplicate)', async () => {
    const { chat, sent, connect } = newChat({ connected: false });
    const clientId = chat.send('oi, tudo bem?');
    assert(chat.messages.length === 1 && chat.messages[0].pending === 'pending' && sent.length === 0, 'offline: pending, nothing sent');
    connect(true); chat.flush();
    assert(sent.length === 1 && sent[0].clientId === clientId && chat.messages[0].pending === 'sending');
    chat.receive({ type: 'message', message: msg(1, 'me', 'oi, tudo bem?', { clientId }) });
    assert(chat.messages.length === 1 && !chat.messages[0].pending && chat.messages[0].id === 'm1', 'confirmed, not duplicated');
    chat.receive({ type: 'message', message: msg(1, 'me', 'oi, tudo bem?', { clientId }) });
    assert(chat.messages.length === 1, 'a repeated delivery changes nothing');
});

test('chat client: refusals are shown on the message; rate limiting just waits; empty and read-only are refused up front', async () => {
    const { chat } = newChat();
    const id = chat.send('algo');
    chat.receive({ type: 'error', ref: id, code: 'forbidden', message: 'Seu papel só permite ler o chat.' });
    assert(chat.messages[0].pending === 'failed' && chat.messages[0].error.includes('só permite ler'));
    chat.retry(id);
    assert(chat.messages[0].pending === 'sending');
    chat.receive({ type: 'error', ref: id, code: 'rate', message: 'devagar' });
    assert(chat.messages[0].pending === 'pending' && !chat.messages[0].error, 'rate: kept, will go out later');
    chat.discard(id);
    assert(chat.messages.length === 0);
    try { chat.send('   '); throw new Error('accepted'); } catch (error) { assert(error.message.includes('vazia')); }
    const viewer = newChat({ canWrite: false }).chat;
    try { viewer.send('x'); throw new Error('accepted'); } catch (error) { assert(error.message.includes('só permite ler')); }
});

test('chat client: unread and mentions count what others wrote since you last read; your own never count', async () => {
    const { chat } = newChat();
    chat.receive({ type: 'history', messages: [msg(1, 'ana', 'bom dia'), msg(2, 'ana', 'veja', { mentions: ['maria'] }), msg(3, 'me', 'ok'), msg(4, 'bia', 'e @mariasouza?', { mentions: ['mariasouza'] }), msg(5, 'ana', 'para outra', { mentions: ['joao'] })], hasMore: true });
    assert(chat.unread === 4 && chat.unreadMentions === 2, `${chat.unread}/${chat.unreadMentions}`);
    assert(chat.mentionsMe({ mentions: ['mariasouza'] }) && chat.mentionsMe({ mentions: ['maria'] }) && !chat.mentionsMe({ mentions: ['mario'] }));
    chat.receive({ type: 'deleted', message: msg(5, 'ana', '', { deletedAt: 'x' }) });
    assert(chat.unread === 3, 'a deleted message is no longer unread');
    chat.markRead();
    assert(chat.unread === 0 && chat.lastRead === 5);
});

test('chat client: the history lives on this device (chat reads offline) together with the unsent messages and what was read', async () => {
    const backend = new MemoryBackend();
    const first = newChat({ storage: backend, connected: false });
    first.chat.receive({ type: 'history', messages: [msg(1, 'ana', 'guardada aqui')], hasMore: false });
    first.chat.markRead();
    first.chat.send('escrita no avião');
    await wait(50);
    const reopened = newChat({ storage: backend, connected: false });
    await reopened.chat.ready;
    assert(reopened.chat.messages.map(m => m.body).join('|') === 'guardada aqui|escrita no avião', reopened.chat.messages.map(m => m.body).join('|'));
    assert(reopened.chat.messages[1].pending === 'pending' && reopened.chat.lastRead === 1);
    reopened.connect(true); reopened.chat.onConnected();
    assert(reopened.sent.some(r => r.type === 'history') && reopened.sent.some(r => r.type === 'send' && r.body === 'escrita no avião'), 'on reconnect: ask for what was missed, send what waited');
    assert((await backend.cacheEntries()).length === 0, 'chat is not host data: the classification cache policy never touches it');
});

test('chat client: history from the server wins over what we had (edits and deletions made while away)', async () => {
    const { chat } = newChat();
    chat.receive({ type: 'history', messages: [msg(1, 'ana', 'versão antiga'), msg(2, 'ana', 'vai sumir')], hasMore: false });
    chat.receive({ type: 'history', messages: [msg(1, 'ana', 'versão nova', { editedAt: 'x' }), msg(2, 'ana', '', { deletedAt: 'y' }), msg(3, 'bia', 'chegou')], hasMore: false });
    assert(chat.messages.map(m => m.body).join('|') === 'versão nova||chegou' && chat.messages[1].deletedAt);
});

const mountChat = async (chat) => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    await registry.load('ultima-chat');
    const element = document.createElement('ultima-chat');
    element.style.cssText = 'display:block;width:320px;height:360px';
    element.attach({ instanceId: 'chat-test', manifest: registry.getManifest('ultima-chat'), config: {}, services: { chat } });
    document.body.append(element);
    assert(await settleOrTimeout(element.whenLoaded()));
    await chat.ready;
    await wait(40);
    return element;
};

test('chat component: renders safely (no input becomes markup), highlights mentions of you, and marks edited/removed', async () => {
    const { chat } = newChat();
    chat.receive({ type: 'history', messages: [
        msg(1, 'ana', '<img src=x onerror=alert(1)> **negrito** e [link](https://example.com) [x](javascript:alert(1))'),
        msg(2, 'bia', 'oi @maria e @mariasouza, não @mariana', { mentions: ['maria', 'mariasouza', 'mariana'] }),
        msg(3, 'ana', 'corrigida', { editedAt: 'x' }), msg(4, 'ana', '', { deletedAt: 'y' }),
    ], hasMore: false });
    const element = await mountChat(chat);
    const log = element.rootNode.querySelector('#log');
    assert(!log.querySelector('img') && !log.querySelector('script'), 'HTML typed by someone is text, not markup');
    assert(log.querySelector('strong')?.textContent === 'negrito' && log.querySelector('a[href="https://example.com"]'));
    assert(![...log.querySelectorAll('a')].some(a => a.getAttribute('href').startsWith('javascript')), 'only http(s) links');
    const marks = [...log.querySelectorAll('mark')].map(m => m.textContent);
    assert(marks.join() === '@maria,@mariasouza', `mentions of me highlighted, not @mariana: ${marks}`);
    assert(log.querySelector('.mentions-me') && log.textContent.includes('(editada)') && log.textContent.includes('Mensagem removida'));
    assert(log.querySelector('.divider')?.textContent === 'Novas mensagens', 'where the unread start');
    element.remove();
});

test('chat component: Enter sends, Shift+Enter does not; pending and failed messages offer their actions; own messages can be edited and removed', async () => {
    const { chat, sent } = newChat();
    const element = await mountChat(chat);
    const text = element.rootNode.querySelector('#text');
    text.value = 'primeira linha';
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    assert(sent.length === 0 && text.value === 'primeira linha', 'Shift+Enter is a new line, not a send');
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert(sent.length === 1 && sent[0].body === 'primeira linha' && text.value === '', 'Enter sends and clears');
    await wait(30);
    assert(element.rootNode.querySelector('.state').textContent === 'Enviando…');

    chat.receive({ type: 'error', ref: sent[0].clientId, code: 'forbidden', message: 'Seu papel só permite ler o chat.' });
    await wait(30);
    const failed = element.rootNode.querySelector('.failed-actions');
    assert(failed && [...failed.querySelectorAll('button')].map(b => b.textContent).join() === 'Tentar de novo,Descartar');
    [...failed.querySelectorAll('button')].find(b => b.textContent === 'Descartar').click();
    await wait(30);
    assert(!element.rootNode.querySelector('.failed-actions'));

    chat.receive({ type: 'message', message: msg(7, 'me', 'minha mensagem') });
    chat.receive({ type: 'message', message: msg(8, 'ana', 'da Ana') });
    await wait(40);
    const own = element.rootNode.querySelector('[data-id="m7"]'), others = element.rootNode.querySelector('[data-id="m8"]');
    assert([...own.querySelectorAll('.actions button')].map(b => b.textContent).join() === 'Editar,Remover');
    assert(!others.querySelector('.actions button'), 'nobody else\'s message can be edited or removed from here');
    sent.length = 0;
    [...own.querySelectorAll('.actions button')].find(b => b.textContent === 'Editar').click();
    await wait(30);
    const editor = element.rootNode.querySelector('.edit textarea');
    editor.value = 'minha mensagem corrigida';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert(sent[0].type === 'edit' && sent[0].id === 'm7' && sent[0].body === 'minha mensagem corrigida');
    await wait(30);
    [...element.rootNode.querySelector('[data-id="m7"]').querySelectorAll('.actions button')].find(b => b.textContent === 'Remover').click();
    assert(sent[1].type === 'delete' && sent[1].id === 'm7');
    element.remove();
});

test('chat component: a viewer reads without a composer; without a collaboration server it says so; with no chat service it degrades', async () => {
    const viewer = await mountChat(newChat({ canWrite: false }).chat);
    assert(viewer.rootNode.querySelector('#composer').hidden && viewer.rootNode.querySelector('#notice').textContent.includes('só permite ler'));
    viewer.remove();
    const offline = await mountChat(newChat({ available: false }).chat);
    assert(offline.rootNode.querySelector('#composer').hidden && offline.rootNode.querySelector('#notice').textContent.includes('servidor de colaboração'));
    offline.remove();

    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    await registry.load('ultima-chat');
    const bare = document.createElement('ultima-chat');
    bare.attach({ instanceId: 'x', manifest: registry.getManifest('ultima-chat'), config: {}, services: { chat: undefined } });
    document.body.append(bare);
    assert(await settleOrTimeout(bare.whenLoaded()));
    assert(bare.rootNode.querySelector('#notice').textContent.includes('não está disponível'));
    bare.remove();
});

test('chat in the shell: the drawer button counts unread messages, colours mentions, and opening it marks everything read', async () => {
    const host = new DevHost({ dbName: `agora-test-${uuid()}` });
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const shell = document.createElement('agora-shell');
    shell.style.cssText = 'display:block;width:900px;height:500px';
    const savedHash = location.hash;
    document.body.append(shell);
    assert(await settleOrTimeout(shell.whenLoaded()));
    await shell.init({ host, registry });
    await wait(300);
    const root = shell.shadowRoot;
    const toggle = root.querySelector('#chat-toggle'), badge = root.querySelector('#chat-badge');
    assert(!toggle.hidden, 'the host provides a chat, so the button exists');
    const chat = shell.workspace.chat;
    chat.receive({ type: 'history', messages: [msg(1, 'ana', 'oi'), msg(2, 'ana', 'veja', { mentions: [host.identity.name.toLowerCase().split(/\s+/)[0]] })], hasMore: false });
    await wait(40);
    assert(badge.textContent === '2' && !badge.hidden, `badge shows ${badge.textContent}`);
    assert(toggle.getAttribute('aria-label').includes('2 mensagem') && toggle.getAttribute('aria-label').includes('mencionando você'), toggle.getAttribute('aria-label'));
    assert(document.title.startsWith('(2)'));
    for (const pane of ['#chat-pane', '#call-pane']) assert(getComputedStyle(root.querySelector(pane)).display === 'none', `${pane} is really hidden until opened`);
    toggle.click();
    await wait(60);
    assert(!root.querySelector('#chat-pane').hasAttribute('hidden') && root.querySelector('#chat-pane ultima-chat'));
    assert(chat.unread === 0 && badge.hidden && !document.title.startsWith('('), 'opened: read, badge gone');
    shell.remove();
    history.replaceState(null, '', location.pathname + savedHash);
    await host.destroy();
});

test('shell on a small screen: panes are sheets one at a time with a scrim, the secondary buttons hide behind the menu, and it all comes back when wide', async () => {
    const host = new DevHost({ dbName: `agora-test-${uuid()}` });
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const shell = document.createElement('agora-shell');
    shell.style.cssText = 'display:block;width:390px;height:600px';
    const savedHash = location.hash;
    document.body.append(shell);
    assert(await settleOrTimeout(shell.whenLoaded()));
    await shell.init({ host, registry });
    await wait(300);
    const root = shell.shadowRoot;
    const shown = selector => getComputedStyle(root.querySelector(selector)).display !== 'none';
    assert(await untilTrue(() => shell.hasAttribute('compact')), 'narrow: compact');
    assert(root.querySelector('agora-workspace').compact, 'and so is the workspace, by its own width');
    assert(root.querySelector('#palette-pane').hidden && root.querySelector('#inspector-pane').hidden && root.querySelector('#scrim').hidden, 'no pane covers the work');
    assert(!shown('#new') && shown('#menu') && shown('#title'), 'only the essentials, and the menu');

    root.querySelector('#menu').click();
    await wait(30);
    assert(shown('#new') && root.querySelector('#menu').getAttribute('aria-expanded') === 'true', 'the menu brings the rest');
    root.querySelector('#menu').click();

    root.querySelector('#toggle-palette').click();
    assert(!root.querySelector('#palette-pane').hidden && !root.querySelector('#scrim').hidden, 'a sheet and the scrim');
    root.querySelector('#toggle-inspector').click();
    assert(root.querySelector('#palette-pane').hidden && !root.querySelector('#inspector-pane').hidden, 'one sheet at a time');
    assert(root.querySelector('#toggle-palette').getAttribute('aria-pressed') === 'false');
    root.querySelector('#scrim').click();
    assert(root.querySelector('#inspector-pane').hidden && root.querySelector('#scrim').hidden, 'the scrim closes it');

    root.querySelector('agora-workspace').dispatchEvent(new CustomEvent('compact-add', { bubbles: true, composed: true }));
    assert(!root.querySelector('#palette-pane').hidden, '"add" in the window list opens the palette');
    const before = shell.workspace.instances().length;
    root.querySelector('agora-palette').dispatchEvent(new CustomEvent('palette-add', { bubbles: true, composed: true, detail: { type: 'ultima-text' } }));
    await wait(100);
    assert(shell.workspace.instances().length === before + 1 && root.querySelector('#palette-pane').hidden, 'adding closes the sheet: back to the work');

    shell.style.width = '1100px';
    assert(await untilTrue(() => !shell.hasAttribute('compact')), 'wide again');
    assert(!root.querySelector('#palette-pane').hidden && !root.querySelector('#inspector-pane').hidden && root.querySelector('#scrim').hidden && shown('#new'), 'the desktop layout is back');
    shell.remove();
    history.replaceState(null, '', location.pathname + savedHash);
    await host.destroy();
});

// ---- welcome workspace (D-38) ----

test('templates: a template is applied through the controller, as ONE undo step, and a bad one changes nothing', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const doc = await openDoc();
    const workspace = new Workspace({ doc, registry, user: { id: 'u' } });
    const ids = applyTemplate(workspace, WELCOME);
    assert(workspace.title === WELCOME.title && workspace.instances().length === 4 && ids.size === 4);
    assert(workspace.layout.findPanelOf(ids.get('guia')) === workspace.layout.findPanelOf(ids.get('caderno')), 'the notebook is a tab beside the guide');
    assert(workspace.layout.findPanelOf(ids.get('guia')) !== workspace.layout.findPanelOf(ids.get('tabela')), 'the table has its own panel');
    const [link, ...rest] = workspace.bus.list();
    assert(!rest.length && link.from.instance === ids.get('tabela') && link.to.instance === ids.get('grafo') && link.to.port === 'graph');
    assert(workspace.sharedText(ids.get('guia')).getText().startsWith('# Bem-vindo'), 'the guide text is in the shared document');
    doc.undo();
    assert(workspace.instances().length === 0 && workspace.bus.list().length === 0, 'one undo removes the whole template');
    throws(() => applyTemplate(workspace, { title: 'Meio', instances: [{ key: 'x', type: 'nao-existe' }] }), 'not registered');
    assert(workspace.instances().length === 0 && workspace.title === '', 'nothing half-applied');
});

test('welcome in the shell: the first visit opens it ready (the table feeds the graph), the button brings a fresh one, a reload makes no extra', async () => {
    const host = new DevHost({ dbName: `agora-test-${uuid()}` });
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    const shell = document.createElement('agora-shell');
    shell.style.cssText = 'display:block;width:1100px;height:600px';
    const savedHash = location.hash;
    location.hash = '';
    document.body.append(shell);
    assert(await settleOrTimeout(shell.whenLoaded()));
    await shell.init({ host, registry });
    await wait(900);
    const workspace = shell.workspace;
    assert(workspace.title === WELCOME.title && workspace.instances().length === 4, 'first visit: the welcome workspace');
    const view = shell.shadowRoot.querySelector('agora-workspace');
    const graph = view.shadowRoot.querySelector('ultima-graph');
    assert(graph.rootNode.querySelectorAll('circle').length >= 6, 'the graph shows what the table emits');
    const notes = [...view.shadowRoot.querySelectorAll('ultima-notes')].find(n => n.shared.getText().startsWith('# Bem-vindo'));
    assert(!notes.rootNode.querySelector('#preview').hidden, 'the guide opens for reading');
    assert((await host.list()).length === 1 && !(await host.get(workspace.id)).seed, 'seeded once');
    shell.shadowRoot.querySelector('#welcome').click();
    await wait(900);
    assert((await host.list()).length === 2 && shell.workspace.id !== workspace.id && shell.workspace.instances().length === 4, 'the button makes another');
    shell.remove();
    history.replaceState(null, '', location.pathname + savedHash);
    await host.destroy();
});

// ---- settings dialog ----

const fakeHost = (over = {}) => {
    const calls = { logout: [], level: [], clear: 0 };
    return { calls, settings: {
        account: { name: 'Maria', logout: async options => { calls.logout.push(options); if (over.logoutFails) throw new Error('Sem conexão: não é possível sair agora.'); } },
        device: {
            cacheLevels: ['nenhum', 'publico', 'interno', 'restrito'], cacheLevel: 'interno',
            setCacheLevel: async level => { calls.level.push(level); },
            describe: async () => ({ workspaces: 3, cacheEntries: 12, pending: over.pending ?? 0 }),
            clear: async () => { calls.clear++; },
        },
    } };
};
const openSettings = async host => {
    const settings = document.createElement('agora-settings');
    document.body.append(settings);
    assert(await settleOrTimeout(settings.whenLoaded()));
    await settings.open({ host });
    await wait(60);
    return settings;
};
const q = (settings, selector) => settings.rootNode.querySelector(selector);

test('settings: shows account, device data and app settings, from what the host offers', async () => {
    const settings = await openSettings(fakeHost());
    assert(settings.isOpen);
    const text = q(settings, '#content').textContent;
    for (const expected of ['Maria', 'Sair', 'Nível do cache offline', 'Limpar este dispositivo', 'Tema', 'Rede', '12', 'Cópias de dados consultados']) assert(text.includes(expected), `missing "${expected}"`);
    assert([...q(settings, '#cache-level').options].map(o => o.value).join() === 'nenhum,publico,interno,restrito', 'only the levels the host allows');
    assert(q(settings, '#cache-level').value === 'interno');
    settings.close();
});

test('settings: a host without cache levels or logout (the dev host) simply does not show them', async () => {
    const settings = await openSettings({ settings: { account: { name: 'Dev' }, device: { describe: async () => ({ workspaces: 1 }), clear: async () => {} } } });
    assert(!q(settings, '#cache-level') && !q(settings, '#logout'));
    assert(q(settings, '#clear') && q(settings, '#theme'), 'clearing the device and the theme are always there');
    settings.close();
    const bare = await openSettings({});
    assert(!q(bare, '#clear') && q(bare, '#theme'), 'with no host settings only the app settings remain');
    bare.close();
});

test('settings: changing the cache level asks the host, says what happened, and warns that restricted data is not encrypted', async () => {
    const host = fakeHost();
    const settings = await openSettings(host);
    assert(!settings.rootNode.textContent.includes('não é cifrado'), 'no warning at "interno"');
    const select = q(settings, '#cache-level');
    select.value = 'nenhum';
    select.dispatchEvent(new Event('change'));
    await wait(80);
    assert(host.calls.level.join() === 'nenhum' && q(settings, '#content').textContent.includes('Nada mais será guardado'));
    host.settings.device.cacheLevel = 'restrito';
    q(settings, '#cache-level').value = 'restrito';
    q(settings, '#cache-level').dispatchEvent(new Event('change'));
    await wait(80);
    assert(q(settings, '#content').textContent.includes('não é cifrado'), 'the warning appears from "restrito" up');
    settings.close();
});

test('settings: a failing level change is reported, not swallowed', async () => {
    const host = fakeHost();
    host.settings.device.setCacheLevel = async () => { throw new Error('Nível acima do permitido por esta instância.'); };
    const settings = await openSettings(host);
    q(settings, '#cache-level').value = 'restrito';
    q(settings, '#cache-level').dispatchEvent(new Event('change'));
    await wait(80);
    assert(q(settings, '[role=alert]').textContent.includes('acima do permitido'));
    settings.close();
});

test('settings: clearing the device is two steps, needs an explicit acknowledgement, and says what will be lost', async () => {
    const host = fakeHost({ pending: 2 });
    const settings = await openSettings(host);
    let cleared = false;
    settings.addEventListener('device-cleared', () => { cleared = true; });
    q(settings, '#clear').click();
    await wait(30);
    const confirm = q(settings, '#confirm-clear');
    assert(confirm && confirm.disabled, 'the destructive button starts disabled');
    assert(q(settings, '#content').textContent.includes('2 item(ns)') && q(settings, '#content').textContent.includes('perdidos'), 'it names what is still unsent');
    confirm.click();
    assert(host.calls.clear === 0, 'a disabled button does nothing');
    q(settings, '#understood').click();
    assert(!confirm.disabled);
    q(settings, '#cancel-clear').click();
    await wait(30);
    assert(q(settings, '#clear') && host.calls.clear === 0, 'cancelling goes back and clears nothing');
    q(settings, '#clear').click(); await wait(30);
    q(settings, '#understood').click();
    q(settings, '#confirm-clear').click();
    await wait(60);
    assert(host.calls.clear === 1 && cleared, 'cleared exactly once, and the shell is told');
    settings.close();
});

test('settings: logout passes the "also clear this device" choice; a failure is shown and the dialog stays', async () => {
    const host = fakeHost({ logoutFails: true });
    const settings = await openSettings(host);
    q(settings, '#logout').click();
    await wait(60);
    assert(host.calls.logout[0].clearDevice === false);
    assert(q(settings, '[role=alert]').textContent.includes('não é possível sair') && settings.isOpen);
    q(settings, '#logout-clear').click();
    q(settings, '#logout').click();
    await wait(60);
    assert(host.calls.logout[1].clearDevice === true);
    settings.close();
});

test('settings: the theme is remembered and announced to the shell', async () => {
    try { localStorage.removeItem(THEME_KEY); } catch { /* ignore */ }
    const settings = await openSettings(fakeHost());
    let heard = null;
    settings.addEventListener('theme-change', event => { heard = event.detail.theme; });
    q(settings, '#theme').value = 'dark';
    q(settings, '#theme').dispatchEvent(new Event('change'));
    assert(heard === 'dark' && localStorage.getItem(THEME_KEY) === 'dark');
    localStorage.removeItem(THEME_KEY);
    settings.close();
});

test('wiping: the IndexedDB backend and the dev host really delete the local data', async () => {
    const name = `agora-test-${uuid()}`;
    const backend = new IndexedDbBackend(name);
    await backend.putCache('k', { value: 1, level: 'publico' });
    await backend.putDocument('d', { meta: {} });
    await backend.destroy();
    const fresh = new IndexedDbBackend(name);
    assert(await fresh.getCache('k') === undefined && await fresh.getDocument('d') === undefined && (await fresh.listWorkspaces()).length === 0);
    await fresh.close();

    const host = new DevHost({ dbName: `agora-test-${uuid()}` });
    const meta = await host.create('A apagar');
    const doc = await host.openDocument(meta);
    doc.set('meta.title', 'x'); await doc.flush();
    localStorage.setItem('agora.algo', '1');
    await host.settings.device.clear();
    assert(localStorage.getItem('agora.algo') === null, 'agora.* local settings are gone');
    assert((await host.list()).length === 0, 'the catalog is empty after wiping');
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
    assert(items().length === 7);
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

test('site: every local link of the landing and the hosting guide is served; the art draws at any point of the story', async () => {
    for (const page of ['../index.html', '../hospedar.html']) {
        const html = new DOMParser().parseFromString(await (await fetch(page)).text(), 'text/html');
        assert(html.title && html.querySelector('main') && html.querySelector('a[href="app.html"]'), `${page}: title, main and the way into the app`);
        for (const el of html.querySelectorAll('a[href], link[href], script[src]')) {
            const ref = el.getAttribute('href') ?? el.getAttribute('src');
            if (/^(https?:|#|mailto:)/.test(ref)) continue;
            assert((await fetch(`../${ref.split('#')[0] || './'}`, { method: 'HEAD' })).ok, `${page}: ${ref} is not served`);
        }
    }
    const { AgoraArt } = await import('../site/art.js');
    const canvas = document.createElement('canvas');
    const art = new AgoraArt(canvas, { still: true });
    const seen = new Set();
    for (const p of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 2, -1]) {                // out-of-range values are clamped, never throw
        art.setProgress(p);
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        seen.add(`${data[0]},${data[1]},${data[2]}`);
    }
    assert(art.progress === 0 && seen.size >= 5, 'the sky changes along the story');
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

// --- conference (mesh): real RTCPeerConnections in this page, synthetic cameras and microphones ---

//A camera (canvas) and a microphone (oscillator) that need no permission and no hardware
const syntheticMedia = () => {
    const requests = [];
    const stops = [];
    return {
        requests,
        stops,
        async getUserMedia(constraints) {
            requests.push(Object.keys(constraints).join());
            if (constraints.video) {
                const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
                const context = canvas.getContext('2d');
                let n = 0;
                const timer = setInterval(() => { context.fillStyle = `hsl(${(n += 20) % 360} 80% 50%)`; context.fillRect(0, 0, 160, 90); }, 40);
                const stream = canvas.captureStream(25);
                stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
                const track = stream.getVideoTracks()[0];
                const stop = track.stop.bind(track);
                track.stop = () => { clearInterval(timer); stops.push('video'); stop(); };
                return stream;
            }
            const audioContext = new AudioContext();
            const oscillator = audioContext.createOscillator();
            const destination = audioContext.createMediaStreamDestination();
            oscillator.connect(destination);
            oscillator.start();
            const track = destination.stream.getAudioTracks()[0];
            const stop = track.stop.bind(track);
            track.stop = () => { stops.push('audio'); stop(); audioContext.close().catch(() => {}); };
            return destination.stream;
        },
    };
};

//A small "room": presence and signalling shared by the people in it, with no server
const newCall = () => {
    const states = new Map();                // clientId -> local presence state
    const people = new Map();                // clientId -> { notify, deliver }
    let nextId = 100;
    const join = (name, { canPublish = true, media = syntheticMedia() } = {}) => {
        const clientId = nextId++;
        const user = { id: `u${clientId}`, name };
        const listeners = new Set();
        const presence = {
            get local() { return states.get(clientId) ?? {}; },
            setLocal(patch) { states.set(clientId, { ...(states.get(clientId) ?? {}), ...patch }); for (const other of people.values()) other.notify(); },
            peers: () => [...states].filter(([id]) => id !== clientId).map(([id, state]) => ({ clientId: id, ...state })),
            onPeers: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        };
        const signalListeners = new Set();
        const signaling = {
            clientId,
            send: (to, data) => { queueMicrotask(() => people.get(to)?.deliver({ type: 'signal', from: clientId, user, data })); return people.has(to); },
            onSignal: fn => { signalListeners.add(fn); return () => signalListeners.delete(fn); },
        };
        people.set(clientId, { notify: () => listeners.forEach(fn => fn()), deliver: event => signalListeners.forEach(fn => fn(event)) });
        presence.setLocal({ user });
        const room = new MeshProvider({ mediaDevices: media }).connect({ roomId: 'call', signaling, presence, me: user, canPublish: () => canPublish });
        return { room, media, user, clientId, leaveNetwork: () => { states.delete(clientId); people.delete(clientId); for (const other of people.values()) other.notify(); } };
    };
    return { join };
};
const untilTrue = async (condition, ms = 8000) => { const end = performance.now() + ms; while (performance.now() < end) { if (await condition()) return true; await wait(40); } return false; };
const playing = stream => new Promise(resolve => {
    const video = Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true, srcObject: stream });
    const done = ok => { clearInterval(timer); clearTimeout(limit); const why = `w${video.videoWidth} t${video.currentTime} rs${video.readyState} paused${video.paused} tracks${stream.getTracks().map(t => t.kind + ':' + t.readyState + (t.muted ? ':muted' : '')).join()}`; video.srcObject = null; playing.last = why; resolve(ok); };
    video.play().catch(() => {});
    const timer = setInterval(() => { if (video.videoWidth > 0) done(true); }, 50);
    const limit = setTimeout(() => done(false), 8000);
});
const remote = (room, clientId) => room.participants.find(p => p.clientId === clientId);

test('conference: before anyone joins, nothing is captured and nothing is connected', async () => {
    const call = newCall();
    const ana = call.join('Ana');
    assert(!ana.room.joined && ana.room.participants.length === 0 && ana.media.requests.length === 0);
    await ana.room.join();                                   // joining alone and without media: no permission is asked
    assert(ana.room.joined && ana.media.requests.length === 0, 'mic/cam never turn on by themselves');
    assert(ana.room.participants.length === 1 && !ana.room.participants[0].mic && !ana.room.participants[0].cam);
    ana.room.destroy();
});

test('conference: two people join with mic and camera, real media flows both ways, and leaving stops the devices', async () => {
    const call = newCall();
    const ana = call.join('Ana'), bia = call.join('Bia');
    await ana.room.join({ mic: true, cam: true });
    await bia.room.join({ mic: true, cam: true });
    assert(await untilTrue(() => remote(ana.room, bia.clientId)?.stream?.getTracks().length === 2 && remote(bia.room, ana.clientId)?.stream?.getTracks().length === 2), 'both receive audio and video tracks');
    assert(await playing(remote(ana.room, bia.clientId).stream), `Ana sees Bia's video frames (${playing.last})`);
    assert(await playing(remote(bia.room, ana.clientId).stream), "Bia sees Ana's video frames");
    const seen = ana.room.participants;
    assert(seen[0].self && seen[0].mic && seen[0].cam && seen.length === 2, 'me first, with my own media state');
    assert(remote(ana.room, bia.clientId).mic && remote(ana.room, bia.clientId).cam, "Bia's state comes through presence");

    ana.room.leave();
    assert(ana.media.stops.includes('audio') && ana.media.stops.includes('video'), 'leaving stops the capture (the device light goes out)');
    assert(await untilTrue(() => !remote(bia.room, ana.clientId)), 'Bia no longer lists Ana');
    bia.room.destroy(); ana.room.destroy();
});

test('conference: turning the mic or camera off stops the capture and tells the others; turning it on again works without renegotiating', async () => {
    const call = newCall();
    const ana = call.join('Ana'), bia = call.join('Bia');
    await ana.room.join({ cam: true });
    await bia.room.join();                                   // a listener: sends nothing, receives
    assert(await untilTrue(() => remote(bia.room, ana.clientId)?.stream?.getVideoTracks().length === 1));
    assert(await playing(remote(bia.room, ana.clientId).stream), 'the listener sees the camera');
    assert(bia.media.requests.length === 0, 'the listener never asked for a device');

    await ana.room.setCam(false);
    assert(ana.media.stops.includes('video') && !ana.room.participants[0].cam);
    assert(await untilTrue(() => remote(bia.room, ana.clientId).cam === false), 'the others see the camera off');
    await ana.room.setMic(true);
    assert(await untilTrue(() => remote(bia.room, ana.clientId).mic === true));
    await ana.room.setCam(true);
    assert(await untilTrue(async () => remote(bia.room, ana.clientId).cam === true && await playing(remote(bia.room, ana.clientId).stream)), 'the camera comes back on the same connection');
    ana.room.destroy(); bia.room.destroy();
});

test('conference: three people connect in a full mesh', async () => {
    const call = newCall();
    const people = ['Ana', 'Bia', 'Caio'].map(name => call.join(name));
    for (const person of people) await person.room.join({ mic: true });
    assert(await untilTrue(() => people.every(a => people.filter(b => b !== a).every(b => remote(a.room, b.clientId)?.stream?.getAudioTracks().length === 1))), 'everyone hears everyone');
    people.forEach(person => person.room.destroy());
});

test('conference: a viewer listens but cannot publish; a refused device does not keep the person out of the call', async () => {
    const call = newCall();
    const viewer = call.join('Leitor', { canPublish: false });
    await viewer.room.join();
    for (const act of [() => viewer.room.setMic(true), () => viewer.room.setCam(true)]) {
        try { await act(); throw new Error('allowed'); } catch (error) { assert(error instanceof ConferenceError && error.code === 'forbidden', error.message); }
    }
    assert(viewer.media.requests.length === 0, 'the device was never even requested');

    const denied = call.join('Bloqueada', { media: { getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } });
    const { errors } = await denied.room.join({ mic: true, cam: true });
    assert(denied.room.joined && errors.length === 2 && errors.every(e => e.code === 'denied' && /permiss/i.test(e.message)));
    assert(!denied.room.participants[0].mic && !denied.room.participants[0].cam);
    viewer.room.destroy(); denied.room.destroy();
});

test('conference: events say who joined, left and was heard; an unsupported context explains why', async () => {
    const call = newCall();
    const ana = call.join('Ana'), bia = call.join('Bia');
    const events = [];
    ana.room.on('participant-joined', e => events.push(`joined:${e.user.name}`));
    ana.room.on('participant-left', () => events.push('left'));
    ana.room.on('track-subscribed', e => events.push(`track:${e.kind}`));
    await ana.room.join({ mic: true });
    await bia.room.join({ mic: true });
    assert(await untilTrue(() => events.includes('track:audio')), 'no track event: ' + events.join());
    bia.room.leave();
    assert(await untilTrue(() => events.includes('left')), 'no left event: ' + events.join());
    assert(events.includes('joined:Bia'), events.join());
    ana.room.destroy(); bia.room.destroy();

    const none = new MeshProvider({ mediaDevices: null }).connect({
        roomId: 'x', me: { id: 'u', name: 'U' }, signaling: { clientId: 1, send: () => false, onSignal: () => () => {} },
        presence: { local: {}, setLocal() {}, peers: () => [], onPeers: () => () => {} },
    });
    assert(!none.supported && none.unsupportedReason.length > 10);
    try { await none.join({ mic: true }); throw new Error('joined'); } catch (error) { assert(error.code === 'unsupported'); }
});

// --- transcription: audio logic, the transcript client, the switch, and Whisper itself when the model is installed ---

const tone = (seconds, level = 0.2, rate = 16000, hz = 220) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => level * Math.sin(2 * Math.PI * hz * i / rate));
const hush = (seconds, level = 0.001, rate = 16000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => level * Math.sin(i * 12.9898));
const cat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const segment = signal => { const found = []; const segmenter = new Segmenter({ onUtterance: u => found.push(u) }); for (let i = 0; i < signal.length; i += 1234) segmenter.feed(signal.subarray(i, i + 1234)); segmenter.flush(); return found; };

test('transcription: the resampler brings 48 kHz and 44.1 kHz to 16 kHz keeping the signal, block by block', () => {
    for (const rate of [48000, 44100, 16000]) {
        const input = tone(1, 0.5, rate, 300);
        const resampler = new Resampler(rate);
        const parts = [];
        for (let i = 0; i < input.length; i += 2048) parts.push(resampler.process(input.subarray(i, i + 2048)));      // as the audio thread delivers it
        const out = cat(...parts);
        assert(Math.abs(out.length - 16000) <= 2, `${rate}: ${out.length} samples`);
        const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        assert(peak > 0.4 && peak < 0.55, `${rate}: the amplitude survived (${peak.toFixed(3)})`);
    }
});

test('transcription: speech after silence becomes one utterance, with a little before and after; noise, clicks and silence become none', () => {
    const found = segment(cat(hush(1), tone(1.2), hush(1.5)));
    assert(found.length === 1, `${found.length} utterances`);
    assert(found[0].durationMs > 1200 && found[0].durationMs < 2200, `duration ${found[0].durationMs}`);
    assert(found[0].startedAt > 400 && found[0].startedAt < 900, `starts near 1 s minus the pre-roll (${found[0].startedAt})`);
    assert(segment(cat(hush(1), tone(0.05), hush(2))).length === 0, 'a click is not speech');
    assert(segment(cat(hush(1), tone(0.3), hush(2))).length === 0, 'under 400 ms is not speech');
    assert(segment(hush(5, 0.01)).length === 0, 'steady room noise is not speech');
    assert(segment(cat(hush(1), tone(0.8), hush(0.2), tone(0.8), hush(2))).length === 1, 'a short breath inside a sentence does not split it');
    assert(segment(cat(tone(0.8), hush(1.2), tone(0.8), hush(1.2))).length === 2, 'a real pause does');
});

test('transcription: speech without a pause is cut at 25 s (Whisper takes 30 s at most) and the rest follows', () => {
    const found = segment(cat(hush(0.5), tone(40), hush(1.5)));
    assert(found.length === 2 && found.every(u => u.durationMs <= 25100), found.map(u => u.durationMs).join());
});

test('transcription: what Whisper invents on silence is discarded; real speech and loops are handled', () => {
    for (const phantom of ['', '  ', '...', '[Música]', '(aplausos)', '♪ música ♪', 'Obrigado por assistir!', 'Legendas pela comunidade Amara.org', 'Thanks for watching.', 'Inscreva-se no canal']) assert(cleanTranscript(phantom) === '', `kept: "${phantom}"`);
    assert(cleanTranscript('  Vamos   revisar a tabela. ') === 'Vamos revisar a tabela.');
    assert(cleanTranscript('Obrigado pela explicação, Ana.') === 'Obrigado pela explicação, Ana.', 'a real thanks stays');
    assert(cleanTranscript('e e e e e e e e e e e e') === 'e e e', 'a decoding loop is cut');
});

const segmentEvent = (seq, author, body, clientId = `c${seq}`) => ({ type: 'segment', segment: { id: `s${seq}`, seq, clientId, author: { id: author, name: author }, body, createdAt: new Date(2026, 9, 16, 14, seq).toISOString() } });
test('transcript client: sends once, confirmation replaces the pending copy, the outbox survives being offline, captions fade', () => {
    let connected = false;
    const sent = [];
    let now = 1000;
    const client = new TranscriptClient({ me: { id: 'me', name: 'Eu' }, send: request => { if (!connected) return false; sent.push(request); return true; }, now: () => now, captionMs: 5000 });
    const clientId = client.send('primeira frase');
    assert(client.segments.length === 1 && client.segments[0].pending && sent.length === 0 && client.pending === 1, 'offline: pending, not sent');
    assert(client.captionOf('me') === 'primeira frase', 'my own caption shows at once');
    connected = true; client.onConnected();
    assert(sent.filter(r => r.type === 'send').length === 1 && sent.some(r => r.type === 'history'), 'on connect: resent and history requested');
    client.receive(segmentEvent(1, 'me', 'primeira frase', clientId));
    assert(client.segments.length === 1 && !client.segments[0].pending && client.pending === 0, 'confirmed, not duplicated');
    client.receive(segmentEvent(1, 'me', 'primeira frase', clientId));
    assert(client.segments.length === 1, 'a repeated delivery changes nothing');
    client.receive(segmentEvent(2, 'ana', 'resposta da Ana'));
    assert(client.captionOf('ana') === 'resposta da Ana');
    now += 6000;
    assert(client.captionOf('ana') === null && client.captionOf('me') === null, 'captions fade after a few seconds');
    assert(client.export().split('\n').length === 2 && client.export().includes('Ana: resposta') === false && client.export().includes('ana: resposta da Ana'), client.export());
});

test('transcript client: history merges in order; a refused segment is not retried forever, a rate limit is', () => {
    const client = new TranscriptClient({ me: { id: 'me', name: 'Eu' }, send: () => false });
    client.receive(segmentEvent(3, 'a', 'três'));
    client.receive({ type: 'history', hasMore: true, messages: [segmentEvent(1, 'a', 'um').segment, segmentEvent(2, 'b', 'dois').segment, segmentEvent(3, 'a', 'três').segment] });
    assert(client.segments.map(s => s.body).join() === 'um,dois,três' && client.hasMore, 'ordered by seq, no duplicate');
    const refused = client.send('negado');
    client.receive({ type: 'error', ref: refused, code: 'forbidden', message: 'Seu papel não permite transcrever.' });
    assert(client.pending === 0 && client.lastError.includes('papel'), 'dropped');
    const limited = client.send('devagar');
    client.receive({ type: 'error', ref: limited, code: 'rate', message: 'muitos' });
    assert(client.pending === 1, 'a rate limit keeps it for later');
    const viewer = new TranscriptClient({ me: { id: 'v', name: 'V' }, canWrite: () => false });
    throws(() => viewer.send('oi'), 'papel');
});

//A room and an engine that are just enough for the switch
const fakeCall = () => {
    const listeners = new Set();
    const room = { joined: true, localAudioTrack: null, transcribing: false, on: (event, fn) => { listeners.add(fn); return () => listeners.delete(fn); }, setTranscribing(on) { this.transcribing = on; }, changed: () => listeners.forEach(fn => fn()) };
    const engine = { supported: true, loads: 0, sessions: [], async load(onProgress) { this.loads++; onProgress(0.5); await wait(10); onProgress(1); }, start(track, options) { const session = { track, options, stopped: false, stop() { this.stopped = true; } }; this.sessions.push(session); return session; } };
    return { room, engine };
};
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test('transcriber: never starts by itself; needs the call; follows the microphone; what is said goes to the transcript; leaving the call turns it off', async () => {
    const { room, engine } = fakeCall();
    const sent = [];
    const client = new TranscriptClient({ me: { id: 'me', name: 'Eu' }, send: r => { sent.push(r); return true; } });
    const transcriber = new Transcriber({ engine, client, room, storage: memoryStorage() });
    assert(transcriber.state === 'off' && engine.loads === 0 && !room.transcribing, 'nothing happens until the person asks');

    room.joined = false;
    await transcriber.enable();
    assert(transcriber.state === 'off' && /chamada/.test(transcriber.error) && engine.loads === 0, 'outside the call: refused with a reason');

    room.joined = true;
    const pending = transcriber.enable();
    assert(transcriber.state === 'loading' && room.transcribing, 'the others are told right away');
    await pending;
    assert(transcriber.state === 'waiting' && engine.sessions.length === 0, 'microphone off: waits, listens to nothing');

    room.localAudioTrack = { id: 'mic1' }; room.changed();
    assert(transcriber.state === 'listening' && engine.sessions.length === 1 && engine.sessions[0].track.id === 'mic1');
    engine.sessions[0].options.onSegment({ text: 'bom dia a todos', startedAt: 5 });
    assert(sent.some(r => r.type === 'send' && r.body === 'bom dia a todos'), 'the segment goes to the transcript');

    room.localAudioTrack = null; room.changed();
    assert(engine.sessions[0].stopped && transcriber.state === 'waiting', 'mic off: the session stops');
    room.localAudioTrack = { id: 'mic2' }; room.changed();
    assert(engine.sessions.length === 2 && transcriber.state === 'listening', 'mic on again: a new session');

    room.joined = false; room.changed();
    assert(transcriber.state === 'off' && !room.transcribing && engine.sessions[1].stopped, 'leaving the call turns it off for everyone to see');
    transcriber.destroy();
});

test('transcriber: errors are explained, the language is remembered, a viewer cannot transcribe', async () => {
    const { room, engine } = fakeCall();
    const client = new TranscriptClient({ me: { id: 'me', name: 'Eu' }, send: () => true });
    const storage = memoryStorage();
    engine.load = async () => { throw Object.assign(new Error('O modelo de transcrição (whisper-base) não está instalado neste servidor.'), { code: 'no_model' }); };
    const transcriber = new Transcriber({ engine, client, room, storage });
    await transcriber.enable();
    assert(transcriber.state === 'error' && !transcriber.enabled && !room.transcribing && /não está instalado/.test(transcriber.error), 'a missing model is said plainly, and nobody is shown as being transcribed');

    assert(transcriber.language === 'pt');
    transcriber.setLanguage('en');
    assert(new Transcriber({ engine, client, room, storage }).language === 'en', 'remembered on this device');
    transcriber.setLanguage('klingon');
    assert(transcriber.language === 'en', 'unknown languages are ignored');

    const viewer = new Transcriber({ engine: fakeCall().engine, client: new TranscriptClient({ me: { id: 'v', name: 'V' }, canWrite: () => false }), room: fakeCall().room, storage: memoryStorage() });
    await viewer.enable();
    assert(viewer.state === 'off' && /papel/.test(viewer.error));
});

test('components are containers of their own contents: data-box follows the width of the box they are in', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    await registry.load('ultima-text');
    const holder = document.createElement('div');
    holder.style.cssText = 'width:300px;height:120px';
    document.body.append(holder);
    const element = document.createElement('ultima-text');
    element.attach({ instanceId: 'box', manifest: registry.getManifest('ultima-text'), config: { text: 'oi' }, services: {} });
    holder.append(element);
    await element.whenLoaded();
    assert(getComputedStyle(element).containerType === 'inline-size', `the host is the container (${getComputedStyle(element).containerType})`);
    assert(await untilTrue(() => element.dataset.box === 'compact'), `300px: ${element.dataset.box}`);
    holder.style.width = '500px';
    assert(await untilTrue(() => element.dataset.box === 'regular'), `500px: ${element.dataset.box}`);
    holder.style.width = '900px';
    assert(await untilTrue(() => element.dataset.box === 'wide'), `900px: ${element.dataset.box}`);
    assert(boxSize(419) === 'compact' && boxSize(420) === 'regular' && boxSize(719) === 'regular' && boxSize(720) === 'wide');
    element.dispose(); holder.remove();
});

test('conference component: the transcription switch drives the transcriber; captions, the "being transcribed" mark and the transcript list follow', async () => {
    const registry = new ComponentRegistry();
    await registerCoreComponents(registry);
    await registry.load('ultima-conference');
    await registry.load('ultima-transcript');
    const call = newCall();
    const ana = call.join('Ana'), bia = call.join('Bia');
    const client = new TranscriptClient({ me: ana.user, send: request => { if (request.type === 'send') client.receive({ type: 'segment', segment: { id: `s-${request.clientId}`, seq: client.segments.length + 1, clientId: request.clientId, author: ana.user, body: request.body, createdAt: new Date().toISOString() } }); return true; } });
    const { engine } = fakeCall();
    const transcriber = new Transcriber({ engine, client, room: ana.room, storage: memoryStorage() });

    const mount = async (tag, services) => {
        const element = document.createElement(tag);
        element.attach({ instanceId: tag, manifest: registry.getManifest(tag), config: {}, services });
        element.style.cssText = 'display:block;width:380px;height:420px';
        document.body.append(element);
        await element.whenLoaded();
        return element;
    };
    const conference = await mount('ultima-conference', { conference: ana.room, transcript: client, transcriber });
    const list = await mount('ultima-transcript', { transcript: client });
    const $ = selector => conference.rootNode.querySelector(selector);

    await ana.room.join({ mic: true });
    await bia.room.join({ cam: true });
    assert($('#transcription').hidden === false && $('#transcribe').getAttribute('aria-pressed') === 'false' && !transcriber.enabled, 'the switch is there, off: joining the call does not start it');
    $('#transcribe').click();
    assert(await untilTrue(() => transcriber.state === 'listening'), `the click turned the transcriber on (${transcriber.state})`);
    assert($('#transcribe').getAttribute('aria-pressed') === 'true' && $('#t-status').textContent.includes('Transcrevendo'), 'and the panel says so');
    assert(ana.room.participants[0].transcribing, 'and everyone is told');

    engine.sessions[0].options.onSegment({ text: 'a receita caiu no segundo trimestre', startedAt: Date.now() });
    await wait(50);
    const tile = [...conference.rootNode.querySelectorAll('.tile')].find(t => t.classList.contains('self'));
    assert(tile.querySelector('.caption').textContent === 'a receita caiu no segundo trimestre', 'the live caption shows on my tile');
    assert(tile.querySelector('.label').textContent.includes('📝'), 'with the mark');
    assert(list.rootNode.querySelector('.segment p').textContent === 'a receita caiu no segundo trimestre', 'and the transcript component lists it');
    list.rootNode.querySelector('#search').value = 'receita'; list.rootNode.querySelector('#search').dispatchEvent(new Event('input'));
    assert(list.rootNode.querySelector('mark')?.textContent === 'receita', 'search highlights the hit, as text (never markup)');

    $('#language').value = 'en'; $('#language').dispatchEvent(new Event('change'));
    assert(transcriber.language === 'en');
    $('#transcribe').click();
    assert(!transcriber.enabled && !ana.room.participants[0].transcribing && $('#transcribe').getAttribute('aria-pressed') === 'false', 'off again, for everyone');

    conference.dispose(); list.dispose(); conference.remove(); list.remove();
    ana.room.destroy(); bia.room.destroy();
});

//The real thing, end to end: a recorded voice goes through the microphone path (audio worklet, resampling, voice detection),
//the worker and Whisper. Needs the model (tools/baixar_modelo_whisper.py): without it this test has nothing to run.
test('transcription: Whisper in the browser transcribes real speech end to end (skipped when models/whisper-base is not installed)', async () => {
    const installed = await fetch('../models/whisper-base/config.json', { method: 'HEAD' }).then(r => r.ok).catch(() => false);
    if (!installed) return;
    const provider = new WhisperProvider({ size: 'base', modelBase: new URL('../models/', location.href).pathname });
    if (!provider.supported) return;
    await provider.load();
    const wav = new Uint8Array(await (await fetch('./fixtures/jfk-16k.wav')).arrayBuffer());
    const pcm = new Int16Array(wav.buffer.slice(44));
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = context.createBuffer(1, pcm.length, 16000);
    buffer.copyToChannel(Float32Array.from(pcm, v => v / 32768), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    source.connect(destination);
    const heard = [];
    const states = [];
    const session = provider.start(destination.stream.getAudioTracks()[0], { language: 'en', onSegment: s => heard.push(s.text), onState: state => states.push(state) });
    await wait(300);
    await context.resume();
    source.start();
    const ok = await (async () => { const end = performance.now() + 40000; while (performance.now() < end) { if (heard.join(' ').toLowerCase().includes('country')) return true; await wait(200); } return false; })();
    session.stop();
    provider.destroy();
    context.close();
    assert(ok, `Whisper heard: "${heard.join(' | ')}" (states ${states.join()})`);
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
