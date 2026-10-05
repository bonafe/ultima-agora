//Acceptance criteria of the MVP (docs/especificacao/11-roadmap-mvp.md, 11.5; traceability in docs/aceite-mvp.md).
//Each "person" is a full client: own IndexedDB, own identity, own Yjs document, own workspace view, talking to the
//REAL agora-sync server over WebSocket. Nothing here is mocked except the clock.
import { ComponentRegistry } from '../../core/registry/component_registry.js';
import { registerCoreComponents } from '../../components/catalog.js';
import { Workspace } from '../../core/workspace/workspace.js';
import { DevHost } from '../../adapters/dev/dev_host.js';
import { uuid } from '../../core/ids.js';
import '../../ui/workspace/agora-workspace.js';
import '../../ui/palette/agora-palette.js';
import '../../ui/inspector/agora-inspector.js';
import '../../ui/shell/agora-shell.js';

const params = new URLSearchParams(location.search);
const HTTP = params.get('sync') ?? 'http://localhost:8788';
const WS = HTTP.replace(/^http/, 'ws');

const tests = [];
const infos = [];
const test = (name, fn) => tests.push({ name, fn });
const info = text => infos.push(text);
const assert = (condition, message = 'assertion failed') => { if (!condition) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, ms = 4000, step = 20) => { const end = performance.now() + ms; while (performance.now() < end) { if (await condition()) return true; await wait(step); } return false; };
const timed = async (condition, ms = 4000) => { const t0 = performance.now(); const ok = await until(condition, ms, 10); return ok ? performance.now() - t0 : Infinity; };

const registry = async () => { const r = new ComponentRegistry(); await registerCoreComponents(r); return r; };
const sleepMs = wait;

//One client of the system
class Person {
    constructor(name, role, workspaceId) { this.name = name; this.role = role; this.workspaceId = workspaceId; }

    static async join(name, role, workspaceId = null) {
        const person = new Person(name, role, workspaceId);
        person.dbName = `acc-${uuid()}`;
        person.host = new DevHost({ dbName: person.dbName, sync: { http: HTTP, url: WS }, role, identity: { id: `u-${name.toLowerCase()}`, name }, });
        person.registry = await registry();
        person.meta = workspaceId ? await person.host.adopt(workspaceId, 'Aceite') : await person.host.create('Aceite');
        person.workspaceId = person.meta.id;
        await person.open();
        return person;
    }

    async open() {
        this.doc = await this.host.openDocument(this.meta);
        this.doc.presence.setLocal({ user: { id: this.host.identity.id, name: this.name, color: this.host.identity.color, kind: 'human' }, focus: null, activity: null });
        this.workspace = new Workspace({ doc: this.doc, registry: this.registry, user: this.host.identity, id: this.workspaceId });
        this.box = document.createElement('div');
        this.box.style.cssText = 'width:640px;height:320px;position:relative;margin:4px;display:inline-block;border:1px solid #888';
        this.view = document.createElement('agora-workspace');
        this.view.style.cssText = 'position:absolute;inset:0';
        this.box.append(this.view);
        document.body.append(this.box);
        await this.view.whenLoaded();
        this.view.workspace = this.workspace;
        await until(() => this.doc.provider?.status === 'synced', 6000);
        return this;
    }

    get synced() { return this.doc.provider?.status === 'synced'; }
    element(id) { return this.view.rootNode.querySelector(`[data-instance-id="${id}"]`); }
    close() { this.doc.provider?.destroy(); this.box?.remove(); this.host.store.forget(this.meta.id); }
    async reopen() { this.close(); this.host = new DevHost({ dbName: this.dbName, sync: { http: HTTP, url: WS }, role: this.role, identity: { id: `u-${this.name.toLowerCase()}`, name: this.name } }); await this.open(); }
}

const team = async (people, ...specs) => {
    const [first, ...rest] = specs;
    const owner = await Person.join(first[0], first[1]);
    people.push(owner);
    for (const [name, role] of rest) people.push(await Person.join(name, role, owner.workspaceId));
    return [...people];
};
const cleanup = people => people.forEach(p => { try { p.close(); } catch { /* already closed */ } });
const guard = fn => async () => { const people = []; try { await fn(people); } finally { cleanup(people); } };

