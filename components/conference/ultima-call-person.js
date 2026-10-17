import { AgoraComponent } from '../../core/components/agora_component.js';
import { createTile, paintTile } from './tile.js';

//One person of the call as a window of its own (config.clientId says whose). It only reads the ConferenceRoom,
//so it can be docked, floated or shown in another browser window like any other component.
export default class UltimaCallPerson extends AgoraComponent {
    #tile = null;
    #stops = [];

    constructor() {
        super({ templateUrl: './ultima-call-person.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        const room = this.conference;
        this.#stops = [room?.on('change', () => this.#paint()), this.transcript?.onChange(() => this.#paint())].filter(Boolean);
        this.#paint();
    }

    onConfig() { this.#paint(); }
    onDispose() { this.#stops.forEach(stop => stop()); }

    #paint() {
        if (!this.loaded) return;
        const person = this.conference?.participants.find(p => String(p.clientId) === this.config.clientId);
        this.rootNode.querySelector('#gone').toggleAttribute('hidden', !!person);
        const slot = this.rootNode.querySelector('#slot');
        slot.toggleAttribute('hidden', !person);
        if (!person) return;
        this.#tile ??= createTile(person);
        paintTile(this.#tile, person, this.transcript);
        if (this.#tile.element.parentNode !== slot) slot.append(this.#tile.element);
    }

    describeContext() { return { clientId: this.config.clientId }; }
}
