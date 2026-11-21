//The voice-command bar of the shell (R-VOICE-1/2): the person's own switch to be listened to, a typed command line (the same pipeline,
//so it works without a microphone and for keyboard/screen-reader users), what was heard, what happened, and the question when a
//command is destructive. It only talks to a VoiceCommandService; it owns no logic of its own.
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { h } from '../dom.js';

const NO_UNDO = new Set(['undo', 'redo', 'describe', 'help', 'focus', 'stop-transcribing']);
const TRANSCRIBER_TEXT = { loading: 'carregando o reconhecimento de voz…', waiting: 'ligue o microfone na chamada', listening: 'escutando', transcribing: 'processando a fala…' };

export class AgoraVoice extends ReactiveComponent {
    #workspace = null;
    #service = null;
    #stops = [];
    #startedTranscriber = false;

    constructor() { super({ templateUrl: './agora-voice.html', shadowDom: true }, import.meta.url); }

    #$(selector) { return this.rootNode.querySelector(selector); }

    //Called by the shell for each opened workspace. Nothing is listened to until the person switches it on.
    bind({ workspace, service }) {
        this.unbind();
        this.#workspace = workspace;
        this.#service = service;
        if (!this.loaded) return;
        this.#attach();
    }

    unbind() {
        this.#stops.forEach(stop => stop());
        this.#stops = [];
        this.#service?.disable();
        if (this.#startedTranscriber) this.#workspace?.transcriber?.disable();
        this.#startedTranscriber = false;
        this.#service = this.#workspace = null;
        if (this.loaded) { this.#$('#feedback').hidden = true; this.#paint(); }
    }

    onLoad() {
        super.onLoad();
        this.#$('#line').addEventListener('submit', event => { event.preventDefault(); this.#submit(); });
        this.#$('#listen').addEventListener('click', () => this.#toggleListening());
        this.#$('#only-commands').addEventListener('change', event => this.#workspace?.transcriber?.setSendToLog(!event.target.checked));
        this.#$('#show-commands').addEventListener('click', () => this.#toggleCommands());
        if (this.#service) this.#attach();
        else this.#paint();
    }

    #attach() {
        this.#stops.push(this.#service.onEvent(event => this.#show(event)));
        const transcriber = this.#workspace.transcriber;
        if (transcriber) this.#stops.push(transcriber.onChange(() => this.#paint()));
        const room = this.#workspace.conference;
        if (room?.on) this.#stops.push(room.on('change', () => this.#paint()));
        this.#paint();
    }

    async #submit() {
        const input = this.#$('#text');
        const text = input.value.trim();
        if (!text || !this.#service) return;
        input.value = '';
        await this.#service.handle(text, { source: 'typed' });
        input.focus();
    }

    async #toggleListening() {
        const service = this.#service;
        const transcriber = this.#workspace?.transcriber;
        if (!service || !transcriber) return;
        if (service.enabled) {
            service.disable();
            if (this.#startedTranscriber) { transcriber.disable(); this.#startedTranscriber = false; }
            this.#paint();
            return;
        }
        transcriber.setSendToLog(!this.#$('#only-commands').checked);
        if (!transcriber.enabled) {                               // the same switch as "Transcrever minha fala": the person is in the call and asks for it
            await transcriber.enable();
            this.#startedTranscriber = transcriber.enabled;
            if (!transcriber.enabled) { this.#show({ type: 'failed', message: transcriber.error ?? 'Não foi possível ligar o reconhecimento de voz.' }); this.#paint(); return; }
        }
        service.enable();
        this.#paint();
    }

    #paint() {
        if (!this.loaded) return;
        const transcriber = this.#workspace?.transcriber;
        const listening = Boolean(this.#service?.enabled);
        const button = this.#$('#listen');
        button.disabled = !transcriber || !transcriber.supported;
        button.setAttribute('aria-pressed', String(listening));
        button.textContent = listening ? '🎙 Ouvindo comandos' : '🎙 Ouvir meus comandos';
        let state = '';
        if (!transcriber) state = 'Voz indisponível aqui; digite os comandos.';
        else if (!transcriber.supported) state = `${transcriber.unsupportedReason ?? 'Este navegador não consegue transcrever.'} Digite os comandos.`;
        else if (listening) state = `Diga "Ágora, …" — ${TRANSCRIBER_TEXT[transcriber.state] ?? transcriber.state}`;
        else state = this.#workspace?.conference?.joined === false ? 'Entre na chamada para usar a voz.' : 'Desligado.';
        this.#$('#state').textContent = state;
        this.#$('#text').disabled = !this.#service;
    }

    #show(event) {
        const feedback = this.#$('#feedback');
        if (event.type === 'ignored') return;                                       // ordinary conversation is not shown
        feedback.hidden = false;
        feedback.className = `feedback ${event.type}`;
        this.#$('#heard').textContent = event.type === 'heard' ? `Ouvi: “${event.text}”` : event.text ? `“${event.text}”` : '';
        const message = event.type === 'heard' ? '…' : event.message ?? '';
        this.#$('#message').textContent = message;
        const actions = this.#$('#actions');
        actions.replaceChildren();
        if (event.type === 'confirm') {
            actions.append(
                h('button', { type: 'button', onClick: () => this.#service?.handle('sim', { source: 'typed' }) }, 'Sim'),
                h('button', { type: 'button', onClick: () => this.#service?.handle('não', { source: 'typed' }) }, 'Não'),
            );
        } else if (event.type === 'done' && event.call && !NO_UNDO.has(event.call.command) && this.#workspace?.canUndo) {
            actions.append(h('button', { type: 'button', onClick: () => { this.#workspace.undo(); this.#show({ type: 'done', message: 'Desfeito.' }); } }, 'Desfazer'));
        }
        if (event.result?.commands) this.#listCommands(event.result.commands, true);
        if (event.type !== 'heard' && this.#$('#speak').checked && message) this.#speak(message);
    }

    #toggleCommands() {
        const list = this.#$('#commands');
        const open = list.hidden;
        if (open) this.#listCommands(this.#service?.commands.list().filter(c => c.phrases.length).map(c => ({ name: c.name, title: c.title, example: c.phrases[0] })) ?? [], false);
        list.hidden = !open;
        this.#$('#show-commands').setAttribute('aria-expanded', String(open));
    }

    #listCommands(commands, reveal) {
        const list = this.#$('#commands');
        list.replaceChildren(...commands.map(c => h('li', {}, c.title, h('small', {}, `“Ágora, ${c.example}”`))));
        if (reveal) { list.hidden = false; this.#$('#show-commands').setAttribute('aria-expanded', 'true'); }
    }

    #speak(text) {
        try {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'pt-BR';
            speechSynthesis.cancel();
            speechSynthesis.speak(utterance);
        } catch { /* no speech synthesis: the text is on screen */ }
    }
}

customElements.define('agora-voice', AgoraVoice);