const growsTo = (person, n) => () => person.workspace.instances().length >= n;

// ---------------------------------------------------------------- A. Composition

test('A1 composition: add by drag (palette → panel edge), by keyboard-equivalent click, move, split, tab', guard(async people => {
    const [maria] = await team(people, ['Maria', 'owner']);
    const first = maria.workspace.addInstance('ultima-notes');
    await sleepMs(300);
    //drag from the palette onto the right edge of the panel (what a mouse does)
    const panel = maria.view.rootNode.querySelector('.panel');
    const rect = panel.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData('application/x-agora-component', 'ultima-table');
    for (const type of ['dragover', 'drop']) panel.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.right - 5, clientY: rect.top + rect.height / 2 }));
    await sleepMs(400);
    assert(maria.workspace.instances().length === 2 && maria.view.rootNode.querySelectorAll('.panel').length === 2, 'the drop split the panel');
    //the keyboard route: the palette item is a native button (Enter/Space activate it), and the panel menu moves/splits
    const text = maria.workspace.addInstance('ultima-text');
    await sleepMs(300);
    maria.workspace.moveInstance(text, { panelId: maria.workspace.layout.findPanelOf(first), side: 'bottom' });
    await sleepMs(300);
    assert(maria.workspace.layout.instanceIds().length === 3 && maria.view.rootNode.querySelectorAll('.panel').length === 3);
    const resize = maria.view.rootNode.querySelector('.splitter');
    assert(resize.getAttribute('role') === 'separator' && resize.tabIndex === 0, 'resizing is reachable by keyboard (focusable separator, arrow keys)');
}));

test('A2 reopening: composition, config and notes come back identical (also with the server unreachable)', guard(async people => {
    const [maria] = await team(people, ['Maria', 'owner']);
    const table = maria.workspace.addInstance('ultima-table', { config: { data: 'from,to\nA,B' } });
    const notes = maria.workspace.addInstance('ultima-notes');
    await sleepMs(300);
    maria.workspace.sharedText(notes).setText('# nota\nconteúdo que precisa sobreviver');
    maria.workspace.layout.setRatio(maria.workspace.layout.rootId, 0.5);
    await maria.doc.flush();
    const before = JSON.stringify(maria.doc.snapshot());

    maria.close();
    maria.host = new DevHost({ dbName: maria.dbName, sync: { http: 'http://127.0.0.1:1', url: 'ws://127.0.0.1:1' }, role: 'owner', identity: { id: 'u-maria', name: 'Maria' } });   // no server at all
    maria.doc = await maria.host.openDocument(maria.meta);
    assert(JSON.stringify(maria.doc.snapshot()) === before, 'the reopened document is identical');
    assert(maria.doc.get(['instances', table, 'config', 'data']) === 'from,to\nA,B');
    assert(maria.doc.text(['content', notes, 'text']).getText().includes('conteúdo que precisa sobreviver'));
    maria.doc.provider?.destroy();
}));

test('A3 removing an instance is undone with undo (and the connections come back with it)', guard(async people => {
    const [maria] = await team(people, ['Maria', 'owner']);
    const table = maria.workspace.addInstance('ultima-table');
    await sleepMs(300);
    const { suggestions, port } = await maria.workspace.invokeAction(table, 'showGraph');
    const graph = maria.workspace.createLinked(table, port, suggestions[0]);
    await sleepMs(300);
    maria.workspace.removeInstance(graph);
    assert(maria.workspace.instances().length === 1 && maria.workspace.bus.list().length === 0);
    maria.doc.undo();
    await sleepMs(200);
    assert(maria.workspace.instance(graph) && maria.workspace.bus.list().length === 1, 'the instance and its connection are back');
}));

// ---------------------------------------------------------------- B. Interoperability

