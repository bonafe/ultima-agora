//Runs Whisper OFF the main thread (decoding takes seconds on a CPU: the page must not freeze meanwhile).
//Everything it loads comes from our own origin (D-37): the runtime from vendor/whisper/ and the model from models/.
//
//  in:  { type: 'load', size, modelBase (a PATH like /models/, not a URL: transformers.js only probes local files for paths), runtimeBase, threads }        out: { type: 'progress', file, loaded, total } ... { type: 'ready' } | { type: 'error', message }
//  in:  { type: 'transcribe', id, audio: Float32Array(16 kHz mono), language }     out: { type: 'result', id, text } | { type: 'failed', id, message }
import { AutoTokenizer, AutoProcessor, AutoModelForSpeechSeq2Seq, env } from '../../vendor/whisper/transformers.min.js';

let whisper = null;                             // { tokenizer, processor, model }
let queue = Promise.resolve();                  // one inference at a time: they would only slow each other down

const LANGUAGES = { pt: 'portuguese', en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian' };

async function load({ size, modelBase, runtimeBase, threads }) {
    env.allowRemoteModels = false;              // never reach for a CDN: the model is served by us, or there is no model
    env.allowLocalModels = true;
    env.localModelPath = modelBase;
    env.backends.onnx.wasm.wasmPaths = { mjs: `${runtimeBase}ort-wasm-simd-threaded.mjs`, wasm: `${runtimeBase}ort-wasm-simd-threaded.wasm` };
    env.backends.onnx.wasm.numThreads = threads;
    //The components are loaded one by one (not through pipeline()): its file probing assumes a remote hub and skips
    //the tokenizer and the processor of a model served from our own origin.
    const files = new Map();
    const id = `whisper-${size}`;
    const progress_callback = event => {
        if (event.status !== 'progress' || !event.total) return;
        files.set(event.file, { loaded: event.loaded, total: event.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        postMessage({ type: 'progress', loaded, total });
    };
    const [tokenizer, processor, model] = await Promise.all([
        AutoTokenizer.from_pretrained(id),
        AutoProcessor.from_pretrained(id),
        AutoModelForSpeechSeq2Seq.from_pretrained(id, { dtype: 'q8', device: 'wasm', progress_callback }),
    ]);
    whisper = { tokenizer, processor, model };
}

async function transcribe({ audio, language }) {
    const { tokenizer, processor, model } = whisper;
    const inputs = await processor(audio);
    const options = { ...inputs, task: 'transcribe', max_new_tokens: 224 };
    if (LANGUAGES[language]) options.language = LANGUAGES[language];         // 'auto' (or unknown): let Whisper detect it
    const tokens = await model.generate(options);
    return tokenizer.batch_decode(tokens, { skip_special_tokens: true })[0].trim();
}

onmessage = ({ data }) => {
    if (data.type === 'load') {
        queue = queue.then(() => load(data)).then(() => postMessage({ type: 'ready' }), error => postMessage({ type: 'error', message: String(error?.message ?? error) }));
    } else if (data.type === 'transcribe') {
        queue = queue.then(async () => {
            if (!whisper) throw new Error('model not loaded');
            postMessage({ type: 'result', id: data.id, text: await transcribe(data) });
        }).catch(error => postMessage({ type: 'failed', id: data.id, message: String(error?.message ?? error) }));
    }
};
