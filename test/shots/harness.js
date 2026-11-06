// Runs the real content scripts on a demo page, through a stand-in for chrome.* (as
// test/store-demo.html does), for the before/after store screenshots (store/capture-before-after.mjs).
// Query: ?plain leaves the extension out (the "before" side); ?remove picks Remove instead of Blur;
// ?host=www.youtube.com&path=/search makes hiding.js treat the page as that site; ?models=0 skips
// the models (pages with nothing for them to check).
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.has('plain')) { window.__ready = true; return; }
  const root = new URL('../..', location.href).href;
  if (q.get('host')) window.__aibTestHost = q.get('host');
  if (q.get('path')) window.__aibTestPath = q.get('path');
  const store = window.__store = {
    enabled: true, images: true, videos: true, text: true, threshold: 0.7, disabledSites: [],
    useModels: q.get('models') !== '0', removeFlagged: q.has('remove'), hideAiOverview: true, hideAiTopics: true
  };
  const local = {};
  const storageListeners = [];
  const messageListeners = [];
  const pick = d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k in local ? local[k] : v]));
  let modelListener = null;
  const runModel = job => new Promise(res => modelListener({ target: 'offscreen', ...job }, null, res));
  window.chrome = {
    storage: {
      sync: { get: (d, cb) => { const r = { ...d, ...store }; if (cb) cb(r); return Promise.resolve(r); } },
      local: {
        get: (d, cb) => { const r = pick(d); if (cb) cb(r); return Promise.resolve(r); },
        set: async patch => {
          Object.assign(local, patch);
          const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
          storageListeners.forEach(f => f(changes, 'local'));
        }
      },
      onChanged: { addListener: f => storageListeners.push(f) }
    },
    runtime: {
      getURL: p => root + p,
      getManifest: () => ({ version: 'demo' }),
      sendMessage: async msg => {
        if (msg.type === 'checkImage') return modelListener ? runModel({ type: 'imageUrl', url: msg.url }) : null;
        if (msg.type === 'checkText') return modelListener ? runModel({ type: 'text', text: msg.text }) : null;
        return null;
      },
      onMessage: { addListener: f => messageListeners.push(f) }
    }
  };
  if (store.useModels) {
    const s = Object.assign(document.createElement('script'), { src: root + 'metadata.js' });
    document.head.append(s);
    await new Promise(r => s.addEventListener('load', r, { once: true }));
    self.__aibModelsUrl = root + 'models/'; // over http://, load the models from this server
    await import(root + 'models.js');
    modelListener = messageListeners.shift(); // models.js registered first
  }
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: root + 'content.css' }));
  for (const src of ['license.js', 'sites.js', 'text-detector.js', 'reports.js', 'platform-labels.js', 'hiding.js', 'badge.js', 'content.js']) {
    document.body.append(Object.assign(document.createElement('script'), { src: root + src, async: false }));
  }
  window.__ready = true;
})();
