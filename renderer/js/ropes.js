// DOM layer for the connection ropes: drives the physics world (rope-sim.js) with
// requestAnimationFrame, draws smooth dashed paths and persists the resting shape.
import { RopeWorld, buildSmoothPath, orthogonalRoute, buildElbowPath, ELBOW_CORNER_RADIUS } from './rope-sim.js';
import { S, api, visibleNodes, setDoc, flush, node as getNode } from './store.js';
import { rectOf, contextMenu, debounce } from './util.js';
import { t } from './i18n.js';
import { resolveCableTies, cableTieConstraints, tieSpread, tieFromLasso } from './cable-ties.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('ropes');

// [list in workspace.json, endpoint field A, endpoint field B]
export const CONNECTION_LISTS = [
  ['connections', 'terminalIdA', 'terminalIdB'],
  ['noteConnections', 'terminalId', 'noteNodeId'],
  ['portalConnections', 'terminalId', 'portalNodeId'],
  ['noteToNoteConnections', 'noteNodeIdA', 'noteNodeIdB'],
  ['portalToPortalConnections', 'portalIdA', 'portalIdB'],
];

const world = new RopeWorld();
const els = new Map(); // connection id -> { vis, hit, list, conn }
let moving = new Set();
let raf = 0;
let picked = new Set();

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const routing = () => (S.prefs && S.prefs.ropeRouting) || 'avoidNodes';

// ------------------------------------------------------------------ cable ties
let canvasPoint = (x, y) => ({ x, y });
export const setCanvasPoint = (fn) => {
  canvasPoint = fn;
};
let selectedTie = null;
let dragTie = null; // { id, position }
let resolvedTies = [];
const tieEls = new Map();
let lassoEl = null;

const tiesHere = () => (S.doc.payload.cableTies || []).filter((x) => (x.floorId || null) === (S.floorId || null));
const pinsMap = () => {
  const m = new Map();
  for (const [id, r] of world.ropes) m.set(id, { pinStart: r.pinStart, pinEnd: r.pinEnd });
  return m;
};
const kick = () => {
  if (world.running && !raf) raf = requestAnimationFrame(loop);
};

function syncTies(now) {
  resolvedTies = resolveCableTies(tiesHere(), pinsMap(), dragTie);
  const woke = world.setTies(cableTieConstraints(resolvedTies), now);
  const ids = new Set(resolvedTies.map((x) => x.id));
  for (const [id, g] of tieEls)
    if (!ids.has(id)) {
      g.remove();
      tieEls.delete(id);
    }
  for (const rt of resolvedTies) if (!tieEls.has(rt.id)) tieEls.set(rt.id, makeTieEl(rt.id));
  return woke;
}

function makeTieEl(id) {
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute('class', 'tie');
  g.dataset.tie = id;
  const bar = document.createElementNS(SVG, 'rect');
  bar.setAttribute('class', 'tie-bar');
  const head = document.createElementNS(SVG, 'rect');
  head.setAttribute('class', 'tie-head');
  const hit = document.createElementNS(SVG, 'rect');
  hit.setAttribute('class', 'tie-hit');
  g.append(bar, head, hit);
  hit.addEventListener('mousedown', (e) => startTieDrag(e, id));
  hit.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectedTie = id;
    paintTies();
    contextMenu(e.clientX, e.clientY, [
      { label: t('Remove cable tie'), icon: 'trash-2', danger: true, run: () => deleteTie(id) },
    ]);
  });
  svg.append(g);
  return g;
}

function paintTies() {
  for (const rt of resolvedTies) {
    const g = tieEls.get(rt.id);
    if (!g) continue;
    const half = tieSpread(rt.memberRopeIds.length) / 2 + 4;
    const angle = (Math.atan2(rt.perp.y, rt.perp.x) * 180) / Math.PI;
    g.setAttribute(
      'transform',
      `translate(${rt.position.x.toFixed(2)} ${rt.position.y.toFixed(2)}) rotate(${angle.toFixed(3)})`,
    );
    const [bar, head, hit] = g.children;
    bar.setAttribute('x', -half);
    bar.setAttribute('y', -2.25);
    bar.setAttribute('width', half * 2);
    bar.setAttribute('height', 4.5);
    bar.setAttribute('rx', 2.25);
    head.setAttribute('x', half + 2);
    head.setAttribute('y', -4);
    head.setAttribute('width', 8);
    head.setAttribute('height', 8);
    head.setAttribute('rx', 2);
    hit.setAttribute('x', -half - 8);
    hit.setAttribute('y', -10);
    hit.setAttribute('width', half * 2 + 16);
    hit.setAttribute('height', 20);
    g.classList.toggle('selected', selectedTie === rt.id);
  }
}

