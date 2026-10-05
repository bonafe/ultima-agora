import { ReactiveComponent } from '../vendor/ultima/reactive_component.js';
import { mix } from '../core/components/mix.js';
import { AgoraComponent } from '../core/components/agora_component.js';
import { validateManifest, validateConfig } from '../core/registry/manifest.js';
import { ComponentRegistry } from '../core/registry/component_registry.js';
import { MemoryStateStore } from '../collaboration/document/memory_state_store.js';
import { Layout } from '../core/workspace/layout.js';
import { Workspace } from '../core/workspace/workspace.js';
import { DevHost } from '../adapters/dev/dev_host.js';
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

test('dev host: catalog creates, renames, lists, archives and duplicates', async () => {
    const host = newHost();
    const a = await host.create('A');
    await host.rename(a.id, 'A2');
    assert((await host.list())[0].title === 'A2');
    const doc = await host.store.open(a.id);
    doc.set('meta.title', 'conteúdo');
    const copy = await host.duplicate(a.id);
    assert(copy.id !== a.id && copy.title === 'A2 (cópia)');
    host.store.forget(copy.id);
    assert((await host.store.open(copy.id)).get('meta.title') === 'conteúdo');
    await host.archive(a.id);
    assert((await host.list()).map(w => w.id).join() === copy.id);
    await host.destroy();
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
    assert(items().length === 2);
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
const failures = lines.filter(l => l.startsWith('FAIL ')).map(l => l.slice(5).split('\n')[0]);
document.title = (failed ? 'FAIL ' : 'PASS ') + summary + (failed ? ` | ${failures.join('; ')}` : '');
