// Google Docs draws documents on a canvas, so there's no page text for content.js to scan or blur.
// Instead, this reads the document's plain text the way File > Download > Plain text does (using
// the user's own Google login), scores it, and shows the verdict in a small badge in the corner
// (badge.js); opening it lists the paragraphs that look AI-written. Nothing in the document is
// blurred, highlighted or selected: it's usually your own document, and you may be typing.

(() => {
  // The test page sets __aibTestDocUrl to pretend it's a Google Doc.
  const where = new URL(window.__aibTestDocUrl || location.href);
  const match = where.hostname === 'docs.google.com' && where.pathname.match(/^\/document\/d\/([\w-]+)/);
  if (!match) return;
  const docId = match[1];

  const DEFAULTS = { enabled: true, text: true, threshold: 0.7, disabledSites: [], useModels: true };
  const MIN_WORDS = 80;
  const MIN_PARAGRAPH_CHARS = 200;
  const CHUNK_WORDS = 350;    // the text model reads up to 512 tokens at a time
  const MAX_CHUNKS = 6;
  const MAX_PARAGRAPHS = 15;  // paragraphs also checked with the text model
  const RECHECK_MS = 15000;   // look for edits this often while the tab is visible

  let settings = { ...DEFAULTS };
  let running = false;
  let lastText = null;        // text of the last finished check
  let userClosed = false;     // badge closed: automatic re-checks stay quiet unless AI turns up
  const Badge = window.AIBBadge;

  chrome.storage.onChanged.addListener((_c, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get(DEFAULTS, s => {
      settings = s;
      if (!isActive()) Badge.remove();
    });
  });

  let access = { ok: false }; // a running trial or plan (license.js)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.license || changes.trialStart)) {
      AIBLicense.load().then(s => { access = AIBLicense.access(s); if (!isActive()) Badge.remove(); });
    }
  });

  function isActive() {
    return access.ok && settings.enabled && settings.text && !window.AIBSites.isListed(location.hostname, settings.disabledSites);
  }

  async function ask(msg) {
    try { return await chrome.runtime.sendMessage(msg); } catch { return null; }
  }

  async function readDocument() {
    const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    // The export redirects to a signed googleusercontent.com link that allows any origin, but only
    // without cookies. 'same-origin' sends the Google login to docs.google.com (needed for private
    // docs) and not to the redirect.
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.ok) return await res.text();
    } catch {}
    // If that fails, the background worker (which isn't limited by the page's origin) can try.
    const res = await ask({ type: 'fetchText', url });
    return res?.text ?? null;
  }

  // auto: a re-check after an edit. It updates the badge quietly.
  async function check({ text = null, auto = false } = {}) {
    if (running) return;
    running = true;
    if (!auto) { userClosed = false; render({ state: 'checking' }); }
    try {
      text ??= await readDocument();
      lastText = text;
      const quiet = auto && userClosed; // closed badge: only reappear if AI turns up
      if (text == null) {
        if (!quiet) render({ state: 'error', message: "Couldn't read this document. Its owner may have turned off downloading." });
        return;
      }
      const words = window.AIBText.normalize(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (words.length < MIN_WORDS) {
        if (!quiet) render({ state: 'short', words: words.length });
        return;
      }

      // Writing patterns across the whole document (more text, more reliable).
      const patterns = window.AIBText.score(text);

      // Text model on the first few chunks of the document.
      let model = null;
      if (settings.useModels) {
        const chunks = [];
        for (let i = 0; i < words.length && chunks.length < MAX_CHUNKS; i += CHUNK_WORDS) {
          const chunk = words.slice(i, i + CHUNK_WORDS);
          if (chunk.length >= 50) chunks.push(chunk.join(' '));
        }
        const results = (await Promise.all(chunks.map(c => ask({ type: 'checkText', text: c })))).filter(Boolean);
        if (results.length) model = results.reduce((a, r) => a + r.score, 0) / results.length;
      }

      // Each longer paragraph on its own, to point at the parts that look AI-written.
      const paragraphs = window.AIBText.normalize(text).split(/\r?\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length >= MIN_PARAGRAPH_CHARS);
      const scored = [];
      for (const [i, p] of paragraphs.entries()) {
        let r = window.AIBText.score(p);
        if (settings.useModels && i < MAX_PARAGRAPHS) {
          const m = await ask({ type: 'checkText', text: p });
          if (m && m.score > r.score) r = m;
        }
        scored.push({ text: p, score: r.score, needed: window.AIBText.threshold(p, settings.threshold) });
      }

      const score = Math.max(patterns.score, model ?? 0);
      const reasons = [...patterns.reasons];
      if (model != null && model >= 0.5) reasons.unshift(`AI text detector: ${Math.round(model * 100)}% likely AI`);
      const result = {
        state: 'done', score, reasons: reasons.slice(0, 3), text,
        flagged: scored.filter(s => s.score >= s.needed), // stricter for medical text, abstracts, poems
        needed: window.AIBText.threshold(text, settings.threshold),
        checked: scored.length
      };
      if (quiet && score < result.needed) return;
      if (quiet) userClosed = false; // AI turned up after an edit: show the badge again
      render(result);
    } finally {
      running = false;
    }
  }

  // Re-check once the document has changed and then stayed the same for one interval
  // (i.e. the user has paused editing). Reading the plain-text export is a few KB.
  let seen = null;
  setInterval(async () => {
    if (document.hidden || running || !isActive() || lastText == null) return;
    const text = await readDocument();
    if (text == null || text === lastText) { seen = null; return; }
    if (text === seen) { seen = null; check({ text, auto: true }); } else seen = text;
  }, RECHECK_MS);

  // ---------- Badge ----------

  function render(r) {
    if (!isActive()) return;
    const done = r.state === 'done';
    const ai = done && r.score >= r.needed;
    const onClose = () => { userClosed = true; };
    const again = { label: 'Check again', onClick: () => check() };

    if (r.state === 'checking') {
      return Badge.render({ tone: 'busy', pill: 'Checking document…', title: 'Checking this document…',
        detail: 'Reading the text and running the detectors.', onClose });
    }
    if (!done) {
      return Badge.render({
        tone: 'info', pill: r.state === 'short' ? 'Too short to check' : 'Couldn’t check',
        title: r.state === 'short' ? 'Too short to check' : 'Couldn’t check this document',
        detail: r.state === 'short' ? `It has ${r.words} words; at least ${MIN_WORDS} are needed.` : r.message,
        actions: [again], onClose
      });
    }

    // "Wrong result?" asks what it really is, then saves a report with the score and text.
    const wrong = {
      label: 'Wrong result?', kind: 'quiet', onClick: () => {
        const row = Badge.el('div', 'actions',
          Badge.el('span', null, 'Is it actually…'),
          Badge.button('act primary', ai ? 'Written by a person' : 'Written by AI', async () => {
            await window.AIBReports.report({ verdict: ai ? 'not-ai' : 'is-ai', kind: 'docs', score: r.score, reasons: r.reasons, text: r.text });
            Badge.render({ ...state, actions: Badge.el('div', 'actions', Badge.el('span', 'note', 'Thanks! Saved. Download reports from the popup.')) });
          }),
          Badge.button('act quiet', 'Cancel', () => Badge.render(state)));
        Badge.render({ ...state, actions: row });
      }
    };
    const n = r.flagged.length;
    // Medical writing needs 0.99 (text-detector.js). Above the usual threshold but below that, say
    // so rather than "no signs".
    const medicalBelow = !ai && r.score >= settings.threshold && r.needed > settings.threshold;
    const state = {
      tone: ai ? 'ai' : medicalBelow ? 'info' : 'clear',
      pill: ai ? 'Likely AI-written' : medicalBelow ? 'Possibly AI-written' : 'No signs of AI', pct: r.score,
      title: ai ? 'This document looks AI-written' : medicalBelow ? 'Possibly AI-written' : 'No strong signs of AI writing',
      detail: [medicalBelow ? 'Medical writing often reads like AI, so it’s only flagged at 99%' : null,
        n ? `${n} of ${r.checked} paragraphs look AI-written` : null, ...r.reasons.slice(0, 2)].filter(Boolean).join(' · '),
      items: r.flagged.map(f => ({ score: f.score, text: f.text.length > 110 ? `${f.text.slice(0, 110)}…` : f.text })),
      actions: [again, wrong], onClose
    };
    Badge.render(state);
  }

  // Start last, so everything above is defined even if settings come back immediately.
  Promise.all([AIBLicense.load(), chrome.storage.sync.get(DEFAULTS)]).then(([stored, s]) => {
    access = AIBLicense.access(stored);
    settings = s;
    if (isActive()) check();
  });
})();
