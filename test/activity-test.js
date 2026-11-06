// Tests that background.js records weekly-summary counts, and that reports arriving at the same
// moment from different tabs are all kept (one write at a time).
// Run from the ai-blocker folder: node test/activity-test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let listener = null;
let store = {};
const wait = ms => new Promise(r => setTimeout(r, ms));

const chrome = {
  runtime: { onMessage: { addListener: f => { listener = f; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, sendMessage: async () => {} },
  offscreen: { hasDocument: async () => false },
  // Slow storage, so overlapping writes would lose counts if they weren't one at a time.
  storage: {
    sync: { get: async d => ({ ...d }) },
    local: {
      get: async k => { await wait(10); return typeof k === 'string' ? { [k]: store[k] } : { ...k, ...store }; },
      set: async p => { await wait(10); store = { ...store, ...JSON.parse(JSON.stringify(p)) }; }
    }
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  tabs: { sendMessage: async () => {} }
};
const context = vm.createContext({
  chrome, console, setTimeout, clearTimeout, URL, TextDecoder, Uint8Array, Date,
  importScripts: (...files) => files.forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context))
});
context.self = context;
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

const send = msg => new Promise(res => { if (!listener(msg, {}, res)) res(undefined); });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' (' + detail + ')' : ''}`); };

(async () => {
  await Promise.all([
    send({ type: 'activity', site: 'a.com', counts: { image: 2 } }),
    send({ type: 'activity', site: 'b.com', counts: { text: 1 } }),
    send({ type: 'activity', site: 'a.com', counts: { image: 1, hidden: 4 } })
  ]);
  const day = context.AIBActivity.dayKey();
  const today = store.activity?.[day] || {};
  check('three reports at once are all kept', today['a.com']?.image === 3 && today['a.com']?.hidden === 4 && today['b.com']?.text === 1, JSON.stringify(today));
  check('stored under today\'s date', Object.keys(store.activity || {}).join() === day);
  console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})();
