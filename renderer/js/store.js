// Renderer-side state. Main process owns structure (add/remove/connect); the renderer owns
// layout (frames, z-order, view). Layout edits are queued and sent as small patches.
import { debounce } from './util.js';

const api = window.maestri;

export const S = {
  wsId: null,
  floorId: null, // current floor (null = Ground)
  doc: null,
  workspaces: [],
  prefs: null,
  env: null,
  selection: new Set(),
  view: { ox: 9800, oy: 8500, zoom: 1 },
  pending: {}, // nodeId -> partial patch not yet sent
  listeners: { doc: [], view: [], selection: [], prefs: [], prompter: [] },
  connStatus: new Map(), // connectionId -> status
};

export const on = (evt, fn) => S.listeners[evt].push(fn);
export const emit = (evt, ...a) => S.listeners[evt].forEach((fn) => fn(...a));

const flushNow = () => {
  if (!S.wsId) return;
  const patches = S.pending;
  S.pending = {};
  api.patchNodes(S.wsId, patches, { origin: [S.view.ox, S.view.oy], zoom: S.view.zoom });
};
const flushSoon = debounce(flushNow, 250);
export const flush = () => flushNow();

// pages of a note stack live in the document but are drawn inside the stack, never on the canvas
export const stackMembers = () => {
  const s = new Set();
  if (S.doc)
    for (const n of S.doc.payload.nodes) {
      if (n.content.noteStack) n.content.noteStack._0.memberNodeIds.forEach((id) => s.add(id));
      if (n.content.band) n.content.band._0.memberNodeIds.forEach((id) => s.add(id));
    }
  return s;
};
export const stackOfNote = (id) =>
  S.doc && S.doc.payload.nodes.find((n) => n.content.noteStack && n.content.noteStack._0.memberNodeIds.includes(id));
export const visibleNodes = () => {
  if (!S.doc) return [];
  const hidden = stackMembers();
  return S.doc.payload.nodes.filter((n) => (n.floorId || null) === (S.floorId || null) && !hidden.has(n.id));
};

export function node(id) {
  return S.doc && S.doc.payload.nodes.find((n) => n.id === id);
}

// Merge a partial update into a node locally and queue it for main.
export function patchNode(id, partial, { silent = false } = {}) {
  const n = node(id);
  if (!n) return;
  Object.assign(n, partial);
  S.pending[id] = { ...(S.pending[id] || {}), ...partial };
  flushSoon();
  if (!silent) emit('doc', { reason: 'patch', ids: [id] });
}

export function commitView() {
  S.doc.payload.canvasOrigin = [S.view.ox, S.view.oy];
  S.doc.payload.canvasZoom = S.view.zoom;
  flushSoon();
}

// Replace the doc with an authoritative one from main, keeping unsent local layout edits.
export function setDoc(wsId, doc, { resetView = false } = {}) {
  S.wsId = wsId;
  if (doc) {
    for (const [id, p] of Object.entries(S.pending)) {
      const n = doc.payload.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, p);
    }
    S.doc = doc;
    const keep = new Set(doc.payload.nodes.map((n) => n.id));
    for (const id of [...S.selection]) if (!keep.has(id)) S.selection.delete(id);
    if (resetView) {
      S.view = { ox: doc.payload.canvasOrigin[0], oy: doc.payload.canvasOrigin[1], zoom: doc.payload.canvasZoom || 1 };
      S.pending = {};
    }
  }
  emit('doc', { reason: resetView ? 'open' : 'replace' });
}

export function select(ids, additive = false) {
  if (!additive) S.selection.clear();
  for (const id of ids) {
    if (additive && S.selection.has(id)) S.selection.delete(id);
    else S.selection.add(id);
  }
  emit('selection');
}

export function bringToFront(id) {
  const top = S.doc.payload.nodes.reduce((m, n) => Math.max(m, n.zIndex || 0), 0);
  const n = node(id);
  if (n && n.zIndex < top) patchNode(id, { zIndex: top + 1 });
}

export const wsEntry = () => S.workspaces.find((w) => w.id === S.wsId);
export { api };
