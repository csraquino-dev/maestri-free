// Infinite canvas: pan/zoom, node drag/resize/selection, ropes (connections), minimap.
import { rectOf, frameOf, kindOf, clamp, toast } from './util.js';
import { S, on, emit, api, patchNode, commitView, setDoc, select, bringToFront, flush, visibleNodes } from './store.js';
import { t } from './i18n.js';
import * as ropes from './ropes.js';
import { closestEdgeMidpointToPoint, staticRopePoints, buildSmoothPath } from './rope-sim.js';
import { DRAW, AREA_TOOLS, drawingOptions } from './draw.js';
import { recognizeShape } from './shape-recognizer.js';
import { createNodeView } from './nodes.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const GRID = 16;
const MIN_SIZE = { terminal: [200, 100], note: [120, 80], default: [160, 100] };

const views = new Map(); // nodeId -> controller
const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const nodesEl = document.getElementById('nodes');
const ropesEl = document.getElementById('ropes');
const overlay = document.getElementById('overlay');
const marquee = document.getElementById('marquee');
const minimap = document.getElementById('minimap');
const zoomLabel = document.getElementById('zoom-label');
const emptyHint = document.getElementById('empty-hint');

let ctxHooks = { edit: () => {} };
export const setHooks = (h) => (ctxHooks = h);

// -------------------------------------------------------------------- coordinates
const vpRect = () => viewport.getBoundingClientRect();
export function toCanvas(clientX, clientY) {
  const r = vpRect();
  return { x: S.view.ox + (clientX - r.left) / S.view.zoom, y: S.view.oy + (clientY - r.top) / S.view.zoom };
}
export function viewportCenter() {
  const r = vpRect();
  return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
}

export function applyView() {
  const { ox, oy, zoom } = S.view;
  world.style.transform = `translate(${-ox * zoom}px, ${-oy * zoom}px) scale(${zoom})`;
  const g = GRID * zoom;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${-(ox * zoom) % g}px ${-(oy * zoom) % g}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  scheduleMinimap();
}

export function setZoom(z, anchorClient) {
  const r = vpRect();
  const ax = anchorClient ? anchorClient.x - r.left : r.width / 2;
  const ay = anchorClient ? anchorClient.y - r.top : r.height / 2;
  const nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
  const cx = S.view.ox + ax / S.view.zoom;
  const cy = S.view.oy + ay / S.view.zoom;
  S.view = { zoom: nz, ox: cx - ax / nz, oy: cy - ay / nz };
  applyView();
  commitView();
}

export function panTo(cx, cy) {
  const r = vpRect();
  S.view.ox = cx - r.width / 2 / S.view.zoom;
  S.view.oy = cy - r.height / 2 / S.view.zoom;
  applyView();
  commitView();
}

export function fitAll() {
  const nodes = visibleNodes();
  if (!nodes.length) return;
  const bb = bbox(nodes);
  const r = vpRect();
  const m = 60;
  const z = clamp(Math.min((r.width - m * 2) / bb.w, (r.height - m * 2) / bb.h), MIN_ZOOM, 1);
  S.view.zoom = z;
  S.view.ox = bb.x + bb.w / 2 - r.width / 2 / z;
  S.view.oy = bb.y + bb.h / 2 - r.height / 2 / z;
  applyView();
  commitView();
}

