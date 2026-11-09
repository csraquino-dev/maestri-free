// Maestri-style sidebar: search pill + "+" , pinned section, groups, folders, workspace rows with live
// terminal activity and floors, drag & drop reordering, resizable width, footer (new group / routines / preferences).
import { el, contextMenu, WORKSPACE_COLORS } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api } from './store.js';
import * as L from './sidebar-layout.js';

const DRAG_MIME = 'application/x-omaestri-sidebar';
let layout = L.emptyLayout();
let query = '';
let stats = {}; // workspaceId -> { terminals, running, attention, floors:[{id,name}] }
let H = {};
const saveLayout = (() => {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => api.sidebarSet(layout), 250);
  };
})();

const root = () => document.getElementById('ws-list');
const sidebar = () => document.getElementById('sidebar');

export async function initSidebar(handlers) {
  H = handlers;
  layout = L.normalizeLayout(await api.sidebarGet());
  applyWidth();
  const input = document.getElementById('sb-search');
  input.placeholder = t('Search workspaces');
  input.addEventListener('input', () => {
    query = input.value;
    render();
  });
  document.getElementById('btn-new-ws').onclick = () => H.createWorkspace();
  document.getElementById('sb-new-group').onclick = () =>
    H.promptName(t('New group'), '', (name) => update(L.createGroup(layout, name)));
  document.getElementById('btn-routines').onclick = () => H.routines();
  document.getElementById('btn-prefs').onclick = () => H.preferences();
  setupResize();
  // a workspace file dropped on the list is imported
  const list = root();
  list.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      list.classList.add('file-over');
    }
  });
  list.addEventListener('dragleave', () => list.classList.remove('file-over'));
  list.addEventListener('drop', (e) => {
    list.classList.remove('file-over');
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.json$/i.test(x.name));
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    H.importWs(window.maestri.pathForFile(f));
  });
  await refreshStats();
}

export async function refreshStats() {
  [S.workspaces, stats] = await Promise.all([api.listWorkspaces(), api.workspaceStats()]);
  render();
}

const update = (next) => {
  layout = next;
  saveLayout();
  render();
};
const applyWidth = () => {
  sidebar().style.width = `${layout.width}px`;
};

function setupResize() {
  const h = document.getElementById('sb-resize');
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-sidebar');
    const startX = e.clientX,
      start = layout.width;
    const move = (ev) => {
      layout.width = Math.max(L.MIN_WIDTH, Math.min(L.MAX_WIDTH, start + ev.clientX - startX));
      applyWidth();
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-sidebar');
      saveLayout();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
}

// ----------------------------------------------------------------- drag & drop
function writeDrag(e, item) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'move';
}
const hasDrag = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG_MIME);
function readDrag(e) {
  try {
    return JSON.parse(e.dataTransfer.getData(DRAG_MIME));
  } catch {
    return null;
  }
}
function endDrag() {
  document.querySelectorAll('.sb-caret, .sb-drop').forEach((n) => n.classList.remove('sb-caret', 'sb-drop'));
}

function dropZone(node, target, { into = false } = {}) {
  node.addEventListener('dragover', (e) => {
    if (!hasDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    node.classList.add(into ? 'sb-drop' : 'sb-caret');
  });
  node.addEventListener('dragleave', () => node.classList.remove('sb-caret', 'sb-drop'));
  node.addEventListener('drop', (e) => {
    const item = readDrag(e);
    endDrag();
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    update(L.moveSidebarItem(layout, item, target));
  });
}

// ------------------------------------------------------------------------ rows
function activityBadge(s) {
  if (!s || !s.terminals) return null;
  return el(
    'span',
    {
      class: `sb-act${s.running ? ' running' : ''}`,
      title: t('{n} terminal(s), {r} working', { n: s.terminals, r: s.running }),
    },
    icon('terminal', 11),
    String(s.terminals),
    s.running ? el('i', { class: 'sb-pulse' }) : null,
  );
}

function workspaceRow(w, target) {
  const s = stats[w.id];
  const active = w.id === S.wsId;
  const floors = (s && s.floors) || [];
  const showFloors = floors.length > 0 && L.isFloorListExpanded(layout, w.id);
  const row = el('li', { class: 'sb-li', draggable: !w.isPinned });
  const btn = el(
    'button',
    {
      class: `sb-row${active && !(showFloors && S.floorId) ? ' active' : ''}`,
      type: 'button',
      title: w.workingDirectory,
      onclick: () => H.open(w.id, null),
      oncontextmenu: (e) => {
        e.preventDefault();
        workspaceMenu(e, w);
      },
    },
    el('span', { class: 'ws-dot', style: { background: WORKSPACE_COLORS[w.color] || WORKSPACE_COLORS.blue } }),
    el('span', { class: 'ws-name' }, w.name || t('Untitled workspace')),
    w.isPinned ? icon('pin', 11, 'ws-pin') : null,
    activityBadge(s),
    floors.length
      ? el(
          'span',
          {
            class: 'sb-floor-toggle',
            title: showFloors ? t('Hide floors') : t('Show floors'),
            onclick: (e) => {
              e.stopPropagation();
              update(L.setFloorListExpanded(layout, w.id, !showFloors));
            },
          },
          icon(showFloors ? 'chevron-down' : 'chevron-right', 13),
        )
      : null,
  );
  row.append(btn);
  if (showFloors) {
    row.append(
      el(
        'ul',
        { class: 'sb-floors' },
        ...floors.map((f) =>
          el(
            'li',
            {},
            el(
              'button',
              {
                class: `sb-row sub${active && S.floorId === f.id ? ' active' : ''}`,
                type: 'button',
                onclick: () => H.open(w.id, f.id),
              },
              icon('git-branch', 12),
              el('span', { class: 'ws-name' }, f.name),
            ),
          ),
        ),
      ),
    );
  }
  const item = { kind: 'workspace', workspaceId: w.id };
  row.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    writeDrag(e, item);
    row.classList.add('sb-dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('sb-dragging');
    endDrag();
  });
  if (target) dropZone(row, target);
  return row;
}

