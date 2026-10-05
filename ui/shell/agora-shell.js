//The Agora application shell: toolbar, palette, workspace and inspector around one open workspace.
//Everything it knows about the outside world comes from the host (identity, catalog, store) and the registry.
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { Workspace } from '../../core/workspace/workspace.js';
import { h } from '../dom.js';
import '../palette/agora-palette.js';
import '../workspace/agora-workspace.js';
import '../inspector/agora-inspector.js';

const STATUS_TEXT = { synced: 'Salvo', saving: 'Salvando…', error: 'Erro ao salvar', offline: 'Offline', connecting: 'Conectando…' };
const hashFor = id => `#/workspace/${id}`;
const idFromHash = () => /^#\/workspace\/(.+)$/.exec(location.hash)?.[1] ?? null;
const isTextField = element => element?.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

export class AgoraShell extends ReactiveComponent {
    #host = null;
    #registry = null;
    #workspace = null;
    #meta = null;
    #cleanup = [];
    #touchTimer = null;

    constructor() {
        super({ templateUrl: './agora-shell.html', shadowDom: true }, import.meta.url);
    }

    get workspace() { return this.#workspace; }

    #$(selector) { return this.rootNode.querySelector(selector); }

    //Shows a message under the toolbar. kind: 'error' | 'warning'
    notify(message, kind = 'error') {
        const banner = this.#$('#banner');
        banner.textContent = message;
        banner.className = kind;
        banner.hidden = !message;
    }

    async init({ host, registry }) {
        await this.whenLoaded();
        this.#host = host;
        this.#registry = registry;
        this.#$('agora-palette').registry = registry;
        this.#wire();
        if (host.persistent === false) this.notify('Armazenamento do navegador indisponível (janela anônima ou dados de site bloqueados). Seu trabalho NÃO será salvo ao recarregar.', 'warning');
        const open = () => this.#openFromHash().catch(error => {
            console.error('[agora-shell] could not open the workspace:', error);
            this.notify(`Não foi possível abrir o workspace: ${error.message}. Detalhes no Console (F12).`);
        });
        addEventListener('hashchange', open);
        await open();
    }

    #wire() {
        const on = (selector, event, fn) => this.#$(selector).addEventListener(event, fn);
        on('#new', 'click', async () => { location.hash = hashFor((await this.#host.create()).id); });
        on('#duplicate', 'click', async () => { if (this.#meta) location.hash = hashFor((await this.#host.duplicate(this.#meta.id)).id); });
        on('#archive', 'click', async () => {
            if (!this.#meta) return;
            await this.#host.archive(this.#meta.id);
            location.hash = '';
        });
        on('#workspaces', 'change', event => { location.hash = hashFor(event.target.value); });
        on('#title', 'change', async event => {
            const title = event.target.value.trim() || 'Sem título';
            this.#workspace?.setTitle(title);
            if (this.#meta) this.#meta = await this.#host.rename(this.#meta.id, title);
            await this.#refreshList();
        });
        on('#undo', 'click', () => this.#workspace?.doc.undo());
        on('#redo', 'click', () => this.#workspace?.doc.redo());
        for (const [button, pane] of [['#toggle-palette', '#palette-pane'], ['#toggle-inspector', '#inspector-pane']]) {
            on(button, 'click', event => {
                const hidden = this.#$(pane).toggleAttribute('hidden');
                event.currentTarget.setAttribute('aria-pressed', String(!hidden));
            });
        }
        this.rootNode.addEventListener('palette-add', event => {
            if (!this.#workspace) { this.notify('Nenhum workspace aberto ainda.'); return; }
            try { this.#workspace.addInstance(event.detail.type); } catch (error) {
                console.error('[agora-shell] could not add component:', error);
                this.notify(`Não foi possível adicionar o componente: ${error.message}`);
            }
        });
        this.rootNode.addEventListener('instance-selected', event => { this.#$('agora-inspector').selectedId = event.detail.id; });
        //Ctrl+Z / Ctrl+Shift+Z, unless the user is typing (text fields have their own undo)
        addEventListener('keydown', event => {
            if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || isTextField(event.composedPath()[0])) return;
            event.preventDefault();
            if (event.shiftKey) this.#workspace?.doc.redo(); else this.#workspace?.doc.undo();
        });
    }

    async #openFromHash() {
        let id = idFromHash();
        if (!id || !(await this.#host.get(id)) || (await this.#host.get(id)).archivedAt) {
            const first = (await this.#host.list())[0] ?? await this.#host.create('Meu primeiro workspace');
            id = first.id;
            history.replaceState(null, '', hashFor(id));
        }
        await this.#open(id);
    }

    async #open(id) {
        this.#cleanup.forEach(stop => stop());
        this.#cleanup = [];

        this.#meta = await this.#host.get(id);
        const doc = await this.#host.store.open(id);
        const workspace = new Workspace({ doc, registry: this.#registry, user: this.#host.identity });
        this.#workspace = workspace;

        this.#$('agora-workspace').workspace = workspace;
        this.#$('agora-inspector').workspace = workspace;
        this.#$('agora-inspector').selectedId = null;
        this.#$('agora-palette').canAdd = !workspace.readOnly;
        this.#$('#title').value = this.#meta.title;
        document.title = `${this.#meta.title} — Ultima Agora`;

        const refreshHistory = () => {
            this.#$('#undo').disabled = !doc.canUndo;
            this.#$('#redo').disabled = !doc.canRedo;
        };
        const showStatus = status => { this.#$('#status').textContent = STATUS_TEXT[status] ?? status; };
        refreshHistory();
        showStatus(doc.status);
        this.#cleanup.push(
            doc.onHistory(refreshHistory),
            doc.onChange('', () => {
                clearTimeout(this.#touchTimer);
                this.#touchTimer = setTimeout(() => this.#host.touch(id).catch(() => {}), 1000);
            }),
            doc.onStatus(showStatus),
        );
        await this.#refreshList();
    }

    async #refreshList() {
        const select = this.#$('#workspaces');
        const list = await this.#host.list();
        select.replaceChildren(...list.map(w => h('option', { value: w.id, selected: w.id === this.#meta?.id }, w.title)));
    }
}

customElements.define('agora-shell', AgoraShell);
