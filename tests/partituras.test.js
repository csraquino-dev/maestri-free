'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-prt-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(
  path.join(home, 'preferences.json'),
  JSON.stringify({
    skillPaths: [],
    rolePresets: [{ id: 'ROLE-1', name: 'Reviewer', prompt: 'Review.', color: '#007AFF', icon: 'person.fill' }],
  }),
);
const { createCore } = require('../main/core');
const { createPartituras } = require('../main/partituras');

let core, ws, doc, P, A, B, N, outside;
test.before(async () => {
  core = await createCore();
  ws = core.workspaces;
  doc = ws.activeDoc;
  P = createPartituras({
    workspaces: ws,
    prefs: () => core.ui.prefs(),
    savePrefs: (p) => core.ui.savePrefs(p),
    rootDir: home,
  });
  A = ws.addTerminal(doc, {
    name: 'Lead',
    command: 'claude',
    workingDirectory: os.tmpdir(),
    roleId: 'ROLE-1',
    isManager: true,
  });
  B = ws.addTerminal(doc, { name: 'Dev', command: 'codex', workingDirectory: os.tmpdir() }, A.id);
  N = ws.addNote(doc, { name: 'Plan', content: 'ship it', anchorId: A.id });
  outside = ws.addNote(doc, { name: 'Elsewhere', content: 'not selected' });
  ws.connect(doc, A.id, B.id);
  ws.connect(doc, A.id, N.id);
  ws.connect(doc, A.id, outside.id);
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test('capture keeps only the selection, its connections, note text, commands and roles', () => {
  const p = P.capture(ws.activeId, [A.id, B.id, N.id], { name: 'Team' });
  assert.equal(p.payload.nodes.length, 3);
  assert.equal(p.payload.connections.length, 1);
  assert.equal(p.payload.noteConnections.length, 1, 'the rope to the note outside the selection is dropped');
  assert.equal(p.noteTexts[N.id], 'ship it');
  assert.deepEqual(
    p.roles.map((r) => r.name),
    ['Reviewer'],
  );
  assert.deepEqual(
    P.commandsOf(p).map((c) => [c.name, c.command]),
    [
      ['Lead', 'claude'],
      ['Dev', 'codex'],
    ],
  );
  assert.throws(() => P.capture(ws.activeId, ['nope']), /nothing selected/);
});

test('save → list (workspace + global) → load → remove', () => {
  const p = P.capture(ws.activeId, [A.id, B.id], { name: 'Pair' });
  P.save(p, null);
  const q = P.capture(ws.activeId, [N.id], { name: 'Only note' });
  P.save(q, ws.activeId);
  const names = P.list(ws.activeId).map((x) => x.name);
  assert.deepEqual(names, ['Only note', 'Pair'], 'workspace partituras first, then global');
  assert.deepEqual(
    P.list(null).map((x) => x.name),
    ['Pair'],
  );
  assert.equal(P.list(null)[0].terminals, 2);
  assert.equal(P.load(p.id, null).name, 'Pair');
  assert.equal(P.load('../../etc/passwd', null), null, 'ids are never used as paths');
  assert.ok(P.remove(q.id, ws.activeId));
  assert.equal(P.list(ws.activeId).length, 1);
});

test('place: fresh ids, relocated, connections remapped, notes written with unique names, roles imported', () => {
  const p = P.capture(ws.activeId, [A.id, B.id, N.id], { name: 'Team' });
  // pretend the role is missing in this installation
  const prefs = core.ui.prefs();
  prefs.rolePresets = [];
  core.ui.savePrefs(prefs);
  const before = doc.payload.nodes.length;
  const r = P.place(ws.activeId, p, { x: 20000, y: 20000 });
  assert.equal(r.nodeIds.length, 3);
  assert.equal(doc.payload.nodes.length, before + 3);
  assert.ok(r.nodeIds.every((id) => ![A.id, B.id, N.id].includes(id)));
  const placed = doc.payload.nodes.filter((n) => r.nodeIds.includes(n.id));
  assert.equal(Math.min(...placed.map((n) => n.frame[0][0])), 20000);
  assert.equal(Math.min(...placed.map((n) => n.frame[0][1])), 20000);
  const term = placed.find((n) => n.content.terminal && n.content.terminal._0.name === 'Lead');
  assert.equal(term.content.terminal._0.id, term.id);
  assert.ok(doc.payload.connections.some((c) => [c.terminalIdA, c.terminalIdB].every((x) => r.nodeIds.includes(x))));
  const note = placed.find((n) => n.content.stickyNote);
  assert.equal(note.content.stickyNote._0.fileName, 'Plan 2.md', 'a clash with the existing "Plan" note is resolved');
  assert.equal(fs.readFileSync(ws.notePath(doc, note), 'utf8'), 'ship it');
  assert.equal(r.rolesAdded, 1);
  assert.equal(core.ui.prefs().rolePresets[0].name, 'Reviewer');
  const again = P.place(ws.activeId, p, { x: 21000, y: 20000 });
  assert.equal(again.rolesAdded, 0, 'roles are only added once');
});

test('export / import round-trips; foreign files are rejected', () => {
  const p = P.capture(ws.activeId, [A.id, N.id], { name: 'Export me' });
  P.save(p, null);
  const file = path.join(home, 'x.partitura.json');
  P.exportTo(p.id, null, file);
  const imported = P.importFrom(file, null);
  assert.notEqual(imported.id, p.id);
  assert.equal(imported.name, 'Export me');
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'nope' }));
  assert.throws(() => P.importFrom(bad), /not a partitura file/);
});