function bbox(nodes) {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const n of nodes) {
    const r = rectOf(n);
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------- rendering
const nodeCtx = {
  git: (root) => ctxHooks.git && ctxHooks.git(root),
  jump: (id, floorId) => ctxHooks.jump && ctxHooks.jump(id, floorId),
  disconnectCross: async (connId) => {
    flush();
    setDoc(S.wsId, await api.removeConnection(S.wsId, 'crossFloorConnections', connId));
  },
  remove: (ids) => removeNodes(ids),
  contextMenu: (e, id) => ctxHooks.nodeMenu && ctxHooks.nodeMenu(e, id),
  edit: (id) => ctxHooks.edit(id),
};

export async function removeNodes(ids) {
  const bands = ids.filter((id) => S.doc.payload.nodes.some((n) => n.id === id && n.content.band));
  if (bands.length) {
    const rest = ids.filter((id) => !bands.includes(id));
    for (const id of bands) await ctxHooks.deleteBand(id);
    ids = rest;
    if (!ids.length) return;
  }
  const stacks = ids.filter((id) => S.doc.payload.nodes.some((n) => n.id === id && n.content.noteStack));
  if (stacks.length) {
    const rest = ids.filter((id) => !stacks.includes(id));
    for (const id of stacks) await ctxHooks.deleteStack(id);
    ids = rest;
    if (!ids.length) return;
  }
  const terms = ids.filter((id) => S.doc.payload.nodes.find((n) => n.id === id && n.content.terminal));
  if (
    terms.length &&
    !confirm(
      terms.length > 1
        ? t('Close {n} terminals? Running processes will be stopped.', { n: terms.length })
        : t('Close this terminal? Running processes will be stopped.'),
    )
  )
    return;
  flush();
  const doc = await api.removeNodes(S.wsId, ids);
  setDoc(S.wsId, doc);
}

function sig(n) {
  return JSON.stringify(n.content);
}

export function render() {
  const nodes = visibleNodes();
  const alive = new Set(nodes.map((n) => n.id));
  for (const [id, v] of views) {
    if (!alive.has(id)) {
      v.destroy();
      v.el.remove();
      views.delete(id);
    }
  }
  for (const n of nodes) {
    let v = views.get(n.id);
    if (!v) {
      v = createNodeView(n, nodeCtx);
      v.sig = sig(n);
      views.set(n.id, v);
      nodesEl.append(v.el);
      v.mount();
    } else {
      const s = sig(n);
      if (s !== v.sig) {
        v.sig = s;
        v.update(n);
      }
    }
    const r = rectOf(n);
    const st = v.el.style;
    st.left = `${r.x}px`;
    st.top = `${r.y}px`;
    st.width = `${r.w}px`;
    st.height = `${r.h}px`;
    st.zIndex = String(n.zIndex || 0);
    v.el.classList.toggle('selected', S.selection.has(n.id));
  }
  emptyHint.hidden = nodes.length > 0;
  drawRopes();
  scheduleMinimap();
}

export const viewOf = (id) =>
  views.get(id) || [...views.values()].map((v) => v.memberView && v.memberView(id)).find(Boolean);
export const allViews = () => views;

// ------------------------------------------------------------------------- ropes
// Physics, drawing and persistence live in ropes.js (+ rope-sim.js).
export const drawRopes = () => ropes.sync();
export const setConnStatus = (id, st) => ropes.setConnStatus(id, st);

// ----------------------------------------------------------------------- minimap
let mmRaf = 0;
function scheduleMinimap() {
  cancelAnimationFrame(mmRaf);
  mmRaf = requestAnimationFrame(drawMinimap);
}
let mmMap = null;
function drawMinimap() {
  if (!S.doc) return;
  const ctx = minimap.getContext('2d');
  const W = minimap.width,
    H = minimap.height;
  ctx.clearRect(0, 0, W, H);
  const r = vpRect();
  const vw = r.width / S.view.zoom,
    vh = r.height / S.view.zoom;
  const view = { x: S.view.ox, y: S.view.oy, w: vw, h: vh };
  const nodes = visibleNodes();
  const all = nodes.map(rectOf).concat([view]);
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const a of all) {
    x1 = Math.min(x1, a.x);
    y1 = Math.min(y1, a.y);
    x2 = Math.max(x2, a.x + a.w);
    y2 = Math.max(y2, a.y + a.h);
  }
  const pad = 40;
  x1 -= pad;
  y1 -= pad;
  x2 += pad;
  y2 += pad;
  const s = Math.min(W / (x2 - x1), H / (y2 - y1));
  const ox = (W - (x2 - x1) * s) / 2,
    oy = (H - (y2 - y1) * s) / 2;
  mmMap = { x1, y1, s, ox, oy };
  const tx = (x) => ox + (x - x1) * s,
    ty = (y) => oy + (y - y1) * s;
  const cs = getComputedStyle(document.documentElement);
  const colors = {
    terminal: '#0a84ff',
    note: '#d4b800',
    portal: '#bf5af2',
    fileTree: '#30d158',
    text: '#8b8d96',
    shape: '#ff9f0a',
    stroke: '#ff9f0a',
  };
  for (const n of nodes) {
    const a = rectOf(n);
    ctx.fillStyle = colors[kindOf(n)] || '#888';
    ctx.globalAlpha = 0.75;
    ctx.fillRect(tx(a.x), ty(a.y), Math.max(2, a.w * s), Math.max(2, a.h * s));
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cs.getPropertyValue('--text').trim() || '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx(view.x), ty(view.y), view.w * s, view.h * s);
}
minimap.addEventListener('mousedown', (e) => {
  if (!mmMap) return;
  const move = (ev) => {
    const rect = minimap.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * minimap.width;
    const py = ((ev.clientY - rect.top) / rect.height) * minimap.height;
    panTo(mmMap.x1 + (px - mmMap.ox) / mmMap.s, mmMap.y1 + (py - mmMap.oy) / mmMap.s);
  };
  move(e);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  e.stopPropagation();
});

// ----------------------------------------------------------------------- interaction
let spaceDown = false;
const interacting = (on) => document.body.classList.toggle('interacting', on);

function startPan(e) {
  const start = { x: e.clientX, y: e.clientY, ox: S.view.ox, oy: S.view.oy };
  viewport.classList.add('panning');
  interacting(true);
  const move = (ev) => {
    S.view.ox = start.ox - (ev.clientX - start.x) / S.view.zoom;
    S.view.oy = start.oy - (ev.clientY - start.y) / S.view.zoom;
    applyView();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    viewport.classList.remove('panning');
    interacting(false);
    commitView();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startNodeDrag(e, id) {
  if (!S.selection.has(id)) select([id], e.shiftKey);
  else if (e.shiftKey) {
    select([id], true);
    return;
  }
  bringToFront(id);
  const ids = [...S.selection];
  const starts = new Map(ids.map((i) => [i, rectOf(S.doc.payload.nodes.find((n) => n.id === i))]));
  const sx = e.clientX,
    sy = e.clientY;
  let moved = false;
  interacting(true);
  const move = (ev) => {
    const dx = (ev.clientX - sx) / S.view.zoom,
      dy = (ev.clientY - sy) / S.view.zoom;
    if (!moved && Math.hypot(dx, dy) * S.view.zoom < 3) return;
    if (!moved) {
      flush();
      api.historyCheckpoint(S.wsId);
    }
    moved = true;
    for (const [i, r] of starts) {
      const n = S.doc.payload.nodes.find((x) => x.id === i);
      if (!n || n.isLocked) continue;
      n.frame = frameOf({ ...r, x: Math.round(r.x + dx), y: Math.round(r.y + dy) });
      const v = views.get(i);
      v.el.style.left = `${n.frame[0][0]}px`;
      v.el.style.top = `${n.frame[0][1]}px`;
    }
    ropes.setMoving(new Set(ids));
    drawRopes();
    scheduleMinimap();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    interacting(false);
    ropes.setMoving(new Set());
    if (moved)
      for (const i of ids) {
        const n = S.doc.payload.nodes.find((x) => x.id === i);
        if (n) patchNode(i, { frame: n.frame }, { silent: true });
      }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startResize(e, id, edge) {
  const n = S.doc.payload.nodes.find((x) => x.id === id);
  if (!n || n.isLocked) return;
  select([id]);
  bringToFront(id);
  const r0 = rectOf(n);
  const [minW, minH] = MIN_SIZE[kindOf(n)] || MIN_SIZE.default;
  const sx = e.clientX,
    sy = e.clientY;
  interacting(true);
  flush();
  api.historyCheckpoint(S.wsId);
  const move = (ev) => {
    const dx = (ev.clientX - sx) / S.view.zoom,
      dy = (ev.clientY - sy) / S.view.zoom;
    let { x, y, w, h } = r0;
    if (edge.includes('e')) w = Math.max(minW, r0.w + dx);
    if (edge.includes('s')) h = Math.max(minH, r0.h + dy);
    if (edge.includes('w')) {
      w = Math.max(minW, r0.w - dx);
      x = r0.x + (r0.w - w);
    }
    if (edge.includes('n')) {
      h = Math.max(minH, r0.h - dy);
      y = r0.y + (r0.h - h);
    }
    n.frame = frameOf({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    const st = views.get(id).el.style;
    st.left = `${x}px`;
    st.top = `${y}px`;
    st.width = `${w}px`;
    st.height = `${h}px`;
    ropes.setMoving(new Set([id]));
    drawRopes();
    scheduleMinimap();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    interacting(false);
    ropes.setMoving(new Set());
    patchNode(id, { frame: n.frame }, { silent: true });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startConnect(e, fromId) {
  const from = S.doc.payload.nodes.find((n) => n.id === fromId);
  const a = rectOf(from);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'rope');
  line.style.pointerEvents = 'none';
  line.style.strokeDasharray = '6 5';
  overlay.replaceChildren(line);
  interacting(true);
  const r = vpRect();
  const sx = (a.x + a.w - S.view.ox) * S.view.zoom,
    sy = (a.y + a.h / 2 - S.view.oy) * S.view.zoom;
  let target = null;
  const move = (ev) => {
    const x = ev.clientX - r.left,
      y = ev.clientY - r.top;
    line.setAttribute('d', `M${sx},${sy} Q${(sx + x) / 2},${Math.max(sy, y) + 40} ${x},${y}`);
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = under && under.closest && under.closest('.node');
    const id = nodeEl && nodeEl.dataset.id !== fromId ? nodeEl.dataset.id : null;
    if (target !== id) {
      target && views.get(target) && views.get(target).el.classList.remove('link-target');
      target = id;
      target && views.get(target).el.classList.add('link-target');
    }
  };
  const up = async () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    overlay.replaceChildren();
    interacting(false);
    if (target) {
      views.get(target)?.el.classList.remove('link-target');
      await connectNodes(fromId, target);
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  move(e);
}

// ---- draw mode: drag to paint (pen / highlighter) or to size a line, arrow or shape
function startDraw(e) {
  const tool = DRAW.tool;
  const r = vpRect();
  const screen = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
  const world = [toCanvas(e.clientX, e.clientY)];
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const color = DRAW.color;
  const hl = tool === 'highlighter';
  const freehand = tool === 'brush' || tool === 'highlighter' || tool === 'smart';
  pathEl.setAttribute('fill', AREA_TOOLS.has(tool) && DRAW.fill === 'solid' ? color : 'none');
  pathEl.setAttribute('fill-opacity', '0.22');
  pathEl.setAttribute('stroke', color);
  pathEl.setAttribute('stroke-width', String(DRAW.width * S.view.zoom));
  pathEl.setAttribute('stroke-linecap', 'round');
  pathEl.setAttribute('stroke-linejoin', 'round');
  pathEl.setAttribute('stroke-opacity', hl ? '0.4' : '1');
  if (!freehand && DRAW.pattern !== 'solid')
    pathEl.setAttribute(
      'stroke-dasharray',
      DRAW.pattern === 'dashed' ? `${DRAW.width * 4} ${DRAW.width * 3}` : `${DRAW.width} ${DRAW.width * 2}`,
    );
  overlay.replaceChildren(pathEl);
  interacting(true);
  const shapePath = (a, b) => {
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y),
      w = Math.abs(b.x - a.x),
      h = Math.abs(b.y - a.y);
    if (tool === 'rect') return `M${x},${y} h${w} v${h} h${-w} z`;
    if (tool === 'ellipse') return `M${x + w / 2},${y} a${w / 2},${h / 2} 0 1 0 0.01,0 z`;
    if (tool === 'diamond')
      return `M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} z`;
    return `M${a.x},${a.y} L${b.x},${b.y}`;
  };
  const move = (ev) => {
    const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (freehand) {
      const last = screen[screen.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 2) return;
      screen.push(p);
      world.push(toCanvas(ev.clientX, ev.clientY));
      pathEl.setAttribute('d', 'M' + screen.map((q) => `${q.x},${q.y}`).join(' L'));
    } else {
      screen[1] = p;
      world[1] = toCanvas(ev.clientX, ev.clientY);
      pathEl.setAttribute('d', shapePath(screen[0], p));
    }
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    overlay.replaceChildren();
    interacting(false);
    let useTool = tool,
      pts = world.length > 1 || freehand ? world : [world[0], world[0]];
    if (tool === 'smart') {
      const rec = recognizeShape(world);
      useTool = rec.tool === 'pen' ? 'brush' : rec.tool;
      pts = rec.points;
      if (useTool !== 'brush')
        toast(
          t('Recognized: {shape}', {
            shape: {
              line: t('Line'),
              arrow: t('Arrow'),
              rect: t('Rectangle'),
              ellipse: t('Ellipse'),
              diamond: t('Diamond'),
            }[useTool],
          }),
        );
    }
    const made = drawingOptions(useTool, pts);
    if (made && ctxHooks.draw) ctxHooks.draw(made);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---- click-to-connect mode (the toolbar's Connect button): a dashed accent preview rope follows
// the pointer from the nearest edge of the source node; click another node to connect, Esc to cancel.
let connecting = null;
export const isConnecting = () => connecting !== null;
export function cancelConnect() {
  if (!connecting) return;
  window.removeEventListener('mousemove', connecting.move, true);
  window.removeEventListener('click', connecting.click, true);
  window.removeEventListener('keydown', connecting.key, true);
  overlay.replaceChildren();
  viewport.classList.remove('connecting');
  for (const v of views.values()) v.el.classList.remove('link-target');
  connecting = null;
}
export function beginConnect(fromId) {
  cancelConnect();
  const from = S.doc.payload.nodes.find((n) => n.id === fromId);
  if (!from) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'rope-preview');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('r', '3');
  dot.setAttribute('class', 'rope-preview-dot');
  overlay.replaceChildren(path, dot);
  viewport.classList.add('connecting');
  const r = vpRect();
  const toScreen = (p) => ({ x: (p.x - S.view.ox) * S.view.zoom, y: (p.y - S.view.oy) * S.view.zoom });
  let hover = null;
  const move = (ev) => {
    const world = toCanvas(ev.clientX, ev.clientY);
    const start = closestEdgeMidpointToPoint(rectOf(from), world);
    const pts = staticRopePoints(start, world).map(toScreen);
    path.setAttribute('d', buildSmoothPath(pts));
    const tip = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    dot.setAttribute('cx', tip.x);
    dot.setAttribute('cy', tip.y);
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const nodeEl = under && under.closest && under.closest('.node');
    const id = nodeEl && nodeEl.dataset.id !== fromId ? nodeEl.dataset.id : null;
    if (id !== hover) {
      hover && views.get(hover)?.el.classList.remove('link-target');
      hover = id;
      hover && views.get(hover)?.el.classList.add('link-target');
    }
  };
  const click = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const nodeEl = ev.target.closest && ev.target.closest('.node');
    const target = nodeEl && nodeEl.dataset.id !== fromId ? nodeEl.dataset.id : null;
    cancelConnect();
    if (target) connectNodes(fromId, target);
  };
  const key = (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      cancelConnect();
    }
  };
  connecting = { move, click, key };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', key, true);
}

export async function connectNodes(a, b) {
  flush();
  const res = await api.connect(S.wsId, a, b);
  if (res.ok) setDoc(S.wsId, res.doc);
  else toast(t('Cannot connect these nodes (already connected, or unsupported pairing)'));
}

function startMarquee(e) {
  const r = vpRect();
  const sx = e.clientX - r.left,
    sy = e.clientY - r.top;
  const base = e.shiftKey ? new Set(S.selection) : new Set();
  if (!e.shiftKey) select([]);
  marquee.hidden = false;
  interacting(true);
  const move = (ev) => {
    const x = ev.clientX - r.left,
      y = ev.clientY - r.top;
    const l = Math.min(sx, x),
      t = Math.min(sy, y),
      w = Math.abs(x - sx),
      h = Math.abs(y - sy);
    Object.assign(marquee.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
    const c1 = toCanvas(r.left + l, r.top + t),
      c2 = toCanvas(r.left + l + w, r.top + t + h);
    const sel = new Set(base);
    for (const n of visibleNodes()) {
      const q = rectOf(n);
      if (q.x < c2.x && q.x + q.w > c1.x && q.y < c2.y && q.y + q.h > c1.y) sel.add(n.id);
    }
    S.selection = sel;
    for (const [id, v] of views) v.el.classList.toggle('selected', sel.has(id));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    marquee.hidden = true;
    interacting(false);
    emit('selection');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startTieLasso(e) {
  e.preventDefault();
  const start = toCanvas(e.clientX, e.clientY);
  const move = (ev) => ropes.lassoMove(start, toCanvas(ev.clientX, ev.clientY));
  const up = (ev) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    ropes.lassoEnd(start, toCanvas(ev.clientX, ev.clientY)).then((made) => {
      if (!made) toast(t('The line did not cross any rope. Alt+drag across the ropes to gather.'));
    });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

viewport.addEventListener('mousedown', (e) => {
  if (e.target === minimap) return;
  const t = e.target;
  if (
    e.button === 0 &&
    e.altKey &&
    (!S.mode || S.mode === 'select') &&
    ropes.hasRopes() &&
    (t === viewport || t === world || t === nodesEl || t === ropesEl || t.closest('#empty-hint'))
  ) {
    startTieLasso(e);
    return;
  }
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
    if (e.button === 2 && t.closest('.node')) return;
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  if (S.mode === 'draw' && !t.closest('#chrome-top, #chrome-right, #chrome-zoom, #minimap, .pop')) {
    e.preventDefault();
    startDraw(e);
    return;
  }
  if (
    S.mode &&
    S.mode !== 'select' &&
    (t === viewport || t === world || t === nodesEl || t === ropesEl || t.closest('#empty-hint'))
  ) {
    e.preventDefault();
    ctxHooks.place && ctxHooks.place(toCanvas(e.clientX, e.clientY));
    return;
  }
  const port = t.closest('[data-port]');
  if (port) {
    e.preventDefault();
    startConnect(e, port.dataset.port);
    return;
  }
  const rz = t.closest('[data-resize]');
  if (rz) {
    e.preventDefault();
    startResize(e, rz.dataset.id, rz.dataset.resize);
    return;
  }
  const drag = t.closest('[data-drag]');
  if (drag && !t.closest('button, input, textarea')) {
    e.preventDefault();
    startNodeDrag(e, drag.dataset.drag);
    return;
  }
  const nodeEl = t.closest('.node');
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (!S.selection.has(id) || S.selection.size > 1) select([id], e.shiftKey);
    bringToFront(id);
    return;
  }
  if (t === viewport || t === world || t === nodesEl || t === ropesEl || t.closest('#empty-hint')) startMarquee(e);
});

viewport.addEventListener('contextmenu', (e) => e.preventDefault());

viewport.addEventListener(
  'wheel',
  (e) => {
    const overScrollable =
      e.target.closest && e.target.closest('.xterm, .note-edit, .note-preview, .ft, webview, .text-edit');
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(S.view.zoom * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
      return;
    }
    if (overScrollable) return;
    e.preventDefault();
    S.view.ox += (e.shiftKey ? e.deltaY : e.deltaX) / S.view.zoom;
    S.view.oy += (e.shiftKey ? 0 : e.deltaY) / S.view.zoom;
    applyView();
    commitView();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (
    e.code === 'Space' &&
    !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') &&
    !document.activeElement?.closest?.('.xterm')
  ) {
    spaceDown = true;
    viewport.style.cursor = 'grab';
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    viewport.style.cursor = '';
  }
});

// --------------------------------------------------------------------- bootstrap
on('doc', () => render());
on('selection', () => {
  for (const [id, v] of views) v.el.classList.toggle('selected', S.selection.has(id));
});
new ResizeObserver(() => scheduleMinimap()).observe(viewport);

export function focusNode(id) {
  const n = S.doc.payload.nodes.find((x) => x.id === id);
  if (!n) return;
  const r = rectOf(n);
  panTo(r.x + r.w / 2, r.y + r.h / 2);
  select([id]);
  bringToFront(id);
  const v = views.get(id);
  v && v.focus && v.focus();
}

ropes.setCanvasPoint((x, y) => toCanvas(x, y));
