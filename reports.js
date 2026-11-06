// Mistake reports, shared by content.js and google-docs.js.
//
// When someone says "Not AI" (a false alarm) or "This is AI" (a miss), we:
//   1. remember it, so that image or paragraph is treated their way from then on, and
//   2. save a report the user can download from the popup and send to the developer.
// Everything stays in chrome.storage.local on this computer; nothing is uploaded.

(function (root) {
  const MAX_REPORTS = 300;
  const MAX_KEYS = 2000;
  let notAi = new Set();
  let isAi = new Set();

  chrome.storage.local.get({ notAiKeys: [], isAiKeys: [] }, s => {
    notAi = new Set(s.notAiKeys);
    isAi = new Set(s.isAiKeys);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.notAiKeys) notAi = new Set(changes.notAiKeys.newValue || []);
    if (changes.isAiKeys) isAi = new Set(changes.isAiKeys.newValue || []);
  });

  // Paragraphs are remembered by a hash of their text, images and videos by their URL.
  function keyForText(text) {
    const s = text.replace(/\s+/g, ' ').trim().toLowerCase();
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return 't:' + (h >>> 0).toString(36) + ':' + s.length;
  }
  const keyForMedia = url => (url ? 'm:' + url.slice(0, 500) : null);

  // verdict: 'not-ai' (the detector was wrong to flag it) or 'is-ai' (it missed it).
  async function report({ verdict, kind, key, score = null, reasons = [], text = '', mediaUrl = '' }) {
    const entry = {
      time: new Date().toISOString(),
      verdict, kind,
      site: location.hostname,
      page: location.href.slice(0, 500),
      score: score == null ? null : Math.round(score * 100) / 100,
      reasons,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 1500),
      mediaUrl: mediaUrl.slice(0, 500),
      version: chrome.runtime.getManifest().version
    };
    const field = verdict === 'not-ai' ? 'notAiKeys' : 'isAiKeys';
    const other = verdict === 'not-ai' ? 'isAiKeys' : 'notAiKeys';
    const s = await chrome.storage.local.get({ reports: [], notAiKeys: [], isAiKeys: [] });
    const patch = { reports: [...s.reports, entry].slice(-MAX_REPORTS) };
    if (key) {
      patch[field] = [...new Set([...s[field], key])].slice(-MAX_KEYS);
      patch[other] = s[other].filter(k => k !== key);
    }
    await chrome.storage.local.set(patch);
  }

  // A short confirmation in the corner of the page.
  // A short message at the bottom of the window. duration: how long it stays (ms).
  function toast(message, { duration = 3000 } = {}) {
    const host = document.createElement('div');
    host.setAttribute('data-aib-ui', 'toast');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001; }
      div { font: 500 13px system-ui, -apple-system, "Segoe UI", sans-serif; background: #16181d; color: #f3f4f6;
            padding: 9px 14px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.25);
            transition: opacity .3s ease; max-width: min(560px, calc(100vw - 32px)); line-height: 1.4; }
      div.long { border-radius: 12px; }
    `;
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.textContent = message;
    if (message.length > 70) box.className = 'long';
    shadow.append(style, box);
    document.body.appendChild(host);
    setTimeout(() => { box.style.opacity = '0'; }, duration - 400);
    setTimeout(() => host.remove(), duration);
  }

  root.AIBReports = {
    keyForText, keyForMedia, report, toast,
    isNotAi: key => !!key && notAi.has(key),
    isMarkedAi: key => !!key && isAi.has(key)
  };
})(window);
