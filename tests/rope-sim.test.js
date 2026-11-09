'use strict';
// Rope physics (derived from the analysis of Maestri's renderer) — pure module, no DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'rope-sim.js')).href);
const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

test('edge pins: the closest pair of facing edge midpoints is chosen', async () => {
  const { closestEdgePins } = await load();
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 300, y: 0, w: 100, h: 100 };
  const { start, end } = closestEdgePins(a, b);
  assert.deepEqual(start, { x: 100, y: 50 });
  assert.deepEqual(end, { x: 300, y: 50 });
  const c = { x: 0, y: 300, w: 100, h: 100 };
  const v = closestEdgePins(a, c);
  assert.deepEqual(v.start, { x: 50, y: 100 });
  assert.deepEqual(v.end, { x: 50, y: 300 });
});

test('static rope hangs with a ~12% parabolic sag and 21 points', async () => {
  const { staticRopePoints, POINT_COUNT } = await load();
  const pts = staticRopePoints({ x: 0, y: 0 }, { x: 500, y: 0 });
  assert.equal(pts.length, POINT_COUNT);
  assert.equal(pts[0].y, 0);
  assert.equal(pts[20].y, 0);
  assert.ok(Math.abs(pts[10].y - 60) < 1e-6, `mid sag ${pts[10].y}`); // 500 * 0.12
  const short = staticRopePoints({ x: 0, y: 0 }, { x: 50, y: 0 });
  assert.ok(Math.abs(short[10].y - 20) < 1e-6); // minimum sag of 20px
});

test('a rope keeps its pins, droops under gravity and settles to rest', async () => {
  const { Rope, SLEEP_THRESHOLD, FIXED_DT } = await load();
  const start = { x: 0, y: 0 },
    end = { x: 400, y: 0 };
  // start taut and straight: gravity must pull the middle down
  const rope = new Rope(
    start,
    end,
    Array.from({ length: 21 }, (_, i) => ({ x: i * 20, y: 0 })),
  );
  for (let i = 0; i < 400; i++) rope.step(FIXED_DT);
  assert.deepEqual(rope.points[0], start);
  assert.deepEqual(rope.points[20], end);
  assert.ok(rope.points[10].y > 5, `middle droops (y=${rope.points[10].y})`);
  assert.ok(rope.lastMovement < SLEEP_THRESHOLD, `settled (movement=${rope.lastMovement})`);
  // length stays close to chord * slack (distance constraints hold)
  assert.ok(len(rope.points) < 400 * 1.2, `length ${len(rope.points)}`);
  assert.ok(len(rope.points) > 400 * 0.99);
});

test('moving a pin makes the rope swing, then it settles again', async () => {
  const { Rope, FIXED_DT } = await load();
  const rope = new Rope({ x: 0, y: 0 }, { x: 300, y: 0 });
  rope.settle(300);
  const before = rope.points[10].y;
  rope.pinEnd = { x: 300, y: 200 };
  let peakMove = 0;
  for (let i = 0; i < 20; i++) {
    rope.step(FIXED_DT);
    peakMove = Math.max(peakMove, rope.lastMovement);
  }
  assert.ok(peakMove > 5, `rope reacted (movement ${peakMove})`);
  for (let i = 0; i < 600; i++) rope.step(FIXED_DT);
  assert.ok(rope.lastMovement < 0.5);
  assert.ok(rope.points[10].y > before, 'new resting shape follows the pin');
});

test('obstacle avoidance keeps rope points out of node rectangles', async () => {
  const { Rope, FIXED_DT } = await load();
  const free = new Rope({ x: 0, y: 0 }, { x: 600, y: 0 });
  const block = { x: 250, y: 60, w: 100, h: 140 }; // sits in the rope's natural sag (~106px deep)
  const blocked = new Rope({ x: 0, y: 0 }, { x: 600, y: 0 });
  for (let i = 0; i < 600; i++) {
    free.step(FIXED_DT);
    blocked.step(FIXED_DT, [block]);
  }
  const inRect = (p) => p.x > block.x && p.x < block.x + block.w && p.y > block.y && p.y < block.y + block.h;
  assert.ok(free.points.some(inRect), 'without avoidance the rope sags through the block');
  assert.equal(blocked.points.filter(inRect).length, 0, 'with avoidance no point stays inside the block');
});

