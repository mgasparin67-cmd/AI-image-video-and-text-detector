// Tests the trial-end counts and the review question's rules (activity.js, license.js). Run from the
// ai-blocker folder: node test/trial-end-test.js
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`); };
globalThis.window = globalThis;
require('../activity.js');
require('../license.js');
const { describe, trialTotals, dayKey } = globalThis.AIBActivity;
const { endingSoon, reviewDue, REVIEW_AFTER } = globalThis.AIBLicense;

check('all kinds', describe({ image: 212, video: 34, text: 8, hidden: 12 }) === 'flagged 212 likely AI images, 34 videos and 8 passages of text, and hid 12 other AI items', describe({ image: 212, video: 34, text: 8, hidden: 12 }));
check('one kind, one item', describe({ image: 1 }) === 'flagged 1 likely AI image');
check('text only says it is AI', describe({ text: 2 }) === 'flagged 2 likely AI passages of text');
check('video first says it is AI', describe({ video: 2, text: 1 }) === 'flagged 2 likely AI videos and 1 passage of text');
check('only hidden', describe({ hidden: 3 }) === 'hid 3 AI items');
check('big numbers get commas', describe({ image: 1234 }) === 'flagged 1,234 likely AI images');
check('nothing means nothing to say', describe({}) === '' && describe() === '');

const DAY = 86400000, start = new Date(2026, 10, 2, 12).getTime();
const dayOf = n => dayKey(new Date(start + n * DAY));
const activity = {
  [dayOf(-1)]: { a: { image: 100 } }, // before the trial
  [dayOf(0)]: { a: { image: 5 } },
  [dayOf(7)]: { a: { video: 2 }, b: { hidden: 1 } },
  [dayOf(8)]: { a: { image: 100 } } // after it
};
const t = trialTotals(activity, start, 7);
check('trial totals count only the trial', t.image === 5 && t.video === 2 && t.hidden === 1, JSON.stringify(t));

check('reminder: 2 days left', endingSoon({ mode: 'trial', daysLeft: 2 }));
check('reminder: not at 3 days', !endingSoon({ mode: 'trial', daysLeft: 3 }));
check('reminder: not for paying customers', !endingSoon({ mode: 'licensed', daysLeft: 0 }));

const trial = { mode: 'trial' }, paid = { mode: 'licensed' };
check('review: asked in trial and paid at the threshold', reviewDue(trial, REVIEW_AFTER) && reviewDue(paid, REVIEW_AFTER));
check('review: not before the threshold', !reviewDue(trial, REVIEW_AFTER - 1));
check('review: not once answered', !reviewDue(paid, 500, { done: true }));
check('review: gives up if ignored', reviewDue(paid, 500, { shown: 2 }) && !reviewDue(paid, 500, { shown: 3 }));
check('review: not on developer copies or when paused', !reviewDue({ mode: 'dev' }, 500) && !reviewDue({ mode: 'expired' }, 500) && !reviewDue({ mode: 'ended' }, 500));
process.exit(results.every(Boolean) ? 0 : 1);
