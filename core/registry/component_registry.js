//Catalog of component definitions. The palette is built from manifests alone; component code is
//only loaded when an instance is created (R-REG-1).
import { validateManifest } from './manifest.js';

export class ComponentRegistry extends EventTarget {
    #definitions = new Map();       //name -> { manifest, load, component }

    //manifest: object; load: () => Promise<module> whose default export (or `component`) is the class
    register({ manifest, load, replaces = null }) {
        const errors = validateManifest(manifest);
        if (errors.length) throw new Error(`Invalid manifest${manifest?.name ? ` "${manifest.name}"` : ''}:\n  ${errors.join('\n  ')}`);
        if (typeof load !== 'function') throw new TypeError(`register("${manifest.name}"): "load" must be a function`);

        const existing = this.#definitions.get(manifest.name);
        if (existing && existing.manifest.version !== replaces) {
            throw new Error(`Component "${manifest.name}" is already registered (version ${existing.manifest.version}); pass replaces: "${existing.manifest.version}" to override it`);
        }
        this.#definitions.set(manifest.name, { manifest: structuredClone(manifest), load, component: null });
        this.dispatchEvent(new CustomEvent('registered', { detail: { name: manifest.name } }));
    }

    unregister(name) {
        if (this.#definitions.delete(name)) this.dispatchEvent(new CustomEvent('unregistered', { detail: { name } }));
    }

    has(name) { return this.#definitions.has(name); }

    getManifest(name) { return this.#definitions.get(name)?.manifest ?? null; }

    list({ category = null, search = '' } = {}) {
        const term = search.trim().toLowerCase();
        return [...this.#definitions.values()].map(d => d.manifest)
            .filter(m => !category || m.category === category)
            .filter(m => !term || `${m.title} ${m.description ?? ''} ${m.name}`.toLowerCase().includes(term))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    //Loads the component class on first use and defines its custom element.
    async load(name) {
        const definition = this.#definitions.get(name);
        if (!definition) throw new Error(`Component "${name}" is not registered`);
        if (!definition.component) {
            const module = await definition.load();
            const component = module.default ?? module.component;
            if (typeof component !== 'function') throw new Error(`Component "${name}": the loaded module has no default export or "component" class`);
            if (!customElements.get(definition.manifest.tag)) customElements.define(definition.manifest.tag, component);
            definition.component = component;
        }
        return definition.component;
    }

    //Components with an input port that accepts `type` (exact match for now; subtyping and converters come with the bus, M2).
    typesAccepting(type) {
        return this.list().filter(m => Object.values(m.inputs ?? {}).some(port => port.type === type));
    }

    typesProducing(type) {
        return this.list().filter(m => Object.values(m.outputs ?? {}).some(port => port.type === type));
    }
}