test('world: wakes on a new rope, sleeps when settled, wakes again when a node moves', async () => {
  const { RopeWorld } = await load();
  const w = new RopeWorld();
  const frames = new Map([
    ['a', { x: 0, y: 0, w: 100, h: 100 }],
    ['b', { x: 400, y: 0, w: 100, h: 100 }],
  ]);
  const conns = [{ id: 'c1', from: 'a', to: 'b', saved: null }];
  assert.equal(w.sync(conns, frames, { now: 0 }), true);
  let t = 0,
    asleep = false,
    ticks = 0;
  while (!asleep && ticks < 2000) {
    t += 16;
    asleep = w.tick(t).asleep;
    ticks++;
  }
  assert.ok(asleep, 'went to sleep');
  assert.ok(t / 1000 < 10.5, `slept within the 10 s cap (${t / 1000}s)`);
  assert.equal(w.sync(conns, frames, { now: t }), false, 'an unchanged canvas does not wake it');
  frames.set('b', { x: 400, y: 150, w: 100, h: 100 });
  assert.equal(w.sync(conns, frames, { now: t }), true, 'moving an endpoint wakes it');
  assert.equal(w.tick(t + 16).asleep, false);
});

test('world: saved rope shape is restored without waking; removed ropes are reported', async () => {
  const { RopeWorld, closestEdgePins, staticRopePoints } = await load();
  const frames = new Map([
    ['a', { x: 0, y: 0, w: 100, h: 100 }],
    ['b', { x: 400, y: 0, w: 100, h: 100 }],
  ]);
  const { start, end } = closestEdgePins(frames.get('a'), frames.get('b'));
  const saved = staticRopePoints(start, end);
  const w = new RopeWorld();
  assert.equal(w.sync([{ id: 'c1', from: 'a', to: 'b', saved }], frames, { now: 0 }), false);
  assert.equal(w.tick(16).asleep, true);
  w.sync([], frames, { now: 100 });
  assert.deepEqual([...w.takeRemoved().keys()], ['c1']);
});

test('world: a dragged node wakes a sleeping rope that passes nearby (80px)', async () => {
  const { RopeWorld } = await load();
  const frames = new Map([
    ['a', { x: 0, y: 0, w: 100, h: 100 }],
    ['b', { x: 500, y: 0, w: 100, h: 100 }],
    ['c', { x: 250, y: 400, w: 80, h: 80 }],
  ]);
  const conns = [{ id: 'c1', from: 'a', to: 'b', saved: null }];
  const w = new RopeWorld();
  w.sync(conns, frames, { now: 0, avoidNodes: false });
  let t = 0;
  while (!w.tick((t += 16)).asleep && t < 20000);
  assert.equal(
    w.sync(conns, frames, { now: t, avoidNodes: false, moving: new Set(['c']) }),
    false,
    'far away: stays asleep',
  );
  frames.set('c', { x: 250, y: 90, w: 80, h: 80 }); // now within 80px of the sagging rope
  assert.equal(w.sync(conns, frames, { now: t, avoidNodes: false, moving: new Set(['c']) }), true);
});

test('paths: smooth bézier through 21 points and rounded elbow routes', async () => {
  const { buildSmoothPath, staticRopePoints, orthogonalRoute, buildElbowPath } = await load();
  const d = buildSmoothPath(staticRopePoints({ x: 0, y: 0 }, { x: 100, y: 0 }));
  assert.match(d, /^M 0\.00 0\.00( C [^C]+){20}$/);
  const route = orthogonalRoute({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 200, w: 100, h: 100 });
  assert.equal(route.length, 4);
  assert.match(buildElbowPath(route, 10), /Q/);
  const straight = orthogonalRoute({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 20, w: 100, h: 100 });
  assert.equal(straight.length, 2);
});
