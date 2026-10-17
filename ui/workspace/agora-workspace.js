//Renders the workspace's docking layout and hosts the component instances (docs 07, 7.3).
//
//Structural changes (layout, instances added/removed/renamed) repaint the panel tree, reusing the live
//instance elements. Config changes go straight to the element, and content changes (notes text) never
//repaint: moving a focused textarea would blur it. Which tab is active, and which instance is selected,
//are per-user view state and stay out of the document (R-LAY-5).
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { h } from '../dom.js';
import { COMPONENT_MIME } from '../palette/agora-palette.js';
import { dropTargetAt, placement } from './drop_targets.js';
import { createFloatFrame } from './float_frame.js';
import { openPopout, openPip, pipSupported } from './popout.js';
import { buildCompactBar, buildSheet } from './compact_bar.js';
import { flattenTree } from '../../core/workspace/layout.js';

const COMPACT_AT = 720;             //px of the workspace's own width below which it shows one window at a time (R-LAY-13)
const DRAG_THRESHOLD = 5;           //px before a press on a tab becomes a drag
const MENU_ITEMS = [['right', 'Dividir à direita'], ['bottom', 'Dividir abaixo'], ['left', 'Dividir à esquerda'], ['top', 'Dividir acima']];

export class AgoraWorkspaceView extends ReactiveComponent {
    #workspace = null;
    #stop = [];
    #elements = new Map();          //instanceId -> { element, body }
    #active = new Map();            //panelId -> instanceId (view state)
    #tabsSeen = new Map();          //panelId -> Set of instanceIds already shown there
    #selected = null;
    #queued = false;
    #refocus = null;                //splitter id to refocus after a repaint
    #detached = new Map();          //instanceId -> { kind: 'float' | 'window', body, frame?, popout? } (view state, R-LAY-5)
    #personal = new Map();          //id -> { title, element, park, dock }: windows of the shell (the call), not in the document
                                    //dock: null (floating / other window) or { panelId, side, ratio }: shown beside a panel, for this person only
    #compactAt = COMPACT_AT;
    #compact = false;               //narrow box: one window at a time (a different presentation of the same document)
    #compactActive = null;          //the window shown (view state, never in the document)
    #compactSeen = new Set();       //windows already in the list: a new one becomes the active
    #viewed = new Set();            //windows looked at at least once: only those get the "news" dot
    #activity = new Set();          //windows that received a value while hidden
    #compactRecords = [];
    #accessory = null;              //an element the shell wants above the bar when compact (the call's mini-bar)
    #sheet = false;                 //the list of all windows is open
    #renaming = null;
    #virtual = new Map();           //virtual panel id -> the real panel it hangs from (rebuilt on every paint)

    //How a new browser window is opened (tests replace it)
    openWindow = (...args) => window.open(...args);
    requestPip = undefined;         //test seam for documentPictureInPicture.requestWindow; also lets a test pretend support
    get pipAvailable() { return this.requestPip !== undefined || pipSupported(this.ownerDocument.defaultView ?? window); }

    constructor() {
        super({ templateUrl: './agora-workspace.html', shadowDom: true }, import.meta.url);
    }

