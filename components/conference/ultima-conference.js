import { AgoraComponent } from '../../core/components/agora_component.js';
import { h } from '../../ui/dom.js';
import { LANGUAGES } from '../../transcription/transcriber.js';
import { createTile, paintTile } from './tile.js';

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
    #asking = false;                        // the consent question is showing

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
        const recorder = this.recorder;
        if (recorder) {
            root.querySelector('#record').addEventListener('click', () => this.#toggleRecording());
            root.querySelector('#record-yes').addEventListener('click', () => this.#startRecording());
            root.querySelector('#record-no').addEventListener('click', () => { this.#asking = false; this.#paint(); });
            root.querySelector('#open-recordings').addEventListener('click', () => this.dispatchEvent(new CustomEvent('palette-add', { bubbles: true, composed: true, detail: { type: 'ultima-recordings' } })));
            stops.push(recorder.onChange(() => this.#paint()));
        }
        this.#stop = () => stops.forEach(stop => stop());
        this.#paint();
    }

    onRole() { this.#paint(); }
    onConfig() { this.#paint(); }
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

    //Recording starts only after the person says yes to the question: it is their own audio, and everyone will see the badge
    async #toggleRecording() {
        const recorder = this.recorder;
        if (recorder.recording) { await recorder.stop(); this.#asking = false; }
        else this.#asking = !this.#asking;
        this.#paint();
    }

    async #startRecording() {
        this.#asking = false;
        this.#errors = [];
        try { await this.recorder.start({ consented: true }); }
        catch (error) { this.#errors = [error.message]; }
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
        this.#paintRecording();
        root.querySelector('#tiles').toggleAttribute('hidden', !this.config.tiles);       // tiles: false = only the controls (the call window shows people as windows of its own)
        if (this.config.tiles) this.#paintTiles(people);
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

    #paintRecording() {
        const recorder = this.recorder;
        const box = this.rootNode.querySelector('#recording');
        box.toggleAttribute('hidden', !recorder);
        if (!recorder) return;
        const button = this.rootNode.querySelector('#record');
        button.setAttribute('aria-pressed', String(recorder.recording));
        button.textContent = recorder.recording ? 'Gravando: parar' : 'Gravar minha fala';
        button.disabled = !recorder.supported || !this.conference.canPublish;
        this.rootNode.querySelector('#record-consent').toggleAttribute('hidden', !this.#asking || recorder.recording);
        const waiting = recorder.pending;
        this.rootNode.querySelector('#r-status').textContent = !recorder.supported ? 'Este navegador não consegue gravar.'
            : recorder.lastError ? `Problema ao enviar a gravação: ${recorder.lastError.message}${waiting ? ` (${waiting} trechos esperando)` : ''}`
            : recorder.recording ? `Gravando o seu áudio e enviando ao workspace${waiting > 1 ? ` (${waiting} trechos esperando)` : ''}.`
            : waiting ? `Enviando o final da gravação (${waiting} trechos)…` : '';
    }

    #paintTiles(people) {
        const container = this.rootNode.querySelector('#tiles');
        const alive = new Set(people.map(p => p.clientId));
        for (const [id, tile] of this.#tiles) if (!alive.has(id)) { tile.element.remove(); this.#tiles.delete(id); }
        for (const person of people) {
            let tile = this.#tiles.get(person.clientId);
            if (!tile) { tile = createTile(person); this.#tiles.set(person.clientId, tile); }
            paintTile(tile, person, this.transcript);
            container.append(tile.element);                  // keeps the order: me first
        }
    }

    describeContext() { return { joined: this.conference?.joined ?? false, participants: this.conference?.participants.length ?? 0 }; }
}
