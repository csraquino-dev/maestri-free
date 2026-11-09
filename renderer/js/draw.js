// Drawing tools: the draw toolbar (tools + style controls), the style controls reused by the selection toolbar,
// and the conversion of a mouse gesture into a node (freehand / line / arrow / rectangle / ellipse / diamond).
import { el } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export const TOOLS = [
  ['smart', 'wand-sparkles', 'Smart draw (turns your stroke into a shape)'],
  ['brush', 'brush', 'Pen'],
  ['highlighter', 'highlighter', 'Highlighter'],
  ['line', 'minus', 'Line'],
  ['arrow', 'arrow-up-right', 'Arrow'],
  ['rect', 'square', 'Rectangle'],
  ['ellipse', 'circle', 'Ellipse'],
  ['diamond', 'diamond', 'Diamond'],
];
export const AREA_TOOLS = new Set(['rect', 'ellipse', 'diamond']);
export const SWATCHES = [
  '#0a84ff',
  '#5e5ce6',
  '#bf5af2',
  '#ff375f',
  '#ff453a',
  '#ff9f0a',
  '#ffd60a',
  '#30d158',
  '#64d2ff',
  '#8e8e93',
  '#ffffff',
  '#1c1c1e',
  '#a2845e',
  '#ff6482',
];
export const MIN_WIDTH = 1,
  MAX_WIDTH = 24;

const load = () => {
  try {
    return JSON.parse(localStorage.getItem('drawState') || 'null');
  } catch {
    return null;
  }
};
export const DRAW = Object.assign(
  { tool: 'brush', color: '#0a84ff', width: 3, pattern: 'solid', fill: 'none' },
  load() || {},
);
export const setDraw = (patch) => {
  Object.assign(DRAW, patch);
  try {
    localStorage.setItem('drawState', JSON.stringify(DRAW));
  } catch {
    /* storage unavailable */
  }
};
export const defaultWidth = (tool) => (tool === 'highlighter' ? 12 : 3);

const gbtnLocal = (ic, label, onClick, { active = false, text } = {}) => {
  const b = el(
    'button',
    { class: `gbtn${active ? ' active' : ''}`, type: 'button', title: label, 'aria-label': label },
    text ? el('span', { class: 'gtxt' }, text) : icon(ic, 20),
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.classList.remove('pulse');
    void b.offsetWidth;
    b.classList.add('pulse');
    onClick(e);
  });
  return b;
};
const divider = () => el('span', { class: 'gdiv', 'aria-hidden': 'true' });

function colorPopover(anchor, color, onPick) {
  document.querySelectorAll('.pop').forEach((n) => n.remove());
  const r = anchor.getBoundingClientRect();
  const custom = el('input', {
    type: 'color',
    value: /^#[0-9a-f]{6}$/i.test(color) ? color : '#0a84ff',
    oninput: () => {
      onPick(custom.value);
    },
  });
  const pop = el(
    'div',
    { class: 'pop glass swatch-pop', style: { left: `${Math.max(8, r.left - 60)}px`, top: `${r.bottom + 10}px` } },
    el('div', { class: 'pop-title' }, t('Color')),
    el(
      'div',
      { class: 'swatch-grid' },
      ...SWATCHES.map((c) =>
        el('button', {
          class: `swatch-btn${c.toLowerCase() === String(color).toLowerCase() ? ' on' : ''}`,
          type: 'button',
          title: c,
          style: { background: c },
          onclick: () => {
            onPick(c);
            pop.remove();
          },
        }),
      ),
    ),
    el('label', { class: 'swatch-custom' }, icon('palette', 14), t('Custom color'), custom),
  );
  document.body.append(pop);
  const off = (ev) => {
    if (!pop.contains(ev.target)) {
      pop.remove();
      window.removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => window.addEventListener('mousedown', off, true), 0);
}

// style = { color, width, pattern, fill }; opts = { pattern: bool, area: bool }; onChange(partial)
export function styleControls(style, opts, onChange) {
  const sw = el('span', { class: 'sw-dot', style: { background: style.color } });
  const colorBtn = el('button', { class: 'gbtn', type: 'button', title: t('Color'), 'aria-label': t('Color') }, sw);
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPopover(colorBtn, style.color, (c) => onChange({ color: c }));
  });
  const out = [
    colorBtn,
    divider(),
    gbtnLocal('minus', t('Thinner'), () => onChange({ width: Math.max(MIN_WIDTH, style.width - 1) })),
    el('span', { class: 'gcount', title: t('Thickness') }, `${style.width}px`),
    gbtnLocal('plus', t('Thicker'), () => onChange({ width: Math.min(MAX_WIDTH, style.width + 1) })),
  ];
  if (opts.pattern) {
    out.push(
      divider(),
      gbtnLocal(null, t('Solid'), () => onChange({ pattern: 'solid' }), {
        active: style.pattern === 'solid',
        text: '—',
      }),
      gbtnLocal(null, t('Dashed'), () => onChange({ pattern: 'dashed' }), {
        active: style.pattern === 'dashed',
        text: '╌',
      }),
      gbtnLocal(null, t('Dotted'), () => onChange({ pattern: 'dotted' }), {
        active: style.pattern === 'dotted',
        text: '┈',
      }),
    );
  }
  if (opts.area)
    out.push(
      divider(),
      gbtnLocal(
        'square',
        style.fill === 'solid' ? t('No fill') : t('Fill'),
        () => onChange({ fill: style.fill === 'solid' ? 'none' : 'solid' }),
        { active: style.fill === 'solid' },
      ),
    );
  return out;
}

