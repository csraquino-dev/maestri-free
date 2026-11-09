// Floating "glass" chrome over the canvas, modelled on Maestri's (found with REA):
//  • a main pill with the tools: select · terminal · note · attach · files · portal · text · draw
//  • a contextual pill that springs in below it when something is selected, with the actions
//    of that node type (terminal: edit | connect+badge | restart | delete).
import { el, kindOf, inner } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api, on, node as getNode, patchNode, setDoc, flush } from './store.js';
import * as canvas from './canvas.js';
import { CONNECTION_LISTS } from './ropes.js';
import { cyclePrompter, placementLabel } from './prompter.js';
import { DRAW, setDraw, defaultWidth, drawBar, styleControls, selectionStyle, applySelectionStyle } from './draw.js';

let H = {}; // handlers supplied by app.js
const mainPill = document.getElementById('main-pill');
const slot = document.getElementById('ctx-slot');
let ctxEl = null;
let ctxKey = '';

// ------------------------------------------------------------------ primitives
export function gbtn({ ic, label, onClick, active = false, disabled = false, text: txt }) {
  const b = el(
    'button',
    { class: `gbtn${active ? ' active' : ''}`, type: 'button', title: label, 'aria-label': label, disabled },
    txt ? el('span', { class: 'gtxt' }, txt) : icon(ic, 20),
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    b.classList.remove('pulse');
    void b.offsetWidth;
    b.classList.add('pulse'); // 0.38s scale pulse, like Maestri
    onClick && onClick(e);
  });
  return b;
}
const divider = () => el('span', { class: 'gdiv', 'aria-hidden': 'true' });

// ----------------------------------------------------------------- main pill
const TOOLS = [
  ['select', 'mouse-pointer-2', 'Select'],
  ['terminal', 'terminal', 'Add terminal / agent'],
  ['note', 'sticky-note', 'Add note'],
  ['attach', 'paperclip', 'Attach a file as a note'],
  ['fileTree', 'folder-tree', 'Add file tree'],
  ['portal', 'globe', 'Add portal (browser)'],
  ['text', 'type', 'Add text'],
  ['draw', 'pen-line', 'Shapes and lines'],
];

export function paintMain() {
  mainPill.replaceChildren(
    ...TOOLS.map(([id, ic, label]) => {
      const armed = S.mode === id;
      return gbtn({ ic, label: t(label), active: armed, onClick: (e) => H.pickTool(id, e.currentTarget) });
    }),
  );
}

// ------------------------------------------------------------- connections badge
function rowsFor(nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  const rows = [];
  const label = (id) => {
    const n = getNode(id);
    if (!n) return '?';
    const i = inner(n);
    return (i && (i.name || (i.fileName || '').replace(/\.md$/i, ''))) || t(kindOf(n));
  };
  for (const [list, fa, fb] of CONNECTION_LISTS) {
    for (const c of S.doc.payload[list]) {
      const a = ids.has(c[fa]),
        b = ids.has(c[fb]);
      if (!a && !b) continue;
      const other = a ? c[fb] : c[fa];
      const otherNode = getNode(other);
      rows.push({ list, id: c.id, other, label: label(other), kind: otherNode ? kindOf(otherNode) : 'unknown' });
    }
  }
  for (const c of S.doc.payload.crossFloorConnections || []) {
    const a = ids.has(c.terminalIdA),
      b = ids.has(c.terminalIdB);
    if (!a && !b) continue;
    const other = a ? c.terminalIdB : c.terminalIdA;
    rows.push({
      list: 'crossFloorConnections',
      id: c.id,
      other,
      label: label(other),
      kind: 'terminal',
      floorId: a ? c.floorIdB : c.floorIdA,
      floor: true,
    });
  }
  return rows;
}

