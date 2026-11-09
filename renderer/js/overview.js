// Floor overview (Ctrl+Shift+\): every floor as a card with a minimap of its nodes and its terminals as chips.
// Click a terminal, then a terminal on another floor, to join them with a cross-floor rope; click a link to cut it.
import { el, kindOf, inner, rectOf, toast } from './util.js';
import { S, api, setDoc, flush } from './store.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const KIND_COLOR = {
  terminal: '#0a84ff',
  note: '#ffd60a',
  noteStack: '#ff9f0a',
  band: '#bf5af2',
  portal: '#30d158',
  fileTree: '#64d2ff',
  text: '#8e8e93',
  shape: '#8e8e93',
  stroke: '#8e8e93',
  freehand: '#8e8e93',
  connector: '#ff375f',
};
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

let open = null;

export function isOverviewOpen() {
  return !!open;
}
export function closeOverview() {
  if (open) open.close();
}

export function openOverview({ goFloor, focusNode, pick = null } = {}) {
  if (open) {
    open.close();
    return;
  }
  let picked = pick; // terminal id waiting for its partner
  const root = document.getElementById('modal-root');
  const grid = el('div', { class: 'ov-grid' });
  const links = svgEl('svg', { class: 'ov-links' });
  const hint = el('div', { class: 'ov-hint' });
  const wrap = el('div', { class: 'ov-wrap' }, grid, links);
  const bg = el(
    'div',
    {
      class: 'ov-bg',
      onmousedown: (e) => {
        if (e.target === bg) close();
      },
    },
    el(
      'div',
      { class: 'ov' },
      el(
        'div',
        { class: 'ov-head' },
        icon('layout-grid', 18),
        el('h3', {}, t('Floor overview')),
        el('span', { class: 'grow' }),
        hint,
        el('button', { class: 'btn-x', title: t('Close'), onclick: () => close() }, icon('x', 16)),
      ),
      wrap,
    ),
  );
  const esc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (picked) {
        picked = null;
        render();
      } else close();
    }
  };
  const onResize = () => drawLinks();
  function close() {
    bg.remove();
    window.removeEventListener('keydown', esc, true);
    window.removeEventListener('resize', onResize);
    open = null;
  }
  open = { close };

  const levels = () => [
    { id: null, name: t('Ground'), branch: '', icon: 'house' },
    ...S.doc.payload.floors.map((f) => ({ id: f.id, name: f.name, branch: f.branchName, icon: 'git-branch' })),
  ];
  const nodesOf = (id) => S.doc.payload.nodes.filter((n) => (n.floorId || null) === id);
  const termName = (n) => (inner(n) && inner(n).name) || t('Terminal');

  function minimap(nodes) {
    const shown = nodes.filter((n) => !['stroke', 'freehand'].includes(kindOf(n)));
    const svg = svgEl('svg', { class: 'ov-mini' });
    if (!shown.length) {
      svg.setAttribute('viewBox', '0 0 100 50');
      return svg;
    }
    const rs = shown.map((n) => ({ n, r: rectOf(n) }));
    const x0 = Math.min(...rs.map((o) => o.r.x)),
      y0 = Math.min(...rs.map((o) => o.r.y));
    const x1 = Math.max(...rs.map((o) => o.r.x + o.r.w)),
      y1 = Math.max(...rs.map((o) => o.r.y + o.r.h));
    const pad = 40;
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const { n, r } of rs)
      svg.append(
        svgEl('rect', {
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          rx: 14,
          fill: KIND_COLOR[kindOf(n)] || '#8e8e93',
          'fill-opacity': 0.55,
          stroke: KIND_COLOR[kindOf(n)] || '#8e8e93',
          'stroke-width': 6,
        }),
      );
    return svg;
  }

  async function onChip(term, level) {
    if (!picked) {
      picked = term.id;
      render();
      return;
    }
    if (picked === term.id) {
      picked = null;
      render();
      return;
    }
    const first = S.doc.payload.nodes.find((n) => n.id === picked);
    if (!first || (first.floorId || null) === level.id) {
      picked = term.id;
      render();
      return;
    }
    flush();
    const r = await api.connect(S.wsId, picked, term.id);
    picked = null;
    if (!r.ok) toast(t('Those terminals are already connected.'));
    setDoc(S.wsId, r.doc);
    render();
  }

  function render() {
    hint.textContent = picked
      ? t('Now click a terminal on a different floor (Esc cancels).')
      : t('Click a terminal, then one on another floor, to connect them.');
    grid.replaceChildren(
      ...levels().map((lv) => {
        const nodes = nodesOf(lv.id);
        const terms = nodes.filter((n) => n.content.terminal);
        const here = (S.floorId || null) === lv.id;
        return el(
          'section',
          { class: `ov-card${here ? ' here' : ''}` },
          el(
            'header',
            {},
            icon(lv.icon, 16),
            el('b', {}, lv.name),
            lv.branch ? el('span', { class: 'ov-branch' }, lv.branch) : null,
            el('span', { class: 'grow' }),
            el(
              'span',
              { class: 'ov-count' },
              t('{n} nodes', { n: nodes.filter((n) => !n.content.crossFloorConnector).length }),
            ),
            el(
              'button',
              {
                class: 'btn-ghost sm',
                onclick: () => {
                  close();
                  goFloor(lv.id);
                },
              },
              icon('arrow-right', 12),
              t('Open'),
            ),
          ),
          minimap(nodes),
          el(
            'div',
            { class: 'ov-chips' },
            ...(terms.length
              ? terms.map((n) =>
                  el(
                    'button',
                    {
                      class: `ov-chip${picked === n.id ? ' picked' : ''}`,
                      dataset: { term: n.id },
                      title: t('Click to connect · double-click to open'),
                      onclick: () => onChip(n, lv),
                      ondblclick: () => {
                        close();
                        focusNode(n.id, lv.id);
                      },
                    },
                    icon('terminal', 12),
                    termName(n),
                  ),
                )
              : [el('span', { class: 'ov-none' }, t('No terminals'))]),
          ),
        );
      }),
    );
    requestAnimationFrame(drawLinks);
  }

  function drawLinks() {
    links.replaceChildren();
    const box = wrap.getBoundingClientRect();
    links.setAttribute('width', box.width);
    links.setAttribute('height', box.height);
    const pos = (id) => {
      const c = grid.querySelector(`[data-term="${id}"]`);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
    };
    for (const c of S.doc.payload.crossFloorConnections) {
      const a = pos(c.terminalIdA),
        b = pos(c.terminalIdB);
      if (!a || !b) continue;
      const sag = 40 + Math.abs(a.y - b.y) * 0.1;
      const d = `M${a.x},${a.y} C${a.x},${a.y + sag} ${b.x},${b.y + sag} ${b.x},${b.y}`;
      links.append(svgEl('path', { d, class: 'ov-rope' }));
      const hit = svgEl('path', { d, class: 'ov-rope-hit' });
      const title = svgEl('title');
      title.textContent = t('Click to disconnect');
      hit.append(title);
      hit.addEventListener('click', async () => {
        flush();
        setDoc(S.wsId, await api.removeConnection(S.wsId, 'crossFloorConnections', c.id));
        render();
      });
      links.append(hit);
    }
  }

  root.append(bg);
  window.addEventListener('keydown', esc, true);
  window.addEventListener('resize', onResize);
  render();
}
