'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-xfl-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');

let core, ws, doc, A, B, C;
test.before(async () => {
  core = await createCore();
  ws = core.workspaces;
  doc = ws.activeDoc;
  doc.payload.floors.push({ id: 'floor-1', name: 'Feature', branchName: 'f1', worktreePath: os.tmpdir(), hooks: {} });
  A = ws.addTerminal(doc, { name: 'Ground agent', workingDirectory: os.tmpdir() });
  B = ws.addTerminal(doc, { name: 'Floor agent', workingDirectory: os.tmpdir(), floorId: 'floor-1' });
  C = ws.addTerminal(doc, { name: 'Ground two', workingDirectory: os.tmpdir() });
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test('same-floor terminals use a normal connection, different floors a cross-floor one with a connector on each floor', () => {
  assert.ok(ws.connect(doc, A.id, C.id));
  assert.equal(doc.payload.crossFloorConnections.length, 0);
  const c = ws.connect(doc, A.id, B.id);
  assert.equal(doc.payload.crossFloorConnections.length, 1);
  assert.equal(c.floorIdA, null);
  assert.equal(c.floorIdB, 'floor-1');
  const ca = doc.payload.nodes.find((n) => n.id === c.connectorNodeIdA);
  const cb = doc.payload.nodes.find((n) => n.id === c.connectorNodeIdB);
  assert.equal(ca.floorId, null);
  assert.equal(cb.floorId, 'floor-1');
  assert.equal(ca.content.crossFloorConnector._0.peerName, 'Floor agent');
  assert.equal(cb.content.crossFloorConnector._0.peerFloorName, 'Ground');
  assert.equal(ws.connect(doc, B.id, A.id), null, 'no duplicates');
});

test('agents see the terminal on the other floor as a connected agent', () => {
  assert.ok(ws.connectionsOf(doc, A.id).agents.includes(B.id));
  assert.ok(ws.connectionsOf(doc, B.id).agents.includes(A.id));
});

test('removing a terminal removes the connection and both connectors', () => {
  const before = doc.payload.nodes.length;
  ws.removeNode(doc, B.id);
  assert.equal(doc.payload.crossFloorConnections.length, 0);
  assert.equal(doc.payload.nodes.length, before - 3, 'terminal + 2 connectors');
  assert.ok(!ws.connectionsOf(doc, A.id).agents.includes(B.id));
});

test('deleting a floor drops its cross connections and the connector left on the other floor', async () => {
  const B2 = ws.addTerminal(doc, { name: 'Floor agent 2', workingDirectory: os.tmpdir(), floorId: 'floor-1' });
  const c = ws.connect(doc, C.id, B2.id);
  assert.ok(c);
  require('../main/cross-floor').dropFloor(doc, 'floor-1');
  assert.equal(doc.payload.crossFloorConnections.length, 0);
  assert.ok(!doc.payload.nodes.some((n) => n.id === c.connectorNodeIdA), 'ground connector removed');
});
