# lib/

The extension runs its models with two third-party libraries. Their files are not in this
repository; to run the extension from source, put these files in this folder:

| File | From |
|---|---|
| `transformers.min.js` | [Transformers.js](https://github.com/huggingface/transformers.js) 4.3.1 by Hugging Face (Apache-2.0), its browser build |
| `ort-wasm-simd-threaded.asyncify.mjs`, `ort-wasm-simd-threaded.asyncify.wasm` | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.31.0-dev.20260911-2a43ec07e by Microsoft (MIT) |

Both come from their npm packages (`@huggingface/transformers`, `onnxruntime-web`). See
`NOTICE.txt` for their licenses.
