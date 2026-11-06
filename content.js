// Finds images, videos and text on the page, asks the detectors about them, and blurs
// anything likely to be AI-generated behind a warning with a "View anyway" button.

(() => {
  const DEFAULTS = { enabled: true, images: true, videos: true, text: true, threshold: 0.7, disabledSites: [], useModels: true, platformLabels: true, hideAiOverview: true, hideAiTopics: false,
    topicBlock: [], topicIgnore: [], allowChannels: [], removeFlagged: false };
  const MIN_IMG_PX = 120;
  const MIN_VIDEO_PX = 200;
  const MIN_TEXT_CHARS = 280;
  const TEXT_SELECTOR =
    'p, blockquote, li, div:not(:has(div, p, ul, ol, li, table, section, article, pre, blockquote, h1, h2, h3, h4))';

  // Video sampling: like Hive, blur when two frames in a row both score high. One odd frame
  // can't trigger it, but an AI clip partway through a real video still gets caught.
  // Frames are taken quickly at first, then more slowly for the rest of a long video.
  const FAST_FRAME_MS = 2500;
  const FAST_FRAMES = 6;
  const SLOW_FRAME_MS = 10000;
  const MAX_FRAMES = 36; // about 5 minutes of playback

  // Image URLs from AI generator hosts.
  const AI_HOSTS = /(oaidalleapiprodscus|dalle|cdn\.midjourney\.com|replicate\.delivery|image\.civitai\.com|cdn\.leonardo\.ai|ideogram\.ai|lexica\.art|images\.nightcafe|pollinations\.ai|gencraft|playgroundai|stablediffusionweb)/i;
  // Captions, alt text, etc. that say the image or video is AI.
  const AI_LABELS = /\b(ai[- ]generated|generated (with|by|using) (ai|midjourney|dall-?e|stable diffusion|firefly|chatgpt|gemini|sora|veo|runway|kling)|made with ai|midjourney|dall[-·]?e|stable diffusion|#aiart|#aivideo|ai art|ai video|created with ai|imagined with ai|made with (sora|veo|runway|kling|pika))\b/i;

  // YouTube thumbnails (wherever they're shown) skip the image model: they're designed images
  // (bold text, logos, cut-outs), and it flagged 9 of 143 real, pre-AI ones (6%). YouTube's own AI
  // labels, hiding videos about AI, and checking the player's frames still apply.
  // See evaluation/results/youtube_thumbs_prereg.txt.
  const YOUTUBE_THUMBNAIL = /^https:\/\/i\d?\.ytimg\.com\/(vi|vi_webp|an_webp)\//;

  const Reports = window.AIBReports; // reports.js
  const USER_MARKED = { score: 1, reasons: ['You reported this as AI'] };

  let settings = { ...DEFAULTS };
  let mutationObserver = null;
  let viewObserver = null;
  let resizeObserver = null;
  const overlays = new Set();
  const removed = new Set(); // flagged items taken off the page ("Remove" instead of "Blur")
  const videos = new Set();
  const stats = { checked: 0, waiting: 0 }; // images, shown in the popup

  let access = { ok: false }; // a running trial or plan (license.js); checked before starting
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') chrome.storage.sync.get(DEFAULTS, s => { settings = s; restart(); });
    // The license is re-checked hourly: only start over if that changed anything.
    if (area === 'local' && (changes.license || changes.trialStart)) {
      const was = access.ok;
      loadAccess().then(() => { if (access.ok !== was) restart(); });
    }
  });
  const loadAccess = () => AIBLicense.load().then(s => { access = AIBLicense.access(s); });
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'stats') sendResponse({ flagged: overlays.size + removed.size + textFindings.size, ...stats });
    if (msg?.type === 'reportAsAi') markAsAi(msg);
  });

  function isActive() {
    return access.ok && settings.enabled && !window.AIBSites.isListed(location.hostname, settings.disabledSites);
  }

  function restart() {
    teardown();
    if (isActive()) start();
  }

  function start() {
    Hide.configure(settings); // your own words and allowed channels
    viewObserver = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          viewObserver.unobserve(e.target);
          if (e.target.tagName === 'IMG') checkImage(e.target);
          else if (e.target.tagName === 'VIDEO') checkVideo(e.target);
          else checkTextWithModel(e.target);
        }
      }
    }, { rootMargin: '400px' });

    resizeObserver = new ResizeObserver(entries => {
      for (const e of entries) e.target.__aibOverlay?.place();
    });

    scan(document.body);

    let pending = [];
    let timer = null;
    mutationObserver = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          // Lazy loaders swap src after the fact: check the image again.
          const img = m.target;
          if (img.tagName === 'IMG' && img.dataset.aib && !img.dataset.aibFlag) { delete img.dataset.aib; pending.push(img); }
        } else {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && !n.hasAttribute('data-aib-ui')) pending.push(n);
          }
        }
      }
      clearTimeout(timer);
      timer = setTimeout(() => { const nodes = pending; pending = []; nodes.forEach(scan); scheduleArticles(); }, 250);
    });
    mutationObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset']
    });
    window.addEventListener('resize', placeAll);
    scheduleArticles();

    // Search engines' AI answers stream in, and YouTube reuses its video elements for new videos,
    // so check those two sites every second.
    if (Hide.isSearchPage() || Hide.isShoppingSite() || Hide.isGmail() || Hide.isYouTube()) {
      sweepHiding();
      hideSweep = setInterval(() => { if (!document.hidden) sweepHiding(); }, HIDE_SWEEP_MS);
    }

    // Platform labels often render after the post itself (or change text in place), which the
    // mutation observer can miss, so sweep again every few seconds on those sites.
    if (settings.platformLabels && window.AIBPlatform.platform()) {
      labelSweep = setInterval(() => { if (!document.hidden) checkPlatformLabels(document.body); }, LABEL_SWEEP_MS);
    }
  }

  function teardown() {
    mutationObserver?.disconnect();
    viewObserver?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', placeAll);
    clearInterval(labelSweep);
    clearInterval(hideSweep);
    clearTimeout(articleTimer);
    lastYouTubeId = null;
    articlesChecked = 0;
    document.querySelectorAll('[data-aib-hidden]').forEach(unhide);
    document.querySelectorAll('[data-aib-article]').forEach(el => delete el.dataset.aibArticle);
    for (const v of videos) stopSampling(v);
    videos.clear();
    for (const ov of overlays) ov.remove();
    overlays.clear();
    holdPreviews(false);
    for (const el of removed) el.__aibUnflag?.();
    removed.clear();
    for (const el of [...textFindings.keys()]) el.__aibUnflag?.();
    textFindings.clear();
    clearTimeout(badgeTimer);
    Badge.remove();
    badgeClosed = false;
    document.querySelectorAll('[data-aib]').forEach(el => {
      el.classList.remove('aib-media-blur');
      delete el.dataset.aib;
      delete el.dataset.aibFlag;
      delete el.dataset.aibForId;
      delete el.dataset.aibTopic;
      delete el.__aibOverlay;
      el.__aibUnflag?.();
    });
    document.querySelectorAll('[data-aib-topic-id]').forEach(el => delete el.dataset.aibTopicId);
  }

  function placeAll() {
    for (const ov of overlays) ov.place();
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 || !root.isConnected) return;
    const queue = (tag, enabled) => {
      if (!enabled) return;
      const els = root.tagName === tag ? [root] : root.querySelectorAll(tag);
      for (const el of els) {
        if (el.dataset.aib) continue;
        el.dataset.aib = 'queued';
        viewObserver.observe(el);
      }
    };
    queue('IMG', settings.images);
    queue('VIDEO', settings.videos);
    if (settings.platformLabels) checkPlatformLabels(root);
    if (settings.text && location.hostname !== 'docs.google.com') { // Docs: google-docs.js
      const blocks = root.matches(TEXT_SELECTOR) ? [root, ...root.querySelectorAll(TEXT_SELECTOR)] : root.querySelectorAll(TEXT_SELECTOR);
      for (const el of blocks) checkText(el);
    }
  }

  async function ask(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res?.modelError) modelsDown();
      return res;
    } catch {
      return null; // extension was reloaded or the worker is unavailable
    }
  }

  // The detection models couldn't load (a failed or stalled download, usually). Say so, rather
  // than quietly treating everything as "not AI": once per page, and at most every 10 minutes
  // across tabs. The popup shows the details and "Try again".
  const MODELS_DOWN_EVERY_MS = 10 * 60 * 1000;
  let modelsDownShown = false;
  async function modelsDown() {
    if (modelsDownShown || !isActive()) return;
    modelsDownShown = true;
    const { modelsDownNoticeAt = 0 } = await chrome.storage.local.get({ modelsDownNoticeAt: 0 });
    if (Date.now() - modelsDownNoticeAt < MODELS_DOWN_EVERY_MS) return;
    await chrome.storage.local.set({ modelsDownNoticeAt: Date.now() });
    Reports.toast('Sloply couldn’t load its detection models, so pictures and text are only getting basic checks. Open Sloply to try again.', { duration: 10000 });
  }

  const better = (a, b) => (b && b.score > (a?.score ?? 0) ? b : a);

  // ---------- Text ----------

  function checkText(el) {
    if (el.dataset.aib) return;
    if (el.isContentEditable || el.closest('[data-aib-flag], [data-aib-ui], pre, code, textarea, nav, header, footer')) return;
    const text = el.textContent;
    if (text.length < MIN_TEXT_CHARS) return; // may grow later, so don't mark it done
    el.dataset.aib = 'done';
    if (el.querySelector('[data-aib-flag]')) return;

    el.__aibKey = Reports.keyForText(text);
    if (Reports.isNotAi(el.__aibKey)) return;
    if (Reports.isMarkedAi(el.__aibKey)) return flagText(el, USER_MARKED);

    const r = window.AIBText.score(text);
    if (r.score >= settings.threshold && r.score >= window.AIBText.threshold(el.innerText || text, settings.threshold)) { // stricter for medical text, abstracts, poems (innerText keeps a poem's lines)
      flagText(el, r);
    } else if (settings.useModels) {
      // Run the language model once the paragraph is near the screen.
      el.__aibLocal = r;
      viewObserver.observe(el);
    }
  }

  async function checkTextWithModel(el) {
    if (!el.isConnected || el.closest('[data-aib-flag]')) return;
    const res = await ask({ type: 'checkText', text: window.AIBText.normalize(el.textContent).replace(/\s+/g, ' ').trim().slice(0, 4000) });
    const result = better(el.__aibLocal, res);
    if (isActive() && settings.text && result && result.score >= window.AIBText.threshold(el.innerText || el.textContent, settings.threshold) && el.isConnected && !el.closest('[data-aib-flag]')) {
      flagText(el, result);
    }
  }

  // Flagged text isn't blurred: a badge in the corner of the page (badge.js) says how likely it
  // is AI-written and lists the passages. With "Remove" picked, it's taken off the page instead.
  function flagText(el, r, kind = 'text') {
    if (settings.removeFlagged) return removeFlagged(el);
    tally('text');
    el.dataset.aibFlag = '1';
    textFindings.set(el, { kind, r });
    el.__aibUnflag = () => {
      textFindings.delete(el);
      delete el.dataset.aibFlag;
      delete el.__aibUnflag;
      renderBadge();
    };
    renderBadge();
  }

  // ---------- Counts for the weekly summary (activity.js, summary.html) ----------
  // Only how many of each kind, per site and day: no addresses or text. Sent to the background
  // worker, which keeps them for 8 weeks on this computer.

  let tallies = {};
  let tallyTimer = null;
  function tally(kind) {
    tallies[kind] = (tallies[kind] || 0) + 1;
    clearTimeout(tallyTimer);
    tallyTimer = setTimeout(() => {
      const counts = tallies;
      tallies = {};
      ask({ type: 'activity', site: location.hostname, counts });
    }, 2000);
  }

  // ---------- The badge for AI text ----------

  const Badge = window.AIBBadge;
  const textFindings = new Map(); // element -> { kind: 'text' | 'article', r }
  let badgeTimer = null;
  let badgeClosed = false; // closed with ×: stays closed on this page

  function renderBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(drawBadge, 120); // paragraphs are often flagged in quick succession
  }

  const inPageOrder = (a, b) => (a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const excerpt = text => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 110 ? `${t.slice(0, 110)}…` : t; };

  function drawBadge() {
    const found = [...textFindings].filter(([el]) => el.isConnected).sort(inPageOrder);
    if (!found.length || !isActive() || badgeClosed) return Badge.remove();
    const articles = found.filter(([, f]) => f.kind === 'article');
    const lead = [...(articles.length ? articles : found)].sort((a, b) => b[1].r.score - a[1].r.score)[0][1];
    const title = articles.length === 1 ? 'This article looks AI-written'
      : articles.length > 1 ? `${articles.length} articles on this page look AI-written`
      : `${found.length} ${found.length === 1 ? 'passage on this page looks' : 'passages on this page look'} AI-written`;
    Badge.render({
      tone: 'ai', pill: 'Likely AI-written', pct: lead.r.score, title,
      detail: (lead.r.reasons || []).slice(0, 2).join(' · '),
      items: found.map(([el, f]) => ({
        score: f.r.score,
        text: f.kind === 'article' ? `Article: ${excerpt(el.querySelector('p')?.textContent || el.textContent)}` : excerpt(el.textContent),
        onGo: () => spotlight(el),
        onNotAi: () => markNotAi(el, f.kind, f.r)
      })),
      onClose: () => { badgeClosed = true; }
    });
  }

  // Scroll to a flagged passage and outline it briefly.
  function spotlight(el) {
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    el.classList.remove('aib-spot');
    void el.offsetWidth; // restart the outline animation
    el.classList.add('aib-spot');
    setTimeout(() => el.classList.remove('aib-spot'), 2000);
  }

  // ---------- Mistake reports ----------

  // "Not AI": un-blur it for good and save a report.
  function markNotAi(el, kind, r) {
    const isText = kind === 'text' || kind === 'article';
    Reports.report({
      verdict: 'not-ai', kind, key: el.__aibKey, score: r.score, reasons: r.reasons,
      text: isText ? el.textContent : '',
      mediaUrl: isText ? '' : (el.currentSrc || el.src || '')
    });
    el.__aibUnflag?.();
    Reports.toast('Thanks for the report. It won’t be blurred again.');
  }

  // "Report as AI" from the right-click menu: something the detector missed.
  function markAsAi({ srcUrl, selectionText }) {
    if (srcUrl) {
      const el = [...document.querySelectorAll('img, video')].find(e => (e.currentSrc || e.src) === srcUrl);
      const kind = el?.tagName === 'VIDEO' ? 'video' : 'image';
      Reports.report({ verdict: 'is-ai', kind, key: Reports.keyForMedia(srcUrl), mediaUrl: srcUrl });
      if (el && isActive() && resizeObserver) flagMedia(el, USER_MARKED, kind);
    } else if (selectionText) {
      const node = getSelection()?.anchorNode;
      const block = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('p, li, blockquote, div');
      const useBlock = block && block.textContent.includes(selectionText.slice(0, 40));
      const text = useBlock ? block.textContent : selectionText;
      Reports.report({ verdict: 'is-ai', kind: 'text', key: Reports.keyForText(text), text });
      if (useBlock && isActive() && !block.dataset.aibFlag) {
        block.dataset.aib = 'done';
        flagText(block, USER_MARKED);
      }
    }
    Reports.toast('Thanks for the report. It will be blurred from now on.');
  }

  // ---------- Images ----------

  async function checkImage(img) {
    if (!img.isConnected) return;
    if (!img.complete) {
      img.addEventListener('load', () => checkImage(img), { once: true });
      return;
    }
    const w = img.offsetWidth, h = img.offsetHeight;
    if (w < MIN_IMG_PX || h < MIN_IMG_PX) { img.dataset.aib = 'small'; return; }
    // Lazy-loading placeholder (e.g. Google Images starts with a 1x1 GIF): wait for the real
    // picture. The src change it gets later sends it back through scan().
    if (img.naturalWidth <= 2 && img.naturalHeight <= 2) { img.dataset.aib = 'placeholder'; return; }
    img.dataset.aib = 'checking';
    stats.waiting++;
    try {
      await checkLoadedImage(img);
    } finally {
      stats.waiting--;
      stats.checked++;
    }
  }

  async function checkLoadedImage(img) {
    const url = img.currentSrc || img.src;
    img.__aibKey = Reports.keyForMedia(url);
    if (Reports.isNotAi(img.__aibKey)) { img.dataset.aib = 'done'; return; }
    if (Reports.isMarkedAi(img.__aibKey)) { img.dataset.aib = 'done'; return flagMedia(img, USER_MARKED, 'image'); }
    let result = labelSignals(img, url);
    if (result.score < 0.9 && url && !url.startsWith('blob:') && !YOUTUBE_THUMBNAIL.test(url)) {
      result = better(result, await ask({ type: 'checkImage', url }));
    }
    img.dataset.aib = 'done';
    if (isActive() && settings.images && result.score >= settings.threshold && img.isConnected) {
      flagMedia(img, result, 'image');
    }
  }

  function labelSignals(el, url) {
    if (url && AI_HOSTS.test(url)) {
      return { score: 0.92, reasons: ['Hosted on an AI image generator'] };
    }
    const figure = el.closest('figure');
    const label = [
      el.getAttribute('alt'), el.title, el.getAttribute('aria-label'),
      figure?.querySelector('figcaption')?.textContent
    ].filter(Boolean).join(' ');
    if (AI_LABELS.test(label)) {
      return { score: 0.9, reasons: ['Caption or label says it is AI-generated'] };
    }
    return { score: 0, reasons: [] };
  }

  // ---------- Platform AI labels (platform-labels.js) ----------

  const LABEL_SWEEP_MS = 3000;
  let labelSweep = null;
  let lastYouTubeId = null;

  function flagLabeled(media, platform, label) {
    const kind = media.tagName === 'VIDEO' ? 'video' : 'image';
    if (!isActive() || media.dataset.aibFlag || !(kind === 'video' ? settings.videos : settings.images)) return;
    if (Reports.isNotAi(Reports.keyForMedia(media.currentSrc || media.src))) return;
    media.dataset.aib = 'done';
    const ytId = platform === 'YouTube' && window.AIBPlatform.youtubeVideoId();
    if (ytId) media.dataset.aibForId = ytId;
    flagMedia(media, { score: 0.99, reasons: [`Labeled by ${platform}: “${label}”`] }, kind);
  }

  function checkPlatformLabels(rootEl) {
    const Platform = window.AIBPlatform;
    if (!Platform.platform()) return;
    for (const { media, platform, label } of Platform.findLabeled(rootEl)) flagLabeled(media, platform, label);

    // YouTube: check the page data of each new watch/Shorts video once.
    const id = Platform.platform().name === 'YouTube' && Platform.youtubeVideoId();
    if (id && id !== lastYouTubeId) {
      lastYouTubeId = id;
      Platform.youtubeSynthetic(id).then(synthetic => {
        const video = Platform.youtubePlayerVideo();
        if (synthetic && video && Platform.youtubeVideoId() === id) {
          flagLabeled(video, 'YouTube', 'Altered or synthetic content');
        }
      });
    }
  }

  // ---------- Whole articles ----------
  // Blog posts and articles are usually split into short paragraphs, each too short to judge
  // on its own. So the page's main text is also scored as a whole, the way Google Docs are.

  const ARTICLE_MIN_WORDS = 150;
  const ARTICLE_CHUNK_WORDS = 350; // the text model reads up to 512 tokens at a time
  const ARTICLE_MAX_CHUNKS = 4;
  const MAX_ARTICLES = 3;           // per page, so long feeds don't queue up the model
  const ARTICLE_SKIP = 'nav, header, footer, aside, form, pre, code, [role="navigation"], [role="complementary"], [contenteditable="true"], [data-aib-ui]';
  // Only containers marked up as an article or post: on other pages, unrelated paragraphs that
  // happen to share a parent (a feed, a list of samples) would be judged as one text.
  const ARTICLE_LIKE = 'article, main, [role="main"], [itemprop="articleBody"], [class*="article" i], [class*="post" i], [class*="entry" i], [class*="story" i], [class*="blog" i], [class*="content" i], [id*="article" i], [id*="post" i], [id*="content" i]';
  let articleTimer = null;
  let articlesChecked = 0;

  function scheduleArticles() {
    if (!settings.text || location.hostname === 'docs.google.com') return; // Docs: google-docs.js
    clearTimeout(articleTimer);
    articleTimer = setTimeout(checkArticles, 1500);
  }

  const articleParagraphs = node =>
    [...node.querySelectorAll('p, li:not(:has(p, li))')].filter(p => !p.closest(ARTICLE_SKIP));
  const wordCount = text => text.split(/\s+/).filter(Boolean).length;

  // The page's article bodies, found the way reader modes do: credit each paragraph's text to
  // its parent (and half to its grandparent, for sites that wrap every paragraph), then take
  // the elements with the most.
  function findArticles() {
    const credit = new Map();
    for (const p of document.querySelectorAll('p')) {
      if (p.closest(ARTICLE_SKIP)) continue;
      const len = p.textContent.trim().length;
      if (len < 40) continue;
      const parent = p.parentElement, grand = parent?.parentElement;
      if (parent) credit.set(parent, (credit.get(parent) || 0) + len);
      if (grand) credit.set(grand, (credit.get(grand) || 0) + len / 2);
    }
    const picked = [];
    for (const [node] of [...credit].sort((a, b) => b[1] - a[1])) {
      // A post marked up as one <article> counts as one, even when it's split into sections.
      const body = node.closest('article, [itemprop="articleBody"]') || node;
      const marked = body.matches(ARTICLE_LIKE) || body.parentElement?.matches(ARTICLE_LIKE);
      if (!marked || body === document.body || body === document.documentElement) continue;
      if (picked.some(o => o.contains(body) || body.contains(o))) continue;
      if (wordCount(articleParagraphs(body).map(p => p.textContent).join(' ')) < ARTICLE_MIN_WORDS) continue;
      picked.push(body);
      if (picked.length === MAX_ARTICLES) break;
    }
    return picked;
  }

  async function checkArticles() {
    if (!isActive() || !settings.text) return;
    for (const node of findArticles()) {
      if (articlesChecked >= MAX_ARTICLES) return;
      if (node.dataset.aibArticle || node.closest('[data-aib-flag]')) continue;
      node.dataset.aibArticle = 'checking';
      articlesChecked++;
      await checkArticle(node);
    }
  }

  async function checkArticle(node) {
    const text = articleParagraphs(node).map(p => window.AIBText.normalize(p.textContent).replace(/\s+/g, ' ').trim()).join('\n\n');
    const key = Reports.keyForText(text);
    node.dataset.aibArticle = 'done';
    if (Reports.isNotAi(key)) return;

    let result = Reports.isMarkedAi(key) ? USER_MARKED : window.AIBText.score(text);
    const needed = window.AIBText.threshold(text, settings.threshold); // stricter for medical text and abstracts
    if (result.score < needed && settings.useModels) {
      const words = text.split(/\s+/);
      const chunks = [];
      for (let i = 0; i < words.length && chunks.length < ARTICLE_MAX_CHUNKS; i += ARTICLE_CHUNK_WORDS) {
        const chunk = words.slice(i, i + ARTICLE_CHUNK_WORDS);
        if (chunk.length >= 50) chunks.push(chunk.join(' '));
      }
      const scores = (await Promise.all(chunks.map(c => ask({ type: 'checkText', text: c })))).filter(Boolean);
      if (scores.length) {
        const score = scores.reduce((a, r) => a + r.score, 0) / scores.length;
        result = better(result, { score, reasons: [`AI text detector: ${Math.round(score * 100)}% likely AI across the article`] });
      }
    }
    if (!isActive() || !settings.text || result.score < needed || !node.isConnected || node.closest('[data-aib-flag]')) return;

    // One entry for the whole article instead of one per paragraph.
    node.querySelectorAll('[data-aib-flag]').forEach(el => { if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') el.__aibUnflag?.(); });
    node.__aibKey = key;
    node.dataset.aib = 'done';
    flagText(node, result, 'article');
  }

  // ---------- Hiding: Google AI Overview, YouTube videos about AI (hiding.js) ----------

  const Hide = window.AIBHide;
  const HIDE_SWEEP_MS = 1000;
  let hideSweep = null;

  function hide(el, why) {
    el.dataset.aibHidden = why;
    el.classList.add('aib-hidden');
    tally('hidden');
  }

  function unhide(el) {
    el.classList.remove('aib-hidden');
    delete el.dataset.aibHidden;
  }

  function sweepHiding() {
    if (settings.hideAiOverview) {
      Hide.findAiOverviews(document.body).forEach(el => hide(el, 'ai-overview'));
      Hide.findAiModeLinks(document.body).forEach(el => hide(el, 'ai-mode'));
      Hide.findShoppingSummaries(document.body).forEach(el => hide(el, 'ai-summary'));
      Hide.findRufus(document.body).forEach(el => hide(el, 'ai-button'));
      Hide.findGmailAiButtons(document.body).forEach(el => hide(el, 'ai-button'));
    }
    if (!Hide.isYouTube()) return;
    for (const item of Hide.youtubeItems()) {
      const { el, id } = item;
      // YouTube reuses these elements for other videos, so look again every time.
      const about = settings.hideAiTopics ? Hide.aboutAi(item) : false;
      if (about === true && !el.dataset.aibHidden) {
        hide(el, 'ai-topic');
        el.dataset.aibTopicId = id || '';
      } else if (el.dataset.aibHidden === 'ai-topic' && (about === false || el.dataset.aibTopicId !== (id || ''))) {
        unhide(el);
        delete el.dataset.aibTopicId;
      }
    }
    checkYouTubePlayer();
  }


  // The player keeps the same <video> element from one video to the next, so a warning has to
  // be taken down when the video changes, and put up again if the new one is about AI.
  function checkYouTubePlayer() {
    const video = window.AIBPlatform.youtubePlayerVideo();
    if (!video) return;
    const id = window.AIBPlatform.youtubeVideoId();
    const title = Hide.youtubeCurrentTitle();
    const stale = 'aibForId' in video.dataset && video.dataset.aibForId !== id;
    const about = settings.hideAiTopics && id ? Hide.aboutAi({ id, title, channels: Hide.youtubeCurrentChannels() }) : false;
    // The title can lag behind the address for a moment after switching videos.
    const noLongerAi = video.dataset.aibTopic && about === false;
    if (stale || noLongerAi) {
      video.__aibUnflag?.();
      delete video.dataset.aibForId;
      delete video.dataset.aibTopic;
    }
    if (!id || !settings.hideAiTopics || !settings.videos || video.dataset.aibFlag || about !== true) return;
    video.dataset.aibForId = id;
    video.dataset.aibTopic = '1';
    flagMedia(video, {
      score: 1, noReport: true, title: 'This video is about AI', pill: 'About AI · Hide',
      sub: 'You chose to hide videos about AI'
    }, 'video');
  }

  // ---------- Videos ----------
  // Score frames while the video plays on screen; blur once two in a row look AI-generated.

  async function checkVideo(v) {
    if (!v.isConnected || videos.has(v)) return;
    videos.add(v);
    v.__aibSrc = v.currentSrc || v.src;

    // A new clip in the same player (feeds like Shorts reuse one <video>): start over.
    v.addEventListener('loadeddata', () => {
      const src = v.currentSrc || v.src;
      if (src === v.__aibSrc || !isActive()) return;
      v.__aibSrc = src;
      v.__aibKey = Reports.keyForMedia(src);
      v.__aibUnflag?.();
      stopSampling(v);
      if (Reports.isMarkedAi(v.__aibKey)) return flagMedia(v, USER_MARKED, 'video');
      if (!Reports.isNotAi(v.__aibKey)) startSampling(v);
    });

    v.__aibKey = Reports.keyForMedia(v.__aibSrc);
    if (Reports.isNotAi(v.__aibKey)) return;
    if (Reports.isMarkedAi(v.__aibKey)) return flagMedia(v, USER_MARKED, 'video');

    const quick = labelSignals(v, v.__aibSrc);
    if (quick.score >= settings.threshold) return flagMedia(v, quick, 'video');

    if (v.poster) {
      const poster = await ask({ type: 'checkImage', url: v.poster });
      if (poster?.score >= Math.max(settings.threshold, 0.9) && isActive()) {
        return flagMedia(v, { ...poster, reasons: ['Thumbnail looks AI-generated', ...poster.reasons] }, 'video');
      }
    }
    if (settings.useModels) startSampling(v);
  }

  // The highest score that two frames in a row both reach (Hive's "consecutive" score).
  function consecutiveScore(frames) {
    let best = 0;
    for (let i = 0; i < frames.length - 1; i++) best = Math.max(best, Math.min(frames[i], frames[i + 1]));
    return best;
  }

  function startSampling(v) {
    const frames = [];
    const run = v.__aibRun = {}; // a new clip in the same player starts a new run
    const next = () => {
      v.__aibTimer = setTimeout(sample, frames.length < FAST_FRAMES ? FAST_FRAME_MS : SLOW_FRAME_MS);
    };
    const sample = async () => {
      if (v.dataset.aibFlag || !v.isConnected || !isActive()) return stopSampling(v);
      const rect = !v.paused && v.readyState >= 2 && !document.hidden && visibleRect(v);
      if (!rect) return next();

      const r = await ask({ type: 'checkVideoFrame', rect, dpr: window.devicePixelRatio || 1 });
      if (v.__aibRun !== run || v.dataset.aibFlag) return; // stopped or flagged while waiting
      if (r) frames.push(r.score);

      const score = consecutiveScore(frames);
      if (score >= settings.threshold) {
        stopSampling(v);
        flagMedia(v, {
          score,
          reasons: [`AI detector: ${Math.round(score * 100)}% likely AI in back-to-back frames`]
        }, 'video');
      } else if (frames.length >= MAX_FRAMES) {
        stopSampling(v);
      } else {
        next();
      }
    };
    next();
  }

  function stopSampling(v) {
    clearTimeout(v.__aibTimer);
    v.__aibTimer = null;
    v.__aibRun = null;
  }

  // The part of the video that's on screen, in viewport pixels, or null if too little is.
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_VIDEO_PX || r.height < MIN_VIDEO_PX * 0.5) return null;
    const x = Math.max(0, r.left), y = Math.max(0, r.top);
    const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
    if (w * h < r.width * r.height * 0.6) return null;
    return { x, y, width: w, height: h };
  }

  // ---------- Blurring images and videos ----------

  function flagMedia(el, r, kind) {
    if (el.dataset.aibFlag) return;
    // The cover over a YouTube video about AI stays a cover: you opened that video yourself.
    if (settings.removeFlagged && !r.noReport) return removeFlagged(el);
    tally(r.noReport ? 'hidden' : kind); // noReport: the cover over a YouTube video about AI
    el.dataset.aibFlag = '1';
    el.dataset.aib ||= 'done';
    el.classList.add('aib-media-blur');

    // Keep a blurred video paused, even if the site's player tries to restart it.
    const isVideo = kind === 'video';
    let revealed = false;
    const wasPlaying = isVideo && !el.paused;
    const keepPaused = () => { if (!revealed) el.pause(); };
    if (isVideo) { el.pause(); el.addEventListener('play', keepPaused); }

    const ov = makeOverlay(kind, r, {
      reveal: () => {
        revealed = true;
        el.classList.remove('aib-media-blur');
        if (wasPlaying) el.play().catch(() => {});
      },
      hide: () => {
        revealed = false;
        el.classList.add('aib-media-blur');
        if (isVideo) el.pause();
      },
      notAi: r.noReport ? null : () => {
        revealed = true;
        markNotAi(el, kind, r);
        if (wasPlaying) el.play().catch(() => {});
      }
    });

    // Put the overlay next to the element and line it up exactly on top of it,
    // without wrapping it (wrapping breaks a lot of site layouts).
    ov.place = () => {
      if (!el.isConnected) { ov.remove(); overlays.delete(ov); return; }
      ov.style.left = '0px';
      ov.style.top = '0px';
      const a = ov.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      ov.style.left = `${b.left - a.left}px`;
      ov.style.top = `${b.top - a.top}px`;
      ov.style.width = `${b.width}px`;
      ov.style.height = `${b.height}px`;
    };
    (el.closest('picture') || el).after(ov);
    el.__aibOverlay = ov;
    el.__aibUnflag = () => {
      ov.remove();
      overlays.delete(ov);
      holdPreviews(false); // the pointer may have been on it
      el.classList.remove('aib-media-blur');
      if (isVideo) el.removeEventListener('play', keepPaused);
      delete el.dataset.aibFlag;
      delete el.__aibOverlay;
      delete el.__aibUnflag;
    };
    resizeObserver.observe(el);
    ov.place();
  }

  // ---------- Removing instead of blurring ----------
  // With "Remove" picked in the popup, a flagged item is taken off the page with no warning.
  // Switching back to "Blur" brings it back, blurred.

  function removeFlagged(el) {
    tally(el.tagName === 'IMG' ? 'image' : el.tagName === 'VIDEO' ? 'video' : 'text');
    el.dataset.aibFlag = '1';
    el.dataset.aib ||= 'done';
    // For a picture or video, the whole item it belongs to goes (its link, figure and caption, grid
    // tile or card), so no empty frame is left where it was.
    const target = removalTarget(el);
    target.classList.add('aib-removed');
    const isVideo = el.tagName === 'VIDEO';
    const keepPaused = () => el.pause();
    if (isVideo) { el.pause(); el.addEventListener('play', keepPaused); }
    removed.add(el);
    el.__aibUnflag = () => {
      target.classList.remove('aib-removed');
      if (isVideo) el.removeEventListener('play', keepPaused);
      removed.delete(el);
      delete el.dataset.aibFlag;
      delete el.__aibUnflag;
    };
  }

  // The element that holds just this picture or video. Climb while the parent adds nothing else
  // that matters: no other picture or video (40 px or more), at most a caption's worth of text, and
  // not much more height (it may be wider: block wrappers usually are, and that's empty space).
  // Stops before the page's main areas, so an image in an article removes the image (and its
  // caption), never the article.
  // Characters of extra text allowed: more for text in the picture's own column (a title and site
  // name under a search result, a caption) than for text beside it (a headline next to a photo).
  const REMOVAL_MAX_TEXT = 160;
  const REMOVAL_MAX_TEXT_BELOW = 300;
  const REMOVAL_STOP = 'body, html, main, [role="main"], article, [role="article"], [role="feed"], section, form, nav, header, footer, aside, ul, ol, table';
  function removalTarget(el) {
    if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') return el;
    const box = e => e.getBoundingClientRect();
    const own = Math.max(box(el).height, 1);
    const ownWidth = Math.max(box(el).width, 1);
    const maxHeight = Math.max(own * 1.8, own + 80); // room for a title or caption
    const textOf = e => (e.innerText || '').replace(/\s+/g, ' ').trim().length;
    let target = el;
    // No fixed depth: sites nest a tile 10+ levels deep (Google Images), and the checks below stop
    // the climb as soon as a parent holds anything else.
    for (let i = 0; i < 30; i++) {
      const parent = target.parentElement;
      if (!parent || parent.matches(REMOVAL_STOP)) break;
      const otherMedia = [...parent.querySelectorAll('img, video, picture, canvas, iframe, svg')].some(m => {
        if (target.contains(m) || m.contains(target)) return false;
        const r = box(m);
        return r.width >= 40 && r.height >= 40;
      });
      if (otherMedia) break;
      const sameColumn = box(parent).width <= ownWidth * 1.2;
      if (textOf(parent) - textOf(target) > (sameColumn ? REMOVAL_MAX_TEXT_BELOW : REMOVAL_MAX_TEXT)) break;
      if (box(parent).height > maxHeight) break;
      target = parent;
    }
    // A list item or grid cell that is now nothing but this item goes too (e.g. a search result tile).
    const cell = target.parentElement;
    if (cell?.matches('li, [role="listitem"], [role="gridcell"]') && textOf(cell) - textOf(target) <= REMOVAL_MAX_TEXT
        && ![...cell.querySelectorAll('img, video')].some(m => !target.contains(m) && box(m).width >= 40)) target = cell;
    return target;
  }

  // ---------- Warning overlay ----------

  // Built with DOM calls rather than innerHTML: some sites (YouTube, Google Docs) enforce
  // Trusted Types, which rejects HTML strings.
  const OVERLAY_STYLE = `
    :host { all: initial; --accent: #7dd3fc; --ease-out: cubic-bezier(0.23, 1, 0.32, 1); }
    * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Roboto, sans-serif; text-shadow: none; }
    .wrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            padding: 8px; background: rgba(15, 14, 13, 0.32); border-radius: 6px; overflow: hidden;
            animation: fade 200ms ease-out; }
    .card { max-width: 340px; background: rgba(26, 24, 22, 0.94); color: #f5f5f4; border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.08); padding: 11px 14px 12px; text-align: center; line-height: 1.35;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32); animation: enter 220ms var(--ease-out); }
    .title { font-size: 13px; font-weight: 650; letter-spacing: -0.01em; display: flex; gap: 7px; align-items: center; justify-content: center; }
    .mark { flex: none; width: 16px; height: 16px; border-radius: 4px; background: var(--accent); color: #082f49;
            display: grid; place-items: center; font: 800 11px/1 ui-monospace, Menlo, Consolas, monospace; }
    .sub { font-size: 11.5px; color: #a8a29e; margin-top: 4px; }
    .actions { display: flex; gap: 4px; align-items: center; justify-content: center; margin-top: 10px; }
    button { all: unset; font-family: system-ui, "Segoe UI", Roboto, sans-serif; cursor: pointer; font-size: 12px; font-weight: 600;
             border-radius: 6px; transition: transform 160ms var(--ease-out), background-color 150ms ease, color 150ms ease; }
    button:active { transform: scale(0.97); }
    .view { background: var(--accent); color: #082f49; padding: 5px 12px; }
    .report { color: #a8a29e; padding: 5px 9px; font-weight: 500; }
    .pills { display: none; position: absolute; top: 6px; right: 6px; gap: 4px; pointer-events: auto; }
    .pills button { background: rgba(26, 24, 22, 0.9); border: 1px solid rgba(255, 255, 255, 0.08); padding: 3px 9px; font-size: 11px; }
    .hide { color: var(--accent); }
    .notai { color: #d6d3d1; font-weight: 500; }
    @media (hover: hover) and (pointer: fine) {
      .view:hover { background: #bae6fd; }
      .report:hover { color: #f5f5f4; background: rgba(255, 255, 255, 0.06); }
      .pills button:hover { background: rgba(40, 37, 34, 0.95); }
    }
    :host([revealed]) .wrap { display: none; }
    :host([revealed]) .pills { display: flex; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @keyframes fade { from { opacity: 0; } }
    @keyframes enter { from { opacity: 0; transform: translateY(4px) scale(0.97); } }
    @media (prefers-reduced-motion: reduce) {
      .card { animation-name: fade; }
      button:active { transform: none; }
    }
  `;

  const POINTER_EVENTS = ['pointerover', 'pointerout', 'pointermove', 'pointerdown', 'pointerup',
    'mouseover', 'mouseout', 'mousemove', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu'];

  function holdPreviews(on) {
    document.documentElement.classList.toggle('aib-hold-previews', on);
    if (on) document.querySelectorAll('ytd-video-preview video').forEach(v => v.pause());
  }

  function el(tag, cls, ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...children.filter(c => c != null));
    return e;
  }

  function button(cls, label, onClick, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function makeOverlay(kind, r, { reveal, hide, notAi }) {
    const host = document.createElement('div');
    host.setAttribute('data-aib-ui', kind);
    const shadow = host.attachShadow({ mode: 'open' });
    const pct = Math.round(r.score * 100);
    const reasons = (r.reasons || []).slice(0, 2).join(' · ');

    const card = el('div', 'card',
      el('div', null,
        el('div', 'title', el('span', 'mark', '!'), r.title || `This ${kind} is most likely AI-generated`),
        el('div', 'sub', r.sub || `${pct}% likely${reasons ? ' · ' + reasons : ''}`)),
      el('div', 'actions',
        button('view', 'View anyway', () => { host.setAttribute('revealed', ''); reveal(); }),
        notAi && button('report', 'Not AI?', notAi, 'Report a mistake and stop blurring this')));
    card.firstChild.firstChild.firstChild.setAttribute('aria-hidden', 'true');
    const wrap = el('div', `wrap ${kind}`, card);
    wrap.setAttribute('role', 'alert');

    const pills = el('div', `pills ${kind}`,
      button('hide', r.pill || 'Likely AI · Hide', () => { host.removeAttribute('revealed'); hide(); }, r.noReport ? 'Click to blur again.' : `${pct}% likely AI. Click to blur again.`),
      notAi && button('notai', 'Not AI', notAi, 'Report a mistake and stop blurring this'));

    shadow.append(el('style', null, OVERLAY_STYLE), wrap, pills);
    // Don't let clicks fall through to links, players or the image underneath.
    host.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    // Nor hovering and pressing: sites start things from those too (YouTube's hover preview).
    for (const type of POINTER_EVENTS) host.addEventListener(type, e => e.stopPropagation());
    // YouTube's hover preview is a separate player laid over the thumbnail, above this warning,
    // and it starts on hover however events are stopped. Hold it off while the pointer is on an
    // unrevealed warning.
    host.addEventListener('pointerenter', () => { if (!host.hasAttribute('revealed')) holdPreviews(true); });
    host.addEventListener('pointerleave', () => holdPreviews(false));
    wrap.querySelector('.view').addEventListener('click', () => holdPreviews(false));

    overlays.add(host);
    return host;
  }

  // Start last, so everything above is defined even if settings come back immediately.
  Promise.all([loadAccess(), chrome.storage.sync.get(DEFAULTS)]).then(([, s]) => { settings = s; restart(); });
})();
