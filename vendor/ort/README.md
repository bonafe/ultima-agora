# vendor/ort

Prebuilt ONNX Runtime Web (CPU/WASM) for the in-browser decision model (D-06). **Do not edit.** Regenerate with `tools/vendor-ort`
(`npm install && npm run build`).

| package | version |
|---|---|
| onnxruntime-web | 1.31.0-dev.20260914-8d85527a0 |

| file | size | sha256 |
|---|---|---|
| `ort.wasm.min.mjs` | 0.1 MB | `1617c813ada08592706d29a9963ab6258864dce4299bd402d2196bd648b63bfe` |
| `ort-wasm-simd-threaded.mjs` | 0.0 MB | `c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f` |
| `ort-wasm-simd-threaded.wasm` | 14.3 MB | `06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3` |

Only `voice/interpreters/model/` may import it (the Laya backend). Threads are used when the page is cross-origin isolated.
