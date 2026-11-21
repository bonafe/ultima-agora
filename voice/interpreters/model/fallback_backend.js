//FallbackBackend: a ChoiceBackend made of several, in order of preference (e.g. the server model first, then the one in the browser).
//The first that loads is used; one that fails is skipped (for good if it says it is not retryable, else for `coolOffMs`) and the next
//one answers the SAME question, so a flaky server costs the person a slower answer, not a missing one. If all fail, choose() throws.
import { assertChoiceBackend } from './choice_backend.js';

export class FallbackBackend {
    #backends; #coolOffMs; #now; #down = new Map();                    // backend -> { until } (Infinity = never again)
    #active = null;
    state = 'idle';

    constructor(backends, { coolOffMs = 60_000, now = () => Date.now() } = {}) {
        this.#backends = backends.map(assertChoiceBackend); this.#coolOffMs = coolOffMs; this.#now = now;
    }

    get id() { return this.#active?.id ?? this.#backends[0]?.id ?? 'none'; }
    get active() { return this.#active; }

    #usable() { return this.#backends.filter(backend => (this.#down.get(backend) ?? 0) <= this.#now()); }
    #fail(backend, error) { this.#down.set(backend, error?.retryable === false ? Infinity : this.#now() + this.#coolOffMs); if (this.#active === backend) this.#active = null; }

    //Loads the first backend that can; returns its info plus which one it was
    async load(options) {
        const errors = [];
        for (const backend of this.#usable()) {
            try { const info = await backend.load(options); this.#active = backend; this.state = 'ready'; return { ...info, backend: backend.id }; }
            catch (error) { errors.push(`${backend.id}: ${error.message}`); this.#fail(backend, error); }
        }
        this.state = 'failed';
        throw new Error(`Nenhum modelo disponível (${errors.join('; ') || 'todos em espera'})`);
    }

    async choose(question) {
        const errors = [];
        for (const backend of this.#usable()) {
            try {
                if (backend.state !== 'ready') await backend.load();
                const answer = await backend.choose(question);
                this.#active = backend; this.state = 'ready';
                return { ...answer, backend: backend.id };
            } catch (error) { errors.push(`${backend.id}: ${error.message}`); this.#fail(backend, error); }
        }
        this.state = 'failed';
        throw new Error(`Nenhum modelo respondeu (${errors.join('; ') || 'todos em espera'})`);
    }

    dispose() { for (const backend of this.#backends) backend.dispose(); this.#active = null; this.state = 'idle'; }
}