function badge(nodes) {
  const rows = rowsFor(nodes);
  if (!rows.length) return null;
  const b = el('button', { class: 'badge-btn', title: t('Connections'), type: 'button' }, String(rows.length));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.pop').forEach((n) => n.remove());
    const r = b.getBoundingClientRect();
    const pop = el(
      'div',
      { class: 'pop glass', style: { left: `${Math.max(8, r.left - 80)}px`, top: `${r.bottom + 10}px` } },
      el('div', { class: 'pop-title' }, t('Connections')),
      ...rows.map((row) =>
        el(
          'div',
          { class: 'pop-row' },
          el(
            'button',
            {
              class: 'pop-main',
              onclick: () => {
                pop.remove();
                if (row.floor) H.jump(row.other, row.floorId);
                else canvas.focusNode(row.other);
              },
            },
            icon(
              row.kind === 'terminal'
                ? 'terminal'
                : row.kind === 'note'
                  ? 'sticky-note'
                  : row.kind === 'portal'
                    ? 'globe'
                    : 'link',
              14,
            ),
            row.label,
          ),
          el(
            'button',
            {
              class: 'pop-x',
              title: t('Disconnect'),
              onclick: async () => {
                pop.remove();
                flush();
                setDoc(S.wsId, await api.removeConnection(S.wsId, row.list, row.id));
              },
            },
            icon('unlink', 14),
          ),
        ),
      ),
      rows.length > 1
        ? el(
            'button',
            {
              class: 'pop-all',
              onclick: async () => {
                pop.remove();
                flush();
                for (const row of rows) setDoc(S.wsId, await api.removeConnection(S.wsId, row.list, row.id));
              },
            },
            icon('trash-2', 14),
            t('Disconnect all'),
          )
        : null,
    );
    document.body.append(pop);
    const off = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        window.removeEventListener('mousedown', off, true);
      }
    };
    setTimeout(() => window.addEventListener('mousedown', off, true), 0);
  });
  return b;
}

// ------------------------------------------------------- contextual contents
const selectedNodes = () =>
  [...S.selection]
    .map(getNode)
    .filter(Boolean)
    .filter((n) => (n.floorId || null) === (S.floorId || null));
const view = (id) => canvas.viewOf(id);

