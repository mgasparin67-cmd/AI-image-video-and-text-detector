// What the extension flagged or hid, per day and site, for the weekly summary (summary.html).
// Stored in chrome.storage.local as { "YYYY-MM-DD": { "site": { image, video, text, hidden } } }
// and kept for 8 weeks. Only counts are kept: no addresses of pages, images or text.
// Used by the background worker (the only writer) and the summary page.

(function (root) {
  const KINDS = ['image', 'video', 'text', 'hidden'];
  const KEEP_DAYS = 56;

  // The local calendar day, "YYYY-MM-DD".
  const dayKey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const daysBefore = (day, n) => {
    const [y, m, d] = day.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d - n));
  };

  // Adds counts for a site on a day; drops days older than KEEP_DAYS. Returns a new object.
  function add(activity, day, site, counts) {
    const out = {};
    const oldest = daysBefore(day, KEEP_DAYS - 1);
    for (const [d, sites] of Object.entries(activity || {})) if (d >= oldest) out[d] = { ...sites };
    const row = { ...(out[day]?.[site] || {}) };
    for (const k of KINDS) if (counts[k] > 0) row[k] = (row[k] || 0) + Math.floor(counts[k]);
    out[day] = { ...(out[day] || {}), [site || '(unknown)']: row };
    return out;
  }

  // The last `days` days up to `today`: per-day totals, overall totals, and sites by total.
  function summarize(activity, today = dayKey(), days = 7) {
    const zero = () => Object.fromEntries(KINDS.map(k => [k, 0]));
    const totals = zero();
    const bySite = new Map();
    const perDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = daysBefore(today, i);
      const dayTotals = zero();
      for (const [site, row] of Object.entries(activity?.[day] || {})) {
        const s = bySite.get(site) || zero();
        for (const k of KINDS) {
          const n = row[k] || 0;
          dayTotals[k] += n; totals[k] += n; s[k] += n;
        }
        bySite.set(site, s);
      }
      perDay.push({ day, ...dayTotals, total: KINDS.reduce((a, k) => a + dayTotals[k], 0) });
    }
    const sites = [...bySite].map(([site, s]) => ({ site, ...s, total: KINDS.reduce((a, k) => a + s[k], 0) }))
      .filter(s => s.total > 0)
      .sort((a, b) => b.total - a.total || a.site.localeCompare(b.site));
    return { days: perDay, totals: { ...totals, all: KINDS.reduce((a, k) => a + totals[k], 0) }, sites };
  }

  // Totals for a free trial: every calendar day it touched, from its start to its end.
  function trialTotals(activity, trialStart, trialDays) {
    const end = dayKey(new Date(trialStart + trialDays * 86400000));
    return summarize(activity, end, trialDays + 1).totals;
  }

  // "flagged 212 likely AI images and 34 videos, and hid 12 other AI items", or '' if nothing was.
  function describe({ image = 0, video = 0, text = 0, hidden = 0 } = {}) {
    const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
    const list = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
    const flagged = [];
    if (image) flagged.push(plural(image, 'likely AI image', 'likely AI images'));
    if (video) flagged.push(plural(video, flagged.length ? 'video' : 'likely AI video', flagged.length ? 'videos' : 'likely AI videos'));
    if (text) flagged.push(plural(text, flagged.length ? 'passage of text' : 'likely AI passage of text', flagged.length ? 'passages of text' : 'likely AI passages of text'));
    if (!flagged.length) return hidden ? `hid ${plural(hidden, 'AI item', 'AI items')}` : '';
    return `flagged ${list(flagged)}${hidden ? `, and hid ${plural(hidden, 'other AI item', 'other AI items')}` : ''}`;
  }

  root.AIBActivity = { KINDS, KEEP_DAYS, dayKey, daysBefore, add, summarize, trialTotals, describe };
})(typeof window !== 'undefined' ? window : self);
