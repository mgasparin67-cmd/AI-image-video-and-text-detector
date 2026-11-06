// Runs the local AI-detection models inside a hidden extension page.
//
// Image / video frames: haywoodsloan/ai-image-detector-deploy (SwinV2, Apache 2.0), converted to
//   4-bit ONNX. Its config says "swin" because Transformers.js has no SwinV2 class; the ONNX
//   graph is complete, so the Swin wrapper just feeds it pixels.
//   https://huggingface.co/haywoodsloan/ai-image-detector-deploy
// Text: Vanguard (ModernBERT-large fine-tuned on ~1.1M human and AI texts, MIT license),
//   converted to ONNX. It outputs one number, P(AI).
//   https://huggingface.co/ShantanuT01/vanguard-ai-text-detector

import { env, pipeline, AutoTokenizer, AutoModelForSequenceClassification, RawImage } from './lib/transformers.min.js';

// Where the model files come from.
// - Empty: the models/ folder inside the extension (developer installs; nothing is downloaded).
// - A URL: a copy of the models/ folder, with the same layout, hosted elsewhere (store builds).
//   Files are downloaded the first time a model is needed and kept in the browser's cache, which
//   survives extension updates. Pin the URL to a commit so the files can't change under users,
//   e.g. https://huggingface.co/USER/slopless-models/resolve/COMMIT_HASH/
// The test pages set __aibModelsUrl to try a download from a local server.
const MODELS_URL = self.__aibModelsUrl ?? '';

if (MODELS_URL) {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = MODELS_URL;
  env.remotePathTemplate = '{model}/';
  env.useBrowserCache = true;
} else {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = chrome.runtime.getURL('models/');
}
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
const lastProgress = { image: 0, text: 0 };
function progressFor(kind) {
  const files = {};
  lastProgress[kind] = Date.now();
  return p => {
    lastProgress[kind] = Date.now();
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
      const pct = Math.floor((l / t) * 100);
      if (pct !== status[kind].pct) report(kind, { state: 'downloading', pct });
    }
  };
}

// A download that stops making progress is a failure, not "loading" forever (a bad connection
// can leave a request open without data). Only while downloading: compiling the model afterwards
// can take a while with no progress events.
const STALL_MS = self.__aibStallMs || 90 * 1000; // the test page sets __aibStallMs
function failIfStalled(kind, loading) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      const s = status[kind];
      if (s.state === 'downloading' && s.pct < 100 && Date.now() - lastProgress[kind] > STALL_MS) {
        reject(new Error(`The ${kind} model download stopped (no data for ${STALL_MS / 1000} s)`));
      }
    }, 5000);
  });
  return Promise.race([loading, stalled]).finally(() => clearInterval(timer));
}

// Errors while loading a model are marked, so the background worker can tell "the models aren't
// working" (warn the user) from "this one image couldn't be downloaded" (skip it quietly).
function modelLoadError(kind, e) {
  const err = e instanceof Error ? e : new Error(String(e));
  err.modelLoad = true;
  report(kind, { state: 'error', error: String(err.message || err) });
  return err;
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
  if (imageModel) return imageModel;
  const loading = (async () => {
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
  })();
  imageModel = failIfStalled('image', loading).catch(e => { imageModel = null; throw modelLoadError('image', e); });
  return imageModel;
}

let textModel = null;
function loadTextModel() {
  if (textModel) return textModel;
  const loading = (async () => {
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
  })();
  textModel = failIfStalled('text', loading).catch(e => { textModel = null; throw modelLoadError('text', e); });
  return textModel;
}

// ---------- Scheduling ----------
// Model runs go through one queue, two at a time, and images (and video frames) go first: a
// picture on screen matters more than a paragraph the reader may not reach. Downloading and
// decoding happen outside the queue, in parallel.

const PRIORITY = { image: 0, text: 1 };
const MAX_RUNNING = 2; // two at a time keeps the card busy; three made images slower (test/pipeline-bench.html)
const queue = [];
let running = 0;
let order = 0;

function schedule(kind, run) {
  return new Promise((resolve, reject) => {
    queue.push({ kind, run, resolve, reject, n: order++ });
    drain();
  });
}

function drain() {
  while (running < MAX_RUNNING && queue.length) {
    queue.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.n - b.n);
    const job = queue.shift();
    running++;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { running--; drain(); });
  }
}

// ---------- Images ----------

async function classifyImage(image) {
  const clf = await loadImageModel();
  const out = await schedule('image', () => clf(image, { top_k: 2 }));
  const score = out.find(o => o.label === 'artificial')?.score ?? 0;
  return { score, reasons: [`AI image detector: ${Math.round(score * 100)}% likely AI`] };
}

// A video frame (a tab screenshot cropped to the video).
async function scoreFrame({ dataUrl, crop }) {
  let image = await RawImage.fromURL(dataUrl);
  if (crop) image = await image.crop(crop); // [x0, y0, x1, y1] in pixels
  return classifyImage(image);
}

// An image on a page: downloaded once, then its metadata and its pixels are both checked.
async function checkImageUrl({ url }) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const meta = AIBMetadata.scan(new Uint8Array(await blob.slice(0, AIBMetadata.MAX_BYTES).arrayBuffer()));
  if (meta.score >= 0.9) return meta;
  // Drawings and icons aren't what the model knows.
  if (/svg/i.test(blob.type) || /^data:image\/svg|\.svg(\?|$)/i.test(url)) return meta;
  const model = await classifyImage(await RawImage.fromBlob(blob));
  return model.score > meta.score ? model : meta;
}

async function scoreText({ text }) {
  const { tokenizer, model } = await loadTextModel();
  const enc = await tokenizer(text, { truncation: true, max_length: MAX_TOKENS });
  if (enc.input_ids.dims[1] < MIN_TOKENS) return null;
  const { logits } = await schedule('text', () => model(enc));
  const score = 1 / (1 + Math.exp(-logits.data[0])); // single output: P(AI)
  const reasons = score >= 0.5 ? [`AI text detector: ${Math.round(score * 100)}% likely AI`] : [];
  return { score, reasons };
}

// ---------- Unloading when idle ----------
// The two models take several hundred MB while this page is open. After IDLE_MS with no work, it
// asks the background worker to close it; the next check opens it again (a few seconds to reload).

const IDLE_MS = self.__aibIdleMs || 10 * 60 * 1000; // the test page sets __aibIdleMs
let active = 0;
let lastUsed = Date.now();

setInterval(() => {
  if (active === 0 && Date.now() - lastUsed >= IDLE_MS) {
    chrome.runtime.sendMessage({ type: 'modelsIdle' }).catch(() => {});
  }
}, Math.min(60 * 1000, IDLE_MS / 2));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  // warmup: load both models now ("Try again" in the popup), rather than on the next check.
  const warmup = () => Promise.all([loadImageModel(), loadTextModel()]).then(() => ({ ready: true }));
  const handlers = { imageUrl: checkImageUrl, image: scoreFrame, text: scoreText, warmup };
  const job = handlers[msg.type]?.(msg);
  if (!job) return;
  active++;
  lastUsed = Date.now();
  job.then(sendResponse)
    // A model that couldn't load says so (modelError); anything else (an image that couldn't be
    // downloaded, say) is just no result.
    .catch(e => { console.warn('model error', e); sendResponse(e?.modelLoad ? { modelError: String(e.message || e) } : null); })
    .finally(() => { active--; lastUsed = Date.now(); });
  return true;
});
