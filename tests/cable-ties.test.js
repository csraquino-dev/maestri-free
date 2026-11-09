'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const ties = require('../main/cable-ties');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'cable-ties.js')).href);
const loadSim = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'rope-sim.js')).href);

// three horizontal ropes, 40px apart, from x=0 to x=400
const straight = (y) => ({
  pinStart: { x: 0, y },
  pinEnd: { x: 400, y },
  points: Array.from({ length: 21 }, (_, i) => ({ x: i * 20, y })),
});

test('a lasso line across ropes makes one tie at the crossing centroid, members ordered across the ropes', async () => {
  const G = await load();
  const ropes = new Map([
    ['a', straight(0)],
    ['b', straight(40)],
    ['c', straight(80)],
  ]);
  const tie = G.tieFromLasso(ropes, { x: 200, y: 100 }, { x: 200, y: -20 }, () => 'T1', 'now');
  assert.equal(tie.id, 'T1');
  assert.deepEqual(tie.position, { x: 200, y: 40 });
  assert.equal(tie.memberConnectionIds.length, 3);
  assert.deepEqual([...tie.memberConnectionIds].sort(), ['a', 'b', 'c']);
  assert.equal(
    G.tieFromLasso(ropes, { x: 200, y: 300 }, { x: 200, y: 200 }, () => 'x', 'now'),
    null,
    'crosses nothing',
  );
  assert.equal(
    G.tieFromLasso(ropes, { x: 200, y: 0 }, { x: 203, y: 0 }, () => 'x', 'now'),
    null,
    'too short',
  );
});

test('members are laid side by side, 4px apart, across the shared direction', async () => {
  const G = await load();
  assert.deepEqual(G.lateralOffsets(3), [-4, 0, 4]);
  assert.equal(G.tieSpread(3), 8);
  const pins = new Map([
    ['a', straight(0)],
    ['b', straight(40)],
  ]);
  const resolved = G.resolveCableTies(
    [{ id: 't', position: { x: 200, y: 20 }, memberConnectionIds: ['a', 'b', 'gone'] }],
    pins,
  );
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].memberRopeIds, ['a', 'b']);
  assert.ok(Math.abs(resolved[0].tangent.x) > 0.99, 'tangent follows the ropes');
  const targets = G.cableTieConstraints(resolved);
  const ya = targets.get('a')[0].point.y,
    yb = targets.get('b')[0].point.y;
  assert.ok(Math.abs(Math.abs(ya - yb) - 4) < 1e-6, `members 4px apart, got ${Math.abs(ya - yb)}`);
  assert.equal(
    G.resolveCableTies([{ id: 't', position: { x: 0, y: 0 }, memberConnectionIds: ['zzz'] }], pins).length,
    0,
    'a tie without live ropes disappears',
  );
});

test('hit test: the collar is grabbable along its length, not far away', async () => {
  const G = await load();
  const base = { position: { x: 100, y: 100 }, tangent: { x: 1, y: 0 }, perp: { x: 0, y: 1 }, memberCount: 3, zoom: 1 };
  assert.ok(G.tieHitTest({ ...base, point: { x: 100, y: 110 } }));
  assert.ok(!G.tieHitTest({ ...base, point: { x: 100, y: 150 } }));
  assert.ok(!G.tieHitTest({ ...base, point: { x: 140, y: 100 } }));
});

test('simulated ropes pass through their tie point and leave it straight', async () => {
  const G = await load();
  const { Rope } = await loadSim();
  const rope = new Rope({ x: 0, y: 0 }, { x: 400, y: 0 });
  const target = { point: { x: 200, y: -80 }, tangent: { x: 1, y: 0 } };
  rope.tieTargets = [target];
  rope.settle(300);
  const clamp = G.resolveTieClamps(rope.pinStart, rope.pinEnd, rope.points, rope.tieTargets);
  const held = clamp.pins.find((p) => p.target.x === 200 && p.target.y === -80);
  assert.ok(held, 'a point is pinned at the tie');
  const p = rope.points[held.index];
  assert.ok(Math.hypot(p.x - 200, p.y + 80) < 1, `rope passes through the tie (${p.x}, ${p.y})`);
  const a = rope.points[held.index - 1],
    b = rope.points[held.index + 1];
  assert.ok(Math.abs(a.y - p.y) < 2 && Math.abs(b.y - p.y) < 2, 'leaves the collar along the tangent');
});

test('backend: create/move/delete, ropes must exist, new tie takes over a rope, dead ropes are pruned', () => {
  const doc = {
    payload: {
      connections: [{ id: 'c1' }, { id: 'c2' }],
      noteConnections: [],
      portalConnections: [],
      noteToNoteConnections: [],
      portalToPortalConnections: [],
      crossFloorConnections: [{ id: 'x1' }],
      cableTies: [],
    },
  };
  assert.throws(
    () => ties.create(doc, { id: 't', position: { x: 1, y: 2 }, memberConnectionIds: ['nope'] }, null),
    /at least one rope/,
  );
  assert.throws(
    () => ties.create(doc, { id: 't', position: { x: NaN, y: 2 }, memberConnectionIds: ['c1'] }, null),
    /invalid tie/,
  );
  const t1 = ties.create(doc, { id: 't1', position: { x: 1, y: 2 }, memberConnectionIds: ['c1', 'c2', 'x1#B'] }, null);
  assert.deepEqual(t1.memberConnectionIds, ['c1', 'c2', 'x1#B']);
  ties.create(doc, { id: 't2', position: { x: 5, y: 5 }, memberConnectionIds: ['c2'] }, null);
  assert.deepEqual(
    doc.payload.cableTies.find((t) => t.id === 't1').memberConnectionIds,
    ['c1', 'x1#B'],
    'c2 moved to the new tie',
  );
  assert.ok(ties.move(doc, 't1', { x: 9, y: 9 }));
  assert.deepEqual(doc.payload.cableTies.find((t) => t.id === 't1').position, { x: 9, y: 9 });
  assert.equal(ties.move(doc, 't1', { x: 'a', y: 1 }), null);
  doc.payload.connections = [];
  doc.payload.crossFloorConnections = [];
  ties.prune(doc);
  assert.equal(doc.payload.cableTies.length, 0, 'no ropes left, no ties left');
});
