//Which interpreter the app uses, from `?model=` (the person's choice; it never changes by itself):
//
//  off     (default)  rules only: deterministic, instant, nothing leaves the browser
//  remote             rules, then the model on the server (agora-sync -> agora-model / inteligencia-aberta / external API)
//  local              rules, then Laya in this browser (heavy: ~262 MB, seconds per sentence on a CPU, does not run everywhere)
//  auto               rules, then the server model, then the browser one if the server has none or fails
//
//The rules always go first; a model only ever gets what they did not understand, and only suggests (see ChainInterpreter).
import { ChainInterpreter } from './chain.js';
import { RulesInterpreter } from './rules.js';
import { ModelInterpreter } from './model/model_interpreter.js';
import { FallbackBackend } from './model/fallback_backend.js';
import { RemoteChoiceBackend } from './model/remote/remote_backend.js';

export const MODEL_MODES = ['off', 'remote', 'local', 'auto'];

//endpoint: { baseUrl, session(workspaceId) } from the host (null when there is no sync server).  onError: shown by the host.
export async function createInterpreter({ mode = 'off', commands, workspaceId, endpoint = null, onError = () => {}, createLocal = null } = {}) {
    const rules = new RulesInterpreter();
    if (!MODEL_MODES.includes(mode)) { onError(new Error(`?model=${mode} não existe (use ${MODEL_MODES.join(', ')})`)); return rules; }
    if (mode === 'off') return rules;

    const backends = [];
    if ((mode === 'remote' || mode === 'auto') && endpoint) backends.push(new RemoteChoiceBackend({ baseUrl: endpoint.baseUrl, workspaceId, session: endpoint.session }));
    else if (mode === 'remote') onError(new Error('Este host não tem servidor de sincronização: não há modelo no servidor.'));
    if (mode === 'local' || mode === 'auto') {
        //Imported only when wanted: the ONNX code stays out of the page unless the person asked for the browser model
        const make = createLocal ?? (async () => new (await import('./model/laya/laya_backend.js')).LayaBackend());
        backends.push(await make());
    }
    if (!backends.length) return rules;
    const model = new ModelInterpreter({ backend: new FallbackBackend(backends), commands, extractor: rules });
    return new ChainInterpreter([rules, model], { onError });
}
