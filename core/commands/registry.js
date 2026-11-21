//The commands a person (by voice, or typing) can give the workspace. A command is a named, typed operation that goes through the
//same Workspace API as the UI, so it obeys the same roles, is one undo step and is recorded with createdVia 'voice'
//(R-VOICE-1, R-AGT-2). There is no back door: `run` receives the workspace and nothing else.
//
//  spec: { name, title, phrases:[example sentences, for help], params:{ field: { type, required } },
//          access: 'compose' | 'content' | 'any', destructive: bool, confirm(args, ctx) -> question, run(workspace, args, ctx) -> message | {message, ...} }
//
//execute() never throws: it returns { ok, message } or { ok:false, needsConfirmation, question } so the caller only has to show it.
export const ACCESS = ['compose', 'content', 'any'];

export class CommandRegistry {
    #commands = new Map();

    register(spec) {
        if (!spec?.name || typeof spec.run !== 'function') throw new Error('A command needs a name and run()');
        if (this.#commands.has(spec.name)) throw new Error(`Command "${spec.name}" is already registered`);
        const access = spec.access ?? 'any';
        if (!ACCESS.includes(access)) throw new Error(`Command "${spec.name}": invalid access "${access}"`);
        this.#commands.set(spec.name, { params: {}, phrases: [], destructive: false, ...spec, access });
        return this;
    }

    get(name) { return this.#commands.get(name) ?? null; }
    list() { return [...this.#commands.values()]; }

    //Who may run it, by the same rules as the UI (R-PERM-3: the server enforces them again)
    allowed(workspace, name) {
        const spec = this.get(name);
        if (!spec) return false;
        if (spec.access === 'compose') return workspace.canCompose;
        if (spec.access === 'content') return workspace.canEditContent;
        return true;
    }

    //call: { command, args }.  confirmed: the person already said yes to this exact call.
    async execute(workspace, call, { confirmed = false } = {}) {
        const spec = this.get(call?.command);
        if (!spec) return { ok: false, reason: 'unknown', message: `Não conheço o comando "${call?.command ?? ''}".` };
        const args = call.args ?? {};
        for (const [field, rule] of Object.entries(spec.params)) {
            if (rule.required && (args[field] === undefined || args[field] === null || args[field] === '')) return { ok: false, reason: 'missing', message: `Faltou dizer: ${rule.title ?? field}.` };
        }
        if (!this.allowed(workspace, spec.name)) return { ok: false, reason: 'forbidden', message: `Seu papel (${workspace.role}) não permite "${spec.title}".` };
        try {
            if (spec.destructive && !confirmed) return { ok: false, reason: 'confirm', needsConfirmation: true, question: spec.confirm?.(args, workspace) ?? `Confirma: ${spec.title}?` };
            const outcome = await spec.run(workspace, args);
            return { ok: true, ...(typeof outcome === 'string' ? { message: outcome } : outcome) };
        } catch (error) {
            return { ok: false, reason: 'failed', message: error.message };
        }
    }
}
