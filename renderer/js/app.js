import { el, toast, contextMenu, rectOf } from './util.js';
import { S, api, setDoc, select, flush, visibleNodes } from './store.js';
import * as canvas from './canvas.js';
import {
  pullRequestsDialog,
  gitDialog,
  savePartituraDialog,
  partituraPaletteDialog,
  bandDeleteDialog,
  stackDeleteDialog,
  newTerminalDialog,
  editNodeDialog,
  workspaceDialog,
  preferencesDialog,
  floorCreateDialog,
  floorEditDialog,
  landDialog,
  routinesDialog,
  promptName,
} from './dialogs.js';
import { icon } from './icons.js';
import * as sidebar from './sidebar.js';
import { openOverview } from './overview.js';
import { initChrome, setMode } from './chrome.js';
import { cyclePrompter } from './prompter.js';
import { openPalette, isPaletteOpen } from './palette.js';
import { t, setLang, hydrate } from './i18n.js';

window.__icon = icon; // used by contextMenu() for item icons

const SIZES = {
  terminal: [640, 400],
  note: [260, 150],
  portal: [640, 440],
  fileTree: [280, 360],
  text: [200, 44],
  shape: [200, 140],
  stroke: [220, 80],
};

// --------------------------------------------------------------- static markup
function hydrateStatic() {
  hydrate();
  document.querySelectorAll('[data-icon]').forEach((n) => {
    n.replaceChildren(icon(n.dataset.icon, Number(n.dataset.size) || 16));
    n.classList.add('ico-wrap');
  });
}

