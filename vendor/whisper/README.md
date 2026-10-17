# vendor/whisper

Prebuilt browser runtime for Whisper running IN the browser (D-06, D-37). **Do not edit.** Regenerate with `tools/vendor-whisper`
(`npm install && npm run build`). The model weights are NOT here: see `tools/baixar_modelo_whisper.py` (they go to `models/`, outside git).

| package | version |
|---|---|
| @huggingface/transformers | 4.3.1 |
| onnxruntime-web | 1.31.0-dev.20260914-8d85527a0 |

| file | size | sha256 |
|---|---|---|
| `transformers.min.js` | 0.6 MB | `24c6599f22c01a2873eb955bb04b41b46d029e033ecc36ffdb3f6683ec658ea9` |
| `ort-wasm-simd-threaded.mjs` | 0.0 MB | `c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f` |
| `ort-wasm-simd-threaded.wasm` | 14.3 MB | `06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3` |

`transformers.min.js` differs from upstream in one place: a gist id was cut from a warning message (see `tools/vendor-whisper/build.mjs`).

Only `transcription/whisper/` may import it. CPU (WASM) execution; threads are used when the page is cross-origin isolated.
