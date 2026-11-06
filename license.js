// License: who gets to use Sloply. Shared by the service worker, the popup, the welcome page
// and the page scripts. Only the license check talks to the server; detection never does.
//
// Everything works for 7 days from install, with no card and no account. After that Sloply stays
// off until a plan is bought on Stripe: monthly, or lifetime paid once.
//
// chrome.storage.local holds:
//   trialStart  when the trial started (ms). Also copied to chrome.storage.sync, see background.js
//   license     { key, plan, status, token, checkedAt } after a key was entered or bought
//   installId   a random ID for this browser, which the server counts against the license's limit
//
// A license only counts with a token: the server's signature over the key, this browser's installId
// and an expiry. The extension holds only the public key, so editing storage can't make one, and one
// can't be copied to another browser. load() works out license.valid from it; the stored value of
// valid is never trusted.

(() => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const TRIAL_DAYS = 7;
  const ENDING_DAYS = 2; // the trial reminder starts this many days before the end
  const REVIEW_AFTER = 20; // items flagged or hidden before asking for a review, once
  const REVIEW_MAX_SHOWN = 3; // popup openings it stays up for if it's never answered
  // Loaded unpacked, for testing: everything works with no plan. store/build-store-zip.sh replaces
  // the unpacked line below, so this isn't in what the store gets. To test the paywall on an unpacked
  // copy, run chrome.storage.local.set({ devPaywall: true }) in the service worker's console.
  const manifest = () => globalThis.chrome?.runtime?.getManifest?.();
  const unpacked = () => !!manifest() && !manifest().update_url;

  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  const self = {
    TRIAL_DAYS,
    // Verifies the server's license tokens; the private half is a secret on the server only. Set by
    // store/make-license-key.mjs.
    PUBLIC_KEY: {"kty":"EC","crv":"P-256","x":"MAWoWPfl5gFBPVUwkqjsR5tg6WI61-H57TNLUJaKsjM","y":"7h1HrPsd6HXaO0OrQLSv5eJKRmOIy5fED5YLFdd-0Mw"},
    REVIEW_AFTER,
    REVIEWS_URL: 'https://chromewebstore.google.com/detail/slopless/imemjjpgjcmkbcpoglmpieekihphjidk/reviews',
    SITE: 'https://sloply.app',
    API: 'https://ykswafstzcusxjevemez.supabase.co/functions/v1',
    // Public by design: the Supabase "anon" key, same as on the website. It can only call the
    // license functions; the licenses table blocks it from reading anything.
    ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlrc3dhZnN0emN1c3hqZXZlbWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMzI2MjAsImV4cCI6MjEwODgwODYyMH0.ulCFEWuaXs3keZGrt78-XSR5YW3dcq7xeF2iNeFX5Wk',
    KEY_PATTERN: /^ABK-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/,

    // { ok, mode, daysLeft }
    //   dev       loaded unpacked, no plan needed
    //   licensed  paid monthly plan or lifetime
    //   trial     in the free trial. No trialStart yet (the install event hasn't run) is day one
    //   expired   the trial is over and nothing was bought
    //   ended     the trial is over and a plan was canceled or refunded
    //   limit     the trial is over and the license is in use on too many other browsers
    access({ license, devPaywall, trialStart } = {}, now = Date.now()) {
      if (unpacked() && !devPaywall) return { ok: true, mode: 'dev', daysLeft: 0 };
      if (license?.valid) return { ok: true, mode: 'licensed', daysLeft: 0 };
      const left = (trialStart ?? now) + TRIAL_DAYS * DAY - now;
      if (left > 0) return { ok: true, mode: 'trial', daysLeft: Math.ceil(left / DAY) };
      return { ok: false, mode: license?.status === 'device_limit' ? 'limit' : license?.key ? 'ended' : 'expired', daysLeft: 0 };
    },

    // Whether a token is the server's, for this key and this browser, and not expired. Any failure
    // counts as no.
    async verifyToken(token, key, installId, now = Date.now()) {
      try {
        if (!self.PUBLIC_KEY || !token || !key || !installId) return false;
        const [payload, signature] = token.split('.');
        const publicKey = await crypto.subtle.importKey('jwk', self.PUBLIC_KEY, ECDSA, false, ['verify']);
        const good = await crypto.subtle.verify(ECDSA, publicKey, b64urlBytes(signature), new TextEncoder().encode(payload));
        if (!good) return false;
        const { k, i, exp } = JSON.parse(new TextDecoder().decode(b64urlBytes(payload)));
        return k === key && i === installId && exp > now;
      } catch {
        return false;
      }
    },

    // Page scripts on http:// pages have no crypto.subtle, so the service worker checks for them.
    tokenGood: (license, installId) => globalThis.crypto?.subtle
      ? self.verifyToken(license.token, license.key, installId)
      : chrome.runtime.sendMessage({ type: 'verifyToken', license, installId }).then(Boolean, () => false),

    async load() {
      const stored = await chrome.storage.local.get(['license', 'devPaywall', 'trialStart', 'installId']);
      if (!stored.license) return stored;
      return { ...stored, license: { ...stored.license, valid: await self.tokenGood(stored.license, stored.installId) } };
    },

    endingSoon: a => a.mode === 'trial' && a.daysLeft <= ENDING_DAYS,

    // Ask for a review only from people it's working for, and never again once answered.
    reviewDue: (a, total, { done = false, shown = 0 } = {}) =>
      (a.mode === 'trial' || a.mode === 'licensed') && total >= REVIEW_AFTER && !done && shown < REVIEW_MAX_SHOWN,

    // Re-check a stored key every hour (and whenever the popup opens), so a plan that ended or a
    // refund stops working soon after.
    isStale: license => !!license?.key && Date.now() - (license.checkedAt || 0) > HOUR,

    call(fn, body) {
      return fetch(`${self.API}/${fn}`, {
        method: body ? 'POST' : 'GET',
        headers: { apikey: self.ANON_KEY, Authorization: `Bearer ${self.ANON_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    }
  };

  globalThis.AIBLicense = self;
})();
