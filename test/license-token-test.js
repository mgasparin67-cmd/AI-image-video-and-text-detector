// Tests signed licenses in license.js: only a token the server signed, for this key and this browser
// and not expired, unlocks a store install. Run from the ai-blocker folder:
// node test/license-token-test.js
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const STORE = { version: '1', update_url: 'https://clients2.google.com/service/update2/crx' };
let local = {};
globalThis.chrome = {
  runtime: { getManifest: () => STORE },
  storage: { local: { get: async names => Object.fromEntries(names.filter(n => n in local).map(n => [n, local[n]])) } }
};
require('../license.js');
const License = globalThis.AIBLicense;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const KEY = 'ABK-AAAAA-BBBBB-CCCCC-DDDDD', INSTALL = '11111111-1111-1111-1111-111111111111';
const LONG_AGO = Date.now() - 30 * 86400000; // past the trial, so only a license can unlock

async function sign(privateKey, { k = KEY, i = INSTALL, p = 'monthly', exp = Date.now() + 86400000 } = {}) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ k, i, p, exp })));
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign(ECDSA, privateKey, new TextEncoder().encode(payload))))}`;
}
const mode = async (license, installId = INSTALL) => {
  local = { trialStart: LONG_AGO, license, installId };
  return License.access(await License.load()).mode;
};

(async () => {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const good = await sign(pair.privateKey);

  check('no public key in the build: nothing verifies', await mode({ key: KEY, token: good }) === 'ended');
  License.PUBLIC_KEY = await crypto.subtle.exportKey('jwk', pair.publicKey);

  check('a good token unlocks', await mode({ key: KEY, token: good, plan: 'monthly' }) === 'licensed');
  check('typing valid: true into storage does not', await mode({ key: KEY, valid: true }) === 'ended');
  check('valid: true with no key at all does not', await mode({ valid: true }) === 'expired');
  check('a token signed with another key does not', await mode({ key: KEY, token: await sign(other.privateKey) }) === 'ended');
  check('an expired token does not', await mode({ key: KEY, token: await sign(pair.privateKey, { exp: Date.now() - 1000 }) }) === 'ended');
  check('a token copied from another browser does not', await mode({ key: KEY, token: good }, '22222222-2222-2222-2222-222222222222') === 'ended');
  check('a token for another key does not', await mode({ key: 'ABK-ZZZZZ-BBBBB-CCCCC-DDDDD', token: good }) === 'ended');
  const [, sig] = good.split('.');
  const forged = b64url(new TextEncoder().encode(JSON.stringify({ k: KEY, i: INSTALL, p: 'lifetime', exp: Date.now() + 1e12 })));
  check('an edited token does not', await mode({ key: KEY, token: `${forged}.${sig}` }) === 'ended');
  check('garbage does not, and does not throw', await mode({ key: KEY, token: 'not.a-token' }) === 'ended');
  check('no installId does not', await mode({ key: KEY, token: good }, null) === 'ended');

  check('over the browser limit says so', await mode({ key: KEY, status: 'device_limit' }) === 'limit');
  local = { trialStart: Date.now(), license: { key: KEY, valid: true }, installId: INSTALL };
  check('a bad token during the trial still leaves the trial', License.access(await License.load()).mode === 'trial');

  // Page scripts on http:// pages have no crypto.subtle and ask the service worker.
  const realCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  let asked = null;
  chrome.runtime.sendMessage = async msg => { asked = msg; return true; };
  check('without crypto.subtle it asks the service worker', await License.tokenGood({ key: KEY, token: good }, INSTALL) === true && asked?.type === 'verifyToken');
  chrome.runtime.sendMessage = async () => { throw new Error('no receiver'); };
  check('and counts no answer as no', await License.tokenGood({ key: KEY, token: good }, INSTALL) === false);
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });

  process.exit(results.every(Boolean) ? 0 : 1);
})();
