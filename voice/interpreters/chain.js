//ChainInterpreter: tries interpreters in order; the first that understands wins. The usual chain is [rules, model]: the grammar answers
//what it knows in under a millisecond and never guesses; only what it does NOT understand is put to the decision model, which then only
//SUGGESTS (its confidence is the model's probability, so VoiceCommandService asks "Quis dizer…?" below its minConfidence).
//
//A model that fails (server down, device too weak) is not an error for the person: it counts as "did not understand", and the rules'
//"não entendi" stands. onError(error, interpreter) lets the host show it.
export class ChainInterpreter {
    #chain; #onError;
    constructor(chain, { onError = () => {} } = {}) { this.#chain = chain; this.#onError = onError; }

    async interpret(text, ctx) {
        for (const interpreter of this.#chain) {
            let call;
            try { call = await interpreter.interpret(text, ctx); }
            catch (error) { this.#onError(error, interpreter); continue; }
            if (call?.command) return call;
        }
        return null;
    }
}
