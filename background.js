// Service worker: checks images, video frames and text for AI-generation signals.
// Cheap checks (file metadata) run here. The AI-detection models run in a hidden
// offscreen page (models.js), because service workers can't run them reliably.

importScripts('metadata.js', 'activity.js', 'license.js'); // AIBMetadata: image metadata signals; AIBActivity: weekly counts; AIBLicense: trial and license

const CACHE_LIMIT = 500;
const imageCache = new Map();
const textCache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return; // meant for the models page
  const handlers = {
    checkImage: () => cached(imageCache, msg.url, () => checkImage(msg.url)),
    checkText: () => cached(textCache, msg.text, () => runModel({ type: 'text', text: msg.text })),
    checkVideoFrame: () => checkVideoFrame(msg, sender),
    fetchText: () => fetchGoogleDocText(msg.url),
    // From the page script: what it flagged or hid, for the weekly summary.
    activity: () => recordActivity(msg.site, msg.counts),
    // "Try again" in the popup after the models failed: start over with a fresh models page.
    retryModels: () => retryModels(),
    // From models.js after 10 minutes without work: close it to free memory.
    modelsIdle: () => closeIdleModels(),
    // From models.js, which can't use chrome.storage itself.
    modelStatus: () => chrome.storage.local.set({ modelStatus: msg.status }).then(() => true),
    // Welcome page and popup: buying, entering a key, re-checking it.
    startCheckout: () => startCheckout(msg.email, msg.plan),
    activateKey: () => activateKey(msg.key),
    refreshLicense: () => refreshLicense(),
    // From page scripts on http:// pages, which can't check a signature themselves.
    verifyToken: () => AIBLicense.verifyToken(msg.license?.token, msg.license?.key, msg.installId),
    updateBadge: () => updateBadge(),
    // From unlock.js on the website's success page, right after paying.
    claimSession: () => claimSession(msg.sessionId)
  };
  const handler = handlers[msg?.type];
  if (!handler) return;
  handler()
    .then(sendResponse)
    .catch(() => sendResponse(null));
  return true; // keep the channel open for the async response
});

function cached(cache, key, fn) {
  if (cache.has(key)) return cache.get(key);
  const result = fn();
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  // Retry failures later, including a missing model result, so a model that starts working
  // later isn't hidden behind an earlier "not AI".
  result.then(r => { if (!r || r.incomplete || r.modelError) cache.delete(key); }, () => cache.delete(key));
  return result;
}

const useModels = async () => (await chrome.storage.sync.get({ useModels: true })).useModels;

// ---------- Offscreen models page ----------

let creating = null;
let closing = null;
let inFlight = 0; // model jobs sent and not yet answered

async function ensureOffscreen() {
  await closing; // being closed for idleness: wait, then open a fresh one
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run local AI-detection models on images, video frames and text'
  }).finally(() => { creating = null; });
  await creating;
}

async function runModel(job) {
  inFlight++; // counted from the start, so an idle close can't slip in before the job is sent
  try {
    if (!(await useModels())) return null;
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ target: 'offscreen', ...job });
  } catch (e) {
    // Show it in the popup instead of failing silently.
    console.warn('model page failed', e);
    const { modelStatus = {} } = await chrome.storage.local.get('modelStatus');
    const kind = job.type === 'text' ? 'text' : 'image';
    await chrome.storage.local.set({ modelStatus: { ...modelStatus, [kind]: { state: 'error', error: String(e) } } });
    return null;
  } finally {
    inFlight--;
  }
}

// ---------- Weekly summary counts ----------
// One writer, one write at a time, so tabs reporting together don't overwrite each other.

let activityWrites = Promise.resolve();
function recordActivity(site, counts) {
  activityWrites = activityWrites.then(async () => {
    const { activity = {} } = await chrome.storage.local.get('activity');
    await chrome.storage.local.set({ activity: AIBActivity.add(activity, AIBActivity.dayKey(), site, counts || {}) });
  }).catch(() => {});
  return activityWrites.then(() => true);
}

// Start over after a failure: close the models page (its failed state goes with it), reset the
// popup's status, and load both models now so the popup shows the download.
async function retryModels() {
  if (!(await useModels())) return false;
  if (await chrome.offscreen.hasDocument()) {
    closing = chrome.offscreen.closeDocument().catch(() => {}).finally(() => { closing = null; });
    await closing;
  }
  await chrome.storage.local.set({ modelStatus: { image: { state: 'idle', pct: 0 }, text: { state: 'idle', pct: 0 } } });
  const r = await runModel({ type: 'warmup' });
  return !!r?.ready;
}

