const DEFAULTS = { enabled: true, images: true, videos: true, text: true, threshold: 0.7, disabledSites: [], useModels: true, platformLabels: true, hideAiOverview: true, hideAiTopics: false, removeFlagged: false };
const $ = id => document.getElementById(id);

let settings;
let host = null;
let tabId = null;
let modelStatus = {};

init();

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try { host = new URL(tab.url).hostname || null; } catch {}

  for (const id of ['enabled', 'images', 'videos', 'text', 'useModels', 'platformLabels', 'hideAiOverview', 'hideAiTopics']) {
    $(id).checked = settings[id];
    $(id).addEventListener('change', () => {
      save({ [id]: $(id).checked });
      renderState();
    });
  }

  $('threshold').value = settings.threshold;
  renderThreshold(settings.threshold);
  $('threshold').addEventListener('input', () => renderThreshold(Number($('threshold').value)));
  $('threshold').addEventListener('change', () => save({ threshold: Number($('threshold').value) }));
  $('resetThreshold').addEventListener('click', () => {
    $('threshold').value = DEFAULTS.threshold;
    renderThreshold(DEFAULTS.threshold);
    save({ threshold: DEFAULTS.threshold });
  });

  renderState();
  $('siteToggle').addEventListener('click', () => {
    // Resume takes off every entry that covers this site (the site itself or a parent domain).
    const sites = paused() ? AIBSites.without(host, settings.disabledSites) : [...settings.disabledSites, host];
    save({ disabledSites: sites }).then(renderState);
  });

  const stored = await chrome.storage.local.get({ modelStatus: {}, reports: [] });
  renderModels(stored.modelStatus);
  renderReports(stored.reports);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.modelStatus) renderModels(changes.modelStatus.newValue || {});
    if (area === 'local' && changes.reports) renderReports(changes.reports.newValue || []);
  });

  $('editTopics').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('retryModels').addEventListener('click', async () => {
    const btn = $('retryModels');
    btn.disabled = true; btn.dataset.busy = '1'; btn.textContent = 'Trying…';
    try { await chrome.runtime.sendMessage({ type: 'retryModels' }); } catch {}
    delete btn.dataset.busy; btn.textContent = 'Try again'; btn.disabled = false;
    // The status updates through chrome.storage as the models load (or fail again).
  });
  $('openSummary').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('summary.html') }));
  renderMode();
  $('modeBlur').addEventListener('click', () => { save({ removeFlagged: false }); renderMode(); });
  $('modeRemove').addEventListener('click', () => { save({ removeFlagged: true }); renderMode(); });
  $('downloadReports').addEventListener('click', downloadReports);
  $('clearReports').addEventListener('click', async () => {
    if (!confirm('Delete your reports and forget which items you marked as AI or not AI?')) return;
    await chrome.storage.local.set({ reports: [], notAiKeys: [], isAiKeys: [] });
  });

  await renderAccess(await AIBLicense.load());
  await askForReview();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.license || changes.trialStart)) AIBLicense.load().then(renderAccess);
  });
  const openWelcome = hash => chrome.tabs.create({ url: chrome.runtime.getURL(`welcome.html${hash}`) });
  $('choosePlan').addEventListener('click', () => openWelcome(''));
  $('lockChoose').addEventListener('click', () => openWelcome(''));
  $('lockKey').addEventListener('click', () => openWelcome('#key'));
  // Opening the popup always re-checks, so a plan that ended shows up right away.
  const { license } = await AIBLicense.load();
  if (license?.key) chrome.runtime.sendMessage({ type: 'refreshLicense' }).catch(() => {});

  refreshStats();
  setInterval(refreshStats, 1000); // live progress while the popup is open
}

// Free trial: days left, with a link to the plans. Trial over or plan ended: everything is replaced
// by the locked card. Bought: the plan and a link to manage it.
async function renderAccess(stored) {
  const a = AIBLicense.access(stored);
  chrome.runtime.sendMessage({ type: 'updateBadge' }).catch(() => {});
  document.body.classList.toggle('locked', !a.ok);
  $('lock').hidden = a.ok;
  $('lockTitle').textContent = a.mode === 'limit' ? 'This license is on too many browsers' : a.mode === 'ended' ? 'Your plan has ended' : 'Your free trial has ended';
  if (a.mode === 'limit') $('lockBody').textContent = 'A license works in up to 3 browsers. Sign out the others on sloply.app/manage.html, then open this again.';
  if (a.mode === 'expired' && stored.trialStart) {
    const { activity } = await chrome.storage.local.get({ activity: {} });
    const did = AIBActivity.describe(AIBActivity.trialTotals(activity, stored.trialStart, AIBLicense.TRIAL_DAYS));
    if (did) $('lockBody').textContent = `In your free trial, Sloply ${did}. It’s paused now. Keep it on for $2.99 a month, or $24.99 once.`;
  }
  const ending = AIBLicense.endingSoon(a);
  $('planBar').hidden = a.mode !== 'trial';
  $('planBar').classList.toggle('ending', ending);
  $('planText').textContent = ending && a.daysLeft === 1 ? 'Last day of your free trial' : `Free trial · ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left`;
  $('choosePlan').textContent = ending ? 'Keep Sloply on' : 'Choose a plan';
  $('licenseFoot').hidden = a.mode !== 'licensed' && a.mode !== 'dev';
  $('licenseManage').hidden = a.mode === 'dev';
  if (a.mode === 'dev') $('licenseText').textContent = 'Developer copy · no plan needed';
  if (a.mode === 'licensed') $('licenseText').textContent = stored.license.plan === 'lifetime' ? 'Lifetime license' : 'Monthly plan';
}

