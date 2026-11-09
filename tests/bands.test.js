'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-bnd-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');

let core, ws, doc, B, T1, T2, T3, NOTE;
test.before(async () => {
  core = await createCore();
  ws = core.workspaces;
  doc = ws.activeDoc;
  B = core.bands;
  T1 = ws.addTerminal(doc, { name: 'Front', workingDirectory: os.tmpdir() });
  T2 = ws.addTerminal(doc, { name: 'Back', workingDirectory: os.tmpdir() });
  T3 = ws.addTerminal(doc, { name: 'Ops', workingDirectory: os.tmpdir() });
  NOTE = ws.addNote(doc, { name: 'Shared', content: 'x' });
  ws.connect(doc, T1.id, NOTE.id);
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test('create needs two free terminals; the band is big enough for a terminal and mirrors connections', () => {
  assert.throws(() => B.create(doc, [T1.id]), /at least two terminals/);
  assert.throws(() => B.create(doc, [T1.id, NOTE.id]), /at least two terminals/, 'notes are not terminals');
  const band = B.create(doc, [T1.id, T2.id]);
  const d = band.content.band._0;
  assert.deepEqual(d.memberNodeIds, [T1.id, T2.id]);
  assert.equal(d.shownMemberId, T1.id);
  assert.ok(band.frame[1][0] >= 760 && band.frame[1][1] >= 420);
  assert.deepEqual(T2.frame, band.frame, "members take the band's frame");
  assert.ok(
    doc.payload.noteConnections.some((c) => c.terminalId === T2.id && c.noteNodeId === NOTE.id),
    'the note is now connected to every member',
  );
  assert.equal(B.bandOf(doc, T2.id).id, band.id);
  assert.throws(() => B.create(doc, [T1.id, T3.id]), /at least two terminals/, 'already banded');
});

test('connecting a node to the band connects every member', () => {
  const band = doc.payload.nodes.find((n) => n.content.band);
  const note2 = ws.addNote(doc, { name: 'Other', content: 'y' });
  assert.ok(ws.connect(doc, band.id, note2.id) || true);
  const linked = doc.payload.noteConnections
    .filter((c) => c.noteNodeId === note2.id)
    .map((c) => c.terminalId)
    .sort();
  assert.deepEqual(linked, [T1.id, T2.id].sort());
});

test('add existing terminal, add a new member (cloned context), show, reorder, rename, list width', () => {
  const band = doc.payload.nodes.find((n) => n.content.band);
  assert.equal(B.addTerminals(doc, band.id, [T3.id, T3.id]), 1);
  const fresh = B.addNewMember(doc, band.id, { name: 'Logs' });
  const d = band.content.band._0;
  assert.equal(d.shownMemberId, fresh.id);
  assert.equal(fresh.content.terminal._0.workingDirectory, T1.content.terminal._0.workingDirectory);
  assert.equal(d.memberNodeIds.length, 4);
  B.setShown(doc, band.id, T2.id);
  assert.equal(B.shownOf(d), T2.id);
  assert.throws(() => B.setShown(doc, band.id, 'nope'), /not in the band/);
  B.moveMember(doc, band.id, fresh.id, T1.id);
  assert.equal(d.memberNodeIds[0], fresh.id);
  B.rename(doc, band.id, 'Stack');
  assert.deepEqual([d.name, d.hasCustomName], ['Stack', true]);
  B.setListWidth(doc, band.id, 9999);
  assert.equal(d.listWidth, 360);
  assert.ok(
    doc.payload.noteConnections.some((c) => c.terminalId === fresh.id && c.noteNodeId === NOTE.id),
    "the new member inherits the band's connections",
  );
});

test('removing a member puts it back on the canvas; a band with one member dissolves; dissolve keeps terminals', () => {
  let band = doc.payload.nodes.find((n) => n.content.band);
  const out = B.removeMember(doc, band.id, T3.id);
  assert.ok(!B.memberIds(doc).has(out.id));
  assert.notDeepEqual(out.frame, band.frame);
  B.dissolve(doc, band.id);
  assert.ok(!doc.payload.nodes.some((n) => n.content.band));
  assert.equal(B.memberIds(doc).size, 0);
  band = B.create(doc, [T1.id, T2.id]);
  B.removeMember(doc, band.id, T1.id);
  assert.ok(!doc.payload.nodes.some((n) => n.content.band), 'one terminal left: no band');
});

test('remove with keepTerminals=false closes the member terminals and reports their ids', () => {
  const band = B.create(doc, [T1.id, T2.id]);
  const killed = B.remove(doc, band.id, { keepTerminals: false });
  assert.deepEqual(killed.sort(), [T1.id, T2.id].sort());
  assert.ok(!doc.payload.nodes.some((n) => n.id === T1.id || n.id === T2.id || n.id === band.id));
});

test('deleting a member terminal directly removes it from its band', () => {
  const a = ws.addTerminal(doc, { name: 'A', workingDirectory: os.tmpdir() });
  const b = ws.addTerminal(doc, { name: 'B', workingDirectory: os.tmpdir() });
  const c = ws.addTerminal(doc, { name: 'C', workingDirectory: os.tmpdir() });
  const band = B.create(doc, [a.id, b.id, c.id]);
  ws.removeNode(doc, b.id);
  assert.deepEqual(band.content.band._0.memberNodeIds, [a.id, c.id]);
});
