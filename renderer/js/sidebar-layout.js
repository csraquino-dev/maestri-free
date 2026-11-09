// Sidebar layout model (pure, DOM-free). Mirrors the structure observed in Maestri's sidebar:
//   topLevelItems: workspace | folder         groups: collapsible sections holding workspaces/folders
//   folder: { id, name, isExpanded, workspaceIds[] }      group: { id, name, sortOrder, isExpanded, items[] }
// Drag items:   {kind:'workspace',workspaceId} | {kind:'folder',folderId} | {kind:'group',groupId}
// Drop targets: {kind:'top',beforeId} | {kind:'group',groupId,beforeId} | {kind:'folder',folderId,beforeId} | {kind:'groupOrder',beforeGroupId}
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 480;
export const DEFAULT_WIDTH = 260;

export const emptyLayout = () => ({ topLevelItems: [], groups: [], floorListExpanded: {}, width: DEFAULT_WIDTH });

export function normalizeLayout(raw) {
  const l = { ...emptyLayout(), ...(raw && typeof raw === 'object' ? raw : {}) };
  l.topLevelItems = Array.isArray(l.topLevelItems) ? l.topLevelItems : [];
  l.groups = Array.isArray(l.groups) ? l.groups : [];
  l.floorListExpanded = l.floorListExpanded && typeof l.floorListExpanded === 'object' ? l.floorListExpanded : {};
  l.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(l.width) || DEFAULT_WIDTH));
  return l;
}

export const itemId = (item) =>
  item.kind === 'workspace' ? item.workspaceId : item.kind === 'folder' ? item.folder.id : item.groupId;
const uid = () => (crypto.randomUUID ? crypto.randomUUID().toUpperCase() : String(Math.random()).slice(2));

export function allAssignedWorkspaceIds(layout) {
  const ids = new Set();
  const read = (items) => {
    for (const it of items) {
      if (it.kind === 'workspace') ids.add(it.workspaceId);
      else if (it.kind === 'folder') it.folder.workspaceIds.forEach((w) => ids.add(w));
    }
  };
  read(layout.topLevelItems);
  layout.groups.forEach((g) => read(g.items));
  return ids;
}

