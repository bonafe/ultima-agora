//The call window: the call's controls above a small workspace of its own where each person is a window, so the
//call is composed with the same docking, floating and pop-out as everything else. That workspace is local and
//personal: it is not in the shared document and nobody else sees how you arranged it.
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { ComponentRegistry } from '../../core/registry/component_registry.js';
import { Workspace } from '../../core/workspace/workspace.js';
import { MemoryStateStore } from '../../collaboration/document/memory_state_store.js';
import '../workspace/agora-workspace.js';

const PERSON = 'ultima-call-person';
const LOCAL_COMPONENTS = ['conference/ultima-call-person.manifest.json', 'transcript/ultima-transcript.manifest.json'];

export class AgoraCall extends ReactiveComponent {
    #room = null;
    #workspace = null;
    #controls = null;
    #stops = [];
    #people = new Map();            //clientId -> instanceId of its window

    constructor() {
        super({ templateUrl: './agora-call.html', shadowDom: true }, import.meta.url);
    }

    get workspace() { return this.#workspace; }

    //parent: the shared Workspace (identity, conference room, transcript); registry: the application's, for the controls
    async init({ parent, registry }) {
        await this.whenLoaded();
        const room = this.#room = parent.conference;
        const view = this.rootNode.querySelector('agora-workspace');
        await view.whenLoaded();
        view.compactAt = 0;                                       //everybody visible, whatever the width

        const local = new ComponentRegistry();
        await Promise.all(LOCAL_COMPONENTS.map(path => local.registerFromUrl(new URL(`../../components/${path}`, import.meta.url))));
        const doc = await new MemoryStateStore().open(`call-${parent.id ?? 'local'}`);
        Object.assign(doc, { conference: room, transcript: parent.transcript, transcriber: parent.transcriber });
        this.#workspace = new Workspace({ doc, registry: local, user: parent.user });
        view.workspace = this.#workspace;

        await registry.load('ultima-conference');
        const manifest = registry.getManifest('ultima-conference');
        const controls = this.#controls = document.createElement(manifest.tag);
        controls.attach({ instanceId: 'call-controls', manifest, config: { tiles: false }, services: { conference: room, transcript: parent.transcript ?? undefined, transcriber: parent.transcriber ?? undefined } });
        this.rootNode.querySelector('#controls').append(controls);

        //"Abrir transcrição" in the controls opens it as a window of the call, not in the shared workspace
        this.addEventListener('palette-add', event => {
            event.stopPropagation();
            if (event.detail?.type !== 'ultima-transcript' || this.#workspace.instances().some(i => i.type === 'ultima-transcript')) return;
            this.#workspace.addInstance('ultima-transcript', { target: { side: 'bottom' } });
        });
        this.#stops = [room.on('change', () => this.#sync())];
        this.#sync();
    }

    onRole(role) { this.#controls?.onRole?.(role); }

    //One window per person while I am in the call; whoever leaves loses their window
    #sync() {
        const ws = this.#workspace, room = this.#room;
        if (!ws || !room) return;
        const people = room.joined ? room.participants : [];
        this.rootNode.querySelector('agora-workspace').toggleAttribute('hidden', !room.joined);
        const alive = new Set(people.map(p => p.clientId));
        for (const [clientId, instanceId] of this.#people) {
            if (!alive.has(clientId)) { ws.removeInstance(instanceId); this.#people.delete(clientId); }
        }
        for (const person of people) {
            const known = this.#people.get(person.clientId);
            if (known) { if (ws.instance(known)?.label !== person.user.name) ws.setLabel(known, person.user.name); continue; }
            const last = [...this.#people.values()].at(-1);
            const narrow = this.clientWidth > 0 && this.clientWidth < 520;                      //a phone: stack them, columns would be slivers
            const target = last ? { panelId: ws.layout.findPanelOf(last), side: narrow || !(this.#people.size % 2) ? 'bottom' : 'right' } : {};
            this.#people.set(person.clientId, ws.addInstance(PERSON, { config: { clientId: String(person.clientId) }, label: person.user.name, target }));
        }
    }

    dispose() {
        this.#stops.forEach(stop => stop());
        this.#controls?.dispose?.();
        this.rootNode.querySelector('agora-workspace').release();
    }
}

customElements.define('agora-call', AgoraCall);
