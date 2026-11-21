//Decision-model relay: the browser asks "which of these options does this sentence mean?" and this forwards the question to the model
//service (server/agora-model, or anything that speaks the same /choose contract) and returns its scores. It adds what the model
//service must not have to know: who is asking (the workspace token), how often, how big, and that nothing is kept.
//
//  upstream contract:  POST {url}/choose  { question?, options: [{ id, text }], state }  ->  { scores: [{ id, p }], ms, model }
//
//PRIVACY: the sentence (`state`) is the person's speech turned to text. It is forwarded and forgotten: never stored, never logged here
//(only counts and timings are), and the model service is the operator's to choose (AGORA_MODEL_URL).
export class DecideError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const LIMITS = { options: 40, optionText: 400, state: 1000, question: 300 };

//Throws DecideError(400) unless the body is a well-formed question; returns only the fields the upstream understands
export function validateQuestion(body) {
    const bad = message => { throw new DecideError(400, 'bad_request', message); };
    if (!body || typeof body !== 'object') bad('Corpo inválido.');
    if (typeof body.state !== 'string' || !body.state.trim()) bad('Falta a frase (state).');
    if (body.state.length > LIMITS.state) bad(`A frase passa de ${LIMITS.state} caracteres.`);
    if (body.question !== undefined && (typeof body.question !== 'string' || body.question.length > LIMITS.question)) bad('Pergunta inválida.');
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > LIMITS.options) bad(`Envie de 2 a ${LIMITS.options} opções.`);
    const seen = new Set();
    for (const option of body.options) {
        if (typeof option?.id !== 'string' || !option.id || typeof option.text !== 'string' || !option.text || option.text.length > LIMITS.optionText) bad('Opção inválida (id e text).');
        if (seen.has(option.id)) bad(`Opção repetida: ${option.id}.`);
        seen.add(option.id);
    }
    return { question: body.question, options: body.options.map(({ id, text }) => ({ id, text })), state: body.state };
}

export function createDecide({ url = null, token = null, timeoutMs = 10_000, perMinute = 30, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
    const base = url ? url.replace(/\/+$/, '') : null;
    const stamps = new Map();                                          // person -> recent request times (R-AG-8 spirit: a loop must not hammer the model)

    const underLimit = person => {
        const since = now() - 60_000;
        const recent = (stamps.get(person) ?? []).filter(at => at > since);
        if (recent.length >= perMinute) { stamps.set(person, recent); return false; }
        recent.push(now()); stamps.set(person, recent);
        if (stamps.size > 1000) for (const [key, list] of stamps) if (!list.some(at => at > since)) stamps.delete(key);
        return true;
    };

    return {
        enabled: Boolean(base),

        //Is a model behind this server? (the browser asks before offering it)
        async status() {
            if (!base) return { available: false };
            try {
                const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)) });
                const info = response.ok ? await response.json().catch(() => ({})) : null;
                return info ? { available: true, model: info.model ?? null } : { available: false };
            } catch { return { available: false }; }
        },

        async choose(claims, body) {
            if (!base) throw new DecideError(503, 'no_model', 'Este servidor não tem um modelo de decisão configurado.');
            const question = validateQuestion(body);
            if (!underLimit(claims.sub)) throw new DecideError(429, 'rate_limited', 'Muitos pedidos seguidos; espere um instante.');
            const started = now();
            let response;
            try {
                response = await fetchImpl(`${base}/choose`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
                    body: JSON.stringify(question),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                log(`decide: model unreachable (${error.name})`);                          // never the sentence
                throw new DecideError(error.name === 'TimeoutError' ? 504 : 502, 'model_unreachable', 'O modelo não respondeu.');
            }
            if (!response.ok) { log(`decide: model answered HTTP ${response.status}`); throw new DecideError(502, 'model_failed', 'O modelo falhou.'); }
            const answer = await response.json().catch(() => null);
            const scores = answer?.scores;
            const ids = new Set(question.options.map(option => option.id));
            if (!Array.isArray(scores) || scores.length !== ids.size || !scores.every(s => ids.has(s?.id) && Number.isFinite(s.p))) {
                log('decide: model answered something that is not the contract');
                throw new DecideError(502, 'model_failed', 'Resposta inesperada do modelo.');
            }
            log(`decide: ${question.options.length} options, ${now() - started} ms`);
            return { scores: scores.map(({ id, p }) => ({ id, p })), ms: Number.isFinite(answer.ms) ? answer.ms : now() - started, model: typeof answer.model === 'string' ? answer.model : null };
        },
    };
}