// Close the models page to give its memory back, unless work has come in meanwhile.
async function closeIdleModels() {
  if (!(await chrome.offscreen.hasDocument())) return false;
  if (inFlight || creating || closing) return false; // checked right before closing, with no await between
  closing = chrome.offscreen.closeDocument().catch(() => {}).finally(() => { closing = null; });
  await closing;
  await chrome.storage.local.set({ modelStatus: { image: { state: 'idle', pct: 0 }, text: { state: 'idle', pct: 0 } } });
  return true;
}

// ---------- Images ----------

// With the models on, the model page downloads the image once and checks both its metadata and
// its pixels. With them off, only the metadata is checked, here.
async function checkImage(url) {
  if (!(await useModels())) return scanMetadata(url);
  const result = await runModel({ type: 'imageUrl', url });
  // No model result: still check the metadata here, and say whether the model itself is broken
  // (the page then tells the user) or just this image couldn't be read. Neither is cached.
  if (!result || result.modelError) return { ...(await scanMetadata(url)), incomplete: true, modelError: result?.modelError };
  return result;
}

async function scanMetadata(url) {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok || !res.body) return { score: 0, reasons: [] };

    // Read only the start of the file, where metadata lives.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < AIBMetadata.MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    return AIBMetadata.scan(bytes);
  } catch {
    // Network errors, blocked requests, etc. Treat as "no signal".
  }
  return { score: 0, reasons: [] };
}

// ---------- License ----------
// Install starts the free trial and opens the welcome page. Checkout on Stripe lands on the
// website's success page, where unlock.js hands the checkout session here.

// The start date is kept in both storage areas, and the earliest one wins. chrome.storage.local is
// wiped on uninstall; the synced copy may bring the date back after a reinstall when Chrome sync is
// on, which makes restarting the trial less easy, not impossible.
async function setUpTrial() {
  const [{ trialStart: here }, { trialStart: synced }] = await Promise.all([
    chrome.storage.local.get('trialStart'),
    chrome.storage.sync.get('trialStart')
  ]);
  const trialStart = Math.min(here ?? Infinity, synced ?? Infinity, Date.now());
  if (here !== trialStart) await chrome.storage.local.set({ trialStart });
  if (synced !== trialStart) await chrome.storage.sync.set({ trialStart });
}

// Updating from a version without this trial (up to 0.7.2) starts it too, and says so.
async function openWelcome(reason, previousVersion) {
  const { license } = await AIBLicense.load();
  const before = reason === 'update' && /^0\.([0-6]\.|7\.[0-2]$)/.test(previousVersion || '') && !license?.valid;
  if (reason === 'install' || before) chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
}

// The toolbar icon says when the trial is about to end or is over, without interrupting the page.
async function updateBadge() {
  const a = AIBLicense.access(await AIBLicense.load());
  const ending = AIBLicense.endingSoon(a);
  const stopped = !a.ok;
  await chrome.action.setBadgeBackgroundColor({ color: '#f0a800' });
  await chrome.action.setBadgeText({ text: ending ? `${a.daysLeft}d` : stopped ? '!' : '' });
  await chrome.action.setTitle({ title: ending ? `Sloply: free trial ends in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}` : stopped ? 'Sloply is paused. Choose a plan to turn it back on.' : 'Sloply' });
  return true;
}

// Hourly re-check. The alarm survives the service worker sleeping; it's (re)created on install,
// update and browser start.
const ensureLicenseAlarm = () => chrome.alarms.create('license', { periodInMinutes: 60 });
chrome.runtime.onStartup.addListener(async () => {
  ensureLicenseAlarm();
  setUpTrial().then(updateBadge);
  const { license } = await AIBLicense.load();
  if (AIBLicense.isStale(license)) refreshLicense();
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'license') return;
  updateBadge();
  const { license } = await AIBLicense.load();
  if (license?.key) refreshLicense();
});

async function startCheckout(email, plan) {
  try {
    const { data } = await AIBLicense.call('create-checkout', { email, plan, trial: false });
    return data.url ? { url: data.url } : { error: data.error || 'Couldn’t start checkout. Try again in a moment.' };
  } catch {
    return { error: 'Couldn’t reach the server. Check your connection and try again.' };
  }
}

