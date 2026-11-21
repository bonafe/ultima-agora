//VoiceCommandService: what the person says (or types) becomes a command on the workspace.
//
//  utterance -> gate (wake word, unless typed) -> interpreter -> CommandRegistry.execute -> feedback
//
//The person's own switch (R-TRANS-1 spirit): nothing is interpreted until enable(); it only hears the person's own speech
//(Transcriber.onUtterance) and acts with the person's role, never more (R-AG-3). Destructive commands are asked back
//("Remover as notas?") and run only on a "sim" (R-AG-4). A rate limit keeps a misheard loop from rewriting the workspace (R-AG-8).
//
//Events (onEvent): { type: 'heard' | 'done' | 'failed' | 'confirm' | 'unknown' | 'ignored' | 'limited', text, message, call, result }
import { createCommandRegistry } from '../core/commands/catalog.js';
import { RulesInterpreter } from './interpreters/rules.js';

const fold = text => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const YES = /^(?:sim|confirma|confirmo|pode|pode ser|claro|isso|isso mesmo|ok|certo|manda ver)\b/;
const NO = /^(?:nao|cancela|cancelar|deixa|deixa pra la|esquece|para)\b/;

export class VoiceCommandService {
    #workspace; #interpreter; #commands; #wake; #minConfidence; #maxPerMinute; #pendingMs; #now;
    #enabled = false;
    #listeners = new Set();
    #stopListening = null;
    #pending = null;                                   // { call, question, expires }
    #stamps = [];

    //interpreter: anything with interpret(text, ctx) -> call | null (a Promise is fine). wake: the words that open a command.
    constructor({ workspace, interpreter = new RulesInterpreter(), commands = createCommandRegistry(), wake = ['agora', 'ultima agora'],
        minConfidence = 0.6, maxPerMinute = 20, pendingMs = 15000, now = () => Date.now() }) {
        this.#workspace = workspace; this.#interpreter = interpreter; this.#commands = commands; this.#wake = wake.map(fold);
        this.#minConfidence = minConfidence; this.#maxPerMinute = maxPerMinute; this.#pendingMs = pendingMs; this.#now = now;
    }

    get enabled() { return this.#enabled; }
    get commands() { return this.#commands; }
    get pending() { return this.#pending && this.#pending.expires > this.#now() ? { question: this.#pending.question } : null; }
    onEvent(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #emit(event) { for (const fn of [...this.#listeners]) { try { fn(event); } catch (e) { console.error('[voice] listener error:', e); } } return event; }

    //The person turns commands on: from now on their own speech is listened to (typed commands work even when off, for accessibility)
    enable() {
        if (this.#enabled) return;
        this.#enabled = true;
        this.#stopListening = this.#workspace.transcriber?.onUtterance(({ text }) => { this.handle(text, { source: 'voice' }); }) ?? null;
    }
    disable() { this.#enabled = false; this.#pending = null; this.#stopListening?.(); this.#stopListening = null; }

    //Takes one sentence. source 'typed' needs no wake word. Returns the event it emitted.
    async handle(text, { source = 'voice' } = {}) {
        const spoken = String(text ?? '').trim();
        if (!spoken) return { type: 'ignored', text: spoken };

        if (this.#pending && this.#pending.expires <= this.#now()) this.#pending = null;
        const answer = this.#pending ? this.#answer(fold(spoken).replace(/[.,!?;:]+$/g, '').trim()) : null;
        if (answer === 'yes') return this.#confirmPending();
        if (answer === 'no') { this.#pending = null; return this.#emit({ type: 'done', text: spoken, message: 'Cancelado.' }); }

        const sentence = source === 'typed' ? (this.#afterWake(spoken) ?? spoken) : this.#afterWake(spoken);      // typing needs no wake word, but may carry one
        if (sentence === null) return this.#emit({ type: 'ignored', text: spoken });         // ordinary conversation: not for us
        if (!this.#underLimit()) return this.#emit({ type: 'limited', text: spoken, message: 'Muitos comandos seguidos; espere um instante.' });
        this.#emit({ type: 'heard', text: spoken });

        const description = this.#workspace.describe();
        const actionTitles = description.instances.flatMap(item => Object.entries(this.#workspace.registry.getManifest(item.type)?.actions ?? {}).flatMap(([, spec]) => [spec.title, ...(spec.aliases ?? [])])).filter(Boolean);
        let call;
        try { call = await this.#interpreter.interpret(sentence, { actionTitles, description }); }
        catch (error) { return this.#emit({ type: 'failed', text: spoken, message: `Não consegui interpretar: ${error.message}` }); }
        if (!call?.command) return this.#emit({ type: 'unknown', text: spoken, message: 'Não entendi o comando.' });

        if ((call.confidence ?? 1) < this.#minConfidence) {                                     // not sure: ask, do not guess
            const title = this.#commands.get(call.command)?.title ?? call.command;
            this.#pending = { call, question: `Quis dizer "${title}"?`, expires: this.#now() + this.#pendingMs, confirmed: true };
            return this.#emit({ type: 'confirm', text: spoken, call, message: this.#pending.question });
        }
        return this.#run(call, spoken, false);
    }

    //Runs a call (already interpreted) exactly like a spoken one: used by the typed command line and by tests
    run(call) { return this.#run(call, call.command, false); }

    #answer(folded) { return YES.test(folded) ? 'yes' : NO.test(folded) ? 'no' : null; }

    async #confirmPending() {
        const { call } = this.#pending;
        this.#pending = null;
        return this.#run(call, call.command, true);
    }

    async #run(call, text, confirmed) {
        this.#stamps.push(this.#now());
        const result = await this.#commands.execute(this.#workspace, call, { confirmed });
        if (result.needsConfirmation) {
            this.#pending = { call, question: result.question, expires: this.#now() + this.#pendingMs };
            return this.#emit({ type: 'confirm', text, call, message: result.question });
        }
        return this.#emit({ type: result.ok ? 'done' : 'failed', text, call, message: result.message, result });
    }

    //"Ágora, adiciona uma tabela" -> "adiciona uma tabela"; no wake word -> null
    #afterWake(spoken) {
        const folded = fold(spoken);
        for (const word of this.#wake) {
            const match = new RegExp(`^(?:ei |oi |ola )?${word}\\b[\\s,:;.!-]*`).exec(folded);
            if (match && folded.length > match[0].length) return spoken.slice(match[0].length);
        }
        return null;
    }

    #underLimit() {
        const since = this.#now() - 60000;
        this.#stamps = this.#stamps.filter(stamp => stamp > since);
        return this.#stamps.length < this.#maxPerMinute;
    }
}
