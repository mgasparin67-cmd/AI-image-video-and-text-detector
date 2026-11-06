// Settings page: sites never to check, and your own words and channels for hiding YouTube
// videos about AI.

const LISTS = ['disabledSites', 'topicBlock', 'topicIgnore', 'allowChannels'];
const DEFAULTS = { disabledSites: [], topicBlock: [], topicIgnore: [], allowChannels: [] };
const $ = id => document.getElementById(id);

const toList = text => [...new Set(text.split('\n').map(s => s.trim()).filter(Boolean))];
// Sites are saved as host names ("https://www.example.com/page" -> "www.example.com").
const sitesIn = text => [...new Set(toList(text).map(AIBSites.normalize).filter(Boolean))];
const notSites = text => toList(text).filter(s => !AIBSites.normalize(s));
const current = () => Object.fromEntries(LISTS.map(id => [id, id === 'disabledSites' ? sitesIn($(id).value) : toList($(id).value)]));

init();

async function init() {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  for (const id of LISTS) {
    $(id).value = saved[id].join('\n');
    $(id).addEventListener('input', scheduleSave);
  }
  $('tryText').addEventListener('input', renderVerdict);
  renderVerdict();
}

let timer = null;
function scheduleSave() {
  renderVerdict();
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await chrome.storage.sync.set(current());
      const bad = notSites($('disabledSites').value);
      $('saved').textContent = bad.length
        ? `Saved. Not a site, so ignored: ${bad.join(', ')}`
        : 'Saved. Open tabs update on their own.';
    } catch (e) {
      $('saved').textContent = `Couldn’t save: ${e.message}`;
    }
  }, 400);
}

// Uses the same matching as the page script (hiding.js), with what's typed right now.
function renderVerdict() {
  const text = $('tryText').value.trim();
  const v = $('verdict');
  if (!text) { v.textContent = ''; delete v.dataset.ai; return; }
  window.AIBHide.configure(current());
  const ai = window.AIBHide.isAiTopic(text);
  v.dataset.ai = ai;
  v.replaceChildren(Object.assign(document.createElement('b'), { textContent: ai ? 'Would be hidden' : 'Would be shown' }),
    ai ? ' — it matches an AI term or one of your words.' : ' — no AI terms (after your “don’t count” list).');
}
