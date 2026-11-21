//"Convidar": a dialog with the link that joins this workspace, as a QR code (to scan with another device) and as text to copy.
//The link is editable: when the app was opened as localhost the QR would be useless on another device, so the person fixes the
//address (the dialog says so) and the QR follows.
import { ReactiveComponent } from '../../vendor/ultima/reactive_component.js';
import { renderSVG } from '../../vendor/qr/uqr.js';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

//Why this link would not work from another device, or null
export function linkProblem(link) {
    let url;
    try { url = new URL(link); } catch { return 'Isto não parece um link válido.'; }
    if (LOCAL.has(url.hostname) || url.hostname.endsWith('.localhost')) return 'Este endereço só funciona neste computador. Abra o app pelo IP ou nome da rede (ex.: https://192.168.2.155:8443/app.html) e gere o QR de novo, ou troque o endereço no campo acima.';
    return null;
}

export class AgoraInvite extends ReactiveComponent {
    constructor() { super({ templateUrl: './agora-invite.html', shadowDom: true }, import.meta.url); }

    #$(selector) { return this.rootNode.querySelector(selector); }
    get isOpen() { return this.loaded && this.#$('#dialog').open; }
    get link() { return this.#$('#link').value.trim(); }

    onLoad() {
        super.onLoad();
        this.#$('#close').addEventListener('click', () => this.close());
        this.#$('#link').addEventListener('input', () => this.#paint());
        this.#$('#copy').addEventListener('click', () => this.#copy());
    }

    open({ link }) {
        this.#$('#link').value = link;
        this.#$('#copied').textContent = '';
        this.#paint();
        if (!this.#$('#dialog').open) this.#$('#dialog').showModal();
    }

    close() { if (this.isOpen) this.#$('#dialog').close(); }

    #paint() {
        const link = this.link;
        const qr = this.#$('#qr');
        try { qr.innerHTML = link ? renderSVG(link, { ecc: 'M', border: 0 }) : ''; } catch { qr.textContent = 'Link longo demais para um QR code.'; }
        const problem = link ? linkProblem(link) : 'Informe o link.';
        this.#$('#warn').hidden = !problem;
        this.#$('#warn').textContent = problem ?? '';
    }

    async #copy() {
        const note = this.#$('#copied');
        try { await navigator.clipboard.writeText(this.link); note.textContent = 'Link copiado.'; }
        catch { this.#$('#link').select(); note.textContent = 'Selecionado: copie com Ctrl+C.'; }
    }
}

customElements.define('agora-invite', AgoraInvite);
