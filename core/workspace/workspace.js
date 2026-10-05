//The workspace controller: the only way to change the composition (R-INST-*, R-DOC-*). The UI, and later
//agents, call these operations; there is no other mutation path (principle "colaboração nativa").
//
//  doc.meta                     { schemaVersion, title }
//  doc.instances.<id>           { type, typeVersion, label, config, createdBy, createdVia }
//  doc.layout                   see layout.js
//  doc.content.<id>             collaborative content of one instance (R-DOC-2)
import { Layout } from './layout.js';
import { validateConfig } from '../registry/manifest.js';

export const SCHEMA_VERSION = 1;
import { uuid } from '../ids.js';
const newInstanceId = () => `cmp-${uuid().slice(0, 8)}`;

export class Workspace {
    #doc;
    #registry;
    #user;
    #layout;

    constructor({ doc, registry, user }) {
        this.#doc = doc;
        this.#registry = registry;
        this.#user = user;
        this.#layout = new Layout(doc);
        if (doc.get('meta.schemaVersion') === undefined) doc.set('meta.schemaVersion', SCHEMA_VERSION);
    }

    get doc() { return this.#doc; }
    get layout() { return this.#layout; }
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
