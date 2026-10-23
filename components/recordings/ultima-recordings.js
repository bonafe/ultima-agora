import { AgoraComponent } from '../../core/components/agora_component.js';
import { h } from '../../ui/dom.js';

const KIND = { audio: 'Áudio', video: 'Vídeo', screen: 'Tela' };
const when = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const length = ms => { if (!Number.isFinite(ms)) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const size = bytes => bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

//What was recorded in the calls: each person's own audio, listed from the server (the workspace document holds none of it, R-DOC-4).
//Needs `this.recordings` (a RecordingApi): the file is reached through a signed, temporary link the server puts on each item.
export default class UltimaRecordings extends AgoraComponent {
    #stop = null;
    #loading = false;

    constructor() {
        super({ templateUrl: './ultima-recordings.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        const root = this.rootNode;
        if (!this.recordings) {
            root.querySelector('#notice').textContent = 'As gravações não estão disponíveis neste workspace (é preciso o servidor de sincronização).';
            root.querySelector('#notice').hidden = false;
            root.querySelector('#bar').hidden = true;
            return;
        }
        root.querySelector('#refresh').addEventListener('click', () => this.#load());
        for (const button of root.querySelectorAll('.export')) button.addEventListener('click', () => this.#export(button.dataset.format));
        //A recording that just finished shows up by itself
        this.#stop = this.recorder?.onChange(() => { if (!this.recorder.recording && !this.recorder.pending) this.#load(); });
        this.#load();
    }

    onDispose() { this.#stop?.(); }

    async #load() {
        if (this.#loading) return;
        this.#loading = true;
        const status = this.rootNode.querySelector('#status');
        status.textContent = 'Carregando…';
        try {
            const recordings = await this.recordings.list();
            status.textContent = '';
            this.#paint(recordings);
        } catch (error) { status.textContent = `Não foi possível carregar as gravações: ${error.message}`; }
        finally { this.#loading = false; }
    }

    #paint(recordings) {
        const list = this.rootNode.querySelector('#list');
        if (!recordings.length) { list.replaceChildren(h('li', { class: 'empty' }, 'Ninguém gravou ainda. Na chamada, "Gravar minha fala" grava só o seu áudio.')); return; }
        list.replaceChildren(...[...recordings].reverse().map(r => {
            const url = this.recordings.mediaUrl(r);
            return h('li', { class: 'item' },
                h('header', {}, h('span', { class: 'who' }, r.userName), h('small', {}, `${KIND[r.kind] ?? r.kind} · ${when(r.createdAt)}${r.durationMs ? ` · ${length(r.durationMs)}` : ''}${r.sizeBytes ? ` · ${size(r.sizeBytes)}` : ''}`)),
                r.status === 'complete' && url
                    ? [h('audio', { controls: true, preload: 'none', src: url, 'aria-label': `Áudio de ${r.userName}` }), h('a', { class: 'download', href: url, download: `gravacao-${r.userName}-${r.id.slice(0, 8)}` }, 'Baixar')]
                    : h('span', { class: 'state' }, r.status === 'recording' ? '● Gravando agora…' : 'Indisponível'),
                r.truncated ? h('span', { class: 'warn' }, 'Incompleta: a gravação foi interrompida (aba fechada ou conexão perdida) e termina onde parou.') : null);
        }));
    }

    async #export(format) {
        const status = this.rootNode.querySelector('#status');
        try {
            const text = await this.recordings.transcript(format);
            const link = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `transcricao.${format}` });
            link.click();
            URL.revokeObjectURL(link.href);
            status.textContent = '';
        } catch (error) { status.textContent = `Não foi possível baixar a transcrição: ${error.message}`; }
    }

    describeContext() { return { kind: 'recordings' }; }
}
