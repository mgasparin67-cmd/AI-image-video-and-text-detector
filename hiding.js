// Optional hiding (popup switches):
//   - AI answers in search: Google's and Bing's "AI Overview", DuckDuckGo's "Search Assist", and
//     the tabs and buttons that open their AI chat modes (Google and Bing "AI Mode", DuckDuckGo
//     "Search Assist" and "Duck.ai").
//   - YouTube videos whose title or description is about AI: on the home page, search, the
//     sidebar, Shorts shelves and playlists, plus a warning over the player when one is opened
//     directly. Most lists don't show descriptions, so each video's is fetched from YouTube once.
// These sites change their markup often, so this goes by visible text where it can (Bing draws its
// "AI Overview" title without text, so there it goes by its answer container). English only.

(function (root) {
  const host = () => root.__aibTestHost || location.hostname;
  const path = () => root.__aibTestPath || location.pathname;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  // ---------- AI answers in search ----------

  const SEARCH_ENGINES = [
    { name: 'Google', host: /(^|\.)google\.[a-z.]+$/, path: /^\/search$/, label: /^ai overviews?$/i },
    { name: 'Bing', host: /(^|\.)bing\.com$/, path: /^\/search$/, container: '#copans_container' },
    { name: 'DuckDuckGo', host: /(^|\.)duckduckgo\.com$/, path: /^\/$/, label: /^search assist$/i }
  ];
  // Links, tabs and buttons that open an AI chat mode instead of results.
  const AI_MODE_LABEL = /^(ai mode|search assist|duck\.ai)$/i;
  // Containers that hold more than the AI answer: stop climbing before reaching them.
  // Bing's #b_topw is a list of top answers that can hold others besides the AI one.
  const RESULTS_STOP = '#rso, #center_col, #rcnt, #search, #b_results, #b_topw, [data-testid="mainline"], [role="main"], main, body';
  // A label inside one of these is a tab or button, not the AI answer's heading (DuckDuckGo has a
  // "Search Assist" button in a toolbar next to the search settings).
  const CONTROLS = 'a, button, [role="button"], [role="link"], [role="tab"], nav, header, [role="navigation"]';
  // A normal search result: its title is a heading inside a link (Google) or a link inside a
  // heading (Bing, DuckDuckGo).
  const RESULT_TITLE = 'a h2, a h3, h2 a, h3 a, a [role="heading"][aria-level="3"]';

  const searchEngine = () => SEARCH_ENGINES.find(e => e.host.test(host()) && e.path.test(path())) || null;
  const isSearchPage = () => !!searchEngine();

  // Whether el holds a search result that isn't inside the block.
  const hasOtherResult = (el, block) => [...el.querySelectorAll(RESULT_TITLE)].some(t => !block.contains(t));

  // From the AI answer's heading, the biggest block around it that doesn't also hold the ordinary
  // results. Layouts differ (Google's signed-in and signed-out pages, for one), so stop at the
  // first container that also holds a real result. With a label, also stop once the block no
  // longer starts with it: Google answers "People also ask" questions with an AI Overview too,
  // and that stops at the answer, leaving the question and the rest of the box.
  function answerBlock(start, label) {
    const results = document.querySelector('#rso');
    const startsWithLabel = el => !label || label.test(norm(el.innerText).slice(0, norm(start.textContent).length));
    let block = start;
    while (block.parentElement) {
      const parent = block.parentElement;
      if (parent.matches(RESULTS_STOP) || (results && parent.contains(results)) || hasOtherResult(parent, block)) break;
      if (!startsWithLabel(parent)) break;
      block = parent;
    }
    return block;
  }

  // The AI answer boxes under rootEl.
  function findAiOverviews(rootEl) {
    const engine = searchEngine();
    if (!engine || !rootEl?.querySelectorAll) return [];
    const starts = engine.container
      ? [...rootEl.querySelectorAll(engine.container)]
      : [...rootEl.querySelectorAll('h1, h2, h3, [role="heading"], div, span')].filter(el =>
          el.childElementCount <= 2 && !el.closest(CONTROLS) && engine.label.test(norm(el.textContent)));
    const found = new Set();
    for (const el of starts) {
      if (el.closest('[data-aib-hidden]')) continue;
      if (engine.label && !el.getClientRects().length) continue; // collapsed: check it when it opens
      const block = answerBlock(el, engine.label);
      // Never hide something that holds results, whatever the layout.
      if (block === el || block.querySelector('#rso') || block.querySelectorAll(RESULT_TITLE).length > 0) continue;
      found.add(block);
    }
    return [...found];
  }

  // Tabs and buttons that open an AI chat mode. Each is hidden as its own small item (its tab or
  // button), never anything bigger, so a whole toolbar can't disappear.
  function findAiModeLinks(rootEl) {
    if (!isSearchPage() || !rootEl?.querySelectorAll) return [];
    const found = new Set();
    for (const el of rootEl.querySelectorAll('a, button, [role="link"], [role="tab"], [role="listitem"], li, div, span')) {
      if (el.childElementCount > 3 || el.closest('[data-aib-hidden]')) continue;
      if (!AI_MODE_LABEL.test(norm(el.textContent)) && !AI_MODE_LABEL.test(norm(el.getAttribute('aria-label')))) continue;
      const target = el.closest('[role="listitem"], li') || el.closest('a, button, [role="link"], [role="tab"]') || el;
      const r = target.getBoundingClientRect();
      if (r.width > 300 || r.height > 80) continue;
      if (![...found].some(f => f.contains(target))) found.add(target);
    }
    return [...found].filter(t => ![...found].some(o => o !== t && o.contains(t)));
  }

  // ---------- AI review summaries on shopping sites ----------

  const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/;
  const AMAZON_AI_NOTE = /^(ai )?generated from the text of customer reviews$/i;
  const AMAZON_SUMMARY_TITLE = /^customers say$/i;
  const isShoppingSite = () => AMAZON_HOST.test(host());

  // Amazon marks its summary as AI-written in plain text. From that note, the smallest block that
  // also holds the summary's "Customers say" title. Real reviews are never inside it.
  function findShoppingSummaries(rootEl) {
    if (!isShoppingSite() || !rootEl?.querySelectorAll) return [];
    const found = new Set();
    for (const note of rootEl.querySelectorAll('div, span, p')) {
      if (note.childElementCount > 2 || !AMAZON_AI_NOTE.test(norm(note.textContent)) || note.closest('[data-aib-hidden]')) continue;
      let block = note.parentElement;
      for (let up = 0; block && block !== document.body && up < 8; up++, block = block.parentElement) {
        const hasTitle = [...block.querySelectorAll('h2, h3, h4, [role="heading"]')].some(h => AMAZON_SUMMARY_TITLE.test(norm(h.textContent)));
        if (hasTitle) break;
      }
      if (block && block !== document.body && block.querySelector('h2, h3, h4, [role="heading"]') && !block.querySelector('[data-hook="review"]')) found.add(block);
    }
    return [...found];
  }

  // Amazon's Rufus assistant: its small buttons, matched on their whole label, and its panel.
  const RUFUS_BUTTON = /^(rufus|ask rufus|open rufus panel|ask rufus about selected text)$/i;
  const RUFUS_PANEL = '#nav-flyout-rufus';

  function findRufus(rootEl) {
    if (!isShoppingSite() || !rootEl?.querySelectorAll) return [];
    const found = new Set(rootEl.querySelectorAll(RUFUS_PANEL));
    for (const el of rootEl.querySelectorAll('button, [role="button"]')) {
      if (el.closest('[data-aib-hidden]') || el.closest(RUFUS_PANEL)) continue;
      if (!RUFUS_BUTTON.test(norm(el.getAttribute('aria-label') || el.textContent))) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 300 && r.height <= 80) found.add(el);
    }
    return [...found].filter(el => !el.dataset.aibHidden);
  }

  // ---------- Gmail's AI buttons ----------

  const GMAIL_HOST = /^mail\.google\.com$/;
  const GMAIL_AI_BUTTON = /^((try|ask) gemini|help me write|summari[sz]e this email)$/i;
  const GMAIL_MESSAGE = '.a3s, [contenteditable="true"]'; // an email's own content, or a draft
  const isGmail = () => GMAIL_HOST.test(host());
  // Labels can end in a keyboard shortcut: "Help me write (⌥ H)".
  const withoutShortcut = label => norm(label.replace(/[\u202a-\u202e]/g, '')).replace(/\s*\([^()]*\)$/, '');

  // Only Gmail's own small buttons, matched on their whole label. Nothing inside an email or a
  // draft counts, so a message can't get something hidden by naming a button that way.
  function findGmailAiButtons(rootEl) {
    if (!isGmail() || !rootEl?.querySelectorAll) return [];
    const found = new Set();
    for (const el of rootEl.querySelectorAll('button, [role="button"], [aria-label], [data-tooltip]')) {
      if (el.closest('[data-aib-hidden]') || el.closest(GMAIL_MESSAGE)) continue;
      const label = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.textContent;
      if (!GMAIL_AI_BUTTON.test(withoutShortcut(label))) continue;
      const button = el.closest('button, [role="button"]') || el;
      const r = button.getBoundingClientRect();
      if (r.width <= 300 && r.height <= 80) found.add(button);
    }
    return [...found];
  }

  // ---------- YouTube videos about AI ----------

  const YOUTUBE_HOST = /(^|\.)youtube\.com$/;
  const AI_TOPIC = [
    // Case-sensitive, so "ai" in other languages ("Ai no uta", "vai ai") doesn't count.
    /\b(AI|AGI|LLMs?|GPTs?)\b|\bA\.I\./,
    /\b(artificial intelligence|machine learning|deep learning|neural networks?|large language models?|deepfakes?|prompt engineering|vibe coding)\b/i,
    /\b(chat ?gpt|gpt-?[3-9](\.\d)?o?|openai|anthropic|claude (ai|code|opus|sonnet|haiku|[3-9])|google gemini|gemini (ai|pro|ultra|flash|nano|[1-9])|midjourney|stable diffusion|dall-?e|openai sora|sora (ai|2)|deepseek|perplexity ai|(github|microsoft) copilot|grok ?[1-9]|xai|sam altman|nano banana)\b/i,
    /\bai[- ](art|artists?|videos?|images?|music|songs?|covers?|generated|tools?|agents?|models?|news|apps?|voices?|girlfriend|chatbots?|startups?)\b/i,
    /#ai\b/i
  ];
  const YOUTUBE_ITEMS = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer',
    'ytd-reel-item-renderer', 'ytd-playlist-video-renderer', 'ytd-playlist-panel-video-renderer',
    'yt-lockup-view-model', 'ytm-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model-v2'
  ].join(', ');
  const ITEM_TITLE = '#video-title, #video-title-link, h3, a[title]';
  // The description excerpt that search results show.
  const ITEM_SNIPPET = '.metadata-snippet-text, #description-text, .yt-lockup-metadata-view-model-wiz__description';
  const ITEM_LINK = 'a[href*="/watch?v="], a[href*="/shorts/"]';
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/"], ytd-channel-name a';

  const isYouTube = () => YOUTUBE_HOST.test(host());

  // ---------- Your own words and channels (options page) ----------
  // block: extra words that count as AI. ignore: words that never count (e.g. a product name).
  // allowChannels: channels never hidden, by name or @handle.

  let custom = { block: null, ignore: null, channels: new Set() };
  const escape = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole words or phrases only, so "AI" in a custom list doesn't match "said".
  const wordsRegex = (words, flags) => {
    const list = (words || []).map(w => w.trim()).filter(Boolean).map(escape);
    return list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${list.join('|')})(?![\\p{L}\\p{N}])`, flags) : null;
  };
  const channelKey = c => norm(c).toLowerCase().replace(/^@/, '');

  function configure({ topicBlock = [], topicIgnore = [], allowChannels = [] } = {}) {
    custom = {
      block: wordsRegex(topicBlock, 'iu'),
      ignore: wordsRegex(topicIgnore, 'giu'),
      channels: new Set(allowChannels.map(channelKey).filter(Boolean))
    };
  }

  function isAiTopic(text) {
    let t = text || '';
    if (custom.ignore) t = t.replace(custom.ignore, ' ');
    return AI_TOPIC.some(re => re.test(t)) || !!custom.block?.test(t);
  }

  const isAllowedChannel = names => names.some(n => n && custom.channels.has(channelKey(n)));

  const videoIdFrom = href => (href || '').match(/(?:[?&]v=|\/shorts\/)([\w-]{11})/)?.[1] || null;

  // A video's channel, as the names it may go by: its display name and its @handle.
  function channelNames(el) {
    const a = el?.querySelector(CHANNEL_LINK);
    if (!a) return [];
    const handle = (a.getAttribute('href') || '').match(/^\/(@[^/?#]+)/)?.[1];
    return [norm(a.textContent), handle && decodeURIComponent(handle)].filter(Boolean);
  }

  // Every video in the page's lists: [{ el, id, title, snippet, channels }]. Only the outermost
  // element of each video, so hiding it leaves no empty frame behind.
  function youtubeItems() {
    if (!isYouTube()) return [];
    const items = [];
    for (const el of document.querySelectorAll(YOUTUBE_ITEMS)) {
      if (el.parentElement?.closest(YOUTUBE_ITEMS)) continue;
      const t = el.querySelector(ITEM_TITLE);
      const title = norm([t?.textContent, t?.getAttribute('title')].filter(Boolean).join(' '));
      if (!title) continue;
      const snippet = norm(el.querySelector(ITEM_SNIPPET)?.textContent);
      items.push({ el, title, snippet, channels: channelNames(el), id: videoIdFrom(el.querySelector(ITEM_LINK)?.getAttribute('href')) });
    }
    return items;
  }

  // ---------- Video descriptions ----------
  // YouTube's own player endpoint returns a video's details, description included, in about
  // 15 KB (the watch page is 2 MB). Sent without cookies, so it isn't tied to the account and
  // doesn't touch watch history. A few at a time; each video once per page session.

  const MAX_FETCHES = 4;
  const info = new Map(); // videoId -> { text, author }, or null if it couldn't be fetched
  const queue = [];
  let running = 0;
  let clientVersion = null;

  // The web client version YouTube's endpoints expect, read from the page's own config.
  function youtubeClientVersion() {
    if (clientVersion) return clientVersion;
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
      if (m) return (clientVersion = m[1]);
    }
    return '2.20261023.01.00';
  }

  // The description's own text: lines with links are dropped (sponsor lists, gear links,
  // "my other channels"), since "AI Writing App → https://…" in a sponsor list doesn't make a
  // time-management video about AI. So is AMD's "Ryzen AI" chip name in laptop specs.
  const descriptionText = d => d.split('\n')
    .filter(line => !/https?:\/\/|www\.|\.(com|io|ly|gg)\//i.test(line))
    .join('\n')
    .replace(/\bRyzen AI\b/g, 'Ryzen');

  async function fetchDescription(id) {
    const r = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: 'WEB', clientVersion: youtubeClientVersion(), hl: 'en' } } })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()).videoDetails || {};
    return { text: descriptionText(d.shortDescription || ''), author: d.author || '' };
  }

  function pump() {
    while (running < MAX_FETCHES && queue.length) {
      const id = queue.shift();
      running++;
      fetchDescription(id)
        .then(details => info.set(id, details))
        .catch(() => info.set(id, null)) // unknown: leave the video alone
        .finally(() => { running--; pump(); });
    }
  }

  // A video's description and channel: { text, author }, null if unavailable, or undefined
  // while it's being fetched (the caller asks again on its next pass).
  function videoInfo(id) {
    if (!id) return null;
    if (info.has(id)) return info.get(id);
    if (!queue.includes(id)) { queue.push(id); pump(); }
    return undefined;
  }

  function descriptionIsAi(id) {
    const v = videoInfo(id);
    return v === undefined ? undefined : !!v && isAiTopic(v.text);
  }

  // Whether to hide a video: true / false, or undefined while its description is being fetched.
  // Allowed channels always win; then the title, the excerpt search shows, and the description.
  function aboutAi({ id, title, snippet = '', channels = [] }) {
    if (isAllowedChannel(channels)) return false;
    const fromText = isAiTopic(title) || isAiTopic(descriptionText(snippet));
    const v = videoInfo(id);
    if (v && isAllowedChannel([v.author])) return false;
    if (fromText) return channels.length || !id ? true : v === undefined ? undefined : true; // wait for the channel name
    return v === undefined ? undefined : !!v && isAiTopic(v.text);
  }

  // Title of the video in the player on a watch or Shorts page.
  function youtubeCurrentTitle() {
    const h = document.querySelector('ytd-watch-metadata h1, ytd-reel-video-renderer[is-active] h2, yt-shorts-video-title-view-model');
    return norm(h?.textContent) || norm(document.title.replace(/ - YouTube$/, ''));
  }

  // Channel of the video in the player.
  const youtubeCurrentChannels = () => channelNames(document.querySelector('ytd-watch-metadata #owner, ytd-reel-video-renderer[is-active] .metadata-container, ytd-reel-player-overlay-renderer'));

  root.AIBHide = {
    isSearchPage, findAiOverviews, findAiModeLinks, isShoppingSite, findShoppingSummaries, findRufus, isGmail, findGmailAiButtons, isYouTube, configure, isAiTopic, aboutAi, youtubeItems,
    youtubeCurrentTitle, youtubeCurrentChannels, descriptionIsAi, descriptionText
  };
})(window);
