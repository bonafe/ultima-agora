//ModelInterpreter: the interpreter (interpret(text, ctx) -> call | null) that lets a decision model pick the command. It speaks only
//to a ChoiceBackend (./choice_backend.js), so the model behind it is replaceable; it knows commands, not ONNX.
//
//The model chooses WHICH command; cutting the phrases out of the sentence ("a tabela", "para a esquerda") is done by `extractor`
//(RulesInterpreter.extract by default), as in RulesInterpreter: the voice service then resolves them to instances.
//
//confidence = the model's probability for the winner. Below `floor` (or when "conversation" wins) the answer is null: "não entendi".
//The service asks "Quis dizer…?" under its own minConfidence, so a model that is unsure never runs a command by itself.
import { assertChoiceBackend } from './choice_backend.js';

export const NONE = 'none';

//One option per command, from the registry's own words (title + first example): a command added to the catalog is offered to the model by itself
export const describeCommand = spec => `${spec.title}: ${spec.phrases?.[0] ?? spec.name}`;

export class ModelInterpreter {
    #backend; #commands; #extractor; #floor; #describe; #noneText;
    lastRun = null;                                    // { ms, winner, p, scores } of the latest call: for measuring and for the UI

    //commands: a CommandRegistry (or anything with list()).  extractor: { extract(command, text) -> args | null }
    constructor({ backend, commands, extractor = null, floor = 0.2, describe = describeCommand, noneText = 'conversa, não é comando' }) {
        this.#backend = assertChoiceBackend(backend); this.#commands = commands; this.#extractor = extractor; this.#floor = floor;
        this.#describe = describe; this.#noneText = noneText;
    }

    get backend() { return this.#backend; }

    async interpret(text, ctx = {}) {
        const sentence = String(text ?? '').trim();
        if (!sentence) return null;
        const specs = this.#commands.list().filter(spec => spec.phrases?.length);
        const options = [...specs.map(spec => ({ id: spec.name, text: `${spec.name}: ${this.#describe(spec)}` })), { id: NONE, text: `${NONE}: ${this.#noneText}` }];
        const { scores, ms } = await this.#backend.choose({ options, state: sentence });
        const best = scores.reduce((top, score) => (score.p > top.p ? score : top));
        this.lastRun = { ms, winner: best.id, p: best.p, scores, backend: this.#backend.id };
        if (best.id === NONE || best.p < this.#floor) return null;
        const args = this.#extractor?.extract(best.id, sentence, ctx) ?? {};
        return { command: best.id, args, confidence: best.p };
    }
}