function containerHeader(kind, c, count) {
  const open = c.isExpanded !== false;
  return el(
    'div',
    { class: 'sb-head-row' },
    icon(open ? 'chevron-down' : 'chevron-right', 13),
    icon(kind === 'group' ? 'layers' : 'folder', 14, 'sb-ic'),
    el('span', { class: 'ws-name' }, c.name),
    el('span', { class: 'sb-count' }, String(count)),
  );
}

function folderRow(folder, ctx) {
  const byId = ctx.byId;
  const kids = folder.workspaceIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .filter((w) => !query || (w.name || '').toLowerCase().includes(query.toLowerCase()));
  const li = el('li', { class: 'sb-li sb-folder', draggable: true });
  const head = el(
    'button',
    {
      class: 'sb-row container',
      type: 'button',
      onclick: () => update(L.toggleExpanded(layout, folder.id)),
      oncontextmenu: (e) => {
        e.preventDefault();
        containerMenu(e, folder.id, 'folder');
      },
    },
    containerHeader('folder', folder, folder.workspaceIds.length),
  );
  li.append(head);
  if (folder.isExpanded !== false || query)
    li.append(
      el(
        'ul',
        { class: 'sb-children' },
        ...kids.map((w) => workspaceRow(w, { kind: 'folder', folderId: folder.id, beforeId: w.id })),
      ),
    );
  const item = { kind: 'folder', folderId: folder.id };
  li.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    writeDrag(e, item);
  });
  li.addEventListener('dragend', endDrag);
  dropZone(head, { kind: 'folder', folderId: folder.id, beforeId: null }, { into: true });
  if (ctx.beforeTarget) dropZone(li, ctx.beforeTarget);
  return li;
}

function groupBlock(g, tree) {
  const li = el('li', { class: 'sb-li sb-group', draggable: true });
  const head = el(
    'button',
    {
      class: 'sb-row container group',
      type: 'button',
      onclick: () => update(L.toggleExpanded(layout, g.id)),
      oncontextmenu: (e) => {
        e.preventDefault();
        containerMenu(e, g.id, 'group');
      },
    },
    containerHeader('group', g, g.items.length),
  );
  li.append(head);
  if (g.isExpanded !== false || query) {
    li.append(
      el(
        'ul',
        { class: 'sb-children' },
        ...g.items.map((it) =>
          it.kind === 'workspace'
            ? workspaceRow(tree.byId.get(it.workspaceId), { kind: 'group', groupId: g.id, beforeId: it.workspaceId })
            : folderRow(it.folder, {
                byId: tree.byId,
                beforeTarget: { kind: 'group', groupId: g.id, beforeId: it.folder.id },
              }),
        ),
      ),
    );
  }
  const item = { kind: 'group', groupId: g.id };
  li.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    writeDrag(e, item);
  });
  li.addEventListener('dragend', endDrag);
  // dropping on the header: workspaces/folders go into the group, groups reorder before it
  head.addEventListener('dragover', (e) => {
    if (hasDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      head.classList.add('sb-drop');
    }
  });
  head.addEventListener('dragleave', () => head.classList.remove('sb-drop'));
  head.addEventListener('drop', (e) => {
    const it = readDrag(e);
    endDrag();
    if (!it) return;
    e.preventDefault();
    e.stopPropagation();
    update(
      L.moveSidebarItem(
        layout,
        it,
        it.kind === 'group'
          ? { kind: 'groupOrder', beforeGroupId: g.id }
          : { kind: 'group', groupId: g.id, beforeId: null },
      ),
    );
  });
  return li;
}

