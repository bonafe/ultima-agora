//Copies the prebuilt files the browser needs; nothing is bundled. onnxruntime-web comes with transformers.js at the exact
//version it was built against. ONE edit: a warning message links a public gist by its 32-hex id, which GitHub push
//protection mistakes for an API key; the id is cut from that message (the warning text is otherwise unchanged).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const out = new URL('../../vendor/whisper/', import.meta.url);
mkdirSync(out, { recursive: true });
const version = name => JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
const files = [
    ['node_modules/@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js'],
    ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
    ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];
const rows = [];
for (const [from, to] of files) {
    let bytes = readFileSync(from);
    if (to === 'transformers.min.js') {
        const text = bytes.toString('utf8').replace(/(gist\.github\.com\/hollance)\/[0-9a-f]{32}/g, '$1');
        if (text.includes('42e32852f24243b748ae6bc1f985b13a')) throw new Error('gist id still present');
        bytes = Buffer.from(text);
    }
    writeFileSync(new URL(to, out), bytes);
    rows.push(`| \`${to}\` | ${(bytes.length / 1e6).toFixed(1)} MB | \`${createHash('sha256').update(bytes).digest('hex')}\` |`);
}
writeFileSync(new URL('README.md', out), `# vendor/whisper

Prebuilt browser runtime for Whisper running IN the browser (D-06, D-37). **Do not edit.** Regenerate with \`tools/vendor-whisper\`
(\`npm install && npm run build\`). The model weights are NOT here: see \`tools/baixar_modelo_whisper.py\` (they go to \`models/\`, outside git).

| package | version |
|---|---|
| @huggingface/transformers | ${version('@huggingface/transformers')} |
| onnxruntime-web | ${version('onnxruntime-web')} |

| file | size | sha256 |
|---|---|---|
${rows.join('\n')}

\`transformers.min.js\` differs from upstream in one place: a gist id was cut from a warning message (see \`tools/vendor-whisper/build.mjs\`).

Only \`transcription/whisper/\` may import it. CPU (WASM) execution; threads are used when the page is cross-origin isolated.
`);
console.log(rows.join('\n'));
