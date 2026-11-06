// Tests that background.js closes the models page when it reports being idle, never while a
// model job is in flight, and reopens it for the next job.
// Run from the ai-blocker folder: node test/idle-unload-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

let open = false;
const events = [];
let listener = null;
let jobDelay = 0;
const local = {};

const chrome = {
  runtime: {
    onMessage: { addListener: f => { listener = f; } },
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    // Jobs sent to the models page: answered after jobDelay ms, if the page is open.
    sendMessage: async msg => {
      if (msg.target !== 'offscreen') return;
      if (!open) throw new Error('Could not establish connection. Receiving end does not exist.');
      events.push(`job ${msg.type}`);
      await wait(jobDelay);
      if (!open) throw new Error('models page closed mid-job');
      return { score: 0.1, reasons: [] };
    }
  },
  offscreen: {
    hasDocument: async () => open,
    createDocument: async () => { await wait(20); open = true; events.push('open'); },
    closeDocument: async () => { await wait(20); open = false; events.push('close'); }
  },
  storage: {
    sync: { get: async d => ({ ...d }) },
    local: { get: async k => (typeof k === 'string' ? { [k]: local[k] } : { ...k, ...local }), set: async p => Object.assign(local, p) }
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  tabs: { sendMessage: async () => {} }
};

const context = vm.createContext({
  chrome, console, setTimeout, clearTimeout, URL, TextDecoder, Uint8Array, fetch,
  importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context))
});
context.self = context;
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

const send = msg => new Promise(res => { if (!listener(msg, {}, res)) res(undefined); });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' (' + detail + ')' : ''}`); };

(async () => {
  // 1. A job opens the page.
  await send({ type: 'checkText', text: 'first' });
  check('a job opens the models page', open && events.includes('open'));

  // 2. Idle report with nothing in flight: the page closes and the popup status resets.
  const closed = await send({ type: 'modelsIdle' });
  check('idle report closes the page', closed === true && !open);
  check('popup status goes back to idle', local.modelStatus?.image?.state === 'idle' && local.modelStatus?.text?.state === 'idle');

  // 3. The next job reopens it.
  events.length = 0;
  const r = await send({ type: 'checkText', text: 'second' });
  check('the next job reopens it and gets an answer', open && events[0] === 'open' && r?.score === 0.1, events.join(', '));

  // 4. Idle report while a job is in flight: the page stays open and the job finishes.
  jobDelay = 150;
  const slow = send({ type: 'checkText', text: 'slow job' });
  await wait(30);
  const refused = await send({ type: 'modelsIdle' });
  const slowResult = await slow;
  check('no close while a job is in flight', refused === false && open && slowResult?.score === 0.1);

  // 5. A job arriving while the page is closing waits, then gets a fresh page.
  jobDelay = 0;
  events.length = 0;
  const closing = send({ type: 'modelsIdle' });
  await wait(5);
  const during = await send({ type: 'checkText', text: 'during close' });
  await closing;
  check('a job during closing reopens the page and is answered', during?.score === 0.1 && open, events.join(', '));

  console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
