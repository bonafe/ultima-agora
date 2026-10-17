import { AgoraComponent } from '../../core/components/agora_component.js';
import { h } from '../../ui/dom.js';
import { colorFor } from '../../collaboration/presence/presence.js';

const timeOf = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

//What was said in the calls, person by person. Needs only `this.transcript` (a TranscriptClient).
export default class UltimaTranscript extends AgoraComponent {
    #stop = null;
    #sticky = true;                         // follow new lines while the reader is at the bottom

    constructor() {
        super({ templateUrl: './ultima-transcript.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        const transcript = this.transcript;
        const root = this.rootNode;
        if (!transcript) {
            const notice = root.querySelector('#notice');
            notice.textContent = 'A transcrição não está disponível neste workspace.';
            notice.hidden = false;
            root.querySelector('#bar').hidden = true;
            return;
        }
        const log = root.querySelector('#log');
        log.addEventListener('scroll', () => { this.#sticky = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
        root.querySelector('#search').addEventListener('input', () => this.#paint());
        root.querySelector('#copy').addEventListener('click', () => this.#copy());
        root.querySelector('#download').addEventListener('click', () => this.#download());
        this.#stop = transcript.onChange(() => this.#paint());
        this.#paint();
    }

    onDispose() { this.#stop?.(); }

    async #copy() {
        const button = this.rootNode.querySelector('#copy');
        try { await navigator.clipboard.writeText(this.transcript.export()); button.textContent = 'Copiado'; }
        catch { button.textContent = 'Não foi possível copiar'; }
        setTimeout(() => { button.textContent = 'Copiar'; }, 1500);
    }

    #download() {
        const url = URL.createObjectURL(new Blob([this.transcript.export() + '\n'], { type: 'text/plain;charset=utf-8' }));
        const link = h('a', { href: url, download: `transcricao-${new Date().toISOString().slice(0, 10)}.txt` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    #paint() {
        const transcript = this.transcript;
        if (!transcript || !this.loaded) return;
        const root = this.rootNode;
        const log = root.querySelector('#log');
        const query = root.querySelector('#search').value.trim().toLowerCase();
        const segments = transcript.segments.filter(s => !query || s.body.toLowerCase().includes(query) || s.author.name.toLowerCase().includes(query));

        const notice = root.querySelector('#notice');
        const message = !transcript.available() ? 'Transcrição indisponível: este workspace não está ligado a um servidor de colaboração.'
            : transcript.pending ? `${transcript.pending} trecho(s) aguardando conexão para serem enviados.` : null;
        notice.textContent = message ?? '';
        notice.hidden = !message;
        for (const id of ['#copy', '#download']) root.querySelector(id).disabled = !transcript.segments.length;

        const nodes = [];
        if (transcript.hasMore && !query) nodes.push(h('button', { class: 'older', type: 'button', onClick: () => transcript.loadOlder() }, 'Trechos anteriores'));
        if (!segments.length) nodes.push(h('p', { class: 'empty' }, query ? 'Nada encontrado.' : 'Ninguém foi transcrito ainda. Na chamada, cada pessoa liga “Transcrever minha fala”.'));
        for (const segment of segments) {
            const mine = segment.author.id === transcript.me.id;
            nodes.push(h('article', { class: `segment${segment.pending ? ' pending' : ''}`, 'data-id': segment.id },
                h('header', {},
                    h('span', { class: 'author', style: `color:${colorFor(segment.author.id)}` }, mine ? 'Você' : segment.author.name),
                    h('time', { datetime: segment.createdAt }, timeOf(segment.createdAt)),
                    segment.pending ? h('span', { class: 'state' }, 'Pendente') : null),
                h('p', {}, ...this.#highlight(segment.body, query))));
        }
        const keepBottom = this.#sticky;
        log.replaceChildren(...nodes);
        if (keepBottom) log.scrollTop = log.scrollHeight;
    }

    //Text with the search hits in <mark>, built from text nodes (nothing a person said becomes markup)
    #highlight(text, query) {
        if (!query) return [text];
        const parts = [];
        const lower = text.toLowerCase();
        let from = 0;
        for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
            parts.push(text.slice(from, at), h('mark', {}, text.slice(at, at + query.length)));
            from = at + query.length;
        }
        parts.push(text.slice(from));
        return parts;
    }

    describeContext() { return { segments: this.transcript?.segments.length ?? 0 }; }
}