export function findFolder(layout, folderId) {
  for (const it of layout.topLevelItems) if (it.kind === 'folder' && it.folder.id === folderId) return it.folder;
  for (const g of layout.groups)
    for (const it of g.items) if (it.kind === 'folder' && it.folder.id === folderId) return it.folder;
  return null;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// Remove the dragged thing from wherever it currently is; returns the removed item (or null).
function detach(layout, item) {
  if (item.kind === 'group') {
    const i = layout.groups.findIndex((g) => g.id === item.groupId);
    return i < 0 ? null : layout.groups.splice(i, 1)[0];
  }
  const same = (it) =>
    item.kind === 'workspace'
      ? it.kind === 'workspace' && it.workspaceId === item.workspaceId
      : it.kind === 'folder' && it.folder.id === item.folderId;
  const pull = (arr) => {
    const i = arr.findIndex(same);
    return i < 0 ? null : arr.splice(i, 1)[0];
  };
  let found = pull(layout.topLevelItems);
  if (!found)
    for (const g of layout.groups) {
      found = pull(g.items);
      if (found) break;
    }
  if (found) return found;
  if (item.kind === 'workspace') {
    const visit = (arr) => {
      for (const it of arr)
        if (it.kind === 'folder') {
          const i = it.folder.workspaceIds.indexOf(item.workspaceId);
          if (i >= 0) {
            it.folder.workspaceIds.splice(i, 1);
            return true;
          }
        }
      return false;
    };
    if (visit(layout.topLevelItems)) return { kind: 'workspace', workspaceId: item.workspaceId };
    for (const g of layout.groups) if (visit(g.items)) return { kind: 'workspace', workspaceId: item.workspaceId };
  }
  // an untracked workspace (never placed yet) is still draggable
  return item.kind === 'workspace' ? { kind: 'workspace', workspaceId: item.workspaceId } : null;
}

export function moveSidebarItem(prev, item, target) {
  const layout = clone(prev);
  if (item.kind === 'group') {
    if (target.kind !== 'groupOrder') return prev;
    const g = detach(layout, item);
    if (!g) return prev;
    const idx =
      target.beforeGroupId === null
        ? layout.groups.length
        : layout.groups.findIndex((x) => x.id === target.beforeGroupId);
    layout.groups.splice(idx < 0 ? layout.groups.length : idx, 0, g);
    layout.groups.forEach((x, i) => {
      x.sortOrder = i;
    });
    return layout;
  }
  if (target.kind === 'groupOrder') return prev;
  // a folder cannot be dropped into another folder
  if (item.kind === 'folder' && target.kind === 'folder') return prev;
  const moved = detach(layout, item);
  if (!moved) return prev;
  const place = (arr, wrap, idOf) => {
    const idx = target.beforeId == null ? arr.length : arr.findIndex((x) => idOf(x) === target.beforeId);
    arr.splice(idx < 0 ? arr.length : idx, 0, wrap);
  };
  if (target.kind === 'top') place(layout.topLevelItems, moved, itemId);
  else if (target.kind === 'group') {
    const g = layout.groups.find((x) => x.id === target.groupId);
    if (!g) return prev;
    place(g.items, moved, itemId);
  } else if (target.kind === 'folder') {
    const f = findFolder(layout, target.folderId);
    if (!f || moved.kind !== 'workspace') return prev;
    const idx = target.beforeId == null ? f.workspaceIds.length : f.workspaceIds.indexOf(target.beforeId);
    f.workspaceIds.splice(idx < 0 ? f.workspaceIds.length : idx, 0, moved.workspaceId);
  }
  return layout;
}

export function createGroup(layout, name) {
  const l = clone(layout);
  l.groups.push({
    id: uid(),
    name: String(name).trim() || 'Group',
    sortOrder: l.groups.length,
    isExpanded: true,
    items: [],
  });
  return l;
}
export function createFolder(layout, name, groupId = null) {
  const l = clone(layout);
  const item = {
    kind: 'folder',
    folder: { id: uid(), name: String(name).trim() || 'Folder', isExpanded: true, workspaceIds: [] },
  };
  if (groupId) {
    const g = l.groups.find((x) => x.id === groupId);
    if (g) {
      g.items.push(item);
      return l;
    }
  }
  l.topLevelItems.push(item);
  return l;
}
export function renameNode(layout, id, name) {
  const l = clone(layout);
  const g = l.groups.find((x) => x.id === id);
  if (g) g.name = String(name).trim() || g.name;
  const f = findFolder(l, id);
  if (f) f.name = String(name).trim() || f.name;
  return l;
}
export function toggleExpanded(layout, id) {
  const l = clone(layout);
  const g = l.groups.find((x) => x.id === id);
  if (g) g.isExpanded = !g.isExpanded;
  const f = findFolder(l, id);
  if (f) f.isExpanded = !f.isExpanded;
  return l;
}
// Deleting a group/folder keeps its workspaces: they go back to the top level.
export function deleteContainer(layout, id) {
  const l = clone(layout);
  const gi = l.groups.findIndex((x) => x.id === id);
  if (gi >= 0) {
    const [g] = l.groups.splice(gi, 1);
    for (const it of g.items) l.topLevelItems.push(it);
    return l;
  }
  const pull = (arr) => {
    const i = arr.findIndex((it) => it.kind === 'folder' && it.folder.id === id);
    if (i < 0) return false;
    const [f] = arr.splice(i, 1);
    f.folder.workspaceIds.forEach((w) => l.topLevelItems.push({ kind: 'workspace', workspaceId: w }));
    return true;
  };
  if (!pull(l.topLevelItems)) for (const g of l.groups) if (pull(g.items)) break;
  return l;
}
export function forgetWorkspace(layout, workspaceId) {
  const l = clone(layout);
  detach(l, { kind: 'workspace', workspaceId });
  delete l.floorListExpanded[workspaceId];
  return l;
}
export function setFloorListExpanded(layout, workspaceId, expanded) {
  const l = clone(layout);
  l.floorListExpanded[workspaceId] = !!expanded;
  return l;
}
export const isFloorListExpanded = (layout, workspaceId) => layout.floorListExpanded[workspaceId] !== false;

// What to render: pinned workspaces, top-level items (+ every untracked workspace) and sorted groups,
// filtered by the search query (a container is kept when any of its workspaces match).
export function visibleTree(layout, workspaces, query = '') {
  const q = query.trim().toLowerCase();
  const match = (w) => !q || (w.name || '').toLowerCase().includes(q);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const assigned = allAssignedWorkspaceIds(layout);
  const pinned = workspaces.filter((w) => w.isPinned && match(w));
  const top = [
    ...layout.topLevelItems,
    ...workspaces
      .filter((w) => !w.isPinned && !assigned.has(w.id))
      .map((w) => ({ kind: 'workspace', workspaceId: w.id })),
  ];
  const keepItem = (it) => {
    if (it.kind === 'workspace') {
      const w = byId.get(it.workspaceId);
      return !!w && !w.isPinned && match(w);
    }
    return !q || it.folder.workspaceIds.some((id) => byId.has(id) && match(byId.get(id)));
  };
  const filterItems = (items) =>
    items.filter((it) => (it.kind === 'workspace' ? !!byId.get(it.workspaceId) : true)).filter(keepItem);
  const groups = layout.groups
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => ({ ...g, items: filterItems(g.items) }))
    .filter((g) => !q || g.items.length > 0);
  return { pinned, top: filterItems(top), groups, byId };
}
