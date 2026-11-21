//Runs Laya (ONNX) OFF the main thread: a forward pass takes hundreds of milliseconds on a CPU and the page must not freeze.
//Everything it loads comes from our own origin: the runtime from vendor/ort/ and the weights from models/laya-*/ (D-37 spirit).
//
//  in:  { type: 'load', modelBase, runtimeBase, threads, onnx }   out: { type: 'progress', loaded, total } then { type: 'ready', loadMs, source } | { type: 'failed', message }
//  in:  { type: 'choose', id, question, options: [text], state }   out: { type: 'result', id, probabilities: [p], ms } | { type: 'failed', id, message }
import * as ort from '../../../../vendor/ort/ort.wasm.min.mjs';
import { ByteLevelBpe } from './bpe_tokenizer.js';
import { buildChoiceInput, temperatureFor, softmax } from './laya_input.js';

let laya = null;                                // { session, tokenizer, special, config }
let queue = Promise.resolve();                  // one pass at a time: they would only slow each other down

const json = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

//The weights are big (hundreds of MB): kept in the Cache Storage so the second visit does not download them again
async function weights(url) {
    const cache = await caches.open('agora-models').catch(() => null);
    const hit = await cache?.match(url);
    if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), source: 'cache' };
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const chunks = []; let loaded = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.length;
        postMessage({ type: 'progress', loaded, total });
    }
    const bytes = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
    return { bytes, source: 'network' };
}

async function load({ modelBase, runtimeBase, threads, onnx }) {
    const started = performance.now();
    ort.env.wasm.wasmPaths = { mjs: `${runtimeBase}ort-wasm-simd-threaded.mjs`, wasm: `${runtimeBase}ort-wasm-simd-threaded.wasm` };
    ort.env.wasm.numThreads = threads ?? (self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency ?? 1) : 1);
    const [config, tokenizerJson, tokenizerConfig, model] = await Promise.all([
        json(`${modelBase}rl_agent_config.json`), json(`${modelBase}tokenizer.json`), json(`${modelBase}tokenizer_config.json`), weights(`${modelBase}${onnx}`),
    ]);
    const tokenizer = new ByteLevelBpe(tokenizerJson);
    const special = { cls: tokenizer.tokenId(tokenizerConfig.cls_token), sep: tokenizer.tokenId(tokenizerConfig.sep_token), mask: tokenizer.tokenId(tokenizerConfig.mask_token) };
    if (Object.values(special).some(id => id === undefined)) throw new Error('This checkpoint has special tokens the Laya backend does not know');
    const session = await ort.InferenceSession.create(model.bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    laya = { session, tokenizer, special, config };
    return { loadMs: Math.round(performance.now() - started), source: model.source };
}

async function choose({ question, options, state }) {
    const { session, tokenizer, special, config } = laya;
    const { inputIds, markerPos } = buildChoiceInput({ encode: text => tokenizer.encode(text), special, config, question, options, state });
    const started = performance.now();
    const out = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds, BigInt), [1, inputIds.length]),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(inputIds, () => 1n), [1, inputIds.length]),
        marker_pos: new ort.Tensor('int64', BigInt64Array.from(markerPos, BigInt), [1, markerPos.length]),
        marker_mask: new ort.Tensor('bool', Uint8Array.from(markerPos, () => 1), [1, markerPos.length]),
        qtype: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
    });
    return { probabilities: softmax(out.logits.data, temperatureFor(config, options.length)), ms: performance.now() - started };
}

onmessage = ({ data }) => {
    if (data.type === 'load') {
        load(data).then(info => postMessage({ type: 'ready', ...info }), error => postMessage({ type: 'failed', message: String(error?.message ?? error) }));
    } else if (data.type === 'choose') {
        queue = queue.then(() => choose(data)).then(
            result => postMessage({ type: 'result', id: data.id, ...result }),
            error => postMessage({ type: 'failed', id: data.id, message: String(error?.message ?? error) }));
    }
};
