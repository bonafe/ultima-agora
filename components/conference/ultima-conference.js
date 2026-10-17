import { AgoraComponent } from '../../core/components/agora_component.js';
import { h } from '../../ui/dom.js';
import { LANGUAGES } from '../../transcription/transcriber.js';

const T_STATUS = {
    waiting: 'Ligue o microfone para ser transcrito.',
    listening: 'Transcrevendo a sua fala (no seu dispositivo; só o texto vai para o workspace).',
    transcribing: 'Transcrevendo…',
};

//Audio and video with the people of the workspace. Needs only `this.conference` (a ConferenceRoom): it works as a tab
//in the workspace or as the shell's tray. Nothing here turns a device on by itself: the person ticks what to turn on.
export default class UltimaConference extends AgoraComponent {
    #stop = null;
    #tiles = new Map();                     // clientId -> { element, video, ... }: kept between repaints so the video never flickers
    #errors = [];

    constructor() {
        super({ templateUrl: './ultima-conference.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        const room = this.conference;
        const root = this.rootNode;
        if (!room) { this.#notice('A chamada não está disponível neste workspace.'); return; }

        root.querySelector('#join').addEventListener('submit', event => { event.preventDefault(); this.#join(); });
        root.querySelector('#mic').addEventListener('click', () => this.#toggle('mic'));
        root.querySelector('#cam').addEventListener('click', () => this.#toggle('cam'));
        root.querySelector('#leave').addEventListener('click', () => { room.leave(); this.#errors = []; });
        this.#stop = room.on('change', () => this.#paint());
        const stopError = room.on('error', error => this.#fail(error));
        const stops = [this.#stop, stopError];
        const transcriber = this.transcriber, transcript = this.transcript;
        if (transcriber) {
            root.querySelector('#transcribe').addEventListener('click', () => this.#toggleTranscription());
            root.querySelector('#language').addEventListener('change', event => transcriber.setLanguage(event.target.value));
            root.querySelector('#language').replaceChildren(...Object.entries(LANGUAGES).map(([code, name]) => h('option', { value: code }, name)));
            root.querySelector('#open-transcript').addEventListener('click', () => this.dispatchEvent(new CustomEvent('palette-add', { bubbles: true, composed: true, detail: { type: 'ultima-transcript' } })));
            stops.push(transcriber.onChange(() => this.#paint()));
        }
        if (transcript) stops.push(transcript.onChange(() => this.#paint()));
        this.#stop = () => stops.forEach(stop => stop());
        this.#paint();
    }

    onRole() { this.#paint(); }
    onDispose() { this.#stop?.(); }

    #notice(message) {
        const box = this.rootNode.querySelector('#notice');
        box.textContent = message ?? '';
        box.toggleAttribute('hidden', !message);
    }

    #fail(error) {
        if (!this.#errors.includes(error.message)) this.#errors.push(error.message);
        this.#paint();
    }

    async #join() {
        const room = this.conference;
        const root = this.rootNode;
        this.#errors = [];
        root.querySelector('#enter').disabled = true;
        try {
            const { errors } = await room.join({ mic: root.querySelector('#join-mic').checked && room.canPublish, cam: root.querySelector('#join-cam').checked && room.canPublish });
            this.#errors = errors.map(e => e.message);
        } catch (error) { this.#errors = [error.message]; }
        root.querySelector('#enter').disabled = false;
        this.#paint();
    }

    async #toggleTranscription() {
        const transcriber = this.transcriber;
        if (transcriber.enabled) transcriber.disable(); else await transcriber.enable();
        this.#paint();
    }

    async #toggle(kind) {
        const room = this.conference;
        const me = room.participants.find(p => p.self);
        this.#errors = [];
        try { await (kind === 'mic' ? room.setMic(!me?.mic) : room.setCam(!me?.cam)); }
        catch (error) { this.#errors = [error.message]; }
        this.#paint();
    }

    #paint() {
        const room = this.conference;
        if (!room || !this.loaded) return;
        const root = this.rootNode;
        const people = room.participants;

        this.#notice(room.supported ? (room.joined && !room.canPublish ? 'Seu papel só permite assistir e ouvir.' : null) : room.unsupportedReason);
        const errors = root.querySelector('#errors');
        errors.replaceChildren(...this.#errors.map(message => h('div', {}, message)));
        errors.toggleAttribute('hidden', !this.#errors.length);

        root.querySelector('#lobby').toggleAttribute('hidden', room.joined);
        root.querySelector('#call').toggleAttribute('hidden', !room.joined);

        if (!room.joined) {
            const names = people.map(p => p.user.name);
            root.querySelector('#who').textContent = names.length ? `Na chamada agora: ${names.join(', ')}.` : 'Ninguém está na chamada.';
            const publish = room.supported && room.canPublish;
            for (const id of ['#join-mic', '#join-cam']) root.querySelector(id).disabled = !publish;
            root.querySelector('#enter').disabled = !room.supported;
            return;
        }

        const me = people.find(p => p.self);
        for (const [id, on, label] of [['#mic', me?.mic, 'Microfone'], ['#cam', me?.cam, 'Câmera']]) {
            const button = root.querySelector(id);
            button.setAttribute('aria-pressed', String(!!on));
            button.textContent = `${label}: ${on ? 'ligado' : 'desligado'}`;
            button.disabled = !room.canPublish;
        }
        this.#paintTranscription();
        this.#paintTiles(people);
    }

    #paintTranscription() {
        const transcriber = this.transcriber;
        const box = this.rootNode.querySelector('#transcription');
        box.toggleAttribute('hidden', !transcriber);
        if (!transcriber) return;
        const button = this.rootNode.querySelector('#transcribe');
        button.setAttribute('aria-pressed', String(transcriber.enabled));
        button.textContent = transcriber.enabled ? 'Transcrição ligada' : 'Transcrever minha fala';
        button.disabled = !transcriber.supported || !transcriber.canWrite || transcriber.state === 'loading';
        const language = this.rootNode.querySelector('#language');
        if (language.value !== transcriber.language) language.value = transcriber.language;
        const text = transcriber.state === 'loading' ? `Carregando o modelo de transcrição… ${Math.round(transcriber.progress * 100)}% (só na primeira vez).`
            : transcriber.error ?? (!transcriber.supported ? transcriber.unsupportedReason : !transcriber.canWrite ? 'Seu papel não permite transcrever.' : T_STATUS[transcriber.state] ?? '');
        this.rootNode.querySelector('#t-status').textContent = text;
    }

    #paintTiles(people) {
        const container = this.rootNode.querySelector('#tiles');
        const alive = new Set(people.map(p => p.clientId));
        for (const [id, tile] of this.#tiles) if (!alive.has(id)) { tile.element.remove(); this.#tiles.delete(id); }
        for (const person of people) {
            let tile = this.#tiles.get(person.clientId);
            if (!tile) {
                const video = h('video', { autoplay: true, playsinline: true, muted: person.self, 'aria-hidden': 'true' });
                video.muted = person.self;                   // never play my own voice back to me
                const avatar = h('div', { class: 'avatar' });
                const name = h('span', { class: 'name' });
                const off = h('span', { class: 'off' });
                const caption = h('div', { class: 'caption', 'aria-hidden': 'true' });
                const element = h('div', { class: 'tile', role: 'listitem' }, video, avatar, caption, h('div', { class: 'label' }, name, off));
                tile = { element, video, avatar, name, off, caption };
                this.#tiles.set(person.clientId, tile);
            }
            const hasVideo = !!person.stream && person.cam;
            if (tile.video.srcObject !== person.stream) tile.video.srcObject = person.stream;
            if (person.stream) tile.video.play?.().catch(() => {});
            tile.element.classList.toggle('self', person.self);
            tile.element.classList.toggle('has-video', hasVideo);
            tile.element.classList.toggle('speaking', person.speaking && person.mic);
            tile.element.classList.toggle('connecting', !person.self && !person.stream);
            tile.avatar.style.background = person.user.color ?? '#667';
            tile.avatar.textContent = [...(person.user.name ?? '?').replace(/^Participante\s*/, '')][0]?.toUpperCase() ?? '?';
            tile.name.textContent = person.self ? `${person.user.name} (você)` : person.user.name;
            tile.off.textContent = [person.mic ? '' : '🔇', person.cam ? '' : '🚫', person.transcribing ? '📝' : ''].filter(Boolean).join(' ');
            tile.caption.textContent = this.transcript?.captionOf(person.user.id) ?? '';
            tile.element.setAttribute('aria-label', `${person.user.name}${person.self ? ' (você)' : ''}: microfone ${person.mic ? 'ligado' : 'desligado'}, câmera ${person.cam ? 'ligada' : 'desligada'}${person.speaking && person.mic ? ', falando' : ''}${person.transcribing ? ', sendo transcrito' : ''}`);
            container.append(tile.element);                  // keeps the order: me first
        }
    }

    describeContext() { return { joined: this.conference?.joined ?? false, participants: this.conference?.participants.length ?? 0 }; }
}