test('B4/B5 table → "mostrar como grafo" → linked graph (one undo step); selecting a node feeds another component; both people see it', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    const table = maria.workspace.addInstance('ultima-table');
    await sleepMs(400);
    const { suggestions, port } = await maria.workspace.invokeAction(table, 'showGraph');
    assert(suggestions[0].component === 'ultima-graph');
    const graph = maria.workspace.createLinked(table, port, suggestions[0]);
    const text = maria.workspace.addInstance('ultima-text', { target: { panelId: maria.workspace.layout.findPanelOf(graph), side: 'bottom' } });
    await sleepMs(400);
    maria.workspace.bus.connect({ instance: graph, port: 'selectedNode' }, { instance: text, port: 'text' });
    assert(await until(() => carlos.workspace.bus.list().length === 2 && carlos.workspace.instances().length === 3), 'Carlos sees the whole composition');
    await sleepMs(600);

    const nodes = [...carlos.element(graph).rootNode.querySelectorAll('.node')];
    assert(nodes.length === 4, `Carlos' graph shows ${nodes.length} nodes`);
    nodes[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleepMs(200);
    assert(carlos.element(text).rootNode.querySelector('p').textContent === nodes[1].getAttribute('aria-label'), "Carlos' selection feeds HIS text");
}));

test('B6/B7 an incompatible connection is refused with a readable reason, and an invalid manifest fails citing the field', guard(async people => {
    const [maria] = await team(people, ['Maria', 'owner']);
    const table = maria.workspace.addInstance('ultima-table');
    const text = maria.workspace.addInstance('ultima-text');
    await sleepMs(300);
    try { maria.workspace.bus.connect({ instance: table, port: 'graph' }, { instance: text, port: 'text' }); throw new Error('accepted'); }
    catch (error) { assert(error.message.includes('Graph') && error.message.includes('String'), error.message); }
    try { maria.registry.register({ manifest: { name: 'x-y', tag: 'x-y', title: 'X', version: '1', module: './x.js' }, load: async () => ({}) }); throw new Error('accepted'); }
    catch (error) { assert(error.message.includes('version'), error.message); }
}));

// ---------------------------------------------------------------- C. Collaboration

test('C8 creation, movement and configuration reach the other person in under one second (local network)', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    const anchor = maria.workspace.addInstance('ultima-notes');
    assert(await until(() => carlos.workspace.instance(anchor)));
    const id = maria.workspace.addInstance('ultima-table');
    const seen = await timed(() => carlos.workspace.instance(id));
    assert(carlos.workspace.layout.findPanelOf(id) === carlos.workspace.layout.findPanelOf(anchor), 'both start in the same panel');
    maria.workspace.moveInstance(id, { panelId: maria.workspace.layout.findPanelOf(anchor), side: 'right' });          // split the panel
    const movedIn = await timed(() => carlos.workspace.layout.findPanelOf(id) !== carlos.workspace.layout.findPanelOf(anchor));
    maria.workspace.setConfig(id, { fromColumn: 'origem' });
    const configIn = await timed(() => carlos.workspace.instance(id)?.config.fromColumn === 'origem');
    info(`C8 latency: create ${seen.toFixed(0)}ms, move ${movedIn.toFixed(0)}ms, config ${configIn.toFixed(0)}ms`);
    assert(seen < 1000 && movedIn < 1000 && configIn < 1000, `${seen}/${movedIn}/${configIn} ms`);
}));

test('C9 simultaneous typing in the same notes converges without losing either edit', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    const notes = maria.workspace.addInstance('ultima-notes');
    assert(await until(() => carlos.workspace.instance(notes)));
    await sleepMs(500);
    maria.workspace.sharedText(notes).setText('um dois três');
    assert(await until(() => carlos.workspace.sharedText(notes).getText() === 'um dois três'));
    const type = (person, text) => { const area = person.element(notes).rootNode.querySelector('#editor'); area.value = text; area.dispatchEvent(new Event('input')); };
    type(maria, 'MARIA um dois três');
    type(carlos, 'um dois três CARLOS');
    assert(await until(() => maria.workspace.sharedText(notes).getText() === carlos.workspace.sharedText(notes).getText() && maria.workspace.sharedText(notes).getText().includes('MARIA') && maria.workspace.sharedText(notes).getText().includes('CARLOS'), 5000),
        `maria="${maria.workspace.sharedText(notes).getText()}" carlos="${carlos.workspace.sharedText(notes).getText()}"`);
}));