// ------------------------------------------------------------------------ menus
function containerOptions() {
  const out = [];
  for (const g of layout.groups)
    out.push({
      label: t('Move to group “{n}”', { n: g.name }),
      icon: 'layers',
      target: { kind: 'group', groupId: g.id, beforeId: null },
    });
  const folders = [];
  const read = (items) =>
    items.forEach((it) => {
      if (it.kind === 'folder') folders.push(it.folder);
    });
  read(layout.topLevelItems);
  layout.groups.forEach((g) => read(g.items));
  for (const f of folders)
    out.push({
      label: t('Move to folder “{n}”', { n: f.name }),
      icon: 'folder',
      target: { kind: 'folder', folderId: f.id, beforeId: null },
    });
  return out;
}

function workspaceMenu(e, w) {
  const item = { kind: 'workspace', workspaceId: w.id };
  contextMenu(e.clientX, e.clientY, [
    { label: t('Edit…'), icon: 'pencil', run: () => H.edit(w) },
    { label: w.isPinned ? t('Unpin') : t('Pin to top'), icon: 'pin', run: () => H.togglePin(w) },
    ...containerOptions().map((o) => ({
      label: o.label,
      icon: o.icon,
      run: () => update(L.moveSidebarItem(layout, item, o.target)),
    })),
    {
      label: t('Move to top level'),
      icon: 'arrow-up-right',
      run: () => update(L.moveSidebarItem(layout, item, { kind: 'top', beforeId: null })),
    },
    { label: t('Open folder'), icon: 'folder-open', run: () => api.openPath(w.workingDirectory) },
    { label: t('Duplicate'), icon: 'copy', run: () => H.duplicate(w) },
    { label: t('Export workspace…'), icon: 'download', run: () => H.exportWs(w) },
    { label: t('Delete'), icon: 'trash-2', danger: true, run: () => H.remove(w) },
  ]);
}

function containerMenu(e, id, kind) {
  contextMenu(e.clientX, e.clientY, [
    {
      label: t('Rename…'),
      icon: 'pencil',
      run: () => {
        const n = kind === 'group' ? layout.groups.find((g) => g.id === id) : L.findFolder(layout, id);
        H.promptName(t('Rename'), n ? n.name : '', (name) => update(L.renameNode(layout, id, name)));
      },
    },
    ...(kind === 'group'
      ? [
          {
            label: t('New folder in this group'),
            icon: 'folder',
            run: () => H.promptName(t('New folder'), '', (name) => update(L.createFolder(layout, name, id))),
          },
        ]
      : []),
    {
      label: kind === 'group' ? t('Delete group (keeps workspaces)') : t('Delete folder (keeps workspaces)'),
      icon: 'trash-2',
      danger: true,
      run: () => update(L.deleteContainer(layout, id)),
    },
  ]);
}

// ----------------------------------------------------------------------- render
export function render() {
  const list = root();
  if (!list) return;
  const tree = L.visibleTree(layout, S.workspaces, query);
  const nodes = [];
  if (tree.pinned.length)
    nodes.push(
      el(
        'li',
        { class: 'sb-section' },
        el('div', { class: 'sb-label' }, t('Pinned')),
        el('ul', {}, ...tree.pinned.map((w) => workspaceRow(w, null))),
      ),
    );
  if (tree.top.length) {
    nodes.push(
      el(
        'li',
        { class: 'sb-section' },
        el(
          'ul',
          {},
          ...tree.top.map((it) =>
            it.kind === 'workspace'
              ? workspaceRow(tree.byId.get(it.workspaceId), { kind: 'top', beforeId: it.workspaceId })
              : folderRow(it.folder, { byId: tree.byId, beforeTarget: { kind: 'top', beforeId: it.folder.id } }),
          ),
        ),
      ),
    );
  }
  for (const g of tree.groups) nodes.push(groupBlock(g, tree));
  if (!nodes.length)
    nodes.push(el('li', { class: 'sb-empty' }, query ? t('No matching workspaces') : t('No workspaces yet')));
  const ul = el('ul', { class: 'sb-root' }, ...nodes);
  // dropping on empty space at the bottom = move to the end of the top level
  ul.addEventListener('dragover', (e) => {
    if (hasDrag(e)) e.preventDefault();
  });
  ul.addEventListener('drop', (e) => {
    const it = readDrag(e);
    endDrag();
    if (!it || it.kind === 'group') return;
    e.preventDefault();
    update(L.moveSidebarItem(layout, it, { kind: 'top', beforeId: null }));
  });
  list.replaceChildren(ul);
  const e = S.workspaces.find((w) => w.id === S.wsId);
  const title = document.getElementById('ws-title');
  if (title) title.textContent = e ? `${e.name}  ·  ${e.workingDirectory}` : '';
}

export const layoutOf = () => layout;
export const forget = (id) => update(L.forgetWorkspace(layout, id));

// test/automation helpers
export const createGroup = (name) => update(L.createGroup(layout, name));
export const moveWorkspace = (workspaceId, target) =>
  update(L.moveSidebarItem(layout, { kind: 'workspace', workspaceId }, target));
