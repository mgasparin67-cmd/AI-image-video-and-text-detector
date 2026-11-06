// Platform AI labels: YouTube, Instagram, Facebook, TikTok and Pinterest mark some content as
// AI-made themselves. Those labels come from the uploader's disclosure or the platform's own
// systems (e.g. Content Credentials), so they're more reliable than any detector.
//
// Approach, kept independent of each site's markup as far as possible:
//   1. Find short elements whose whole text (or aria-label) is exactly a known label, so a
//      comment that merely mentions "AI info" doesn't count.
//   2. Walk up from the label to the nearest post/card that contains a large image or video;
//      that media is what gets blurred.
//   3. YouTube also exposes a flag in its page data (containsSyntheticMedia), which is checked
//      on watch and Shorts pages because the description holding the label may be collapsed.
// Label wording is from each platform's help pages (2024–2026). English only.

(function (root) {
  const PLATFORMS = [
    {
      name: 'YouTube', host: /(^|\.)youtube\.com$/,
      labels: [/^altered or synthetic content$/i]
    },
    {
      name: 'Instagram', host: /(^|\.)instagram\.com$/,
      labels: [/^ai info$/i, /^made with ai$/i]
    },
    {
      name: 'Facebook', host: /(^|\.)facebook\.com$/,
      labels: [/^ai info$/i, /^made with ai$/i]
    },
    {
      name: 'TikTok', host: /(^|\.)tiktok\.com$/,
      labels: [/^creator label(l)?ed as ai-generated$/i, /^ai-generated$/i]
    },
    {
      name: 'Pinterest', host: /(^|\.)pinterest\.[a-z.]+$/,
      labels: [/^ai modified$/i, /^may be modified with ai$/i]
    }
  ];
  const CANDIDATES = 'span, div, a, button, p, h2, h3, h4, li, [aria-label]';
  const MAX_LABEL_CHARS = 60;
  const MIN_MEDIA_PX = 150; // skip avatars and icons when looking for the labeled post's media
  const MAX_CLIMB = 25;

  // The test page sets __aibTestHost to pretend it's one of the platforms.
  const platform = () => {
    const host = root.__aibTestHost || location.hostname;
    return PLATFORMS.find(p => p.host.test(host)) || null;
  };

  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  function isLabel(el, p) {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria && aria.length <= MAX_LABEL_CHARS && p.labels.some(re => re.test(aria))) return true;
    // Only leaf-ish elements: the label text itself, not a container that happens to include it.
    if (el.childElementCount > 2) return false;
    const text = norm(el.textContent);
    return text.length > 0 && text.length <= MAX_LABEL_CHARS && p.labels.some(re => re.test(text));
  }

  // The biggest image or video inside el that's large enough to be the post's content.
  function mainMedia(el) {
    let best = null, bestArea = 0;
    for (const m of el.querySelectorAll('img, video')) {
      const r = m.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= MIN_MEDIA_PX && r.height >= MIN_MEDIA_PX && area > bestArea) { best = m; bestArea = area; }
    }
    return best;
  }

  // A post/card boundary: don't look past it, or a text-only labeled post in a feed would
  // grab the next post's picture.
  const POST_BOUNDARY = 'article, [role="article"], [role="dialog"], li, [data-grid-item], [data-test-id="pin"]';

  // From a label, the media of the post it belongs to.
  function mediaForLabel(label) {
    let el = label;
    for (let i = 0; i < MAX_CLIMB && el && el !== document.body; i++, el = el.parentElement) {
      const media = mainMedia(el);
      if (media) return media;
      if (el.matches(POST_BOUNDARY)) return null;
    }
    return null;
  }

  // Labeled media under root: [{ media, platform, label }].
  function findLabeled(rootEl) {
    const p = platform();
    if (!p || !rootEl?.querySelectorAll) return [];
    const els = rootEl.matches?.(CANDIDATES) ? [rootEl, ...rootEl.querySelectorAll(CANDIDATES)] : rootEl.querySelectorAll(CANDIDATES);
    const found = [];
    const seen = new Set();
    for (const el of els) {
      if (el.closest('[data-aib-ui]') || !isLabel(el, p)) continue;
      // On YouTube the label sits in the description, away from the player it describes.
      const media = p.name === 'YouTube' ? youtubePlayerVideo() : mediaForLabel(el);
      if (media && !seen.has(media)) {
        seen.add(media);
        found.push({ media, platform: p.name, label: norm(el.getAttribute('aria-label') || el.textContent) });
      }
    }
    return found;
  }

  // ---------- YouTube page data ----------

  const ytCache = new Map(); // videoId -> Promise<boolean>

  function youtubeVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  // Whether YouTube's page data marks the current video as altered or synthetic.
  function youtubeSynthetic(id) {
    if (!ytCache.has(id)) {
      ytCache.set(id, fetch(`/watch?v=${encodeURIComponent(id)}`)
        .then(r => r.text())
        .then(html => /"containsSyntheticMedia"\s*:\s*true/.test(html))
        .catch(() => false));
    }
    return ytCache.get(id);
  }

  // The video element currently playing on a watch or Shorts page.
  function youtubePlayerVideo() {
    return document.querySelector('ytd-reel-video-renderer[is-active] video, #shorts-player video, #movie_player video');
  }

  root.AIBPlatform = { platform, findLabeled, youtubeVideoId, youtubeSynthetic, youtubePlayerVideo };
})(window);
