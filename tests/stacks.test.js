'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-stk-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');

let core, ws, doc, S, T, N1, N2, N3;
const cli = path.join(__dirname, '..', 'cli', 'omaestri.js');
const { execFile } = require('child_process');
const omaestri = (tid, ...args) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: tid }, timeout: 60000 },
      (e, o) => resolve(o.trim()),
    ),
  );

test.before(async () => {
  core = await createCore();
  ws = core.workspaces;
  doc = ws.activeDoc;
  S = core.stacks;
  T = ws.addTerminal(doc, { name: 'Agent', workingDirectory: os.tmpdir() });
  N1 = ws.addNote(doc, { name: 'One', content: 'first page', anchorId: T.id });
  N2 = ws.addNote(doc, { name: 'Two', content: 'second page', anchorId: T.id });
  N3 = ws.addNote(doc, { name: 'Three', content: 'third page', anchorId: T.id });
  ws.connect(doc, T.id, N1.id);
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test("create needs two free notes; the stack takes the first note's place and mirrors connections", () => {
  assert.throws(() => S.create(doc, [N1.id]), /at least two notes/);
  const stack = S.create(doc, [N1.id, N2.id]);
  const d = stack.content.noteStack._0;
  assert.deepEqual(d.memberNodeIds, [N1.id, N2.id]);
  assert.equal(d.frontNoteId, N1.id);
  assert.deepEqual(stack.frame, N1.frame);
  assert.deepEqual([...S.memberIds(doc)].sort(), [N1.id, N2.id].sort());
  assert.equal(S.stackOf(doc, N2.id).id, stack.id);
  // N1 was connected to the agent, so N2 (now a page of the same stack) is too
  assert.ok(doc.payload.noteConnections.some((c) => c.terminalId === T.id && c.noteNodeId === N2.id));
  assert.throws(
    () => S.create(doc, [N1.id, N3.id]),
    /at least two notes/,
    'a note already in a stack cannot be filed again',
  );
});

test('an agent reads every page of a connected stack through the CLI', async () => {
  core.startWorkspaceTerminals(ws.activeId);
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(await omaestri(T.id, 'note', 'read', 'Two'), /second page/);
  assert.match(await omaestri(T.id, 'note', 'read', 'One'), /first page/);
});

test('connecting to the stack node connects to all pages', () => {
  const stack = doc.payload.nodes.find((n) => n.content.noteStack);
  const T2 = ws.addTerminal(doc, { name: 'Other', workingDirectory: os.tmpdir() });
  assert.ok(ws.connect(doc, T2.id, stack.id));
  const mine = doc.payload.noteConnections
    .filter((c) => c.terminalId === T2.id)
    .map((c) => c.noteNodeId)
    .sort();
  assert.deepEqual(mine, [N1.id, N2.id].sort());
});

test('add notes, add page, reorder, front page, rename', () => {
  const stack = doc.payload.nodes.find((n) => n.content.noteStack);
  assert.equal(S.addNotes(doc, stack.id, [N3.id, N3.id]), 1);
  assert.deepEqual(stack.content.noteStack._0.memberNodeIds, [N1.id, N2.id, N3.id]);
  const page = S.addPage(doc, stack.id);
  assert.equal(stack.content.noteStack._0.frontNoteId, page.id);
  assert.match(workspacesName(page), /^Página/);
  S.moveMember(doc, stack.id, N3.id, N1.id);
  assert.deepEqual(stack.content.noteStack._0.memberNodeIds.slice(0, 3), [N3.id, N1.id, N2.id]);
  S.setFront(doc, stack.id, N2.id);
  assert.equal(stack.content.noteStack._0.frontNoteId, N2.id);
  assert.throws(() => S.setFront(doc, stack.id, 'nope'), /not in the stack/);
  S.rename(doc, stack.id, 'Specs');
  assert.deepEqual([stack.content.noteStack._0.name, stack.content.noteStack._0.hasCustomName], ['Specs', true]);
});
const workspacesName = (n) => n.content.stickyNote._0.fileName.replace(/\.md$/, '');

test('uniform colour copies the front page colour to every page', () => {
  const stack = doc.payload.nodes.find((n) => n.content.noteStack);
  const front = doc.payload.nodes.find((n) => n.id === stack.content.noteStack._0.frontNoteId);
  front.content.stickyNote._0.color = '#e4f0ff';
  assert.equal(S.toggleUniformColor(doc, stack.id), true);
  for (const id of stack.content.noteStack._0.memberNodeIds)
    assert.equal(doc.payload.nodes.find((n) => n.id === id).content.stickyNote._0.color, '#e4f0ff');
});

test('spill takes a page out; a stack left with one page dissolves; unstack restores every note', () => {
  let stack = doc.payload.nodes.find((n) => n.content.noteStack);
  const members = [...stack.content.noteStack._0.memberNodeIds];
  const out = S.spill(doc, stack.id, members[0]);
  assert.ok(!S.memberIds(doc).has(out.id));
  assert.notDeepEqual(out.frame, stack.frame, 'placed beside the stack');
  S.unstackAll(doc, stack.id);
  assert.ok(!doc.payload.nodes.some((n) => n.content.noteStack));
  assert.equal(S.memberIds(doc).size, 0, 'all notes are free again');
  // two notes -> stack -> spill one -> only one left -> dissolved automatically
  stack = S.create(doc, [N1.id, N2.id]);
  S.spill(doc, stack.id, N1.id);
  assert.ok(!doc.payload.nodes.some((n) => n.content.noteStack));
});

test('remove: keepNotes=false deletes the pages and their files', () => {
  const stack = S.create(doc, [N1.id, N2.id]);
  const file = ws.notePath(doc, N2);
  assert.ok(fs.existsSync(file));
  S.remove(doc, stack.id, { keepNotes: false });
  assert.ok(!doc.payload.nodes.some((n) => n.id === N1.id || n.id === N2.id || n.id === stack.id));
  assert.ok(!fs.existsSync(file));
});
