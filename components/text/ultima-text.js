import { AgoraComponent } from '../../core/components/agora_component.js';

export default class UltimaText extends AgoraComponent {
    constructor() {
        super({ templateUrl: './ultima-text.html', shadowDom: true }, import.meta.url);
    }

    onLoad() {
        super.onLoad();
        this.#show();
    }

    onConfig() { this.#show(); }

    #show() {
        this.state = { text: this.config.text ?? '', size: this.config.size ?? 'normal' };
    }
}