    get workspace() { return this.#workspace; }
    set workspace(workspace) {
        this.release();
        this.#workspace = workspace;
        this.#stop = [
            workspace.doc.onChange('', path => this.#onDocChange(path)),
            workspace.onRole(role => {
                this.#elements.forEach(entry => entry.element?.onRole?.(role));
                this.#queuePaint();                                         //move/close controls appear or disappear
            }),
            workspace.doc.presence.onPeers(() => this.#paintBadges()),
            workspace.bus.onDelivery(id => this.#onDelivery(id)),
        ];
        this.#queuePaint();
    }

    //Lets go of the workspace: stops listening, disposes the instances, closes detached windows
    release() {
        this.#stop.forEach(stop => stop());
        this.#stop = [];
        for (const id of [...this.#personal.keys()]) this.hidePersonal(id);
        this.#detached.forEach(detached => this.#release(detached));
        this.#detached.clear();
        this.#elements.forEach((entry, id) => { entry.element?.dispose?.(); this.#workspace?.bus.detach(id); });
        this.#elements.clear();
    }

    get selectedId() { return this.#selected; }
    get compact() { return this.#compact; }

    //Something the shell keeps above the bar in the compact presentation (the call's mini-bar); null removes it
    set compactAccessory(element) { this.#accessory = element; if (this.#compact) this.#queuePaint(); }

    //Width below which this view shows one window at a time; 0 = never (a view of people in a call wants them all visible)
    get compactAt() { return this.#compactAt; }
    set compactAt(width) { this.#compactAt = width; if (this.loaded) this.#checkCompact(); }

    #checkCompact() {
        const compact = this.clientWidth > 0 && this.clientWidth < this.#compactAt;
        if (compact === this.#compact) return;
        this.#compact = compact;
        this.toggleAttribute('compact', compact);
        this.#queuePaint();
    }

    select(id) {
        if (this.#selected === id) return;
        if (id && !this.#workspace?.instance(id)) return;                       //a personal window is not an instance
        this.#selected = id;
        this.#workspace?.doc.presence.setLocal({ focus: id });
        this.rootNode.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('selected', tab.dataset.id === id));
        this.dispatchEvent(new CustomEvent('instance-selected', { detail: { id }, bubbles: true, composed: true }));
    }

    onLoad() {
        super.onLoad();
        this.#wireComponentDrops();
        new ResizeObserver(() => this.#detached.forEach(detached => detached.frame?.fit())).observe(this.rootNode.querySelector('#floats'));
        //The workspace decides how to present itself by the width of its own box, not of the screen: a narrow browser window is as compact as a phone
        new ResizeObserver(() => this.#checkCompact()).observe(this);
        this.#queuePaint();
    }

    #onDocChange(path) {
        const config = /^instances\.([^.]+)\.config(\.|$)/.exec(path);
        if (config) {
            const record = this.#workspace.instance(config[1]);
            if (record) this.#elements.get(config[1])?.element?.applyConfig?.(record.config);
            return;
        }
        if (path.startsWith('content.') || path.startsWith('meta')) return;
        this.#queuePaint();
    }

    #queuePaint() {
        if (this.#queued) return;
        this.#queued = true;
        queueMicrotask(() => { this.#queued = false; this.#paint(); });
    }

    // ---- presence on the tabs: who is looking at what (5.3) ----

    #paintBadges() {
        if (!this.loaded || !this.#workspace) return;
        const peers = this.#workspace.doc.presence.peers();
        for (const tab of this.rootNode.querySelectorAll('.tab')) {
            tab.querySelectorAll('.peer-dot').forEach(dot => dot.remove());
            const here = peers.filter(peer => peer.focus === tab.dataset.id);
            tab.prepend(...here.map(peer => h('span', {
                class: 'peer-dot', style: `background:${peer.user.color ?? '#667'}`,
                title: `${peer.user.name}${peer.activity?.instance === tab.dataset.id ? ' está editando' : ' está aqui'}`,
            }, peer.activity?.instance === tab.dataset.id ? '✎' : '')));
        }
    }

    // ---- painting ----

    #paint() {
        const workspace = this.#workspace;
        if (!this.loaded || !workspace) return;
        const root = this.rootNode.querySelector('#root');

        const live = new Set(workspace.instances().map(i => i.id));
        for (const [id, entry] of this.#elements) {
            if (!live.has(id)) { entry.element?.dispose?.(); this.#workspace.bus.detach(id); this.#elements.delete(id); }
        }
        for (const [id, detached] of this.#detached) if (!live.has(id) && !this.#personal.has(id)) { this.#release(detached); this.#detached.delete(id); }
        if (this.#selected && !live.has(this.#selected)) { this.#selected = null; this.dispatchEvent(new CustomEvent('instance-selected', { detail: { id: null }, bubbles: true, composed: true })); }

        const tree = this.#withPersonal(workspace.layout.tree());
        root.replaceChildren(this.#compact ? this.#buildCompact(tree) : tree ? this.#buildNode(tree) : this.#emptyState());
        for (const [id, detached] of this.#detached) if (!this.#personal.has(id)) detached.frame?.setTitle(workspace.instance(id)?.label ?? '');

        this.#paintBadges();
        if (this.#refocus) { root.querySelector(`[data-split="${this.#refocus}"]`)?.focus(); this.#refocus = null; }
    }

    #emptyState() {
        return h('div', { class: 'empty' }, h('h2', {}, 'Workspace vazio'), h('p', {}, 'Escolha um componente na paleta (clique ou Enter) ou arraste-o até aqui.'));
    }

    #buildNode(node) {
        return node.kind === 'split' ? this.#buildSplit(node) : this.#buildTabs(node);
    }

    #buildSplit(node) {
        const [first, second] = node.children.map(child => this.#buildNode(child));
        first.style.flex = `${node.ratio} 1 0`;
        second.style.flex = `${1 - node.ratio} 1 0`;
        const splitter = h('div', {
            class: 'splitter', role: 'separator', tabindex: this.#workspace.readOnly ? null : 0, 'data-split': node.id,
            'aria-orientation': node.dir === 'row' ? 'vertical' : 'horizontal', 'aria-valuenow': Math.round(node.ratio * 100), 'aria-valuemin': 10, 'aria-valuemax': 90,
        });
        const container = h('div', { class: `split ${node.dir}` }, first, splitter, second);
        if (!this.#workspace.readOnly) this.#makeResizable(splitter, container, node, first, second);
        return container;
    }

    #makeResizable(splitter, container, node, first, second) {
        const horizontal = node.dir === 'row';
        const ratioAt = event => {
            const rect = container.getBoundingClientRect();
            return horizontal ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
        };
        let ratio = node.ratio;
        splitter.addEventListener('pointerdown', event => {
            splitter.setPointerCapture(event.pointerId);
            const move = e => {
                ratio = Math.min(0.9, Math.max(0.1, ratioAt(e)));
                first.style.flex = `${ratio} 1 0`; second.style.flex = `${1 - ratio} 1 0`;
            };
            const up = () => {
                splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up);
                this.#setRatio(node, ratio);
            };
            splitter.addEventListener('pointermove', move);
            splitter.addEventListener('pointerup', up);
        });
        splitter.addEventListener('keydown', event => {
            const keys = horizontal ? { ArrowLeft: -0.05, ArrowRight: 0.05 } : { ArrowUp: -0.05, ArrowDown: 0.05 };
            if (!(event.key in keys)) return;
            event.preventDefault();
            this.#refocus = node.id;
            this.#setRatio(node, node.ratio + keys[event.key]);
        });
    }

    //A split made for a personal window has no place in the document: its ratio is this person's
    #setRatio(node, ratio) {
        if (!node.personal) { this.#workspace.layout.setRatio(node.id, ratio); return; }
        const dock = this.#personal.get(node.personal)?.dock;
        if (dock) { dock.ratio = Math.min(0.9, Math.max(0.1, ratio)); this.#queuePaint(); }
    }

    //The shared tree as drawn for THIS person: personal windows docked beside a panel are woven in as tabs or splits.
    //Nothing here is written to the document; if the panel a window hangs from disappears, the window floats.
    #withPersonal(tree) {
        this.#virtual.clear();
        const docked = [...this.#personal].filter(([, p]) => p.dock);
        if (!docked.length) return tree;
        const has = (node, id) => node && (node.id === id || node.children?.some(child => has(child, id)));
        for (const [id, p] of docked) {
            if (p.dock.panelId && !has(tree, p.dock.panelId)) { p.dock = null; queueMicrotask(() => this.float(id)); }
        }
        const at = anchor => [...this.#personal].filter(([, p]) => p.dock && (p.dock.panelId ?? null) === anchor);
        const split = (id, p, node, anchor) => {
            const vid = `v-${id}`;
            this.#virtual.set(vid, anchor);
            const first = p.dock.side === 'left' || p.dock.side === 'top';
            const own = { id: vid, kind: 'tabs', tabs: [id] };
            return { id: `v-split-${id}`, personal: id, kind: 'split', dir: p.dock.side === 'left' || p.dock.side === 'right' ? 'row' : 'column',
                ratio: p.dock.ratio ?? (first ? 0.35 : 0.65), children: first ? [own, node] : [node, own] };
        };
        const wrap = node => {
            if (node.kind === 'split') return { ...node, children: node.children.map(wrap) };
            const here = at(node.id);
            let result = { ...node, tabs: [...node.tabs, ...here.filter(([, p]) => p.dock.side === 'center').map(([id]) => id)] };
            for (const [id, p] of here) if (p.dock.side !== 'center') result = split(id, p, result, node.id);
            return result;
        };
        let result = tree ? wrap(tree) : null;
        for (const [id, p] of at(null)) {
            if (!result) { this.#virtual.set(`v-${id}`, null); result = { id: `v-${id}`, kind: 'tabs', tabs: [id] }; }
            else if (p.dock.side === 'center') this.#virtual.set(`v-${id}`, null), result = result.kind === 'tabs' ? { ...result, tabs: [...result.tabs, id] } : split(id, { dock: { ...p.dock, side: 'bottom' } }, result, null);
            else result = split(id, p, result, null);
        }
        return result;
    }

    //What a tab stands for: an instance of the document, or a personal window
    #record(id) {
        const instance = this.#workspace.instance(id);
        if (instance) return instance;
        const personal = this.#personal.get(id);
        return personal ? { id, label: personal.title, personal: true } : null;
    }

    #buildTabs(node) {
        const workspace = this.#workspace;
        const readOnly = workspace.readOnly;
        const records = node.tabs.map(id => this.#record(id)).filter(Boolean);
        const ids = records.map(r => r.id);

        //Active tab: first one on first sight; afterwards the newest arrival; otherwise whatever the user chose
        const seen = this.#tabsSeen.get(node.id);
        const fresh = ids.filter(id => !seen?.has(id));
        let active = this.#active.get(node.id);
        if (!seen) active = ids[0];
        else if (fresh.length) active = fresh.at(-1);
        if (!ids.includes(active)) active = ids[0];
        this.#active.set(node.id, active);
        this.#tabsSeen.set(node.id, new Set(ids));

        const panel = h('div', { class: 'panel', 'data-panel': node.id });
        const select = id => { this.#active.set(node.id, id); this.#queuePaint(); this.select(id); };

        const tabs = records.map(record => h('div', {
            class: `tab${record.id === this.#selected ? ' selected' : ''}${this.#detached.has(record.id) ? ' is-detached' : ''}`, role: 'presentation', 'data-id': record.id,
            onPointerdown: event => { if (!event.target.closest('.close')) this.#beginDrag(event, record.id); },
            onDblclick: event => { if (!event.target.closest('.close')) this.float(record.id); },
        },
            h('button', { class: 'label', type: 'button', role: 'tab', 'aria-selected': record.id === active ? 'true' : 'false', tabindex: record.id === active ? 0 : -1, onClick: () => select(record.id), onKeydown: event => this.#tabKeys(event, ids, record.id, select) }, record.label),
            record.personal ? h('button', { class: 'close', type: 'button', 'aria-label': `Esconder ${record.label}`, title: 'Esconder (a chamada continua)', onClick: () => this.hidePersonal(record.id) }, '–')
                : readOnly ? null : h('button', { class: 'close', type: 'button', 'aria-label': `Fechar ${record.label}`, onClick: () => workspace.removeInstance(record.id) }, '×'),
        ));

        const bar = h('div', { class: 'tabbar', onPointerdown: event => { if (!event.target.closest('.tab, button')) this.#beginDrag(event, active); } },
            h('div', { class: 'tabs', role: 'tablist' }, tabs));
        bar.append(h('button', { type: 'button', 'aria-label': 'Mais ações do painel', 'aria-haspopup': 'menu', onClick: () => this.#toggleMenu(bar, active) }, '⋯'));
        panel.append(bar);

        for (const record of records) {
            const body = h('div', { class: 'tabpanel', role: 'tabpanel', hidden: record.id !== active, 'aria-label': record.label });
            //Every instance is mounted, the inactive tabs just hidden: outputs are derived from the live component, so a
            //source on a background tab must still produce its values for whatever is connected to it (found in M4)
            this.#mount(record, body);
            panel.append(body);
        }
        panel.addEventListener('pointerdown', () => { if (this.#active.get(node.id)) this.select(this.#active.get(node.id)); }, true);

        return panel;
    }

    #tabKeys(event, ids, current, select) {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = ids[(ids.indexOf(current) + step + ids.length) % ids.length];
        select(next);
        queueMicrotask(() => this.rootNode.querySelector(`.tab[data-id="${next}"] button.label`)?.focus());
    }

    #toggleMenu(bar, instanceId) {
        const existing = bar.querySelector('.menu');
        if (existing) { existing.remove(); return; }
        const panelId = this.#workspace.layout.findPanelOf(instanceId);
        const close = () => menu.remove();
        const item = (label, action) => h('button', { type: 'button', role: 'menuitem', onClick: () => { close(); action(); } }, label);
        const detach = this.#detached.has(instanceId)
            ? [item('Reacoplar ao painel', () => this.dock(instanceId))]
            : [item('Destacar em janela flutuante', () => this.float(instanceId)), item('Destacar em outra janela do navegador', () => this.popout(instanceId)),
                ...(this.pipAvailable ? [item('Fixar por cima de tudo (PiP)', () => this.pip(instanceId))] : [])];
        const personal = this.#personal.has(instanceId) ? [item('Esconder (a chamada continua)', () => this.hidePersonal(instanceId))] : [];
        const structure = this.#workspace.readOnly || personal.length ? personal : [
            ...MENU_ITEMS.map(([side, label]) => item(label, () => this.#workspace.moveInstance(instanceId, { panelId, side }))),
            item('Fechar componente', () => this.#workspace.removeInstance(instanceId)),
        ];
        const menu = h('div', { class: 'menu', role: 'menu', onKeydown: event => { if (event.key === 'Escape') { close(); bar.querySelector('button[aria-haspopup]').focus(); } } }, ...detach, ...structure);
        bar.append(menu);
        menu.querySelector('button').focus();
    }

    // ---- instances ----

    //body: the tab's body. A detached instance keeps its element in its float/window; the tab only says so.
    #mount(record, body) {
        if (record.personal) { body.append(this.#personal.get(record.id).element); return; }
        let entry = this.#elements.get(record.id);
        if (!entry) {
            entry = { element: null, tabBody: body };
            this.#elements.set(record.id, entry);
            this.#create(record, entry);
        }
        entry.tabBody = body;
        const detached = this.#awayFrom(record.id);
        if (detached) {
            body.append(this.#placeholder(record, detached));
            if (entry.element && entry.element.parentNode !== detached.body) detached.body.replaceChildren(entry.element);
            return;
        }
        body.append(entry.element ?? h('p', { class: 'notice' }, 'Carregando…'));
    }

    async #create(record, entry) {
        const workspace = this.#workspace;
        const manifest = workspace.registry.getManifest(record.type);
        let element;
        try {
            if (!manifest) throw new Error(`O componente "${record.type}" não está instalado. Sua configuração foi preservada.`);
            await workspace.registry.load(record.type);
            element = document.createElement(manifest.tag);
            element.attach({
                instanceId: record.id, manifest, config: record.config,
                services: {
                    setConfig: patch => workspace.setConfig(record.id, patch),
                    emit: (port, value) => {
                        try { workspace.bus.publish(record.id, port, value); } catch (error) { console.error(`[${manifest.name}]`, error.message); }
                    },
                    ports: workspace.bus.portsFor(record.id),
                    domain: workspace.domain ?? undefined,
                    chat: workspace.chat ?? undefined,
                    conference: workspace.conference ?? undefined,
                    transcript: workspace.transcript ?? undefined,
                    transcriber: workspace.transcriber ?? undefined,
                    presence: {
                        //"I am editing here" (typing); cleared by passing null
                        setActivity: kind => workspace.doc.presence.setLocal({ activity: kind ? { instance: record.id, kind } : null }),
                    },
                    shared: manifest.capabilities?.includes('shared-content') ? workspace.sharedText(record.id) : undefined,
                },
            });
        } catch (error) {
            console.error(`[agora-workspace] could not create ${record.id}:`, error);
            element = h('p', { class: 'notice error', role: 'alert' }, error.message);
        }
        if (this.#elements.get(record.id) !== entry) { element.dispose?.(); return; }       //removed while loading
        entry.element = element;
        (this.#detached.get(record.id)?.body ?? entry.tabBody).replaceChildren(element);
        element.onRole?.(workspace.role);
        if (element.deliverInput) workspace.bus.attach(record.id, element);
    }

    // ---- detaching: floating windows and other browser windows (view state, never in the document) ----

    isDetached(id) { return this.#detached.has(id); }

    #notice(message) { this.dispatchEvent(new CustomEvent('view-notice', { detail: { message }, bubbles: true, composed: true })); }

    //Where the element is drawn instead of the panel/stage: a floating window or another browser window. A narrow box
    //has no room for floating windows, so there they are drawn in the list like any other window.
    #awayFrom(id) {
        const detached = this.#detached.get(id);
        return detached && !(this.#compact && detached.kind === 'float') ? detached : null;
    }

    #placeholder(record, detached) {
        const where = detached.kind === 'float' ? 'numa janela flutuante' : 'em outra janela do navegador';
        return h('div', { class: 'detached' },
            h('p', {}, `“${record.label}” está ${where}.`),
            h('div', {},
                h('button', { type: 'button', onClick: () => { detached.frame?.raise(); detached.popout?.focus(); } }, 'Mostrar'), ' ',
                h('button', { type: 'button', onClick: () => this.dock(record.id) }, 'Reacoplar aqui')));
    }

    #elementOf(id) { return this.#personal.get(id)?.element ?? this.#elements.get(id)?.element ?? null; }
    #labelOf(id) { return this.#personal.get(id)?.title ?? this.#workspace?.instance(id)?.label ?? null; }

    #release(detached) { detached.frame?.destroy(); detached.popout?.close(); }

    //Makes `next` the place where the live element is drawn. The element itself is never recreated.
    #adopt(id, next) {
        const previous = this.#detached.get(id);
        const personal = this.#personal.get(id);
        if (personal) personal.dock = null;
        this.#detached.set(id, next);
        next.body.replaceChildren(this.#elementOf(id) ?? h('p', { class: 'notice' }, 'Carregando…'));
        if (previous) this.#release(previous);
        this.#queuePaint();
    }

    //Where the window should open: over the place the component was, a little off so it reads as a new layer
    #defaultRect(id) {
        const layer = this.rootNode.querySelector('#floats').getBoundingClientRect();
        const shown = this.#elements.get(id)?.tabBody?.getBoundingClientRect();
        const cascade = this.#detached.size * 28;
        //At most ~80% of the workspace: a window that fills it leaves its edges on the screen's edge, where they are hard to grab
        const w = Math.min(Math.max(shown?.width ?? 0, 360), Math.max(240, Math.round(layer.width * 0.8)));
        const h = Math.min(Math.max(shown?.height ?? 0, 260), Math.max(160, Math.round(layer.height * 0.8)));
        //Fully inside the layer: a bottom or right edge out of sight cannot be grabbed to resize
        const fit = rect => ({ ...rect, x: Math.max(0, Math.min(rect.x, layer.width - rect.w)), y: Math.max(0, Math.min(rect.y, layer.height - rect.h)) });
        return fit(shown?.width ? { x: shown.left - layer.left + 24 + cascade, y: shown.top - layer.top + 24 + cascade, w, h } : { x: 60 + cascade, y: 60 + cascade, w: 480, h: 360 });
    }

    //Shows the component in a floating window over the workspace.
    float(id, rect = null) {
        const label = this.#labelOf(id);
        if (label === null || !this.loaded) return;
        const current = this.#detached.get(id);
        if (current?.kind === 'float') { current.frame.raise(); return; }
        const frame = createFloatFrame({
            layer: this.rootNode.querySelector('#floats'), title: label, rect: rect ?? this.#defaultRect(id),
            dockLabel: this.#personal.has(id) ? 'Acoplar a um painel' : 'Reacoplar ao painel',
            onHide: this.#personal.has(id) ? () => this.hidePersonal(id) : null,
            onDock: () => this.dock(id), onPopout: at => this.popout(id, at ?? null), onRaise: () => this.select(id),
        });
        this.#adopt(id, { kind: 'float', frame, body: frame.body });
        this.select(id);
        this.#announce(id);
    }

    //Shows the component in another browser window. `at` ({ x, y } screen coordinates) puts it where the pointer was
    //dropped, so dragging a window out of the browser lands it on the other monitor.
    popout(id, at = null) {
        const label = this.#labelOf(id);
        if (label === null || !this.loaded) return false;
        const current = this.#detached.get(id);
        if (current?.kind === 'window') { current.popout.focus(); return true; }
        const size = current?.frame?.rect ?? this.#defaultRect(id);
        const w = Math.max(size.w, 520), h = Math.max(size.h, 380);
        const rect = { w, h, x: at ? at.x - w / 2 : window.screenX + 80, y: at ? at.y - 20 : window.screenY + 80 };
        const popout = openPopout({
            title: label, rect, themeSource: this, open: this.openWindow,
            dockLabel: this.#personal.has(id) ? 'Acoplar ao workspace' : 'Reacoplar ao workspace',
            onHide: this.#personal.has(id) ? () => this.hidePersonal(id) : null,
            onDock: () => this.dock(id),
            //Closing the window: a component goes back to its panel, a personal window (the call) just hides
            onClosed: () => { if (this.#detached.get(id)?.popout === popout) { if (this.#personal.has(id)) this.hidePersonal(id); else this.dock(id); } },
        });
        if (!popout) {
            this.#notice('O navegador bloqueou a nova janela. Permita pop-ups para este site (ícone na barra de endereço) e tente de novo.');
            if (!current) this.float(id);
            return false;
        }
        this.#adopt(id, { kind: 'window', popout, body: popout.body });
        this.#announce(id);
        return true;
    }

    //Shows the component in a Picture-in-Picture window: small, on top of every application, one at a time.
    //Needs a user gesture (the menu click) or the browser's own trigger. Falls back to a floating window when refused.
    async pip(id) {
        const label = this.#labelOf(id);
        if (label === null || !this.loaded || !this.pipAvailable) return false;
        const current = this.#detached.get(id);
        if (current?.kind === 'window' && current.pip) { current.popout.focus(); return true; }
        const size = current?.frame?.rect ?? this.#defaultRect(id);
        const popout = await openPip({
            title: label, rect: { w: Math.min(Math.max(size.w, 320), 480), h: Math.min(Math.max(size.h, 220), 360) }, themeSource: this,
            ...(this.requestPip ? { request: this.requestPip } : {}),
            dockLabel: this.#personal.has(id) ? 'Acoplar ao workspace' : 'Reacoplar ao workspace',
            onHide: this.#personal.has(id) ? () => this.hidePersonal(id) : null,
            onDock: () => this.dock(id),
            onClosed: () => { if (this.#detached.get(id)?.popout === popout) { if (this.#personal.has(id)) this.hidePersonal(id); else this.dock(id); } },
        });
        if (!popout) {
            this.#notice('O navegador não abriu a janela Picture-in-Picture. Clique no botão de novo (precisa de um clique seu).');
            if (!current && !this.#detached.has(id)) this.float(id);
            return false;
        }
        this.#adopt(id, { kind: 'window', pip: true, popout, body: popout.body });
        this.#announce(id);
        return true;
    }

    //Brings the component back into its panel
    dock(id) {
        if (this.#personal.has(id)) { this.dockPersonal(id); return; }
        const detached = this.#detached.get(id);
        if (!detached) return;
        this.#detached.delete(id);
        const entry = this.#elements.get(id);
        if (entry?.element && entry.tabBody) entry.tabBody.replaceChildren(entry.element);     //out of the window before it closes
        this.#release(detached);
        const panelId = this.#workspace.layout.findPanelOf(id);
        if (panelId) this.#active.set(panelId, id);
        this.#queuePaint();
        this.select(id);
    }

    // ---- compact presentation: one window at a time, a bar at the bottom (R-LAY-13) ----

    #buildCompact(tree) {
        const ids = flattenTree(tree);
        const records = ids.map(id => this.#record(id)).filter(Boolean);
        this.#compactRecords = records;
        if (!records.length) return this.#emptyState();

        const fresh = records.filter(r => !this.#compactSeen.has(r.id));
        //Coming from the docking presentation: what the person was looking at (the selected window, else the last tab shown)
        let active = this.#compactActive ?? this.#selected ?? [...this.#active.values()].at(-1);
        if (this.#compactSeen.size && fresh.length) active = fresh.at(-1).id;
        if (!records.some(r => r.id === active)) active = records[0].id;
        this.#compactActive = active;
        this.#compactSeen = new Set(records.map(r => r.id));
        this.#viewed.add(active); this.#activity.delete(active);

        const stage = h('div', { class: 'compact-stage' });
        for (const record of records) {
            const body = h('div', { class: 'tabpanel', role: 'tabpanel', 'data-id': record.id, hidden: record.id !== active, 'aria-label': record.label });
            this.#mount(record, body);
            stage.append(body);
        }
        const layer = h('div', { class: 'compact' }, stage, this.#accessory, this.#compactBar());
        if (this.#sheet) layer.append(this.#compactSheet());
        if (this.#selected !== active && this.#workspace.instance(active)) queueMicrotask(() => this.select(active));
        return layer;
    }

    #compactBar() {
        return buildCompactBar({
            records: this.#compactRecords, active: this.#compactActive, activity: this.#activity,
            onSelect: (id, focus) => { this.showWindow(id); if (focus) queueMicrotask(() => this.rootNode.querySelector(`.compact-tab[data-id="${id}"]`)?.focus()); },
            onMore: () => { this.#sheet = true; this.#renaming = null; this.#queuePaint(); },
        });
    }

    #compactSheet() {
        const workspace = this.#workspace;
        const close = () => { this.#sheet = false; this.#renaming = null; this.#queuePaint(); };
        return buildSheet({
            records: this.#compactRecords, active: this.#compactActive, activity: this.#activity,
            canEdit: !workspace.readOnly, renaming: this.#renaming,
            onSelect: id => { this.#sheet = false; this.showWindow(id); this.#queuePaint(); },
            onClose: close,
            onStartRename: id => { this.#renaming = id; this.#queuePaint(); },
            onRename: (id, label) => { this.#renaming = null; try { workspace.setLabel(id, label); } catch (error) { console.error('[agora-workspace] rename failed:', error); } this.#queuePaint(); },
            onRemove: id => { try { workspace.removeInstance(id); } catch (error) { console.error('[agora-workspace] close failed:', error); } },
            onAdd: () => { this.#sheet = false; this.#queuePaint(); this.dispatchEvent(new CustomEvent('compact-add', { bubbles: true, composed: true })); },
        });
    }

    //Shows one window in the compact presentation. Only flips what is visible: nothing is rebuilt, so what the person
    //is typing in the others is not disturbed.
    showWindow(id) {
        if (!this.#compact || !this.#compactRecords.some(r => r.id === id)) return;
        this.#compactActive = id;
        this.#viewed.add(id); this.#activity.delete(id);
        for (const body of this.rootNode.querySelectorAll('.compact-stage > .tabpanel')) body.hidden = body.dataset.id !== id;
        this.#refreshBar();
        if (this.#workspace.instance(id)) this.select(id);
    }

    #refreshBar() {
        const bar = this.rootNode.querySelector('.compact-bar');
        if (bar) bar.replaceWith(this.#compactBar());
    }

    //News in a window the person is not looking at (a connected table changed what a graph shows): a dot, not a repaint
    #onDelivery(id) {
        if (!this.#compact || id === this.#compactActive || !this.#viewed.has(id) || this.#activity.has(id)) return;
        this.#activity.add(id);
        this.#refreshBar();
    }

    // ---- personal windows: a window of the shell (the call) that is not in the document ----
    //It floats, goes to another browser window and is hidden like any other, but has no panel to dock to: hiding
    //parks its element in `park` (a hidden container), so whatever it runs (the call) goes on.

    //Shows `element` as a floating window (or in another browser window). `rect` is { x, y, w, h } in the workspace.
    showPersonal(id, { title, element, park, rect = null }) {
        if (!this.loaded) return;
        this.#personal.set(id, { title, element, park, dock: null });
        const layer = this.rootNode.querySelector('#floats').getBoundingClientRect();
        const w = Math.min(560, Math.max(240, layer.width - 40)), height = Math.min(460, Math.max(160, layer.height - 40));
        this.float(id, rect ?? { x: layer.width - w - 20, y: layer.height - height - 20, w, h: height });
    }

    isPersonalShown(id) { return this.#personal.has(id); }

    //Shows the window beside a panel, like a component of the layout but only for this person. `panelId` null with
    //side 'center' = the first panel; with `root`, a side of the whole workspace. Dropped by dragging its tab.
    dockPersonal(id, { panelId = null, side = 'center', root = false } = {}) {
        const personal = this.#personal.get(id);
        if (!personal) return;
        const detached = this.#detached.get(id);
        if (detached) {
            this.#detached.delete(id);
            personal.park?.append(personal.element);                  //out of the window before it closes
            this.#release(detached);
        }
        const anchor = root ? null : panelId ?? (side === 'center' ? this.#workspace.layout.defaultPanel() : null);
        personal.dock = { panelId: anchor, side };
        this.#queuePaint();
        this.#announce(id);
    }

    hidePersonal(id) {
        const personal = this.#personal.get(id);
        if (!personal) return;
        const detached = this.#detached.get(id);
        this.#detached.delete(id);
        this.#personal.delete(id);
        personal.park?.append(personal.element);                  //out of the window before it closes
        if (detached) this.#release(detached);
        this.#queuePaint();
        this.dispatchEvent(new CustomEvent('personal-change', { detail: { id, shown: false }, bubbles: true, composed: true }));
    }

    #announce(id) {
        if (this.#personal.has(id)) this.dispatchEvent(new CustomEvent('personal-change', { detail: { id, shown: true, kind: this.#detached.get(id)?.kind ?? 'docked' }, bubbles: true, composed: true }));
    }

    // ---- drag and drop ----
    //One target computation (drop_targets.js) serves palette items (HTML5 drag) and windows (pointer drag), so the
    //highlight always shows what the drop will do.

    #targetAt(x, y, dragged = null) {
        const area = this.rootNode.querySelector('#root').getBoundingClientRect();
        const panels = [...this.rootNode.querySelectorAll('.panel')];
        return dropTargetAt({ area, panels, layout: this.#workspace.layout, dragged }, x, y);
    }

    //A panel that exists only for a personal window cannot receive document changes: they go to the panel it hangs from
    #resolve(target) {
        if (!this.#virtual.has(target.panelId)) return target;
        const { index, ...rest } = target;
        const anchor = this.#virtual.get(target.panelId);
        return anchor ? { ...rest, panelId: anchor } : { ...rest, panelId: this.#workspace.layout.defaultPanel() };
    }

    #showHint(target, outside = false) {
        const hint = this.rootNode.querySelector('#hint');
        hint.hidden = !target;
        if (!target) return;
        const { rect } = target;
        hint.className = `${target.index !== undefined ? 'slot' : ''}${outside ? ' outside' : ''}`;
        Object.assign(hint.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }

    //A press on a tab (or on the empty part of the bar) becomes a drag after a few pixels: a window follows the
    //pointer; releasing over a panel docks it there; releasing OUTSIDE the browser window opens it in a window of its own.
    #beginDrag(event, instanceId) {
        if (event.button !== 0 || !instanceId || (this.#workspace.readOnly && !this.#personal.has(instanceId))) return;
        const label = this.#labelOf(instanceId) ?? '';
        const start = { x: event.clientX, y: event.clientY };
        const pointerId = event.pointerId;
        const win = this.ownerDocument.defaultView ?? window;      //the window this view is drawn in (it may be a pop-out)
        let ghost = null, target = null, outside = false;

        const cleanup = () => {
            this.removeEventListener('pointermove', move); this.removeEventListener('pointerup', up); this.removeEventListener('pointercancel', cancel);
            win.removeEventListener('keydown', key, true);
            this.removeEventListener('dragstart', native); this.removeEventListener('selectstart', native);
            ghost?.remove();
            this.removeAttribute('dragging');
            this.#showHint(null);
            this.rootNode.querySelectorAll('.tab.dragged').forEach(tab => tab.classList.remove('dragged'));
            if (this.hasPointerCapture?.(pointerId)) this.releasePointerCapture(pointerId);
        };
        const move = e => {
            if (e.pointerId !== pointerId) return;
            if (!ghost) {
                if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
                ghost = h('div', { class: 'ghost' }, label, h('small', {}));
                this.rootNode.append(ghost);
                this.setAttribute('dragging', '');
                try { this.setPointerCapture(pointerId); } catch { /* synthetic pointer: nothing to capture */ }   //so that the pointer is followed outside the window too
                this.rootNode.querySelector(`.tab[data-id="${instanceId}"]`)?.classList.add('dragged');
            }
            outside = e.clientX < 0 || e.clientY < 0 || e.clientX > win.innerWidth || e.clientY > win.innerHeight;
            target = outside ? null : this.#targetAt(e.clientX, e.clientY, instanceId);
            ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
            ghost.lastChild.textContent = outside ? 'Solte para abrir em outra janela' : '';
            this.#showHint(target);
        };
        const up = e => {
            if (e.pointerId !== pointerId) return;
            const dragging = Boolean(ghost);
            const drop = target, out = outside;
            cleanup();
            if (!dragging) return;                                  //it was just a click
            try {
                if (out) this.popout(instanceId, { x: e.screenX, y: e.screenY });
                else if (drop && this.#personal.has(instanceId)) this.dockPersonal(instanceId, placement(this.#resolve(drop)));
                else if (drop) {
                    this.#workspace.moveInstance(instanceId, placement(this.#resolve(drop)));
                    if (this.#detached.has(instanceId)) this.dock(instanceId);
                }
            } catch (error) { console.error('[agora-workspace] drop failed:', error); }
        };
        const cancel = e => { if (e.pointerId === pointerId) cleanup(); };
        const native = e => e.preventDefault();          //the browser would start its own text drag/selection, cancelling this one
        const key = e => { if (e.key === 'Escape') cleanup(); };
        this.addEventListener('pointermove', move); this.addEventListener('pointerup', up); this.addEventListener('pointercancel', cancel);
        this.addEventListener('dragstart', native); this.addEventListener('selectstart', native);
        win.addEventListener('keydown', key, true);
    }

    //Items dragged from the palette use the browser's own drag and drop
    #wireComponentDrops() {
        const root = this.rootNode.querySelector('#root');
        const accepts = event => !this.#workspace?.readOnly && (event.dataTransfer?.types ?? []).includes(COMPONENT_MIME);
        root.addEventListener('dragover', event => {
            if (!accepts(event)) return;
            event.preventDefault();
            this.#showHint(this.#targetAt(event.clientX, event.clientY));
        });
        root.addEventListener('dragleave', event => { if (!event.relatedTarget || !root.contains(event.relatedTarget)) this.#showHint(null); });
        root.addEventListener('drop', event => {
            if (!accepts(event)) return;
            event.preventDefault();
            const target = this.#targetAt(event.clientX, event.clientY);
            this.#showHint(null);
            const type = event.dataTransfer.getData(COMPONENT_MIME);
            try { if (type && target) this.#workspace.addInstance(type, { target: placement(this.#resolve(target)) }); }
            catch (error) { console.error('[agora-workspace] drop failed:', error); }
        });
    }
}

customElements.define('agora-workspace', AgoraWorkspaceView);