// A random ID for this browser, made once. The server counts them against the license's limit.
async function getInstallId() {
  const { installId } = await chrome.storage.local.get('installId');
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function activateKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!AIBLicense.KEY_PATTERN.test(key)) return { error: 'That doesn’t look like a license key. It starts with ABK-.' };
  let res;
  try {
    res = await AIBLicense.call('check-license', { license_key: key, install_id: await getInstallId() });
  } catch {
    return { error: 'Couldn’t reach the server. Check your connection and try again.' };
  }
  const { status, data } = res;
  if (status === 404) return { error: 'No purchase uses that license key.' };
  if (status === 409) return { error: `That key is already in use on ${data.max_browsers} browsers. Sign out the others on sloply.app/manage.html, then try again.` };
  if (status !== 200) return { error: data.error || 'Couldn’t check that key. Try again.' };
  if (!data.valid) {
    return { error: data.status === 'refunded' ? 'That purchase was refunded.' : 'That plan has ended. Choose a plan to keep using Sloply.' };
  }
  if (!data.token) return { error: 'Couldn’t check that key. Try again.' };
  await chrome.storage.local.set({ license: { key, plan: data.plan, status: data.status, token: data.token, checkedAt: Date.now() } });
  return { ok: true, plan: data.plan };
}

// A canceled, refunded or unknown key locks again, and so does one over its browser limit. If the
// server can't be reached, the last token stands until it expires (14 days).
async function refreshLicense() {
  const stored = await AIBLicense.load();
  const { license } = stored;
  if (!license?.key) return AIBLicense.access(stored);
  try {
    const { status, data } = await AIBLicense.call('check-license', { license_key: license.key, install_id: await getInstallId() });
    if (status === 200 || status === 404 || status === 409) {
      const { valid: _, ...kept } = license;
      await chrome.storage.local.set({ license: { ...kept, plan: data.plan ?? license.plan, status: data.status ?? 'unknown', token: data.valid ? data.token : null, checkedAt: Date.now() } });
      return AIBLicense.access(await AIBLicense.load());
    }
  } catch {}
  return AIBLicense.access(stored);
}

// The webhook stores the license a few seconds after payment, so keep asking for a while.
async function claimSession(sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId || '')) return { error: 'Missing checkout session.' };
  for (let tries = 0; tries < 15; tries++) {
    try {
      const { status, data } = await AIBLicense.call(`get-license?session_id=${encodeURIComponent(sessionId)}`);
      if (status === 200 && data.license_key) return activateKey(data.license_key);
      if (status !== 404) return { error: data.error || 'Couldn’t load your license.' };
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return { error: 'Your license isn’t ready yet.' };
}

// ---------- Right-click "Report as AI" ----------
// For things the detector missed. The page script saves the report and blurs the item.

chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  setUpTrial().then(() => { updateBadge(); openWelcome(reason, previousVersion); });
  ensureLicenseAlarm();
  // A license from before signed tokens gets one here.
  chrome.storage.local.get('license').then(({ license }) => { if (license?.key) refreshLicense(); });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'aib-report-media', title: 'Report as AI-generated', contexts: ['image', 'video'] });
    chrome.contextMenus.create({ id: 'aib-report-text', title: 'Report selected text as AI-written', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'reportAsAi',
    srcUrl: info.menuItemId === 'aib-report-media' ? info.srcUrl : undefined,
    selectionText: info.menuItemId === 'aib-report-text' ? info.selectionText : undefined
  }, { frameId: 0 }).catch(() => {});
});

// ---------- Google Docs ----------
// Fallback for google-docs.js when the plain-text export redirects somewhere the page can't follow.
// Only Google Docs export URLs are allowed, so pages can't use this to fetch arbitrary sites.

async function fetchGoogleDocText(url) {
  if (!/^https:\/\/docs\.google\.com\/document\/d\/[\w-]+\/export\?format=txt$/.test(url)) return null;
  const res = await fetch(url, { credentials: 'include' });
  return res.ok ? { text: await res.text() } : null;
}

// ---------- Video frames ----------
// Pages usually can't read pixels from videos hosted on other sites, so instead we take a
// screenshot of the visible tab and crop it to the video. Chrome allows about 2 screenshots
// per second, so captures are queued.

let captureQueue = Promise.resolve();
const CAPTURE_GAP_MS = 600;

function checkVideoFrame({ rect, dpr }, sender) {
  const job = captureQueue.then(async () => {
    const tab = sender.tab;
    if (!tab?.active) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    await new Promise(r => setTimeout(r, CAPTURE_GAP_MS));
    return dataUrl;
  });
  captureQueue = job.catch(() => {});
  return job.then(dataUrl => {
    if (!dataUrl) return null;
    const crop = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height].map(n => Math.round(n * dpr));
    crop[2] -= 1; crop[3] -= 1;
    return runModel({ type: 'image', dataUrl, crop });
  });
}