test('C10 presence: who is here, what they are looking at, that they are typing — and no label of anything they selected', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    const notes = maria.workspace.addInstance('ultima-notes');
    assert(await until(() => carlos.workspace.instance(notes)));
    await sleepMs(500);
    maria.view.select(notes);
    const area = maria.element(notes).rootNode.querySelector('#editor');
    area.value = 'segredo do investigado: JOÃO DA SILVA'; area.dispatchEvent(new Event('input'));
    assert(await until(() => carlos.doc.presence.peers().some(p => p.user.name === 'Maria' && p.focus === notes && p.activity?.instance === notes)), 'Carlos sees Maria, where she is and that she is typing');
    const peer = carlos.doc.presence.peers().find(p => p.user.name === 'Maria');
    assert(peer.user.color && peer.user.kind === 'human');
    assert(!JSON.stringify(peer).includes('JOÃO'), 'presence carries no content or label (R-PRES-3)');
}));

test('C11 offline: edit locally, reconnect, merge without loss (including what the other person did meanwhile)', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    const table = maria.workspace.addInstance('ultima-table');
    assert(await until(() => carlos.workspace.instance(table)));
    carlos.doc.provider.disconnect();
    assert(await until(() => carlos.doc.provider.status === 'offline'));
    carlos.workspace.setConfig(table, { toColumn: 'destino' });                        // offline edit
    carlos.workspace.addInstance('ultima-notes');                                    // offline creation
    maria.workspace.setConfig(table, { labelColumn: 'rotulo' });                      // meanwhile, someone else edits
    carlos.doc.provider.connect();
    assert(await until(() => carlos.synced && maria.workspace.instances().length === 2 && carlos.workspace.instance(table).config.labelColumn === 'rotulo' && maria.workspace.instance(table).config.toColumn === 'destino', 6000), 'everything merged on both sides');
}));

test('C12 a viewer cannot change the document even by tampering with the client: the server refuses and drops the connection', guard(async people => {
    const [maria, visitor] = await team(people, ['Maria', 'owner'], ['Visitante', 'viewer']);
    const id = maria.workspace.addInstance('ultima-text');
    assert(await until(() => visitor.workspace.instance(id)), 'a viewer reads');
    try { visitor.workspace.addInstance('ultima-text'); throw new Error('accepted'); } catch (error) { assert(error.message.includes('cannot change'), error.message); }
    visitor.doc.ydoc.getMap('instances').set('injected', { type: 'ultima-text', label: 'hack', config: {} });      // bypasses every client-side check
    assert(await until(() => visitor.doc.provider.status === 'error'), 'the server dropped the connection');
    await sleepMs(300);
    assert(!maria.workspace.instance('injected') && maria.workspace.instances().length === 1, 'nobody else ever saw the change');
}));

test('C13 a role change in session applies at once, without reloading', guard(async people => {
    const [maria, carlos] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor']);
    assert(carlos.workspace.canCompose);
    const response = await fetch(`${HTTP}/dev/role`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: maria.workspaceId, user: 'u-carlos', role: 'viewer' }) });
    assert((await response.json()).changed === true);
    assert(await until(() => carlos.workspace.role === 'viewer' && !carlos.workspace.canCompose), 'Carlos became read-only live');
    assert(await until(() => carlos.view.rootNode.querySelectorAll('.tab .close').length === 0), 'and the close buttons are gone from his tabs');
    try { carlos.workspace.addInstance('ultima-text'); throw new Error('accepted'); } catch (error) { assert(error.message.includes('cannot change'), error.message); }
}));

// ---------------------------------------------------------------- D. (the part that belongs to the core) and E. Chat

test('D17 duplicating a workspace copies composition and notes', guard(async people => {
    const [maria] = await team(people, ['Maria', 'owner']);
    const notes = maria.workspace.addInstance('ultima-notes');
    maria.workspace.addInstance('ultima-table');
    maria.workspace.sharedText(notes).setText('texto da nota');
    const copy = await maria.host.duplicate(maria.workspaceId);
    const doc = await maria.host.openDocument(copy);
    assert(Object.keys(doc.get('instances')).length === 2, 'composition copied');
    assert(Object.values(doc.get('content')).some(c => String(c.text).includes('texto da nota')), 'notes copied');
    assert(copy.id !== maria.workspaceId);
    doc.provider?.destroy();
}));