function contentFor(nodes) {
  const n = nodes[0];
  const kind = kindOf(n);
  const del = () => canvas.removeNodes(nodes.map((x) => x.id));
  const connect = () => canvas.beginConnect(n.id);
  const btns = [];
  const add = (...x) => btns.push(...x);

  if (nodes.length > 1) {
    add(
      gbtn({
        ic: 'layout-grid',
        label: t('Save as partitura'),
        onClick: () => H.savePartitura(nodes.map((x) => x.id)),
      }),
      divider(),
    );
    const notes = nodes.filter((x) => kindOf(x) === 'note');
    const stacks = nodes.filter((x) => kindOf(x) === 'noteStack');
    if (notes.length >= 2 && stacks.length === 0 && notes.length === nodes.length) {
      add(
        gbtn({
          ic: 'notebook-tabs',
          label: t('File notes into a stack'),
          onClick: () => H.stack('create', { ids: notes.map((x) => x.id) }),
        }),
        divider(),
      );
    } else if (stacks.length === 1 && notes.length >= 1 && notes.length + 1 === nodes.length) {
      add(
        gbtn({
          ic: 'notebook-tabs',
          label: t('Add notes to the stack'),
          onClick: () => H.stack('addNotes', { stackId: stacks[0].id, ids: notes.map((x) => x.id) }),
        }),
        divider(),
      );
    }
    const terms = nodes.filter((x) => kindOf(x) === 'terminal');
    const bands = nodes.filter((x) => kindOf(x) === 'band');
    if (terms.length >= 2 && terms.length === nodes.length)
      add(
        gbtn({
          ic: 'users',
          label: t('Group terminals in a band'),
          onClick: () => H.band('create', { ids: terms.map((x) => x.id) }),
        }),
        divider(),
      );
    else if (bands.length === 1 && terms.length >= 1 && terms.length + 1 === nodes.length)
      add(
        gbtn({
          ic: 'user-plus',
          label: t('Add terminals to the band'),
          onClick: () => H.band('addTerminals', { bandId: bands[0].id, ids: terms.map((x) => x.id) }),
        }),
        divider(),
      );
    if (nodes.length === 2)
      add(
        gbtn({
          ic: 'git-branch',
          label: t('Connect the two selected nodes (Ctrl+Shift+L)'),
          onClick: () => canvas.connectNodes(nodes[0].id, nodes[1].id),
        }),
        divider(),
      );
    add(
      el('span', { class: 'gcount' }, t('{n} selected', { n: nodes.length })),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Delete'), onClick: del }),
    );
    return btns;
  }

  if (kind === 'terminal') {
    const pl = S.prompter.terminalId === n.id ? S.prompter.placement : 'off';
    add(
      gbtn({ ic: 'square-pen', label: t('Edit terminal'), onClick: () => H.edit(n.id) }),
      divider(),
      gbtn({
        ic: pl === 'below' ? 'rows-3' : 'panel-bottom',
        label: placementLabel(pl) + ' (Ctrl+Shift+P)',
        active: pl !== 'off',
        onClick: () => cyclePrompter(n.id),
      }),
      divider(),
      gbtn({
        ic: 'message-square',
        label: t('Chat with the agent (Ctrl+J)'),
        onClick: () => view(n.id)?.toggleChat?.(),
      }),
      gbtn({ ic: 'git-branch', label: t('Connect'), onClick: connect }),
      S.doc.payload.floors.length
        ? gbtn({
            ic: 'arrow-right-left',
            label: t('Connect to a terminal on another floor'),
            onClick: () => H.overview(n.id),
          })
        : null,
      badge([n]),
      divider(),
      gbtn({ ic: 'rotate-cw', label: t('Restart terminal'), onClick: () => view(n.id)?.restart?.() }),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Delete terminal'), onClick: del }),
    );
  } else if (kind === 'note' || kind === 'noteStack') {
    const isStack = kind === 'noteStack';
    const d = isStack ? inner(n) : null;
    const front = isStack
      ? getNode(d.frontNoteId && d.memberNodeIds.includes(d.frontNoteId) ? d.frontNoteId : d.memberNodeIds[0])
      : n;
    const v = () => (isStack ? view(n.id)?.front?.() : view(n.id));
    if (isStack)
      add(
        gbtn({ ic: 'plus', label: t('New page'), onClick: () => H.stack('addPage', { stackId: n.id }) }),
        gbtn({
          ic: 'pencil',
          label: t('Rename stack'),
          onClick: () => H.promptName(t('Rename stack'), d.name, (name) => H.stack('rename', { stackId: n.id, name })),
        }),
        divider(),
      );
    add(
      gbtn({ ic: 'a-arrow-down', label: t('Decrease font size'), onClick: () => v()?.fontSize?.(-1) }),
      gbtn({ ic: 'a-arrow-up', label: t('Increase font size'), onClick: () => v()?.fontSize?.(1) }),
      divider(),
      gbtn({ ic: 'bold', label: t('Bold'), onClick: () => v()?.format?.('bold') }),
      gbtn({ ic: 'italic', label: t('Italic'), onClick: () => v()?.format?.('italic') }),
      gbtn({ ic: 'code', label: t('Code'), onClick: () => v()?.format?.('code') }),
      gbtn({ ic: 'hash', label: t('Heading'), onClick: () => v()?.format?.('heading') }),
      gbtn({ ic: 'list-todo', label: t('Insert to-do'), onClick: () => v()?.format?.('todo') }),
      gbtn({ ic: 'list', label: t('Insert bullet'), onClick: () => v()?.format?.('bullet') }),
      gbtn({ ic: 'braces', label: t('Code block'), onClick: () => v()?.format?.('codeblock') }),
      divider(),
      gbtn({
        ic: front && inner(front).isPreviewing ? 'pencil' : 'eye',
        label: front && inner(front).isPreviewing ? t('Raw') : t('Formatted'),
        onClick: () => v()?.togglePreview?.(),
      }),
      gbtn({ ic: 'palette', label: t('Color'), onClick: () => v()?.pickColor?.() }),
      divider(),
      ...(isStack
        ? [
            gbtn({
              ic: 'layers-2',
              label: d.uniformColor ? t('Free page colors') : t('Same color for all pages'),
              active: d.uniformColor,
              onClick: () => H.stack('toggleUniformColor', { stackId: n.id }),
            }),
            gbtn({
              ic: 'arrow-up-right',
              label: t('Take this page out'),
              onClick: () => front && H.stack('spill', { stackId: n.id, noteId: front.id }),
            }),
            gbtn({
              ic: 'unlink',
              label: t('Unstack all pages'),
              onClick: () => H.stack('unstackAll', { stackId: n.id }),
            }),
            divider(),
          ]
        : []),
      gbtn({ ic: 'git-branch', label: t('Connect'), onClick: connect }),
      badge([n]),
      divider(),
      gbtn({ ic: 'trash-2', label: isStack ? t('Delete stack') : t('Delete note'), onClick: del }),
    );
  } else if (kind === 'band') {
    const d = inner(n);
    const shownId = d.shownMemberId && d.memberNodeIds.includes(d.shownMemberId) ? d.shownMemberId : d.memberNodeIds[0];
    const member = getNode(shownId);
    if (member) {
      const pl = S.prompter.terminalId === member.id ? S.prompter.placement : 'off';
      add(
        gbtn({ ic: 'square-pen', label: t('Edit terminal'), onClick: () => H.edit(member.id) }),
        divider(),
        gbtn({
          ic: pl === 'below' ? 'rows-3' : 'panel-bottom',
          label: placementLabel(pl) + ' (Ctrl+Shift+P)',
          active: pl !== 'off',
          onClick: () => cyclePrompter(member.id),
        }),
        divider(),
        gbtn({ ic: 'git-branch', label: t('Connect'), onClick: () => canvas.beginConnect(n.id) }),
        badge([n]),
        divider(),
        gbtn({ ic: 'rotate-cw', label: t('Restart terminal'), onClick: () => view(n.id)?.restart?.() }),
        divider(),
      );
    }
    add(
      gbtn({
        ic: 'pencil',
        label: t('Rename band'),
        onClick: () => H.promptName(t('Rename band'), d.name, (name) => H.band('rename', { bandId: n.id, name })),
      }),
      gbtn({
        ic: 'plus',
        label: t('New terminal in this band'),
        onClick: () => H.band('addNewMember', { bandId: n.id }),
      }),
      gbtn({
        ic: 'arrow-up-right',
        label: t('Take this terminal out'),
        onClick: () => member && H.band('removeMember', { bandId: n.id, id: member.id }),
      }),
      gbtn({ ic: 'unlink', label: t('Dissolve band'), onClick: () => H.band('dissolve', { bandId: n.id }) }),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Delete band'), onClick: del }),
    );
  } else if (kind === 'portal') {
    const hidden = !!inner(n).chromeHidden;
    add(
      gbtn({ ic: 'rotate-cw', label: t('Reload'), onClick: () => view(n.id)?.reload?.() }),
      divider(),
      gbtn({ ic: 'git-branch', label: t('Connect'), onClick: connect }),
      badge([n]),
      divider(),
      gbtn({
        ic: hidden ? 'panel-top-open' : 'panel-top-close',
        label: hidden ? t('Show address bar') : t('Hide address bar'),
        onClick: () => view(n.id)?.toggleChrome?.(),
      }),
      gbtn({ ic: 'sliders-horizontal', label: t('Edit'), onClick: () => H.edit(n.id) }),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Close portal'), onClick: del }),
    );
  } else if (kind === 'fileTree') {
    add(
      gbtn({ ic: 'git-branch', label: t('Git changes'), onClick: () => H.git(inner(n).rootPath) }),
      divider(),
      gbtn({ ic: 'folder-open', label: t('Reveal in Explorer'), onClick: () => api.openPath(inner(n).rootPath) }),
      gbtn({ ic: 'folder-cog', label: t('Change folder'), onClick: () => H.edit(n.id) }),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Delete file tree'), onClick: del }),
    );
  } else if (kind === 'text') {
    const t_ = inner(n);
    const set = (patch) => {
      const c = JSON.parse(JSON.stringify(getNode(n.id).content));
      Object.assign(c.text._0, patch);
      patchNode(n.id, { content: c });
    };
    add(
      gbtn({
        text: 'R',
        label: t('Regular'),
        active: t_.fontWeight === 'regular',
        onClick: () => set({ fontWeight: 'regular' }),
      }),
      gbtn({
        text: 'M',
        label: t('Medium'),
        active: t_.fontWeight === 'medium',
        onClick: () => set({ fontWeight: 'medium' }),
      }),
      gbtn({
        text: 'B',
        label: t('Bold'),
        active: t_.fontWeight === 'bold',
        onClick: () => set({ fontWeight: 'bold' }),
      }),
      divider(),
      gbtn({
        text: 'Aa',
        label: t('Sans-serif'),
        active: t_.fontFamily === 'sans',
        onClick: () => set({ fontFamily: 'sans' }),
      }),
      gbtn({
        text: 'Ag',
        label: t('Serif'),
        active: t_.fontFamily === 'serif',
        onClick: () => set({ fontFamily: 'serif' }),
      }),
      gbtn({
        text: '</>',
        label: t('Monospaced'),
        active: t_.fontFamily === 'mono',
        onClick: () => set({ fontFamily: 'mono' }),
      }),
      divider(),
      gbtn({
        ic: 'a-arrow-down',
        label: t('Decrease font size'),
        onClick: () => set({ fontSize: Math.max(8, t_.fontSize - 2) }),
      }),
      gbtn({
        ic: 'a-arrow-up',
        label: t('Increase font size'),
        onClick: () => set({ fontSize: Math.min(120, t_.fontSize + 2) }),
      }),
      divider(),
      gbtn({ ic: 'trash-2', label: t('Delete'), onClick: del }),
    );
  } else if (kind === 'shape' || kind === 'stroke' || kind === 'freehand') {
    const st = selectionStyle(n, kind);
    add(
      ...styleControls(st, { pattern: kind !== 'freehand', area: kind === 'shape' }, (patch) => {
        const c = JSON.parse(JSON.stringify(getNode(n.id).content));
        applySelectionStyle(c, kind, patch);
        patchNode(n.id, { content: c });
      }),
    );
    if (kind !== 'freehand') add(divider(), gbtn({ ic: 'square-pen', label: t('Edit'), onClick: () => H.edit(n.id) }));
    add(divider(), gbtn({ ic: 'trash-2', label: t('Delete'), onClick: del }));
  } else return null;
  return btns;
}

