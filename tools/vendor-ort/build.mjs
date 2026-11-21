//Copies the prebuilt files the browser needs; nothing is bundled. Same ONNX Runtime Web build as vendor/whisper's, kept as its
//own copy so the two features stay independent (each vendor/ folder is imported by one module only).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const out = new URL('../../vendor/ort/', import.meta.url);
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json')).version;
const files = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const rows = [];
for (const name of files) {
    const bytes = readFileSync(`node_modules/onnxruntime-web/dist/${name}`);
    writeFileSync(new URL(name, out), bytes);
    rows.push(`| \`${name}\` | ${(bytes.length / 1e6).toFixed(1)} MB | \`${createHash('sha256').update(bytes).digest('hex')}\` |`);
}
writeFileSync(new URL('README.md', out), `# vendor/ort

Prebuilt ONNX Runtime Web (CPU/WASM) for the in-browser decision model (D-06). **Do not edit.** Regenerate with \`tools/vendor-ort\`
(\`npm install && npm run build\`).

| package | version |
|---|---|
| onnxruntime-web | ${version} |

| file | size | sha256 |
|---|---|---|
${rows.join('\n')}

Only \`voice/interpreters/model/\` may import it (the Laya backend). Threads are used when the page is cross-origin isolated.
`);
console.log(rows.join('\n'));