function startTieDrag(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const tie = tiesHere().find((x) => x.id === id);
  if (!tie) return;
  selectedTie = id;
  const p = canvasPoint(e.clientX, e.clientY);
  const grab = { x: tie.position.x - p.x, y: tie.position.y - p.y };
  dragTie = { id, position: { ...tie.position } };
  const move = (ev) => {
    const q = canvasPoint(ev.clientX, ev.clientY);
    dragTie = { id, position: { x: q.x + grab.x, y: q.y + grab.y } };
    syncTies(performance.now());
    paintTies();
    render(lastConns);
    kick();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const pos = dragTie && dragTie.position;
    dragTie = null;
    if (pos) {
      tie.position = pos;
      api.tieMove(S.wsId, id, pos);
    }
    syncTies(performance.now());
    paintTies();
    kick();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  syncTies(performance.now());
  paintTies();
}

async function deleteTie(id) {
  selectedTie = null;
  flush();
  const r = await api.tieDelete(S.wsId, id);
  if (r.doc) setDoc(S.wsId, r.doc);
}

// Alt+drag across ropes: a dashed lasso line; ropes it crosses are gathered in a new tie.
export function lassoMove(start, end) {
  if (!lassoEl) {
    lassoEl = document.createElementNS(SVG, 'line');
    lassoEl.setAttribute('class', 'tie-lasso');
    svg.append(lassoEl);
  }
  lassoEl.setAttribute('x1', start.x);
  lassoEl.setAttribute('y1', start.y);
  lassoEl.setAttribute('x2', end.x);
  lassoEl.setAttribute('y2', end.y);
}
export async function lassoEnd(start, end) {
  if (lassoEl) {
    lassoEl.remove();
    lassoEl = null;
  }
  const tie = tieFromLasso(world.ropes, start, end, () => crypto.randomUUID(), new Date().toISOString());
  if (!tie) return false;
  selectedTie = tie.id;
  flush();
  const r = await api.tieCreate(S.wsId, tie, S.floorId || null);
  if (r.doc) setDoc(S.wsId, r.doc);
  return !!r.ok;
}
export const hasRopes = () => world.ropes.size > 0;

window.addEventListener(
  'mousedown',
  (e) => {
    if (selectedTie && !(e.target.closest && e.target.closest('.tie'))) {
      selectedTie = null;
      paintTies();
    }
  },
  true,
);
window.addEventListener(
  'keydown',
  (e) => {
    if (!selectedTie) return;
    const tg = e.target;
    if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    if (e.key === 'Escape') {
      selectedTie = null;
      paintTies();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      deleteTie(selectedTie);
    }
  },
  true,
);

export function setMoving(ids) {
  moving = ids;
}
export function setPicked(ids) {
  picked = ids;
  paintStyles();
}

function connectionList() {
  const nodes = visibleNodes();
  const visible = new Set(nodes.map((n) => n.id));
  // a page of a note stack is drawn as the stack; several pages connected to the same node collapse into one rope
  const stackOf = new Map();
  for (const n of S.doc.payload.nodes) {
    if (n.content.noteStack) for (const m of n.content.noteStack._0.memberNodeIds) stackOf.set(m, n.id);
    if (n.content.band) for (const m of n.content.band._0.memberNodeIds) stackOf.set(m, n.id);
  }
  const resolve = (id) => stackOf.get(id) || id;
  const out = [];
  const byPair = new Map();
  // a cross-floor connection shows, on each floor, a rope from its terminal to that floor's connector node
  for (const c of S.doc.payload.crossFloorConnections || []) {
    for (const [floor, term, conn, rid] of [
      [c.floorIdA, c.terminalIdA, c.connectorNodeIdA, c.id],
      [c.floorIdB, c.terminalIdB, c.connectorNodeIdB, c.id + '#B'],
    ]) {
      if ((floor || null) !== (S.floorId || null) || !visible.has(term) || !visible.has(conn)) continue;
      out.push({
        id: rid,
        from: resolve(term),
        to: conn,
        saved: null,
        list: 'crossFloorConnections',
        conn: null,
        ids: [{ id: c.id, list: 'crossFloorConnections' }],
      });
    }
  }
  for (const [list, fa, fb] of CONNECTION_LISTS) {
    for (const c of S.doc.payload[list]) {
      const a = resolve(c[fa]),
        b = resolve(c[fb]);
      if (a === b || !visible.has(a) || !visible.has(b)) continue;
      const key = [a, b].sort().join('|');
      if (byPair.has(key)) {
        byPair.get(key).ids.push({ id: c.id, list });
        continue;
      }
      const saved =
        Array.isArray(c.ropePoints) && c.ropePoints.length === 21
          ? c.ropePoints.map((p) => ({ x: p[0], y: p[1] }))
          : null;
      const entry = { id: c.id, from: a, to: b, saved, list, conn: c, ids: [{ id: c.id, list }] };
      byPair.set(key, entry);
      out.push(entry);
    }
  }
  return out;
}

function ensureElements(conns) {
  const ids = new Set(conns.map((c) => c.id));
  for (const [id, e] of els)
    if (!ids.has(id)) {
      e.vis.remove();
      e.hit.remove();
      els.delete(id);
    }
  for (const c of conns) {
    let e = els.get(c.id);
    if (!e) {
      const vis = document.createElementNS(SVG, 'path');
      vis.setAttribute('class', 'rope');
      const hit = document.createElementNS(SVG, 'path');
      hit.setAttribute('class', 'rope-hit');
      hit.addEventListener('mouseenter', () => vis.classList.add('hover'));
      hit.addEventListener('mouseleave', () => vis.classList.remove('hover'));
      const menu = (ev) => {
        ev.preventDefault();
        const ln = (id) => {
          const n = getNode(id);
          const k = n && Object.keys(n.content)[0];
          const i = n && n.content[k] && n.content[k]._0;
          return (i && (i.name || (i.fileName || '').replace(/\.md$/i, ''))) || t('Note');
        };
        const entry = els.get(c.id);
        contextMenu(ev.clientX, ev.clientY, [
          { label: `${ln(entry.from)}  ↔  ${ln(entry.to)}`, icon: 'cable', run: () => {} },
          { label: t('Disconnect'), icon: 'unlink', danger: true, run: () => disconnectAll(entry.ids) },
        ]);
      };
      hit.addEventListener('contextmenu', menu);
      hit.addEventListener('click', menu);
      hit.addEventListener('dblclick', () => disconnectAll(els.get(c.id).ids));
      svg.append(vis, hit);
      e = { vis, hit };
      els.set(c.id, e);
    }
    e.list = c.list;
    e.conn = c.conn;
    e.from = c.from;
    e.to = c.to;
    e.ids = c.ids;
  }
}

function paintStyles() {
  for (const [id, e] of els) {
    const active = S.connStatus.get(id) === 'communicating';
    e.vis.classList.toggle('active', active);
    e.vis.classList.toggle('picked', picked.has(id));
  }
}

function render(conns) {
  const mode = routing();
  const frames = frameMap();
  for (const c of conns) {
    const e = els.get(c.id);
    if (!e) continue;
    let d = '';
    if (mode === 'circuit') {
      const a = frames.get(c.from),
        b = frames.get(c.to);
      if (a && b) d = buildElbowPath(orthogonalRoute(a, b), ELBOW_CORNER_RADIUS);
    } else {
      const rope = world.ropes.get(c.id);
      if (rope) d = buildSmoothPath(rope.points);
    }
    e.vis.setAttribute('d', d);
    e.hit.setAttribute('d', d);
  }
  paintTies();
  paintStyles();
}

function frameMap() {
  return new Map(visibleNodes().map((n) => [n.id, rectOf(n)]));
}

let lastConns = [];
const save = debounce(() => {
  if (!S.wsId) return;
  const payload = {};
  const take = (id, rope, conn) => {
    const pts = rope.points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    payload[id] = pts;
    if (conn) conn.ropePoints = pts;
  };
  for (const c of lastConns) {
    const r = world.ropes.get(c.id);
    if (r) take(c.id, r, c.conn);
  }
  for (const [id, r] of world.takeRemoved()) take(id, r, null);
  if (Object.keys(payload).length) api.saveRopes(S.wsId, payload);
}, 400);

function loop(now) {
  const { asleep } = world.tick(now);
  render(lastConns);
  raf = 0;
  if (!asleep) raf = requestAnimationFrame(loop);
  else save();
}

// Recompute pins/obstacles from the current node frames; (re)start the animation if needed.
export function sync() {
  if (!S.doc) return;
  const conns = connectionList();
  lastConns = conns;
  ensureElements(conns);
  const mode = routing();
  const woke =
    mode === 'circuit'
      ? false
      : world.sync(conns, frameMap(), { moving, avoidNodes: mode === 'avoidNodes', now: performance.now() });
  if (mode !== 'circuit' && woke && reduceMotion()) {
    // reduced motion: same final shape, no swinging
    world.settleAll(120);
    world.running = false;
  }
  syncTies(performance.now());
  render(conns);
  if (world.running && !raf) raf = requestAnimationFrame(loop);
}

async function disconnectAll(ids) {
  flush();
  for (const { id, list } of ids) setDoc(S.wsId, await api.removeConnection(S.wsId, list, id));
}

export function setConnStatus(connId, status) {
  S.connStatus.set(connId, status);
  paintStyles();
}