function drawContent() {
  return drawBar(
    (tool) => {
      setDraw({ tool, width: tool === 'highlighter' || tool === 'brush' ? defaultWidth(tool) : DRAW.width });
      ctxKey = '';
      updateContext();
    },
    (patch) => {
      setDraw(patch);
      ctxKey = '';
      updateContext();
    },
  );
}

function updateContext() {
  if (S.mode === 'draw') {
    const key = `draw|${JSON.stringify(DRAW)}`;
    if (key === ctxKey && ctxEl) return;
    const wasDraw = ctxKey.startsWith('draw|');
    ctxKey = key;
    const pill = el(
      'div',
      { class: 'glass pill ctx-pill', 'data-contextual-toolbar': 'draw', role: 'toolbar' },
      ...drawContent(),
    );
    if (ctxEl) {
      ctxEl.replaceWith(pill);
      ctxEl = pill;
      if (!wasDraw) animateIn(pill);
    } else {
      ctxEl = pill;
      slot.replaceChildren(pill);
      animateIn(pill);
    }
    return;
  }
  const nodes = selectedNodes();
  const key = nodes.map((n) => n.id).join(',');
  const kindKey = nodes.length
    ? `${key}|${nodes.map((n) => kindOf(n) + (kindOf(n) === 'note' ? inner(n).isPreviewing : '') + (kindOf(n) === 'portal' ? inner(n).chromeHidden : '') + (['text', 'shape', 'stroke', 'freehand', 'noteStack', 'band'].includes(kindOf(n)) ? JSON.stringify(inner(n)) : '')).join(',')}|${S.doc.payload.connections.length + S.doc.payload.noteConnections.length + S.doc.payload.portalConnections.length + S.doc.payload.noteToNoteConnections.length + S.doc.payload.portalToPortalConnections.length}`
    : '';
  if (kindKey === ctxKey) return;
  const hadOne = !!ctxEl;
  ctxKey = kindKey;
  const content = nodes.length ? contentFor(nodes) : null;
  if (!content) {
    hideContext();
    ctxKey = '';
    return;
  }
  const pill = el(
    'div',
    { class: 'glass pill ctx-pill', 'data-contextual-toolbar': 'true' },
    ...content.filter(Boolean),
  );
  if (ctxEl && hadOne) {
    ctxEl.replaceWith(pill);
    ctxEl = pill;
    return;
  } // same selection, refresh in place (no re-animation)
  ctxEl = pill;
  slot.replaceChildren(pill);
  animateIn(pill);
}

