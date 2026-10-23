//The recordings API over HTTP (server/agora-sync, docs/especificacao/09 9.7). It authenticates with the same short-lived token
//the realtime connection uses, asked for through `session()` (the host issues it, D-20) and kept until it is about to expire.
export class RecordingApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
    //Worth trying again later: the network, a busy server, a rate limit. Anything else (403, 404, 409, 413) will not change by waiting.
    get retryable() { return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429; }
}

const tokenExpiry = token => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return 0; } };

export class RecordingApi {
    #base; #workspaceId; #session; #fetch; #now; #token = null; #expires = 0;

    //baseUrl: where the sync server is reached over http(s) (the websocket URL with ws -> http)
    constructor({ baseUrl, workspaceId, session, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
        this.#base = baseUrl.replace(/\/$/, ''); this.#workspaceId = workspaceId; this.#session = session; this.#fetch = fetchImpl; this.#now = now;
    }

    async #authorization() {
        if (!this.#token || this.#now() > this.#expires - 30_000) {
            const { token } = await this.#session(this.#workspaceId);
            this.#token = token; this.#expires = tokenExpiry(token);
        }
        return `Bearer ${this.#token}`;
    }

    async #request(path, init = {}) {
        let response;
        try { response = await this.#fetch(`${this.#base}/v1/workspaces/${encodeURIComponent(this.#workspaceId)}/${path}`, { ...init, headers: { authorization: await this.#authorization(), ...(init.headers ?? {}) } }); }
        catch (error) { throw new RecordingApiError(0, 'network', `Sem conexão com o servidor (${error.message}).`); }
        if (response.ok) return response;
        let body = null;
        try { body = (await response.json()).error; } catch { /* not JSON */ }
        if (response.status === 401) this.#token = null;                  //refreshed on the next try
        throw new RecordingApiError(response.status, body?.code ?? 'error', body?.message ?? `O servidor respondeu ${response.status}.`);
    }

    async start({ kind, mime }) {
        const response = await this.#request('recordings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, mime, consent: true }) });
        return response.json();
    }

    async putPart(id, n, blob) { await this.#request(`recordings/${id}/parts/${n}`, { method: 'PUT', body: blob }); }

    async complete(id, { parts, durationMs }) {
        const response = await this.#request(`recordings/${id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts, durationMs }) });
        return response.json();
    }

    async list() { return (await (await this.#request('recordings')).json()).recordings; }

    //Absolute address of a finished recording's file (the link is signed and temporary: it needs no header, so <audio src> works)
    mediaUrl(recording) { return recording.mediaUrl ? `${this.#base}${recording.mediaUrl}` : null; }

    //The transcript in a given format, as text (to download or show)
    async transcript(format = 'txt', sessionId = null) {
        const query = `format=${encodeURIComponent(format)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`;
        return (await this.#request(`transcript?${query}`)).text();
    }
}