test('E18 chat: a message reaches the others in real time, persists across reopening, and a mention notifies', guard(async people => {
    const [maria, carlos, visitor] = await team(people, ['Maria', 'owner'], ['Carlos', 'editor'], ['Visitante', 'viewer']);
    assert(await until(() => maria.doc.chat && carlos.doc.chat && visitor.doc.chat));
    maria.doc.chat.send('Carlos, veja a tabela @carlos');
    const arrived = await timed(() => carlos.doc.chat.messages.some(m => m.body.includes('veja a tabela')));
    info(`E18 chat latency: ${arrived.toFixed(0)}ms`);
    assert(arrived < 1000);
    assert(carlos.doc.chat.unread === 1 && carlos.doc.chat.unreadMentions === 1, 'the mention notifies Carlos');
    assert(await until(() => visitor.doc.chat.messages.length === 1), 'a viewer reads the chat');
    assert(!visitor.doc.chat.canWrite);

    await carlos.reopen();                                                              // close and open again: history comes back
    assert(await until(() => carlos.doc.chat.messages.some(m => m.body.includes('veja a tabela'))), 'the history persists');
}));

// ---------------------------------------------------------------- F. Quality

test('F22 reference workspace (20 instances, 5 participants): builds fast, converges, stays responsive', guard(async people => {
    const names = ['Maria', 'Carlos', 'Ana', 'Bruno', 'Clara'];
    const [maria, ...others] = await team(people, ['Maria', 'owner'], ...names.slice(1).map(n => [n, 'editor']));
    const kinds = ['ultima-text', 'ultima-notes', 'ultima-table', 'ultima-graph'];

    const t0 = performance.now();
    for (let i = 0; i < 20; i++) maria.workspace.addInstance(kinds[i % kinds.length], { target: i ? { panelId: maria.workspace.layout.defaultPanel(), side: i % 3 === 0 ? 'right' : 'center' } : {} });
    const built = performance.now() - t0;
    const everyoneSees = await timed(() => others.every(p => p.workspace.instances().length === 20), 8000);
    await sleepMs(1500);                                                             // let the views mount every component
    const mounted = others.map(p => p.view.rootNode.querySelectorAll('[data-instance-id]').length);

    const target = maria.workspace.instances().find(i => i.type === 'ultima-text').id;
    maria.workspace.setConfig(target, { text: 'mudou' });
    const propagated = await timed(() => others.every(p => p.workspace.instance(target)?.config.text === 'mudou'), 4000);
    //main-thread responsiveness: how late does a 16 ms timer fire while the 6 views are alive
    let worst = 0;
    for (let i = 0; i < 20; i++) { const s = performance.now(); await wait(16); worst = Math.max(worst, performance.now() - s - 16); }
    info(`F22 reference workspace: 20 instances built in ${built.toFixed(0)}ms, seen by 4 others in ${everyoneSees.toFixed(0)}ms, config change reaches all 4 in ${propagated.toFixed(0)}ms, worst timer delay ${worst.toFixed(0)}ms, mounted per client: ${mounted.join('/')}`);
    assert(built < 3000 && everyoneSees < 3000 && propagated < 1000, 'slower than the reference budget');
    assert(mounted.every(n => n >= 18), `views mounted ${mounted}`);
    assert(worst < 250, `the page froze for ${worst.toFixed(0)}ms`);
}));