// One question, after Sloply has done something for them. Either answer ends it for good. Nothing
// is sent anywhere: the link is an ordinary one to the store's reviews page.
async function askForReview() {
  const { activity, reviewPrompt, modelStatus } = await chrome.storage.local.get({ activity: {}, reviewPrompt: {}, modelStatus: {} });
  if (Object.values(modelStatus).some(m => m?.state === 'error')) return; // not while something's wrong
  const total = AIBActivity.summarize(activity, AIBActivity.dayKey(), AIBActivity.KEEP_DAYS).totals.all;
  if (!AIBLicense.reviewDue(AIBLicense.access(await AIBLicense.load()), total, reviewPrompt)) return;
  await chrome.storage.local.set({ reviewPrompt: { ...reviewPrompt, shown: (reviewPrompt.shown || 0) + 1 } });
  const done = () => {
    chrome.storage.local.set({ reviewPrompt: { done: true } });
    $('reviewBar').hidden = true;
    document.body.classList.remove('asking');
  };
  $('reviewLink').href = AIBLicense.REVIEWS_URL;
  $('reviewLink').addEventListener('click', done);
  $('reviewLater').addEventListener('click', done);
  $('reviewBar').hidden = false;
  document.body.classList.add('asking');
}

async function save(patch) {
  Object.assign(settings, patch);
  await chrome.storage.sync.set(patch);
  setTimeout(refreshStats, 400);
}

const paused = () => !!host && AIBSites.isListed(host, settings.disabledSites); // also covers a listed parent domain

// Header: the on/off switch dims everything below it; the site button pauses just this site.
function renderState() {
  document.body.classList.toggle('off', !settings.enabled);
  const btn = $('siteToggle');
  btn.disabled = !host || !settings.enabled;
  btn.textContent = paused() ? 'Resume' : 'Pause';
  btn.title = !host ? 'Not available on this page' : paused() ? `Resume on ${host}` : `Pause on ${host}`;
  renderModels(modelStatus);
  refreshStats();
}

function renderMode() {
  $('modeBlur').setAttribute('aria-pressed', !settings.removeFlagged);
  $('modeRemove').setAttribute('aria-pressed', !!settings.removeFlagged);
}

function renderThreshold(value) {
  $('thresholdValue').textContent = `${Math.round(value * 100)}%`;
  const range = $('threshold');
  range.style.setProperty('--fill', `${((value - range.min) / (range.max - range.min)) * 100}%`);
  $('resetThreshold').hidden = Math.abs(value - DEFAULTS.threshold) < 0.001;
}

function renderModels(status) {
  modelStatus = status;
  const view = s => {
    if (!settings.useModels) return ['idle', 'off'];
    if (!s || s.state === 'idle') return ['idle', 'idle'];
    if (s.state === 'downloading') return ['loading', `loading ${s.pct}%`];
    if (s.state === 'ready') return ['ready', s.device === 'webgpu' ? 'ready·gpu' : 'ready·cpu'];
    if (s.state === 'error') return ['error', 'failed'];
    return ['idle', ''];
  };
  for (const [kind, s] of [['image', status.image], ['text', status.text]]) {
    const [state, text] = view(s);
    $(`${kind}Dot`).dataset.state = state;
    $(`${kind}Status`).textContent = text;
    $(`${kind}Status`).title = s?.error || ''; // the error message, on hover
  }
  renderModelAlert(status);
}

// A model that couldn't load gets a clear warning in place of the counts, with "Try again".
function renderModelAlert(status) {
  const failed = settings.useModels && settings.enabled ? ['image', 'text'].filter(k => status[k]?.state === 'error') : [];
  $('modelAlert').hidden = !failed.length;
  if (!failed.length) return;
  $('modelAlertTitle').textContent = failed.length === 2 ? 'Detection models didn’t load' : `The ${failed[0] === 'image' ? 'image' : 'text'} model didn’t load`;
  $('modelAlertBody').textContent = 'Only basic checks for now.';
  $('modelAlert').title = failed.map(k => status[k].error).filter(Boolean).join('\n');
  if (!$('retryModels').dataset.busy) $('retryModels').disabled = false;
}

function renderReports(reports) {
  $('reportCount').textContent = reports.length;
  $('downloadReports').disabled = reports.length === 0;
  $('clearReports').disabled = reports.length === 0;
}

// Saves the reports as a JSON file: what was reported, where, the score and reasons, and a text sample.
async function downloadReports() {
  const { reports } = await chrome.storage.local.get({ reports: [] });
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), reports }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sloply-reports-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function refreshStats() {
  // The three counts show only while this tab is being checked; otherwise the line says why not.
  const show = (state, text, counts) => {
    $('statusDot').dataset.state = state;
    $('stats').textContent = text;
    document.body.classList.toggle('idle', !counts);
    $('statBlurred').textContent = counts ? counts.flagged : '–';
    $('statChecked').textContent = counts ? counts.checked : '–';
    $('statWaiting').textContent = counts ? counts.waiting : '–';
    $('cellWaiting').toggleAttribute('data-busy', !!counts?.waiting);
  };
  if (!settings.enabled) return show('idle', 'Off everywhere');
  if (paused()) return show('idle', `Paused on ${host}`);
  if (tabId == null) return;
  try {
    const { flagged = 0, checked = 0, waiting = 0 } = await chrome.tabs.sendMessage(tabId, { type: 'stats' });
    // Images still waiting for the model shows whether a slow page is just working through a queue.
    show(waiting ? 'loading' : 'on', `Watching ${host}`, { flagged, checked, waiting });
  } catch {
    show('idle', host ? 'Reload this page to start checking it' : 'Not available on this page');
  }
}