// ------------------------------------------------------------------- theming
function applyScheme() {
  const th = S.prefs.terminalTheme;
  const light =
    th === 'light' ||
    th === 'solarized-light' ||
    (th === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.scheme = light ? 'light' : 'dark';
  document.getElementById('viewport').classList.toggle('dots', S.prefs.canvasBackground !== 'solid');
}

function refreshNodes() {
  for (const n of S.doc.payload.nodes) canvas.viewOf(n.id)?.update?.(n);
}

// ------------------------------------------------------------------- sidebar
const renderSidebar = () => sidebar.render();
const saveWorkspaceEdit = (id) => async (fields) => {
  S.workspaces = await api.updateWorkspace(id, fields);
  renderSidebar();
};

async function switchTo(id, doc) {
  select([]);
  S.floorId = null;
  setDoc(id, doc, { resetView: true });
  canvas.applyView();
  renderSidebar();
  renderFloors();
  refreshHistory();
  sidebar.refreshStats();
}

async function deleteWorkspace(id) {
  flush();
  const res = await api.removeWorkspace(id);
  S.workspaces = res.workspaces;
  sidebar.forget(id);
  switchTo(res.activeId, res.doc);
}

async function openWorkspace(id, floorId = null) {
  if (id !== S.wsId) {
    flush();
    const res = await api.openWorkspace(id);
    S.workspaces = res.workspaces;
    await switchTo(id, res.doc);
  }
  if (floorId !== (S.floorId || null)) setFloor(floorId);
}

// -------------------------------------------------------------------- floors
function renderFloors() {
  const bar = document.getElementById('floors-bar');
  const floors = S.doc.payload.floors;
  const count = (id) => S.doc.payload.nodes.filter((n) => (n.floorId || null) === id).length;
  const tab = (id, label, ic, extra) =>
    el(
      'button',
      {
        class: `floor-tab${S.floorId === id ? ' on' : ''}`,
        title: extra && extra.title,
        onclick: () => setFloor(id),
        oncontextmenu: (e) => {
          e.preventDefault();
          id &&
            floorMenu(
              e,
              floors.find((f) => f.id === id),
            );
        },
      },
      icon(ic, 14),
      label,
      el('span', { class: 'cnt' }, count(id)),
    );
  bar.replaceChildren(
    tab(null, t('Ground'), 'house', { title: t('Main canvas') }),
    ...floors.map((f) => tab(f.id, f.name, 'git-branch', { title: `${f.branchName}\n${f.worktreePath}` })),
    el(
      'button',
      {
        class: 'floor-add',
        title: t('Floor overview ({keys})', { keys: 'Ctrl+Shift+\\' }),
        onclick: () => showOverview(),
      },
      icon('layout-grid', 14),
    ),
    el(
      'button',
      {
        class: 'floor-add',
        title: t('New floor (isolated git worktree)'),
        onclick: () =>
          floorCreateDialog((f) => {
            setFloor(f.id);
          }),
      },
      icon('plus', 14),
      floors.length ? null : t('New floor'),
    ),
  );
}

function setFloor(id) {
  if (S.floorId === id) return;
  S.floorId = id;
  select([]);
  const nodes = visibleNodes();
  setDoc(S.wsId, S.doc);
  if (nodes.length) canvas.fitAll();
  renderFloors();
}

function floorMenu(e, floor) {
  contextMenu(e.clientX, e.clientY, [
    { label: t('Settings and hooks…'), icon: 'settings', run: () => floorEditDialog(floor) },
    {
      label: t('Land (merge into main)…'),
      icon: 'git-merge',
      run: () =>
        landDialog(floor, () => {
          S.floorId = null;
          setDoc(S.wsId, S.doc);
          renderFloors();
        }),
    },
    { label: t('Open folder'), icon: 'folder-open', run: () => api.openPath(floor.worktreePath) },
    { label: t('Delete floor…'), icon: 'trash-2', danger: true, run: () => deleteFloor(floor) },
  ]);
}

async function deleteFloor(floor) {
  const n = S.doc.payload.nodes.filter((x) => x.floorId === floor.id).length;
  if (
    !confirm(
      t(
        'Delete floor "{name}"? Its worktree and {n} node(s) are removed. Commits stay on branch {b} unless you also delete it.',
        { name: floor.name, b: floor.branchName, n },
      ),
    )
  )
    return;
  const del = confirm(
    t('Also delete the git branch {b}? (OK = delete branch, Cancel = keep it)', { b: floor.branchName }),
  );
  flush();
  const r = await api.floorRemove(S.wsId, floor.id, { deleteBranch: del });
  if (!r.ok) return toast(r.error, 6000);
  if (S.floorId === floor.id) S.floorId = null;
  setDoc(S.wsId, r.doc);
  renderFloors();
  if (r.warnings.length) toast(r.warnings.join('; '), 6000);
}

// ------------------------------------------------------------------- adding
async function addNode(kind, opts = {}) {
  const [w, h] = SIZES[kind];
  const c = canvas.viewportCenter();
  const jitter = (visibleNodes().length % 6) * 24;
  const rect = opts.rect || { x: Math.round(c.x - w / 2 + jitter), y: Math.round(c.y - h / 2 + jitter), w, h };
  flush();
  const res = await api.addNode(S.wsId, kind, { ...opts, rect, floorId: S.floorId });
  setDoc(S.wsId, res.doc);
  select([res.nodeId]);
  refreshHistory();
  const v = canvas.viewOf(res.nodeId);
  v && v.focus && setTimeout(() => v.focus(), 250);
}

// Tools (main pill). A tool is "armed" by clicking it; the next click on empty canvas places the node there.
let drawTool = null;
async function attachFile() {
  const p = await api.pickFile([{ name: 'Markdown / texto', extensions: ['md', 'txt'] }]);
  if (!p) return;
  setDoc(S.wsId, await api.noteImport(S.wsId, p));
  toast(t('Imported {n} note(s)', { n: 1 }));
}

function pickTool(id, anchor) {
  canvas.cancelConnect();
  if (id === 'select') return setMode('select');
  if (id === 'attach') {
    setMode('select');
    return attachFile();
  }
  setMode(S.mode === id ? 'select' : id);
}

async function stackOp(op, args) {
  flush();
  const r = await api.stackOp(S.wsId, op, args);
  if (r.doc) setDoc(S.wsId, r.doc);
  if (!r.ok) toast(r.error);
  else if (op === 'create') select([r.result]);
  refreshHistory();
  return r;
}

async function bandOp(op, args) {
  flush();
  const r = await api.bandOp(S.wsId, op, args);
  if (r.doc) setDoc(S.wsId, r.doc);
  if (!r.ok) toast(r.error);
  else if (op === 'create') select([r.result]);
  refreshHistory();
  return r;
}

async function createDrawing(made) {
  flush();
  const res = await api.addNode(S.wsId, made.kind, { ...made.opts, floorId: S.floorId });
  setDoc(S.wsId, res.doc);
  refreshHistory();
}

async function placeAt(p) {
  const mode = S.mode;
  setMode('select');
  const kind = mode === 'draw' ? drawTool && drawTool.kind : mode;
  if (!kind || !SIZES[kind]) return;
  const [w, h] = SIZES[kind];
  const rect = {
    x: Math.round(p.x - (mode === 'terminal' || mode === 'portal' ? 0 : w / 2)),
    y: Math.round(p.y - (mode === 'terminal' || mode === 'portal' ? 0 : h / 2)),
    w,
    h,
  };
  if (kind === 'terminal') return newTerminalDialog((o) => addNode('terminal', { ...o, rect }));
  if (kind === 'fileTree') {
    const d = await api.pickDir();
    return d && addNode('fileTree', { rootPath: d, rect });
  }
  return addNode(kind, { ...(mode === 'draw' ? drawTool.opts : {}), rect });
}

async function placePartitura(id) {
  flush();
  const c = canvas.viewportCenter();
  const r = await api.partituraPlace(S.wsId, id, { x: Math.round(c.x - 300), y: Math.round(c.y - 200) }, S.floorId);
  if (!r.ok) return toast(r.error);
  setDoc(S.wsId, r.doc);
  select(r.nodeIds.filter((nid) => S.doc.payload.nodes.some((n) => n.id === nid)));
  toast(t('Partitura placed'));
  refreshHistory();
}

async function importWorkspace(file) {
  const r = await api.importWorkspace(file || null);
  if (r.canceled) return;
  if (r.error) return toast(t('Could not import: {e}', { e: r.error }), 6000);
  S.workspaces = r.workspaces;
  renderSidebar();
  toast(t('Workspace imported'));
  await openWorkspace(r.entry.id);
}

// ------------------------------------------------------------ command palette
async function addAtCenter(kind) {
  if (kind === 'terminal') return newTerminalDialog((o) => addNode('terminal', o));
  if (kind === 'fileTree') {
    const d = await api.pickDir();
    return d && addNode('fileTree', { rootPath: d });
  }
  return addNode(kind);
}

let openGit = () => {}; // set in boot(); the palette needs it at module level
const paletteHandlers = {
  async run(action) {
    const first = () =>
      [...S.selection].find((x) => S.doc.payload.nodes.some((n) => n.id === x && n.content.terminal)) ||
      terminalsInOrder()[0]?.id;
    switch (action) {
      case 'terminal':
      case 'note':
      case 'fileTree':
      case 'portal':
      case 'text':
        return addAtCenter(action);
      case 'workspace':
        return document.getElementById('btn-new-ws').click();
      case 'importWorkspace':
        return importWorkspace(null);
      case 'git':
        return openGit(S.doc.payload.workingDirectory);
      case 'overview':
        return showOverview();
      case 'pullRequests':
        return pullRequestsDialog(
          S.floorId
            ? (S.doc.payload.floors.find((f) => f.id === S.floorId) || {}).worktreePath
            : S.doc.payload.workingDirectory,
        );
      case 'chat':
        return toggleChatOf();
      case 'partituras':
        return partituraPaletteDialog(placePartitura);
      case 'savePartitura':
        return S.selection.size ? savePartituraDialog([...S.selection]) : toast(t('Select the nodes to save first.'));
      case 'floor':
        return floorCreateDialog((f) => setFloor(f.id));
      case 'group':
        return document.getElementById('sb-new-group').click();
      case 'routines':
        return routinesDialog();
      case 'prefs':
        return document.getElementById('btn-prefs').click();
      case 'prompter': {
        const id = first();
        return id ? cyclePrompter(id) : toast(t('This workspace has no terminals.'));
      }
      case 'fit':
        return canvas.fitAll();
      case 'undo':
        return doHistory('undo');
      case 'redo':
        return doHistory('redo');
      case 'backup': {
        const r = await api.backupNow();
        return toast(r.ok ? t('Backup created') : r.error);
      }
      case 'ide':
        return api.openInIDE(S.wsId);
      default:
        return undefined;
    }
  },
  goWorkspace: (id) => openWorkspace(id),
  goFloor: (id) => setFloor(id),
  async focusNode(id, floorId) {
    if ((S.floorId || null) !== (floorId || null)) setFloor(floorId || null);
    // a note filed in a stack: bring that page to the front and focus the stack
    const band = S.doc.payload.nodes.find((n) => n.content.band && n.content.band._0.memberNodeIds.includes(id));
    if (band) {
      await bandOp('setShown', { bandId: band.id, id });
      id = band.id;
    }
    const stack = S.doc.payload.nodes.find(
      (n) => n.content.noteStack && n.content.noteStack._0.memberNodeIds.includes(id),
    );
    if (stack) {
      await stackOp('setFront', { stackId: stack.id, noteId: id });
      id = stack.id;
    }
    setTimeout(() => canvas.focusNode(id), 80);
  },
};
let showOverview = () => {};
function toggleChatOf() {
  const focused =
    document.activeElement && document.activeElement.closest && document.activeElement.closest('.node.terminal');
  const id =
    (focused && focused.dataset.id) ||
    [...S.selection].find((x) => {
      const n = S.doc.payload.nodes.find((y) => y.id === x);
      return n && n.content.terminal;
    }) ||
    terminalsInOrder()[0]?.id;
  const v = id && canvas.viewOf(id);
  if (v && v.toggleChat) v.toggleChat();
  else toast(t('This workspace has no terminals.'));
}
const showPalette = (opts) => openPalette(paletteHandlers, opts);

// --------------------------------------------------------------- undo / redo
async function refreshHistory() {
  if (!S.wsId) return;
  const st = await api.historyState(S.wsId);
  document.getElementById('btn-undo').disabled = !st.canUndo;
  document.getElementById('btn-redo').disabled = !st.canRedo;
}
async function doHistory(kind) {
  flush();
  const r = await (kind === 'undo' ? api.undo(S.wsId) : api.redo(S.wsId));
  if (!r) return toast(kind === 'undo' ? t('Nothing to undo') : t('Nothing to redo'));
  if (S.floorId && !r.doc.payload.floors.some((f) => f.id === S.floorId)) S.floorId = null;
  setDoc(S.wsId, r.doc);
  renderFloors();
  document.getElementById('btn-undo').disabled = !r.canUndo;
  document.getElementById('btn-redo').disabled = !r.canRedo;
}

// ---------------------------------------------------------------- shortcuts
function terminalsInOrder() {
  return visibleNodes()
    .filter((n) => n.content.terminal)
    .sort((a, b) => rectOf(a).y - rectOf(b).y || rectOf(a).x - rectOf(b).x);
}

function typingTarget(el_) {
  return (
    el_ &&
    (/^(INPUT|TEXTAREA|SELECT)$/.test(el_.tagName) || el_.isContentEditable) &&
    !el_.classList.contains('xterm-helper-textarea')
  );
}

window.addEventListener(
  'keydown',
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'Tab') {
      e.preventDefault();
      const terms = terminalsInOrder();
      if (!terms.length) return;
      const cur = terms.findIndex((n) => S.selection.has(n.id));
      canvas.focusNode(terms[(cur + (e.shiftKey ? terms.length - 1 : 1)) % terms.length].id);
      return;
    }
    if (ctrl && /^[1-9]$/.test(e.key) && !e.shiftKey) {
      const n = terminalsInOrder()[Number(e.key) - 1];
      if (n) {
        e.preventDefault();
        canvas.focusNode(n.id);
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'k' && (e.shiftKey || !(e.target.closest && e.target.closest('.xterm')))) {
      e.preventDefault();
      showPalette();
      return;
    }
    if (isPaletteOpen()) return;
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      const focused = e.target.closest && e.target.closest('.node.terminal');
      const id =
        (focused && focused.dataset.id) ||
        [...S.selection].find((x) => {
          const n = S.doc.payload.nodes.find((y) => y.id === x);
          return n && n.content.terminal;
        }) ||
        terminalsInOrder()[0]?.id;
      if (id) cyclePrompter(id);
      return;
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      toggleChatOf();
      return;
    }
    if (ctrl && e.shiftKey && (e.code === 'Backslash' || e.key === '|' || e.key === '\\')) {
      e.preventDefault();
      showOverview();
      return;
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      connectSelected();
      return;
    }
    if (ctrl && e.key === '0') {
      e.preventDefault();
      canvas.fitAll();
      return;
    }
    if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      canvas.setZoom(S.view.zoom * 1.25);
      return;
    }
    if (ctrl && e.key === '-') {
      e.preventDefault();
      canvas.setZoom(S.view.zoom / 1.25);
      return;
    }
    if (typingTarget(e.target) || e.target.closest?.('.xterm')) return;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doHistory(e.shiftKey ? 'redo' : 'undo');
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doHistory('redo');
      return;
    }
    if (e.key === 'Delete' && S.selection.size) {
      canvas.removeNodes([...S.selection]);
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      select(visibleNodes().map((n) => n.id));
      return;
    }
    if (e.key === 'Escape') {
      if (S.mode !== 'select') setMode('select');
      else select([]);
    }
  },
  true,
);