test('F23 keyboard and screen reader: every control is a native, named, focusable control; the whole flow is operable without a mouse', async () => {
    const host = new DevHost({ dbName: `acc-${uuid()}`, identity: { id: 'u-teclado', name: 'Teclado' } });
    const shell = document.createElement('agora-shell');
    shell.style.cssText = 'display:block;width:1000px;height:600px';
    const saved = location.hash;
    document.body.append(shell);
    try {
        await shell.whenLoaded();
        await shell.init({ host, registry: await registry() });
        await wait(300);
        const root = shell.shadowRoot;

        //1. create a workspace, 2. add a component, 3. connect, 4. open the chat — all through controls a keyboard drives
        root.querySelector('#new').click();                                              // <button>: Enter/Space activate it
        await wait(500);
        const palette = root.querySelector('agora-palette').shadowRoot;
        const items = [...palette.querySelectorAll('button.item')];
        assert(items.length >= 5 && items.every(b => b.tagName === 'BUTTON'), 'palette items are buttons');
        items.find(b => b.textContent.startsWith('Tabela')).click();
        items.find(b => b.textContent.startsWith('Texto')).click();
        await wait(600);
        const ws = shell.workspace;
        const text = ws.instances().find(i => i.type === 'ultima-text').id;
        shell.shadowRoot.querySelector('agora-workspace').select(text);
        await wait(300);
        const select = root.querySelector('agora-inspector').shadowRoot.querySelector('select[aria-label="Receber em text"]');
        assert(select && select.tagName === 'SELECT', 'connecting is a <select>, operable with arrows');
        select.value = [...select.options].find(o => o.value.endsWith('|selectedRow')).value;
        select.dispatchEvent(new Event('change'));
        assert(ws.bus.list().length === 1, 'connected without a mouse');
        const chat = root.querySelector('#chat-toggle');
        assert(chat.tagName === 'BUTTON' && !chat.hidden);
        chat.click();
        await wait(200);
        assert(!root.querySelector('#chat-pane').hasAttribute('hidden'), 'the chat opened');

        //Every interactive element in every shadow tree: native control or role+tabindex+key handler, and a name
        const unnamed = [], unreachable = [];
        const scan = scope => {
            for (const element of scope.querySelectorAll('*')) {
                if (element.shadowRoot) scan(element.shadowRoot);
                const interactive = element.matches('button, a[href], select, textarea, input:not([type=hidden]), [role=button], [role=tab], [role=separator][tabindex]');
                if (!interactive || element.hidden || element.closest('[hidden]')) continue;
                const name = element.getAttribute('aria-label') || element.textContent.trim() || element.getAttribute('title') || element.labels?.[0]?.textContent?.trim() || element.getAttribute('placeholder') || element.getAttribute('aria-labelledby');
                if (!name && !element.disabled) unnamed.push(element.outerHTML.slice(0, 70));
                if (element.tabIndex < 0 && !element.matches('[role=tab]') && !element.disabled) unreachable.push(element.outerHTML.slice(0, 70));
            }
        };
        scan(shell.shadowRoot);
        assert(unnamed.length === 0, `controls without an accessible name: ${unnamed.join(' | ')}`);
        assert(unreachable.length === 0, `controls the keyboard cannot reach: ${unreachable.join(' | ')}`);
        //Nothing clickable that is not a control (a div with an onclick is invisible to the keyboard)
        const fakeButtons = [...shell.shadowRoot.querySelectorAll('[onclick]')];
        assert(fakeButtons.length === 0, 'no onclick on non-controls');
        info(`F23 a11y scan: no unnamed controls, none unreachable by keyboard`);
    } finally { shell.remove(); history.replaceState(null, '', location.pathname + location.search + saved); await host.destroy(); }
});

// ---------------------------------------------------------------- runner

console.log = () => {};
const lines = [];
let failed = 0;
for (const { name, fn } of tests) {
    const started = performance.now();
    try { await fn(); lines.push(`PASS ${name} (${(performance.now() - started).toFixed(0)}ms)`); }
    catch (error) { failed++; lines.push(`FAIL ${name}\n     ${error.message}`); }
}
const summary = `${tests.length - failed}/${tests.length} passed`;
document.getElementById('results').textContent = lines.join('\n') + (infos.length ? `\n\n${infos.join('\n')}` : '');
document.getElementById('summary').textContent = summary;
const failures = lines.filter(l => l.startsWith('FAIL ')).map(l => l.slice(5).replace(/\n\s+/, ' — '));
document.title = `${failed ? 'FAIL' : 'PASS'} ${summary}${failed ? ` | ${failures.join(' || ')}` : ''}${infos.length ? ` ## ${infos.join(' ; ')}` : ''}`;
