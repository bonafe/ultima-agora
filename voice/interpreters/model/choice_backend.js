//ChoiceBackend: the ONE thing the command interpreter needs from a decision model, so that the model can be swapped (another Laya
//checkpoint, a small instruction-tuned LLM, a model fine-tuned on this app's phrases) without touching the interpreter, the voice
//service or the commands. Only the implementation knows its runtime (ONNX, WebGPU, ...); the contract is plain data.
//
//  backend.id                  string     which model this is ('laya-en-int4'): shown in the UI and in measurements
//  backend.state               'idle' | 'loading' | 'ready' | 'failed'
//  backend.load({ onProgress })  -> Promise<{ loadMs, source }>       onProgress({ loaded, total }) in bytes; source 'network' | 'cache'. Idempotent.
//  backend.choose({ question, options: [{ id, text }], state })
//                              -> Promise<{ scores: [{ id, p }], ms }>   p sums to ~1 over the options; ms is the model's own inference time
//  backend.dispose()           frees the model and any worker
//
//A backend never executes anything and knows nothing about commands: it scores options for a sentence (state).
export const CHOICE_BACKEND_METHODS = ['load', 'choose', 'dispose'];

export function assertChoiceBackend(backend) {
    const missing = [...CHOICE_BACKEND_METHODS.filter(name => typeof backend?.[name] !== 'function'), ...(typeof backend?.id === 'string' ? [] : ['id'])];
    if (missing.length) throw new Error(`Not a ChoiceBackend: missing ${missing.join(', ')}`);
    return backend;
}