async function connectSelected() {
  const ids = [...S.selection];
  if (ids.length !== 2) return toast(t('Select exactly two nodes to connect'));
  await canvas.connectNodes(ids[0], ids[1]);
  refreshHistory();
}

// ------------------------------------------------------------------ drag-drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  let n = 0;
  for (const f of e.dataTransfer.files) {
    if (!/\.(md|txt)$/i.test(f.name)) continue;
    const p = window.maestri.pathForFile(f);
    if (p) {
      setDoc(S.wsId, await api.noteImport(S.wsId, p));
      n++;
    }
  }
  if (n) toast(t('Imported {n} note(s)', { n }));
});

// ------------------------------------------------------------------- bootstrap
async function boot() {
  const init = await api.init();
  S.env = init;
  S.prefs = init.prefs;
  S.workspaces = init.workspaces;
  setLang(S.prefs.language);
  hydrateStatic();
  applyScheme();
  const editNode = (id) => {
    const n = S.doc.payload.nodes.find((x) => x.id === id);
    n && editNodeDialog(n, (ids) => canvas.removeNodes(ids));
  };
  openGit = (root) => gitDialog(root, () => canvas.viewsRefresh && canvas.viewsRefresh());
  showOverview = (pick) =>
    openOverview({
      goFloor: (id) => setFloor(id),
      focusNode: (id, fl) => paletteHandlers.focusNode(id, fl),
      pick: typeof pick === 'string' ? pick : null,
    });
  canvas.setHooks({
    jump: (id, fl) => paletteHandlers.focusNode(id, fl),
    git: openGit,
    edit: editNode,
    place: placeAt,
    draw: createDrawing,
    deleteBand: (id) =>
      new Promise((resolve) => {
        const n = S.doc.payload.nodes.find((x) => x.id === id);
        if (!n) return resolve();
        bandDeleteDialog(n, async (keepTerminals) => {
          await bandOp('remove', { bandId: id, keepTerminals });
          resolve();
        });
      }),
    memberMenu: (e, bandId, id) =>
      contextMenu(e.clientX, e.clientY, [
        { label: t('Edit terminal'), icon: 'square-pen', run: () => editNode(id) },
        {
          label: t('Take this terminal out'),
          icon: 'arrow-up-right',
          run: () => bandOp('removeMember', { bandId, id }),
        },
        { label: t('Dissolve band'), icon: 'unlink', run: () => bandOp('dissolve', { bandId }) },
      ]),
    deleteStack: (id) =>
      new Promise((resolve) => {
        const n = S.doc.payload.nodes.find((x) => x.id === id);
        if (!n) return resolve();
        stackDeleteDialog(n, async (keepNotes) => {
          await stackOp('remove', { stackId: id, keepNotes });
          resolve();
        });
      }),
    pageMenu: (e, stackId, noteId) =>
      contextMenu(e.clientX, e.clientY, [
        { label: t('Take this page out'), icon: 'arrow-up-right', run: () => stackOp('spill', { stackId, noteId }) },
        { label: t('Unstack all pages'), icon: 'unlink', run: () => stackOp('unstackAll', { stackId }) },
      ]),
  });
  initChrome({
    overview: showOverview,
    jump: (id, fl) => paletteHandlers.focusNode(id, fl),
    pickTool,
    edit: editNode,
    git: openGit,
    stack: stackOp,
    band: bandOp,
    promptName,
    savePartitura: (ids) => savePartituraDialog(ids),
  });

  const prefsChanged = () => {
    setLang(S.prefs.language);
    applyScheme();
    refreshNodes();
    location.reload();
  };
  await sidebar.initSidebar({
    open: openWorkspace,
    createWorkspace: () =>
      workspaceDialog(null, async (f) => {
        flush();
        const r = await api.createWorkspace(f);
        S.workspaces = r.workspaces;
        await openWorkspace(r.entry.id);
      }),
    edit: (w) => workspaceDialog(w, saveWorkspaceEdit(w.id), () => deleteWorkspace(w.id)),
    togglePin: async (w) => {
      S.workspaces = await api.updateWorkspace(w.id, { isPinned: !w.isPinned });
      renderSidebar();
    },
    remove: (w) => confirm(t('Delete workspace "{name}"?', { name: w.name })) && deleteWorkspace(w.id),
    promptName,
    duplicate: async (w) => {
      const r = await api.duplicateWorkspace(w.id);
      S.workspaces = r.workspaces;
      renderSidebar();
      toast(t('Workspace duplicated'));
      await openWorkspace(r.entry.id);
    },
    exportWs: async (w) => {
      const r = await api.exportWorkspace(w.id);
      if (r.file) toast(t('Exported to {f}', { f: r.file }));
    },
    importWs: (f) => importWorkspace(f),
    routines: () => routinesDialog(),
    preferences: () => preferencesDialog(prefsChanged),
  });
  document.getElementById('btn-ide').onclick = () => api.openInIDE(S.wsId);
  document.getElementById('btn-palette').onclick = () => showPalette();
  document.getElementById('btn-undo').onclick = () => doHistory('undo');
  document.getElementById('btn-redo').onclick = () => doHistory('redo');
  document.getElementById('zoom-in').onclick = () => canvas.setZoom(S.view.zoom * 1.25);
  document.getElementById('zoom-out').onclick = () => canvas.setZoom(S.view.zoom / 1.25);
  document.getElementById('zoom-fit').onclick = () => canvas.fitAll();

  api.on.docChanged((id, doc) => {
    if (id !== S.wsId) return;
    if (S.floorId && !doc.payload.floors.some((f) => f.id === S.floorId)) S.floorId = null;
    setDoc(id, doc);
    renderFloors();
    refreshHistory();
    soon();
  });
  api.on.termData((id, d) => canvas.viewOf(id)?.data?.(d));
  let statsTimer = 0;
  const soon = () => {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => sidebar.refreshStats(), 400);
  };
  api.on.termStatus((id, s) => {
    canvas.viewOf(id)?.status?.(s);
    soon();
  });
  api.on.termExit((id) => canvas.viewOf(id)?.exit?.());
  api.on.connStatus((ws, cid, st) => ws === S.wsId && canvas.setConnStatus(cid, st));
  api.on.noteChanged((nodeId) => canvas.viewOf(nodeId)?.external?.());
  api.on.prefs((p) => {
    S.prefs = p;
    applyScheme();
    refreshNodes();
  });
  api.on.toast((m) => toast(m, 5000));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyScheme();
    refreshNodes();
  });
  document.addEventListener('workspaces-imported', async (e) => {
    S.workspaces = e.detail.workspaces;
    switchTo(e.detail.activeId, e.detail.doc);
  });
  window.addEventListener('beforeunload', () => flush());

  setDoc(init.activeId, init.doc, { resetView: true });
  canvas.applyView();
  renderSidebar();
  renderFloors();
  refreshHistory();

  if (init.crashed) {
    const b = document.getElementById('banner');
    b.hidden = false;
    b.append(
      icon('circle-alert', 16),
      t('open-maestri did not shut down cleanly last time. Your workspace was restored from the last autosave.'),
      el('button', { class: 'btn-ghost', onclick: () => (b.hidden = true) }, t('Dismiss')),
    );
  }
  window.__omaestri = {
    S,
    canvas,
    addNode,
    setFloor,
    renderFloors,
    select,
    setMode,
    sidebar: {
      refresh: () => sidebar.refreshStats(),
      createGroup: (n) => sidebar.createGroup(n),
      moveWorkspace: (id, target) => sidebar.moveWorkspace(id, target),
      layout: () => sidebar.layoutOf(),
    },
  };
}

boot().catch((err) => {
  console.error(err);
  document.body.prepend(
    el('pre', { style: { color: 'red', padding: '20px', userSelect: 'text' } }, String((err && err.stack) || err)),
  );
});
