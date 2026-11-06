// A small badge in the corner of the page that says how likely the text is AI-written, used for
// web pages (content.js) and Google Docs (google-docs.js) instead of blurring or highlighting.
// It starts as a pill; clicking it opens a card listing the parts that look AI-written.
// Built with DOM calls (Docs and YouTube enforce Trusted Types, which rejects HTML strings).

(function (root) {
  const STYLE = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
            --accent: #7dd3fc; --ok: #4ade80; --ease-out: cubic-bezier(0.23, 1, 0.32, 1); }
    * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
    .box { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    button { all: unset; cursor: pointer; font-family: system-ui, "Segoe UI", Roboto, sans-serif;
             transition: transform 160ms var(--ease-out), background-color 150ms ease, color 150ms ease; }
    button:active { transform: scale(0.97); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .pill { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px 6px 9px; border-radius: 999px;
            background: rgba(26, 24, 22, 0.92); color: #e7e5e4; font-size: 12px; font-weight: 600;
            border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22); }
    .pill.enter { animation: rise 220ms var(--ease-out); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #78716c; flex: none; }
    .ai .dot { background: var(--accent); }
    .clear .dot { background: var(--ok); }
    .busy .dot { animation: pulse 1s ease-in-out infinite alternate; }
    .num { font: 600 12px ui-monospace, Menlo, Consolas, monospace; color: var(--accent); }

    .card { width: 320px; max-height: min(420px, 70vh); display: flex; flex-direction: column;
            background: rgba(26, 24, 22, 0.96); color: #f5f5f4; border-radius: 12px; line-height: 1.4;
            border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            transform-origin: bottom right; }
    .card.enter { animation: open 200ms var(--ease-out); }
    .head { display: flex; gap: 8px; align-items: start; padding: 12px 12px 8px 14px; }
    .title { flex: 1; font-size: 13px; font-weight: 650; letter-spacing: -0.01em; }
    .detail { padding: 0 14px 10px; font-size: 11.5px; color: #a8a29e; }
    .x { color: #a8a29e; font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
    .list { overflow-y: auto; border-top: 1px solid rgba(255, 255, 255, 0.07); }
    .item { display: flex; gap: 8px; align-items: baseline; padding: 7px 12px 7px 14px; font-size: 12px; color: #d6d3d1; }
    .item + .item { border-top: 1px solid rgba(255, 255, 255, 0.05); }
    .item .pct { flex: none; width: 34px; font: 600 11.5px ui-monospace, Menlo, Consolas, monospace; color: var(--accent); }
    .item .text, .item .go { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .item .go { text-align: left; font-size: 12px; color: #d6d3d1; border-radius: 4px; }
    .item .no { flex: none; font-size: 11px; color: #a8a29e; padding: 1px 5px; border-radius: 4px; }
    .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 10px 12px 12px 14px;
               border-top: 1px solid rgba(255, 255, 255, 0.07); font-size: 12px; color: #d6d3d1; }
    .act { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; background: rgba(255, 255, 255, 0.08); }
    .act.primary { background: var(--accent); color: #082f49; }
    .act.quiet { background: none; color: #a8a29e; font-weight: 500; padding: 4px 6px; }
    .note { color: #86efac; }
    @media (hover: hover) and (pointer: fine) {
      .pill:hover { background: rgba(40, 37, 34, 0.96); }
      .x:hover, .item .no:hover, .act.quiet:hover { color: #f5f5f4; background: rgba(255, 255, 255, 0.06); }
      .item .go:hover { color: #fff; }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    @keyframes open { from { opacity: 0; transform: scale(0.96); } }
    @keyframes pulse { to { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) {
      .pill.enter, .card.enter { animation-name: fade; }
      .busy .dot { animation: none; }
      button:active { transform: none; }
      @keyframes fade { from { opacity: 0; } }
    }
  `;

  let host = null;
  let open = false;
  let last = null;
  let justToggled = false; // animate the card only when it opens, not on every update

  function el(tag, cls, ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...children.filter(c => c != null && c !== false));
    return e;
  }

  function button(cls, label, onClick, title) {
    const b = el('button', cls, label);
    if (title) b.title = title;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(e); });
    return b;
  }

  // state: {
  //   tone: 'ai' | 'clear' | 'busy' | 'info',
  //   pill: short text, pct: number 0-1 or null (shown in the pill),
  //   title, detail,
  //   items: [{ score, text, onGo?, onNotAi? }],
  //   actions: [{ label, onClick, kind?: 'primary' | 'quiet' }] or a DOM node,
  //   onClose
  // }
  function render(state) {
    last = state;
    const fresh = !host;
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-aib-ui', 'badge');
      host.attachShadow({ mode: 'open' });
      (document.body || document.documentElement).appendChild(host);
    }
    const tone = state.tone || 'info';
    const pct = state.pct != null ? el('span', 'num', `${Math.round(state.pct * 100)}%`) : null;
    const pill = button(`pill ${tone}${fresh ? ' enter' : ''}`, '', () => { open = !open; justToggled = true; render(last); }, open ? 'Hide details' : 'Show details');
    pill.setAttribute('aria-expanded', open);
    pill.append(...[el('span', 'dot'), state.pill, pct].filter(Boolean));

    let card = null;
    if (open) {
      const close = button('x', '×', () => { remove(); state.onClose?.(); }, 'Close');
      close.setAttribute('aria-label', 'Close');
      const items = (state.items || []).map(it => el('div', 'item',
        el('span', 'pct', `${Math.round(it.score * 100)}%`),
        it.onGo ? button('go', it.text, it.onGo, 'Show it on the page') : el('span', 'text', it.text),
        it.onNotAi && button('no', 'Not AI', it.onNotAi, 'Report a mistake and stop flagging this')));
      const actions = state.actions instanceof Node ? state.actions
        : state.actions?.length ? el('div', 'actions', ...state.actions.map(a => button(`act ${a.kind || ''}`, a.label, a.onClick))) : null;
      card = el('div', `card${justToggled ? ' enter' : ''}`,
        el('div', 'head', el('div', 'title', state.title), close),
        state.detail && el('div', 'detail', state.detail),
        items.length && el('div', 'list', ...items),
        actions);
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', state.title);
    }
    justToggled = false;
    host.shadowRoot.replaceChildren(el('style', null, STYLE), el('div', 'box', card, pill));
  }

  function remove() {
    host?.remove();
    host = null;
    open = false;
    last = null;
  }

  root.AIBBadge = { render, remove, el, button, isOpen: () => open };
})(window);
