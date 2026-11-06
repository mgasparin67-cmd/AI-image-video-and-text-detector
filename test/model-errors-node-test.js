// Tests background.js when the models can't load: checks come back marked as a model error (not
// "not AI"), aren't cached, and "Try again" starts over with a fresh models page and loads them.
// Run from the ai-blocker folder: node test/model-errors-node-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let listener = null;
let open = false;
let modelsWork = false; // the models page fails until this is true
const sent = [];
const local = {};
const wait = ms => new Promise(r => setTimeout(r, ms));

const chrome = {
  runtime: {
    onMessage: { addListener: f => { listener = f; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    // The models page: answers like models.js does when a model can't load.
    sendMessage: async msg => {
      if (msg.target !== 'offscreen') return;
      sent.push(msg.type);
      if (msg.type === 'warmup') return modelsWork ? { ready: true } : { modelError: 'download failed' };
      return modelsWork ? { score: 0.2, reasons: [] } : { modelError: 'download failed' };
    }
  },
  offscreen: {
    hasDocument: async () => open,
    createDocument: async () => { await wait(5); open = true; },
    closeDocument: async () => { await wait(5); open = false; sent.push('close'); }
  },
  storage: {
    sync: { get: async d => ({ ...d }) },
    local: { get: async k => (typeof k === 'string' ? { [k]: local[k] } : { ...k, ...local }), set: async p => Object.assign(local, p) }
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  tabs: { sendMessage: async () => {} }
};
// Image metadata is fetched by the background worker when the model can't answer: no signals here.
const fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } });
const context = vm.createContext({
  chrome, console, setTimeout, clearTimeout, URL, TextDecoder, Uint8Array, Date, fetch,
  importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context))
});
context.self = context;
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

const send = msg => new Promise(res => { if (!listener(msg, {}, res)) res(undefined); });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' (' + detail + ')' : ''}`); };

(async () => {
  const img = await send({ type: 'checkImage', url: 'https://example.com/a.jpg' });
  check('image check says the model failed (and still has a metadata result)', !!img?.modelError && img.incomplete === true && img.score === 0, JSON.stringify(img));
  const txt = await send({ type: 'checkText', text: 'some paragraph' });
  check('text check says the model failed', !!txt?.modelError, JSON.stringify(txt));

  // Not cached: once the models work, the same image is checked again.
  modelsWork = true;
  sent.length = 0;
  const again = await send({ type: 'checkImage', url: 'https://example.com/a.jpg' });
  check('a failed result is not cached: the same image is checked again', sent.includes('imageUrl') && again?.score === 0.2, JSON.stringify(again));

  // Try again: closes the models page, resets the status, and loads the models.
  modelsWork = false;
  local.modelStatus = { image: { state: 'error', error: 'x' }, text: { state: 'error', error: 'y' } };
  sent.length = 0;
  modelsWork = true;
  const ok = await send({ type: 'retryModels' });
  check('Try again closes the old models page and loads the models', ok === true && sent[0] === 'close' && sent.includes('warmup'), sent.join(','));
  check('Try again resets the popup status before loading', local.modelStatus.image.state === 'idle' && local.modelStatus.text.state === 'idle');

  console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
