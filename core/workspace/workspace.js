//The workspace controller: the only way to change the composition (R-INST-*, R-DOC-*). The UI, and later
//agents, call these operations; there is no other mutation path (principle "colaboração nativa").
//
//  doc.meta                     { schemaVersion, title }
//  doc.instances.<id>           { type, typeVersion, label, config, createdBy, createdVia }
//  doc.layout                   see layout.js
//  doc.content.<id>             collaborative content of one instance (R-DOC-2)
import { Layout } from './layout.js';
import { validateConfig } from '../registry/manifest.js';
import { Bus } from '../connections/bus.js';

export const SCHEMA_VERSION = 1;
import { uuid } from '../ids.js';
const newInstanceId = () => `cmp-${uuid().slice(0, 8)}`;

export class Workspace {
    #doc;
    #registry;
    #user;
    #layout;
    #bus;

    constructor({ doc, registry, user }) {
        this.#doc = doc;
        this.#registry = registry;
        this.#user = user;
        this.#layout = new Layout(doc);
        this.#bus = new Bus(this);
        if (doc.get('meta.schemaVersion') === undefined) doc.set('meta.schemaVersion', SCHEMA_VERSION);
    }

    get doc() { return this.#doc; }
    get layout() { return this.#layout; }
    get bus() { return this.#bus; }
    get registry() { return this.#registry; }
    get user() { return this.#user; }
    //R-DOC-1: a document from a newer schema than we know is opened read-only.
    get readOnly() { return (this.#doc.get('meta.schemaVersion') ?? 0) > SCHEMA_VERSION; }

    instance(id) {
        const record = this.#doc.get(['instances', id]);
        return record ? { id, ...record } : null;
    }

    instances() {
        return Object.entries(this.#doc.get('instances') ?? {}).map(([id, record]) => ({ id, ...record }));
    }

    #assertWritable() {
        if (this.readOnly) throw new Error('This workspace was made by a newer version and is read-only');
    }

    //Creates an instance and places it in the layout, as one undoable operation.
    addInstance(type, { config = {}, label = null, target = {}, createdVia = 'palette' } = {}) {
        this.#assertWritable();
        const manifest = this.#registry.getManifest(type);
        if (!manifest) throw new Error(`Component "${type}" is not registered`);
        const errors = validateConfig(manifest, config);
        if (errors.length) throw new Error(`Invalid config for "${type}": ${errors.join('; ')}`);

        const id = newInstanceId();
        this.#doc.transact(`add ${type}`, () => {
            this.#doc.set(['instances', id], {
                type, typeVersion: manifest.version, label: label ?? manifest.title, config,
                createdBy: this.#user.id, createdVia,
            });
            this.#layout.place(id, target);
        });
        return id;
    }

    //Removes the instance. Its content stays in the document so that undo brings it back intact.
    removeInstance(id) {
        this.#assertWritable();
        this.#doc.transact(`remove ${id}`, () => {
            this.#bus.removeConnectionsOf(id);                  //R-INST-4
            this.#layout.remove(id);
            this.#doc.delete(['instances', id]);
        });
    }

    moveInstance(id, target) { this.#assertWritable(); this.#layout.move(id, target); }

    //Returns the list of validation problems; applies the patch only when there are none. Written per
    //field, so that simultaneous edits of different fields merge (R-CONF-1).
    setConfig(id, patch) {
        this.#assertWritable();
        const record = this.instance(id);
        if (!record) throw new Error(`Unknown instance "${id}"`);
        const manifest = this.#registry.getManifest(record.type);
        const errors = manifest ? validateConfig(manifest, patch) : [];
        if (errors.length) return errors;
        this.#doc.transact(`configure ${id}`, () => {
            for (const [field, value] of Object.entries(patch)) this.#doc.set(['instances', id, 'config', field], value);
        });
        return [];
    }

    setLabel(id, label) {
        this.#assertWritable();
        this.#doc.transact(`rename ${id}`, () => this.#doc.set(['instances', id, 'label'], label));
    }

    // ---- actions and suggestions (docs 04, 4.6 and 4.7) ----

    //Components that can display a value of `type` on one of their inputs, best first: the ones the action
    //names, then those needing no conversion, then by title.
    suggestVisualizations(type, prefer = []) {
        const types = this.#registry.types;
        return this.#registry.list().flatMap(manifest => {
            for (const [port, spec] of Object.entries(manifest.inputs ?? {})) {
                const compatibility = types.compatibility(type, spec.type);
                if (compatibility.ok) return [{ component: manifest.name, title: manifest.title, port, via: compatibility.via }];
            }
            return [];
        }).sort((a, b) => {
            const rank = c => { const i = prefer.indexOf(c.component); return i === -1 ? prefer.length : i; };
            return rank(a) - rank(b) || (a.via ? 1 : 0) - (b.via ? 1 : 0) || a.title.localeCompare(b.title);
        });
    }

    //Creates a component showing what `sourceId` emits on `sourcePort`, next to it and connected, in ONE
    //undoable operation (R-ACT-2, R-SUG-2).
    createLinked(sourceId, sourcePort, candidate) {
        this.#assertWritable();
        let created = null;
        this.#doc.transact(`link ${candidate.component}`, () => {
            const panelId = this.#layout.findPanelOf(sourceId);
            created = this.addInstance(candidate.component, { createdVia: 'action', target: panelId ? { panelId, side: 'right' } : {} });
            this.#bus.connect({ instance: sourceId, port: sourcePort }, { instance: created, port: candidate.port }, { createdVia: 'action' });
        });
        return created;
    }

    //Runs an action of a live instance. Actions with effect "emit"/"create" publish their result on the
    //declared output port; "create" also offers (or, with autoCreate, makes) a visualization of it.
    async invokeAction(instanceId, name, args) {
        const element = this.#bus.element(instanceId);
        if (!element) throw new Error('O componente precisa estar aberto (visível) para executar ações');
        const manifest = this.#registry.getManifest(this.instance(instanceId).type);
        const spec = manifest.actions?.[name];
        if (!spec) throw new Error(`Ação desconhecida: ${name}`);

        const result = await element.invokeAction(name, args);
        if (spec.effect === 'emit' || spec.effect === 'create') this.#bus.publish(instanceId, spec.port, result);

        let suggestions = [];
        let created = null;
        if (spec.effect === 'create') {
            suggestions = this.suggestVisualizations(spec.produces, spec.suggests ?? []);
            if (spec.autoCreate && suggestions.length) created = this.createLinked(instanceId, spec.port, suggestions[0]);
        }
        return { result, port: spec.port, suggestions, created };
    }

    get title() { return this.#doc.get('meta.title') ?? ''; }
    setTitle(title) { this.#doc.transact('title', () => this.#doc.set('meta.title', title)); }

    //Collaborative text of an instance, behind the SharedText interface (R-NOTES-4) so that a Yjs-backed
    //version can replace it. Plain string for now.
    sharedText(id) {
        const path = ['content', id, 'text'];
        return {
            getText: () => this.#doc.get(path) ?? '',
            setText: text => { this.#assertWritable(); this.#doc.transact(`edit ${id}`, () => this.#doc.set(path, text)); },
            onChange: fn => this.#doc.onChange(path, () => fn(this.#doc.get(path) ?? '')),
        };
    }

    onChange(fn) { return this.#doc.onChange('', fn); }
}