function animateIn(pill) {
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // spring in: y -24 → 0, scale .9 → 1 with a visible overshoot (bounce .4)
    pill.animate(
      [
        { opacity: 0, transform: 'translateY(-24px) scale(.9)' },
        { opacity: 1, transform: 'translateY(3px) scale(1.03)', offset: 0.55 },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ],
      { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)' },
    );
  } else pill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
}

function hideContext() {
  if (!ctxEl) return;
  const pill = ctxEl;
  ctxEl = null;
  const done = () => pill.remove();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
  pill.animate(
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-8px) scale(.96)' },
    ],
    { duration: 150, easing: 'ease-out' },
  ).onfinish = done;
}

export function initChrome(handlers) {
  H = handlers;
  S.mode = 'select';
  paintMain();
  on('selection', updateContext);
  on('doc', updateContext);
  on('prompter', () => {
    ctxKey = '';
    updateContext();
  });
}
export const refreshChrome = () => {
  paintMain();
  ctxKey = '';
  updateContext();
};
export function setMode(mode) {
  S.mode = mode;
  ctxKey = '';
  paintMain();
  updateContext();
  document.getElementById('viewport').classList.toggle('placing', mode !== 'select' && mode !== 'draw');
  document.getElementById('viewport').classList.toggle('drawing', mode === 'draw');
}
