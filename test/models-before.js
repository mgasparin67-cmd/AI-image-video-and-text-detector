// Runs the local AI-detection models inside a hidden extension page.
//
// Image / video frames: haywoodsloan/ai-image-detector-deploy (SwinV2, Apache 2.0), converted to
//   8-bit ONNX and bundled in models/. Its config says "swin" because Transformers.js has no
//   SwinV2 class; the ONNX graph is complete, so the Swin wrapper just feeds it pixels.
//   https://huggingface.co/haywoodsloan/ai-image-detector-deploy
// Text: Vanguard (ModernBERT-large fine-tuned on ~1.1M human and AI texts, MIT license),
//   converted to ONNX and bundled in models/. It outputs one number, P(AI).
//   https://huggingface.co/ShantanuT01/vanguard-ai-text-detector

import { env, pipeline, AutoTokenizer, AutoModelForSequenceClassification, RawImage } from '../lib/transformers.min.js';

// Look in the extension's models/ folder first; anything not there comes from Hugging Face.
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.useWasmCache = false; // the extension's security policy doesn't allow blob: scripts
// The "asyncify" build of ONNX Runtime can run on the graphics card (WebGPU) as well as the CPU.
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.asyncify.wasm')
};
// Multiple CPU threads need a cross-origin-isolated page; 4 was fastest on an 8-core M3
// (more threads land on the slower efficiency cores).
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  : 1;

const IMAGE_MODEL = 'haywoodsloan/ai-image-detector-deploy';
const TEXT_MODEL = 'ShantanuT01/vanguard-ai-text-detector';
// onnx/model_q4g8.onnx: 4-bit weights and an 8-bit word table (268 MB). One file for both devices:
// ~140 ms per paragraph on WebGPU (M3); the 8-bit-only version is faster on the CPU but 400 MB more.
const TEXT_MODEL_FILE = 'model_q4g8';
const MAX_TOKENS = 512;
const MIN_TOKENS = 50; // too little text to judge

const status = { image: { state: 'idle', pct: 0 }, text: { state: 'idle', pct: 0 } };
// Offscreen documents can only use chrome.runtime (no chrome.storage), so the status goes to the
// background worker, which saves it for the popup.
function report(kind, patch) {
  Object.assign(status[kind], patch);
  chrome.runtime.sendMessage({ type: 'modelStatus', status }).catch(() => {});
}

// Tracks download progress across all of a model's files.
function progressFor(kind) {
  const files = {};
  return p => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      const pct = Math.floor((l / t) * 100);
      if (pct !== status[kind].pct) report(kind, { state: 'downloading', pct });
    }
  };
}

async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

// The image model runs on the graphics card when it can (about 5x faster), otherwise on the CPU.
// The 4-bit model is the one version that's fast on both: 8-bit ops aren't supported on WebGPU.
let imageModel = null;
function loadImageModel() {
  imageModel ||= (async () => {
    report('image', { state: 'downloading', pct: 0 });
    const options = { dtype: 'q4', progress_callback: progressFor('image') };
    let device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
    let clf;
    try {
      clf = await pipeline('image-classification', IMAGE_MODEL, { ...options, device });
    } catch (e) {
      if (device !== 'webgpu') throw e;
      console.warn('WebGPU failed, using the CPU instead', e);
      device = 'wasm';
      clf = await pipeline('image-classification', IMAGE_MODEL, { ...options, device });
    }
    report('image', { state: 'ready', pct: 100, device });
    return clf;
  })().catch(e => { imageModel = null; report('image', { state: 'error', error: String(e) }); throw e; });
  return imageModel;
}

let textModel = null;
function loadTextModel() {
  textModel ||= (async () => {
    report('text', { state: 'downloading', pct: 0 });
    const progress_callback = progressFor('text');
    const tokenizer = await AutoTokenizer.from_pretrained(TEXT_MODEL, { progress_callback });
    const load = device => AutoModelForSequenceClassification.from_pretrained(TEXT_MODEL,
      { dtype: 'fp32', model_file_name: TEXT_MODEL_FILE, device, progress_callback });
    let device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
    let model;
    try {
      model = await load(device);
    } catch (e) {
      if (device !== 'webgpu') throw e;
      console.warn('WebGPU failed for the text model, using the CPU instead', e);
      device = 'wasm';
      model = await load(device);
    }
    report('text', { state: 'ready', pct: 100, device });
    return { tokenizer, model };
  })().catch(e => { textModel = null; report('text', { state: 'error', error: String(e) }); throw e; });
  return textModel;
}

async function scoreImage({ url, dataUrl, crop }) {
  const clf = await loadImageModel();
  let image = await RawImage.fromURL(url || dataUrl);
  if (crop) image = await image.crop(crop); // [x0, y0, x1, y1] in pixels
  const out = await clf(image, { top_k: 2 });
  const score = out.find(o => o.label === 'artificial')?.score ?? 0;
  return { score, reasons: [`AI image detector: ${Math.round(score * 100)}% likely AI`] };
}

async function scoreText({ text }) {
  const { tokenizer, model } = await loadTextModel();
  const enc = await tokenizer(text, { truncation: true, max_length: MAX_TOKENS });
  if (enc.input_ids.dims[1] < MIN_TOKENS) return null;
  const { logits } = await model(enc);
  const score = 1 / (1 + Math.exp(-logits.data[0])); // single output: P(AI)
  const reasons = score >= 0.5 ? [`AI text detector: ${Math.round(score * 100)}% likely AI`] : [];
  return { score, reasons };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const job = msg.type === 'image' ? scoreImage(msg) : msg.type === 'text' ? scoreText(msg) : null;
  if (!job) return;
  job.then(sendResponse).catch(e => { console.warn('model error', e); sendResponse(null); });
  return true;
});
