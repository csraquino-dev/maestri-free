'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'sidebar-layout.js')).href);

const W = (id, extra = {}) => ({ id, name: `Workspace ${id}`, isPinned: false, ...extra });

test('untracked workspaces show at top level; pinned ones in their own section', async () => {
  const L = await load();
  const tree = L.visibleTree(L.emptyLayout(), [W('a'), W('b', { isPinned: true }), W('c')]);
  assert.deepEqual(
    tree.pinned.map((w) => w.id),
    ['b'],
  );
  assert.deepEqual(
    tree.top.map((i) => i.workspaceId),
    ['a', 'c'],
  );
});

test('groups and folders: create, rename, toggle, move workspaces in and between them', async () => {
  const L = await load();
  let l = L.createGroup(L.emptyLayout(), 'Clients');
  const g = l.groups[0];
  l = L.createFolder(l, 'Frontend');
  const f = l.topLevelItems[0].folder;
  l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: 'a' }, { kind: 'group', groupId: g.id, beforeId: null });
  assert.deepEqual(l.groups[0].items, [{ kind: 'workspace', workspaceId: 'a' }]);
  l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: 'a' }, { kind: 'folder', folderId: f.id, beforeId: null });
  assert.deepEqual(l.topLevelItems[0].folder.workspaceIds, ['a']);
  assert.equal(l.groups[0].items.length, 0, 'moved out of the group');
  l = L.renameNode(l, f.id, 'Web');
  assert.equal(L.findFolder(l, f.id).name, 'Web');
  l = L.toggleExpanded(l, g.id);
  assert.equal(l.groups[0].isExpanded, false);
  assert.ok(L.allAssignedWorkspaceIds(l).has('a'));
});

test('reordering: drop before a sibling, drop at end, groups reorder with groupOrder', async () => {
  const L = await load();
  let l = L.emptyLayout();
  for (const id of ['a', 'b', 'c'])
    l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: id }, { kind: 'top', beforeId: null });
  l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: 'c' }, { kind: 'top', beforeId: 'a' });
  assert.deepEqual(
    l.topLevelItems.map((i) => i.workspaceId),
    ['c', 'a', 'b'],
  );
  l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: 'c' }, { kind: 'top', beforeId: null });
  assert.deepEqual(
    l.topLevelItems.map((i) => i.workspaceId),
    ['a', 'b', 'c'],
  );
  l = L.createGroup(L.createGroup(L.createGroup(l, 'G1'), 'G2'), 'G3');
  const [g1, , g3] = l.groups;
  l = L.moveSidebarItem(l, { kind: 'group', groupId: g3.id }, { kind: 'groupOrder', beforeGroupId: g1.id });
  assert.deepEqual(
    l.groups.map((g) => g.name),
    ['G3', 'G1', 'G2'],
  );
  assert.deepEqual(
    l.groups.map((g) => g.sortOrder),
    [0, 1, 2],
  );
});

test('a folder cannot be dropped into a folder; a group cannot be dropped as a workspace target', async () => {
  const L = await load();
  let l = L.createFolder(L.createFolder(L.emptyLayout(), 'A'), 'B');
  const [fa, fb] = l.topLevelItems.map((i) => i.folder);
  assert.equal(
    L.moveSidebarItem(l, { kind: 'folder', folderId: fa.id }, { kind: 'folder', folderId: fb.id, beforeId: null }),
    l,
  );
  l = L.createGroup(l, 'G');
  assert.equal(L.moveSidebarItem(l, { kind: 'group', groupId: l.groups[0].id }, { kind: 'top', beforeId: null }), l);
});

test('deleting a group or folder returns its workspaces to the top level', async () => {
  const L = await load();
  let l = L.createFolder(L.createGroup(L.emptyLayout(), 'G'), 'F', null);
  const f = l.topLevelItems[0].folder;
  l = L.moveSidebarItem(l, { kind: 'workspace', workspaceId: 'x' }, { kind: 'folder', folderId: f.id, beforeId: null });
  l = L.deleteContainer(l, f.id);
  assert.deepEqual(
    l.topLevelItems.map((i) => i.workspaceId),
    ['x'],
  );
  l = L.moveSidebarItem(
    l,
    { kind: 'workspace', workspaceId: 'x' },
    { kind: 'group', groupId: l.groups[0].id, beforeId: null },
  );
  l = L.deleteContainer(l, l.groups[0].id);
  assert.deepEqual(
    l.topLevelItems.map((i) => i.workspaceId),
    ['x'],
  );
  assert.equal(l.groups.length, 0);
});

test('search keeps only matching workspaces and the containers that hold them', async () => {
  const L = await load();
  let l = L.createGroup(L.emptyLayout(), 'Work');
  l = L.moveSidebarItem(
    l,
    { kind: 'workspace', workspaceId: 'api' },
    { kind: 'group', groupId: l.groups[0].id, beforeId: null },
  );
  const ws = [W('api', { name: 'Billing API' }), W('web', { name: 'Website' }), W('doc', { name: 'Docs' })];
  const tree = L.visibleTree(l, ws, 'api');
  assert.equal(tree.groups.length, 1);
  assert.equal(tree.top.length, 0);
  const none = L.visibleTree(l, ws, 'zzz');
  assert.equal(none.groups.length, 0);
  assert.equal(none.top.length, 0);
});

test('forgetting a workspace removes it everywhere; width is clamped; floors expand by default', async () => {
  const L = await load();
  let l = L.moveSidebarItem(L.emptyLayout(), { kind: 'workspace', workspaceId: 'a' }, { kind: 'top', beforeId: null });
  l = L.forgetWorkspace(l, 'a');
  assert.equal(L.allAssignedWorkspaceIds(l).size, 0);
  assert.equal(L.normalizeLayout({ width: 9999 }).width, L.MAX_WIDTH);
  assert.equal(L.normalizeLayout({ width: 10 }).width, L.MIN_WIDTH);
  assert.equal(L.isFloorListExpanded(l, 'x'), true);
  l = L.setFloorListExpanded(l, 'x', false);
  assert.equal(L.isFloorListExpanded(l, 'x'), false);
});
