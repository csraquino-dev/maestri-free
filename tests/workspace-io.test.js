'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-wio-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');
const { createWorkspaceIO } = require('../main/workspace-io');

let core, io, src;
test.before(async () => {
  core = await createCore();
  const ws = core.workspaces;
  src = ws.activeId;
  const doc = ws.activeDoc;
  const a = ws.addTerminal(doc, { name: 'Boss', workingDirectory: os.tmpdir() });
  const n = ws.addNote(doc, { name: 'Spec', content: 'copy me', anchorId: a.id });
  const p = ws.addPortal(doc, { name: 'Web', url: 'https://example.com', anchorId: a.id });
  ws.connect(doc, a.id, n.id);
  ws.connect(doc, a.id, p.id);
  doc.payload.floors.push({
    id: 'F1',
    name: 'floor',
    branchName: 'x',
    worktreePath: 'C:/nope',
    hooks: {},
    createdAt: '',
  });
  const onFloor = ws.addNote(doc, { name: 'OnFloor', floorId: 'F1' });
  ws.markDirty(src);
  io = createWorkspaceIO({ workspaces: ws, save: () => core.save() });
  void onFloor;
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test('duplicate: independent copy with fresh ids, notes copied, floors left behind', () => {
  const entry = io.duplicate(src);
  assert.match(entry.name, /\(copy\)$/);
  const copy = core.workspaces.getDoc(entry.id);
  const orig = core.workspaces.getDoc(src);
  assert.equal(copy.payload.nodes.length, orig.payload.nodes.filter((n) => !n.floorId).length);
  assert.equal(copy.payload.floors.length, 0);
  const origIds = new Set(orig.payload.nodes.map((n) => n.id));
  assert.ok(
    copy.payload.nodes.every((n) => !origIds.has(n.id)),
    'every node id is new',
  );
  const term = copy.payload.nodes.find((n) => n.content.terminal);
  assert.equal(term.content.terminal._0.id, term.id, 'terminal content id follows the node id');
  const ids = new Set(copy.payload.nodes.map((n) => n.id));
  assert.ok(copy.payload.noteConnections.every((c) => ids.has(c.terminalId) && ids.has(c.noteNodeId)));
  assert.ok(copy.payload.portalConnections.every((c) => ids.has(c.terminalId) && ids.has(c.portalNodeId)));
  assert.equal(fs.readFileSync(path.join(home, 'workspaces', entry.id, 'notes', 'Spec.md'), 'utf8'), 'copy me');
  fs.writeFileSync(path.join(home, 'workspaces', entry.id, 'notes', 'Spec.md'), 'changed in the copy');
  assert.equal(
    fs.readFileSync(path.join(home, 'workspaces', src, 'notes', 'Spec.md'), 'utf8'),
    'copy me',
    'the original is untouched',
  );
  assert.ok(core.workspaces.list().some((w) => w.id === entry.id));
});

test('export then import round-trips into a brand-new workspace', () => {
  const file = path.join(home, 'out.maestri-workspace.json');
  io.exportTo(src, file);
  const entry = io.importFrom(file);
  assert.notEqual(entry.id, src);
  const doc = core.workspaces.getDoc(entry.id);
  assert.ok(doc.payload.nodes.some((n) => n.content.stickyNote));
  assert.equal(fs.readFileSync(path.join(home, 'workspaces', entry.id, 'notes', 'Spec.md'), 'utf8'), 'copy me');
});

test('import rejects foreign files and ignores note names that try to escape the folder', () => {
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'something-else' }));
  assert.throws(() => io.importFrom(bad), /not an open-maestri workspace file/);
  const evil = JSON.parse(fs.readFileSync(path.join(home, 'out.maestri-workspace.json'), 'utf8'));
  evil.notes = { '..\\..\\evil.md': 'x', 'ok.md': 'fine' };
  fs.writeFileSync(bad, JSON.stringify(evil));
  const entry = io.importFrom(bad);
  assert.ok(fs.existsSync(path.join(home, 'workspaces', entry.id, 'notes', 'ok.md')));
  assert.ok(!fs.existsSync(path.join(home, 'evil.md')));
});
