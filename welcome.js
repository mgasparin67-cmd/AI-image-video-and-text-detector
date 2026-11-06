// Welcome page: opens on install, and from the popup to buy or enter a key.

const $ = id => document.getElementById(id);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABELS = { monthly: 'Subscribe for $2.99/month', lifetime: 'Buy lifetime access for $24.99' };
// What happens to their card, under the button. Shown before they go to Stripe.
const TERMS = {
  monthly: 'Charged $2.99 today, then every month. Cancel anytime on the manage page and you keep it until the end of the month you paid for.',
  lifetime: 'Charged $24.99 once, today. It never renews.'
};
const showPlan = () => { $('buyBtn').textContent = LABELS[plan()]; $('terms').textContent = TERMS[plan()]; };
const plan = () => document.querySelector('input[name=plan]:checked').value;

render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.license || changes.trialStart)) render();
});
if (location.hash === '#key') { $('keyBox').open = true; $('key').focus(); }

for (const input of document.querySelectorAll('input[name=plan]')) input.addEventListener('change', showPlan);
showPlan();

async function render() {
  const stored = await AIBLicense.load();
  const a = AIBLicense.access(stored);
  const text = {
    trial: ['Free trial', a.daysLeft >= AIBLicense.TRIAL_DAYS ? 'Sloply is on. Your 7‑day free trial has started.' : `Your free trial has ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left.`,
      'Everything works during the trial, no card needed. To keep Sloply after that, pick a plan any time. If you buy now, your plan starts today.'],
    expired: ['Trial ended', 'Your free trial has ended.', 'Sloply is paused on every site. Pick a plan to turn it back on.'],
    ended: ['Plan ended', 'Your plan has ended.', 'Sloply is paused on every site. Pick a plan to turn it back on.'],
    limit: ['Too many browsers', 'This license is on too many browsers.', 'A license works in up to 3 browsers. Sign out the others on sloply.app/manage.html, then enter your key below.'],
    licensed: ['Unlocked', 'Sloply is unlocked. Thanks for buying it.', 'It’s working on every site in this browser. You can close this tab.'],
    dev: ['Developer copy', 'Sloply is on, with no plan needed.', 'This copy was loaded unpacked, so the paywall is off. Store installs get the 7-day trial, then need a plan.']
  }[a.mode];
  [$('kicker').textContent, $('title').textContent, $('lede').textContent] = text;
  if (a.mode === 'expired' && stored.trialStart) {
    const { activity } = await chrome.storage.local.get({ activity: {} });
    const did = AIBActivity.describe(AIBActivity.trialTotals(activity, stored.trialStart, AIBLicense.TRIAL_DAYS));
    if (did) $('lede').textContent = `In your free trial, Sloply ${did}. It’s paused now. Pick a plan to keep it on.`;
  }
  const bought = a.mode === 'licensed';
  $('buy').hidden = bought || a.mode === 'dev';
  $('keyBox').hidden = bought || a.mode === 'dev';
  $('owned').hidden = !bought;
  if (bought) {
    $('ownedPlan').textContent = stored.license.plan === 'lifetime' ? 'Lifetime' : 'Monthly plan';
    $('ownedKey').textContent = stored.license.key;
  }
}

function showError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

$('buy').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!EMAIL.test(email)) { showError('buyError', 'Enter a valid email address.'); $('email').focus(); return; }
  showError('buyError');
  const btn = $('buyBtn');
  btn.disabled = true; btn.textContent = 'Opening checkout…';
  const result = await chrome.runtime.sendMessage({ type: 'startCheckout', email, plan: plan() }).catch(() => null);
  if (result?.url) { location.href = result.url; return; } // Stripe, then the website's success page
  showError('buyError', result?.error || 'Couldn’t start checkout. Try again in a moment.');
  btn.disabled = false; showPlan();
});

$('keyForm').addEventListener('submit', async e => {
  e.preventDefault();
  showError('keyError');
  const btn = $('keyBtn');
  btn.disabled = true; btn.textContent = 'Checking…';
  const result = await chrome.runtime.sendMessage({ type: 'activateKey', key: $('key').value }).catch(() => null);
  btn.disabled = false; btn.textContent = 'Activate';
  if (!result?.ok) showError('keyError', result?.error || 'Couldn’t check that key. Try again.');
  // On success the storage change re-renders the page as unlocked.
});
