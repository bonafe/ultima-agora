//RemoteChoiceBackend: a ChoiceBackend (../choice_backend.js) whose model runs on the SERVER, for devices where the in-browser model is too
//slow or does not run at all. It speaks to agora-sync (POST /v1/workspaces/:id/decide), which authenticates the person, limits the rate
//and relays to the model service the operator configured (server/agora-model, the inteligencia-aberta gateway, an external API...).
//The browser neither knows nor cares which: it sends a question and gets scores.
//
//PRIVACY: this sends the person's sentence (their transcribed speech) to the server. Only create one when the person chose a server
//model (?model=remote|auto); the server forwards and forgets it (docs: decision D-44).
//
//  new RemoteChoiceBackend({ baseUrl, workspaceId, session })     session(workspaceId) -> Promise<{ token }>: the same one the sync uses
export class RemoteModelError extends Error {
    constructor(message, { status = 0, retryable = true } = {}) { super(message); this.name = 'RemoteModelError'; this.status = status; this.retryable = retryable; }
}

const TOKEN_REUSE_MS = 4 * 60_000;                              // server tokens live 5 minutes

export class RemoteChoiceBackend {
    #o; #token = null; #tokenAt = 0; #model = null;
    state = 'idle';

    constructor({ baseUrl, workspaceId, session, timeoutMs = 12_000, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now() }) {
        this.#o = { url: `${baseUrl.replace(/\/+$/, '')}/v1/workspaces/${encodeURIComponent(workspaceId)}/decide`, workspaceId, session, timeoutMs, fetchImpl, now };
    }

    get id() { return this.#model ? `remote:${this.#model}` : 'remote'; }

    //Asks whether the server has a model at all; throws (not retryable) when it does not, so a chain can skip it without trying again
    async load() {
        this.state = 'loading';
        const started = this.#o.now();
        try {
            const status = await this.#call('GET');
            if (!status?.available) throw new RemoteModelError('Este servidor não tem um modelo de decisão.', { retryable: false });
            this.#model = status.model ?? null;
            this.state = 'ready';
            return { loadMs: this.#o.now() - started, source: 'server' };
        } catch (error) { this.state = 'failed'; throw error; }
    }

    async choose({ question, options, state }) {
        const answer = await this.#call('POST', { ...(question ? { question } : {}), options, state });
        if (answer.model) this.#model = answer.model;
        return { scores: answer.scores, ms: answer.ms };
    }

    dispose() { this.#token = null; this.state = 'idle'; }

    async #authorization(fresh) {
        if (fresh || !this.#token || this.#o.now() - this.#tokenAt > TOKEN_REUSE_MS) {
            try { this.#token = (await this.#o.session(this.#o.workspaceId)).token; this.#tokenAt = this.#o.now(); }
            catch (error) { throw new RemoteModelError(`Sem token do servidor: ${error.message}`, { retryable: true }); }
        }
        return `Bearer ${this.#token}`;
    }

    async #call(method, body, retried = false) {
        let response;
        try {
            response = await this.#o.fetchImpl(this.#o.url, {
                method, headers: { authorization: await this.#authorization(retried), ...(body ? { 'content-type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.#o.timeoutMs),
            });
        } catch (error) {
            if (error instanceof RemoteModelError) throw error;
            throw new RemoteModelError(error.name === 'TimeoutError' ? 'O servidor demorou demais.' : 'Não consegui falar com o servidor.', { retryable: true });
        }
        if (response.status === 401 && !retried) return this.#call(method, body, true);                      // the token expired: one fresh try
        if (!response.ok) {
            const detail = (await response.json().catch(() => null))?.error?.message ?? `HTTP ${response.status}`;
            throw new RemoteModelError(detail, { status: response.status, retryable: response.status !== 503 && response.status !== 400 });
        }
        return response.json();
    }
}
