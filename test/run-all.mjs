// Runs every automated test: the browser test pages in headless Chrome, and the Node tests.
//   node test/run-all.mjs            all of them
//   node test/run-all.mjs hiding     only those whose name contains "hiding"
//   --save DIR                       pages that hand back data (window.__saveAs = { name, data })
//                                    have it written to DIR/<name>.json (used for evaluations)
//   --page "path?query" --timeout S  run one extra page, e.g. test/text-scores.html?data=...
// Each test page reports through window.__results = [{ name, ok }] and window.__done = true.
// No installs: it uses the Chrome on this computer and Node's built-in WebSocket.

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // the ai-blocker folder
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// [name, page, timeout in seconds]. The model pages load the real models (a few seconds each).
const PAGES = [ // name, page, timeout (seconds)
  ['platform labels', 'test/platform-labels-test.html', 15],
  ['hiding', 'test/hiding-test.html', 15],
  ['never-check sites', 'test/sites-test.html', 15],
  ['ai features', 'test/ai-features-test.html', 15],
  ['popup', 'test/popup-preview.html', 20],
  ['summary', 'test/summary-test.html', 20],
  ['remove mode', 'test/remove-test.html', 20],
  ['model errors: missing files', 'test/model-errors-test.html?case=missing', 60],
  ['model errors: stalled download', 'test/model-errors-test.html?case=stall', 60],
  ['model errors: page notice', 'test/model-errors-test.html?case=notice', 20],
  ['demo page', 'test/test-page.html', 30],
  ['models', 'test/models-test.html?auto', 180],
  ['article', 'test/article-test.html?auto', 180],
  ['google docs', 'test/docs-test.html', 180],
  ['google docs medical', 'test/docs-test.html?medical', 180]
];
const NODE_TESTS = [['idle unload', 'test/idle-unload-test.js'], ['summary counts', 'test/activity-test.js'], ['medical threshold', 'test/medical-test.js'], ['text styles', 'test/text-styles-test.js'], ['developer unlock', 'test/license-dev-test.js'], ['signed licenses', 'test/license-token-test.js'], ['trial end and review', 'test/trial-end-test.js'], ['model errors: background', 'test/model-errors-node-test.js']];

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const saveDir = option('--save');
const extraPage = option('--page');
const extraTimeout = Number(option('--timeout') || 600);
const filter = args[0]?.toLowerCase();
const wanted = name => !filter || name.toLowerCase().includes(filter);
if (extraPage) PAGES.push(['extra page', extraPage, extraTimeout]);

// ---------- Static server for the extension folder ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // /stall/...: answer with headers and then nothing, like a download stuck on a bad connection.
  if (path.startsWith('/stall/')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 100000000 }); res.write(Buffer.alloc(1)); return; }
  if (path.includes('..')) { res.writeHead(400).end(); return; }
  try {
    const body = await readFile(join(ROOT, path));
    // The model loader reads Content-Length (and sometimes asks with HEAD first).
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    if (process.env.DEBUG) console.log('404', req.method, req.url);
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = process.env.BASE || `http://localhost:${server.address().port}/`; // BASE: test against another server

// ---------- Headless Chrome over the DevTools protocol ----------

const profile = await mkdtemp(join(tmpdir(), 'aib-test-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu', '--window-size=1000,800', 'about:blank']);
const wsUrl = await new Promise((resolve, reject) => {
  let err = '';
  chrome.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  chrome.on('exit', code => reject(new Error(`Chrome exited (${code}): ${err.slice(-500)}`)));
  setTimeout(() => reject(new Error('Chrome did not start')), 20000);
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
const consoleBySession = new Map(); // sessionId -> errors and warnings, shown when a page fails
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (process.env.DEBUG && msg.method === 'Network.responseReceived') console.log('net', msg.params.response.status, msg.params.response.url.slice(0, 140));
  if (process.env.DEBUG && msg.method === 'Network.loadingFailed') console.log('net FAILED', msg.params.errorText, msg.params.blockedReason || '');
  const lines = consoleBySession.get(msg.sessionId);
  if (!lines) return;
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    lines.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    lines.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).slice(0, 300));
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function runPage(page, timeout) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  consoleBySession.set(sessionId, []);
  await cdp('Runtime.enable', {}, sessionId);
  if (process.env.DEBUG) await cdp('Network.enable', {}, sessionId);
  await cdp('Page.navigate', { url: base + page }, sessionId);
  const deadline = Date.now() + timeout * 1000;
  let state = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const { result } = await cdp('Runtime.evaluate', {
        expression: 'JSON.stringify({ done: !!window.__done, results: window.__results || [], save: window.__done ? window.__saveAs || null : null })', returnByValue: true
      }, sessionId);
      state = JSON.parse(result.value);
      if (state.done) break;
    } catch { /* page still loading */ }
  }
  if (state?.save && saveDir) {
    const file = join(saveDir, `${state.save.name.replace(/[^\w.-]/g, '_')}.json`);
    await writeFile(file, JSON.stringify(state.save.data));
    console.log(`        saved ${file}`);
  }
  await cdp('Target.closeTarget', { targetId });
  const logs = consoleBySession.get(sessionId);
  consoleBySession.delete(sessionId);
  const withLogs = results => (results.some(r => !r.ok) && logs.length ? [...results, ...logs.slice(0, 5).map(l => ({ name: `console: ${l}`, ok: false, info: true }))] : results);
  if (!state?.done) return withLogs([{ name: `finished within ${timeout} s`, ok: false }, ...(state?.results || [])]);
  return withLogs(state.results.length ? state.results : [{ name: 'reported at least one result', ok: false }]);
}

// ---------- Run ----------

let passed = 0, failed = 0;
const report = (suite, all) => {
  const results = all.filter(r => !r.info);
  const bad = results.filter(r => !r.ok);
  passed += results.length - bad.length;
  failed += bad.length;
  console.log(`${bad.length ? 'FAIL' : 'ok  '}  ${suite} (${results.length - bad.length}/${results.length})`);
  for (const r of bad) console.log(`        ✗ ${r.name}`);
  for (const r of all.filter(r => r.info)) console.log(`          ${r.name}`);
};

const t0 = Date.now();
for (const [name, page, timeout] of PAGES.filter(([n]) => wanted(n))) {
  try {
    report(name, await runPage(page, timeout));
  } catch (e) {
    report(name, [{ name: `page error: ${e.message}`, ok: false }]);
  }
}
for (const [name, file] of NODE_TESTS.filter(([n]) => wanted(n))) {
  const r = spawnSync(process.execPath, [join(ROOT, file)], { encoding: 'utf8' });
  const checks = r.stdout.split('\n').filter(l => /^(PASS|FAIL) /.test(l)).map(l => ({ name: l.slice(6), ok: l.startsWith('PASS') }));
  // A crash or a test that checked nothing is a failure, not an empty pass.
  if (r.status !== 0 || !checks.length) checks.push({ name: `exited with code ${r.status}: ${r.stderr.trim().split('\n').find(l => /Error/.test(l)) || 'no checks ran'}`, ok: false });
  report(name, checks);
}

ws.close();
chrome.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'}: ${passed} passed, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed ? 1 : 0);
