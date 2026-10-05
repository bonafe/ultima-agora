//Configuration panel for the selected instance, generated from the manifest's config schema (R-INS-1).
//Edits are committed on 'change' (blur/Enter), so one edit is one undo step, and go through Workspace.setConfig.
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { h } from '../dom.js';

export class AgoraInspector extends ReactiveComponent {
    #workspace = null;
    #selectedId = null;
    #stop = null;
    #queued = false;

    constructor() {
        super({ templateUrl: './agora-inspector.html', shadowDom: true }, import.meta.url);
    }

    set workspace(workspace) {
        this.#stop?.();
        this.#workspace = workspace;
        this.#stop = workspace?.doc.onChange('', path => {
            if (!path.startsWith('content.') && !this.rootNode.activeElement?.matches?.('input, textarea, select')) this.#queuePaint();
        });
        this.#queuePaint();
    }

    set selectedId(id) { this.#selectedId = id; this.#queuePaint(); }

    onLoad() { super.onLoad(); this.#queuePaint(); }

    #queuePaint() {
        if (this.#queued) return;
        this.#queued = true;
        queueMicrotask(() => { this.#queued = false; this.#paint(); });
    }

    #paint() {
        if (!this.loaded) return;
        const container = this.rootNode.querySelector('#inspector');
        const workspace = this.#workspace;
        const record = workspace && this.#selectedId ? workspace.instance(this.#selectedId) : null;
        if (!record) { container.replaceChildren(h('p', { class: 'empty' }, 'Selecione um componente para configurá-lo.')); return; }

        const manifest = workspace.registry.getManifest(record.type);
        const id = this.#selectedId;
        const readOnly = workspace.readOnly;

        const fields = Object.entries(manifest?.config ?? {}).map(([name, spec]) => this.#field(id, name, spec, record.config[name] ?? spec.default, readOnly));

        container.replaceChildren(...[
            h('h2', {}, record.label),
            h('h3', {}, 'Geral'),
            h('label', {}, h('span', {}, 'Nome'),
                h('input', { type: 'text', '.value': record.label, disabled: readOnly, onChange: event => { const label = event.target.value.trim(); if (label) { workspace.setLabel(id, label); container.querySelector('h2').textContent = label; } } })),
            fields.length ? h('h3', {}, 'Dados') : null,
            ...fields,
            h('h3', {}, 'Informações'),
            h('dl', {},
                h('dt', {}, 'Tipo'), h('dd', {}, `${record.type} ${record.typeVersion}${manifest ? '' : ' (não instalado)'}`),
                h('dt', {}, 'Criado por'), h('dd', {}, `${record.createdBy} (${record.createdVia})`),
                h('dt', {}, 'Id'), h('dd', {}, id)),
            readOnly ? null : h('button', { class: 'danger', type: 'button', onClick: () => workspace.removeInstance(id) }, 'Remover componente'),
        ].filter(Boolean));
    }

    #field(id, name, spec, value, readOnly) {
        const error = h('div', { class: 'error', role: 'alert' });
        const commit = parsed => {
            const errors = this.#workspace.setConfig(id, { [name]: parsed });
            error.textContent = errors.join(' ');
            if (errors.length) this.#queuePaint();
        };
        const common = { disabled: readOnly };
        let input;
        switch (spec.type) {
            case 'text': input = h('textarea', { ...common, '.value': value ?? '', onChange: e => commit(e.target.value) }); break;
            case 'boolean': input = h('input', { ...common, type: 'checkbox', '.checked': !!value, onChange: e => commit(e.target.checked) }); break;
            case 'integer': case 'number':
                input = h('input', { ...common, type: 'number', min: spec.min, max: spec.max, step: spec.type === 'integer' ? 1 : 'any', '.value': value ?? '', onChange: e => commit(e.target.value === '' ? spec.default : Number(e.target.value)) }); break;
            case 'enum':
                input = h('select', { ...common, onChange: e => commit(e.target.value) }, spec.values.map(v => h('option', { value: v, selected: v === value }, v))); break;
            case 'list':
                input = h('textarea', { ...common, '.value': JSON.stringify(value ?? [], null, 1), onChange: e => { try { commit(JSON.parse(e.target.value)); } catch { error.textContent = 'JSON inválido.'; } } }); break;
            case 'color': case 'date':
                input = h('input', { ...common, type: spec.type, '.value': value ?? '', onChange: e => commit(e.target.value) }); break;
            default:
                input = h('input', { ...common, type: 'text', '.value': value ?? '', onChange: e => commit(e.target.value) });
        }
        return h('label', {}, h('span', {}, spec.title ?? name), input, error);
    }
}

customElements.define('agora-inspector', AgoraInspector);