export function drawBar(onTool, onStyle) {
  const tools = TOOLS.map(([id, ic, label]) => gbtnLocal(ic, t(label), () => onTool(id), { active: DRAW.tool === id }));
  const brush = DRAW.tool === 'brush' || DRAW.tool === 'highlighter' || DRAW.tool === 'smart';
  return [...tools, divider(), ...styleControls(DRAW, { pattern: !brush, area: AREA_TOOLS.has(DRAW.tool) }, onStyle)];
}

// ---------------------------------------------------------------- gesture → node options
const pad = (n) => Math.max(0, n);
export function drawingOptions(tool, pts, style = DRAW) {
  const first = pts[0],
    last = pts[pts.length - 1];
  const s = { color: style.color, width: style.width, pattern: style.pattern, fill: style.fill };
  if (tool === 'brush' || tool === 'highlighter') {
    const length = pts.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
    if (pts.length < 2 || length < 3) return null;
    return {
      kind: 'freehand',
      opts: {
        points: pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
        freehandType: tool === 'highlighter' ? 'highlighter' : 'pen',
        style: { color: s.color, width: s.width },
      },
    };
  }
  const x1 = Math.min(first.x, last.x),
    y1 = Math.min(first.y, last.y),
    w = Math.abs(last.x - first.x),
    h = Math.abs(last.y - first.y);
  if (Math.hypot(w, h) < 8) return null;
  if (tool === 'line' || tool === 'arrow') {
    const m = 12; // keep the end caps inside the frame
    const rect = {
      x: Math.round(x1 - m),
      y: Math.round(y1 - m),
      w: Math.round(Math.max(w, 1) + m * 2),
      h: Math.round(Math.max(h, 1) + m * 2),
    };
    const nx = (p) => Math.round(((p.x - rect.x) / rect.w) * 10000) / 10000,
      ny = (p) => Math.round(((p.y - rect.y) / rect.h) * 10000) / 10000;
    return {
      kind: 'stroke',
      opts: { strokeType: tool, rect, start: [nx(first), ny(first)], end: [nx(last), ny(last)], style: s },
    };
  }
  const rect = { x: Math.round(x1), y: Math.round(y1), w: Math.max(24, Math.round(w)), h: Math.max(24, Math.round(h)) };
  return { kind: 'shape', opts: { shapeType: tool, rect, style: s } };
}

export function selectionStyle(node, kind) {
  const c = node.content[kind]._0;
  const color =
    c.strokeColor && !/^#/.test(c.strokeColor)
      ? {
          blue: '#0a84ff',
          red: '#ff453a',
          green: '#30d158',
          orange: '#ff9f0a',
          purple: '#bf5af2',
          pink: '#ff375f',
          cyan: '#64d2ff',
          yellow: '#ffd60a',
          gray: '#8e8e93',
          black: '#1c1c1e',
          white: '#ffffff',
        }[c.strokeColor] || '#0a84ff'
      : c.strokeColor;
  return {
    color,
    width: c.strokeWidth,
    pattern: c.strokeStyle || 'solid',
    fill: c.fillStyle === 'solid' ? 'solid' : 'none',
  };
}
export function applySelectionStyle(content, kind, patch) {
  const c = content[kind]._0;
  if (patch.color !== undefined) {
    c.strokeColor = patch.color;
    if (kind === 'shape') c.fillColor = patch.color;
  }
  if (patch.width !== undefined) c.strokeWidth = patch.width;
  if (patch.pattern !== undefined && kind !== 'freehand') c.strokeStyle = patch.pattern;
  if (patch.fill !== undefined && kind === 'shape') c.fillStyle = patch.fill;
  return content;
}
export { pad };
