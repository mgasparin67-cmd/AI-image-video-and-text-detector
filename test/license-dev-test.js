// Tests the unpacked developer unlock in license.js: unpacked copies work with no plan, and anything
// the store installed (its manifest has update_url) still needs one. Run from the ai-blocker folder:
// node test/license-dev-test.js
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const withManifest = manifest => { globalThis.chrome = { runtime: { getManifest: () => manifest } }; };
require('../license.js');
const { access } = globalThis.AIBLicense;
const STORE = { version: '1', update_url: 'https://clients2.google.com/service/update2/crx' };

withManifest({ version: '1' });
check('unpacked with no plan is on', access({}).ok && access({}).mode === 'dev');
check('unpacked with an ended plan is on', access({ license: { key: 'ABK', valid: false } }).ok);
check('unpacked past the trial is on', access({ trialStart: 1 }).mode === 'dev');
check('devPaywall brings the trial and paywall back', access({ devPaywall: true }).mode === 'trial' && access({ devPaywall: true, trialStart: 1 }).mode === 'expired');

withManifest(STORE);
const DAY = 86400000, NOW = 1800000000000;
const ago = days => ({ trialStart: NOW - days * DAY });
check('store install before the install event is on day one', access({}).mode === 'trial' && access({}).daysLeft === 7);
check('store install on day 1 has 7 days left', access(ago(0), NOW).mode === 'trial' && access(ago(0), NOW).daysLeft === 7);
check('store install with an hour left is still on', access({ trialStart: NOW - 7 * DAY + 3600000 }, NOW).ok);
check('store install at exactly 7 days is off', access(ago(7), NOW).mode === 'expired' && !access(ago(7), NOW).ok);
check('store install after the trial with no plan is off', access(ago(8), NOW).mode === 'expired');
check('store install after the trial with an ended plan is off', access({ ...ago(8), license: { key: 'ABK', valid: false } }, NOW).mode === 'ended');
check('a plan that ended during the trial leaves the trial running', access({ ...ago(2), license: { key: 'ABK', valid: false } }, NOW).mode === 'trial');
check('store install with a plan is on, trial or not', access({ ...ago(8), license: { key: 'ABK', valid: true } }, NOW).mode === 'licensed' && access({ ...ago(1), license: { key: 'ABK', valid: true } }, NOW).mode === 'licensed');

delete globalThis.chrome;
check('without chrome.* it is not treated as unpacked', access({}).mode === 'trial');
process.exit(results.every(Boolean) ? 0 : 1);
