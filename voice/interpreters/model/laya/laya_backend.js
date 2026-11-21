//LayaBackend: a ChoiceBackend (../choice_backend.js) backed by Laya (ModernBERT-large, int4 ONNX) running IN the browser, in a
//worker, on CPU/WASM. The only module that knows the worker, vendor/ort and the weights: swap models by swapping this class.
//
//The weights are not in git: tools/baixar_modelo_laya.py puts them in models/laya-en-int4/ (same origin, works offline afterwards).
const QUESTION = 'Qual comando o usuário deu ao workspace?';

export class LayaBackend {
    #o; #worker = null; #loading = null; #pending = new Map(); #nextId = 1; #onProgress = null;
    state = 'idle';

    constructor({ model = 'laya-en-int4', onnx = 'model_int4.onnx', modelBase = new URL(`../../../../models/${model}/`, import.meta.url).pathname,
        runtimeBase = new URL('../../../../vendor/ort/', import.meta.url).href, threads = null, question = QUESTION,
        createWorker = () => new Worker(new URL('./laya_worker.js', import.meta.url), { type: 'module' }) } = {}) {
        this.#o = { model, onnx, modelBase, runtimeBase, threads, question, createWorker };
    }

    get id() { return this.#o.model; }
    get supported() { return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'; }

    load({ onProgress } = {}) {
        this.#onProgress = onProgress ?? this.#onProgress;
        this.#loading ??= new Promise((resolve, reject) => {
            this.state = 'loading';
            const worker = this.#worker = this.#o.createWorker();
            worker.onmessage = ({ data }) => {
                if (data.type === 'progress') this.#onProgress?.({ loaded: data.loaded, total: data.total });
                else if (data.type === 'ready') { this.state = 'ready'; worker.onmessage = event => this.#onMessage(event.data); resolve({ loadMs: data.loadMs, source: data.source }); }
                else if (data.type === 'failed') { this.state = 'failed'; this.#loading = null; worker.terminate(); reject(new Error(data.message)); }
            };
            worker.onerror = event => { this.state = 'failed'; this.#loading = null; reject(new Error(event.message || 'worker error')); };
            worker.postMessage({ type: 'load', modelBase: this.#o.modelBase, runtimeBase: this.#o.runtimeBase, threads: this.#o.threads, onnx: this.#o.onnx });
        });
        return this.#loading;
    }

    async choose({ question = this.#o.question, options, state }) {
        if (this.state !== 'ready') await this.load();
        const id = this.#nextId++;
        const result = await new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ type: 'choose', id, question, options: options.map(option => option.text), state });
        });
        return { scores: options.map((option, i) => ({ id: option.id, p: result.probabilities[i] })), ms: result.ms };
    }

    #onMessage(data) {
        const waiting = this.#pending.get(data.id);
        if (!waiting) return;
        this.#pending.delete(data.id);
        if (data.type === 'result') waiting.resolve(data); else waiting.reject(new Error(data.message));
    }

    dispose() {
        this.#worker?.terminate(); this.#worker = null; this.#loading = null; this.state = 'idle';
        for (const { reject } of this.#pending.values()) reject(new Error('disposed'));
        this.#pending.clear();
    }
}
