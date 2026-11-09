// Tiny DOM + geometry helpers.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rectOf = (n) => ({ x: n.frame[0][0], y: n.frame[0][1], w: n.frame[1][0], h: n.frame[1][1] });
export const frameOf = (r) => [
  [r.x, r.y],
  [r.w, r.h],
];

export function kindOf(node) {
  const c = node.content;
  if (c.terminal) return 'terminal';
  if (c.stickyNote) return 'note';
  if (c.noteStack) return 'noteStack';
  if (c.band) return 'band';
  if (c.portal) return 'portal';
  if (c.fileTree) return 'fileTree';
  if (c.text) return 'text';
  if (c.shape) return 'shape';
  if (c.stroke) return 'stroke';
  if (c.freehand) return 'freehand';
  if (c.crossFloorConnector) return 'connector';
  return 'unknown';
}
export const inner = (node) => {
  const k = kindOf(node);
  const key = k === 'note' ? 'stickyNote' : k === 'connector' ? 'crossFloorConnector' : k;
  return node.content[key] && node.content[key]._0;
};

export function debounce(fn, ms) {
  let t;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function toast(msg, ms = 2400) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: 'toast' }, msg);
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx').forEach((n) => n.remove());
  const menu = el(
    'div',
    { class: 'ctx', style: { left: `${x}px`, top: `${y}px` } },
    items.map((it) =>
      el(
        'div',
        {
          class: it.danger ? 'danger' : '',
          onclick: () => {
            menu.remove();
            it.run();
          },
        },
        it.icon && window.__icon ? window.__icon(it.icon, 14) : null,
        it.label,
      ),
    ),
  );
  document.body.append(menu);
  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      window.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => window.addEventListener('mousedown', close, true), 0);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight) menu.style.top = `${innerHeight - r.height - 8}px`;
}

export const WORKSPACE_COLORS = {
  blue: '#0a84ff',
  red: '#ff453a',
  green: '#30d158',
  orange: '#ff9f0a',
  purple: '#bf5af2',
  pink: '#ff375f',
  cyan: '#64d2ff',
  yellow: '#ffd60a',
  rainbow: '#a78bfa',
};
