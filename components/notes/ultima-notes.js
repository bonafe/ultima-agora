import { AgoraComponent } from '../../core/components/agora_component.js';
import { renderMarkdown } from '../markdown/markdown.js';

const SAVE_DELAY_MS = 400;      //typing is coalesced so that one undo step is a burst of typing, not a letter

export default class UltimaNotes extends AgoraComponent {
    #editor = null;
    #preview = null;
    #timer = null;
    #stopListening = null;

    constructor() {
        super({ templateUrl: './ultima-notes.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        const root = this.rootNode;
        this.#editor = root.querySelector('#editor');
        this.#preview = root.querySelector('#preview');
        this.#editor.value = this.shared.getText();

        this.#editor.addEventListener('input', () => this.#scheduleSave());
        this.#editor.addEventListener('blur', () => this.#flush());
        root.querySelector('#edit').addEventListener('click', () => this.#setMode('edit'));
        root.querySelector('#view').addEventListener('click', () => this.#setMode('view'));

        //Changes from elsewhere (undo, another participant later). Ignored while this user has unsaved typing.
        this.#stopListening = this.shared.onChange(text => {
            if (this.#timer === null && text !== this.#editor.value) this.#editor.value = text;
            if (!this.#preview.hidden) this.#preview.innerHTML = renderMarkdown(text);
        });
    }

    #scheduleSave() {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#flush(), SAVE_DELAY_MS);
    }

    #flush() {
        if (this.#timer === null) return;
        clearTimeout(this.#timer);
        this.#timer = null;
        if (this.#editor.value !== this.shared.getText()) this.shared.setText(this.#editor.value);
    }

    #setMode(mode) {
        this.#flush();
        const viewing = mode === 'view';
        this.#editor.hidden = viewing;
        this.#preview.hidden = !viewing;
        this.rootNode.querySelector('#edit').setAttribute('aria-pressed', String(!viewing));
        this.rootNode.querySelector('#view').setAttribute('aria-pressed', String(viewing));
        if (viewing) this.#preview.innerHTML = renderMarkdown(this.shared.getText());
        else this.#editor.focus();
    }

    onDispose() {
        this.#flush();
        this.#stopListening?.();
    }

    describeContext() { return { characters: this.shared.getText().length }; }
}
