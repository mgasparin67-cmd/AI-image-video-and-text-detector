// Weekly summary page: what was flagged or hidden in the last 7 days (counts kept by activity.js).

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString();
const count = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
const dayName = (day, opts) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, opts); };
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children.filter(c => c != null));
  return e;
}

render();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.activity || changes.reports)) render(); });

$('toggleTable').addEventListener('click', () => {
  const table = $('dayTable');
  table.hidden = !table.hidden;
  $('chart').hidden = !table.hidden;
  $('toggleTable').textContent = table.hidden ? 'Show as table' : 'Show as chart';
});
$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Clear the counts behind this summary? Mistake reports are kept.')) return;
  await chrome.storage.local.remove('activity');
});

async function render() {
  const { activity = {}, reports = [] } = await chrome.storage.local.get({ activity: {}, reports: [] });
  const s = AIBActivity.summarize(activity, AIBActivity.dayKey(), 7);
  const first = s.days[0].day, last = s.days[s.days.length - 1].day;
  $('range').textContent = `${dayName(first, { month: 'short', day: 'numeric' })} – ${dayName(last, { month: 'short', day: 'numeric' })} · ${fmt(s.totals.all)} flagged or hidden`;
  $('tImages').textContent = fmt(s.totals.image);
  $('tVideos').textContent = fmt(s.totals.video);
  $('tText').textContent = fmt(s.totals.text);
  $('tHidden').textContent = fmt(s.totals.hidden);
  renderChart(s.days);
  renderDayTable(s.days);
  renderSites(s.sites);
  renderReports(reports, first);
}

// One series (flagged or hidden per day): bars from a shared baseline, 4px rounded tops, the
// largest day labelled, every day in a hover tooltip and in the table view.
function renderChart(days) {
  const W = 680, H = 180, top = 22, bottom = 26, gap = 14;
  const max = Math.max(...days.map(d => d.total));
  const plotH = H - top - bottom;
  const colW = W / days.length;
  const barW = Math.min(56, colW - gap);
  const y = v => top + plotH - (max ? (v / max) * plotH : 0);
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Flagged or hidden per day: ${days.map(d => `${dayName(d.day, { weekday: 'short' })} ${d.total}`).join(', ')}` });
  // Recessive gridline at the top value, and the baseline.
  if (max) svg.append(el('svg:line', { class: 'grid', x1: 0, x2: W, y1: y(max), y2: y(max) }));
  svg.append(el('svg:line', { class: 'base', x1: 0, x2: W, y1: y(0), y2: y(0) }));
  const tip = el('div', { class: 'tip', role: 'status' });
  const maxIndex = days.findIndex(d => d.total === max);
  days.forEach((d, i) => {
    const cx = colW * i + colW / 2, x = cx - barW / 2, h = y(0) - y(d.total);
    const r = Math.min(4, h, barW / 2);
    const col = el('svg:g', { class: 'col' });
    // Hit target: the whole column, bigger than the bar.
    const hit = el('svg:rect', { class: 'hit', x: colW * i, y: top, width: colW, height: plotH, tabindex: 0,
      'aria-label': `${dayName(d.day, { weekday: 'long', month: 'short', day: 'numeric' })}: ${d.total}` });
    col.append(hit);
    if (h > 0) {
      // Rounded top corners, square at the baseline.
      col.append(el('svg:path', { class: 'bar',
        d: `M${x},${y(0)} V${y(d.total) + r} Q${x},${y(d.total)} ${x + r},${y(d.total)} H${x + barW - r} Q${x + barW},${y(d.total)} ${x + barW},${y(d.total) + r} V${y(0)} Z` }));
    }
    if (i === maxIndex && max > 0) col.append(el('svg:text', { class: 'value', x: cx, y: y(d.total) - 6, 'text-anchor': 'middle' }, fmt(d.total)));
    col.append(el('svg:text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, dayName(d.day, { weekday: 'short' })));
    const show = () => {
      tip.replaceChildren(el('div', {}, dayName(d.day, { weekday: 'long', month: 'short', day: 'numeric' })),
        el('div', {}, el('b', {}, fmt(d.total)), ` flagged or hidden`),
        el('div', {}, `${count(d.image, 'image')} · ${count(d.video, 'video')} · ${count(d.text, 'passage')} · ${fmt(d.hidden)} hidden`));
      // Above the bar's top, kept inside the chart: flipped below it when there's no room above.
      const box = $('chart').getBoundingClientRect(), svgBox = svg.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const barTop = svgBox.top - box.top + (Math.min(y(d.total), y(0) - 10) / H) * svgBox.height;
      const left = svgBox.left - box.left + (cx / W) * svgBox.width;
      tip.style.left = `${Math.max(tw / 2 + 4, Math.min(box.width - tw / 2 - 4, left))}px`;
      tip.style.top = `${barTop - 8 - th >= 0 ? barTop - 8 : barTop + th + 8}px`;
      tip.classList.add('on');
    };
    const hide = () => tip.classList.remove('on');
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.append(col);
  });
  $('chart').replaceChildren(...[svg, tip, max ? null : el('div', { class: 'empty' }, 'Nothing flagged or hidden in the last 7 days.')].filter(Boolean));
}

function renderDayTable(days) {
  $('dayTable').tBodies[0].replaceChildren(...days.map(d => el('tr', {},
    el('td', {}, dayName(d.day, { weekday: 'short', month: 'short', day: 'numeric' })),
    ...['image', 'video', 'text', 'hidden', 'total'].map(k => el('td', {}, fmt(d[k]))))));
}

function renderSites(sites) {
  if (!sites.length) return $('sites').replaceChildren(el('div', { class: 'empty' }, 'No sites yet.'));
  $('sites').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...['Site', 'Images', 'Videos', 'Text', 'Hidden', 'Total'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...sites.slice(0, 10).map(s => el('tr', {},
      el('td', { class: 'site' }, s.site),
      ...['image', 'video', 'text', 'hidden', 'total'].map(k => el('td', {}, fmt(s[k]))))))));
}

function renderReports(reports, firstDay) {
  const week = reports.filter(r => r.time && AIBActivity.dayKey(new Date(r.time)) >= firstDay);
  const notAi = week.filter(r => r.verdict === 'not-ai').length;
  $('reports').textContent = week.length
    ? `${week.length} this week: ${notAi} marked “Not AI”, ${week.length - notAi} reported as AI. ${reports.length} in total.`
    : `None this week${reports.length ? ` (${reports.length} in total)` : ''}.`;
}
