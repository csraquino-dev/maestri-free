'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'shape-recognizer.js')).href);

// deterministic "hand shake"
let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed / 2147483647 - 0.5) * 2;
};
const jitter = (pts, a) => pts.map((p) => ({ x: p.x + rnd() * a, y: p.y + rnd() * a }));
const along = (corners, per = 25) => {
  const out = [];
  for (let i = 0; i < corners.length - 1; i++)
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push({
        x: corners[i].x + (corners[i + 1].x - corners[i].x) * t,
        y: corners[i].y + (corners[i + 1].y - corners[i].y) * t,
      });
    }
  out.push(corners[corners.length - 1]);
  return out;
};

test('a wobbly straight stroke becomes a line between its ends', async () => {
  const { recognizeShape } = await load();
  const r = recognizeShape(
    jitter(
      along([
        { x: 0, y: 0 },
        { x: 300, y: 120 },
      ]),
      4,
    ),
  );
  assert.equal(r.tool, 'line');
  assert.equal(r.points.length, 2);
});

test('a stroke that ends with arrow barbs becomes an arrow to the tip', async () => {
  const { recognizeShape } = await load();
  const pts = jitter(
    along([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 270, y: 25 },
      { x: 300, y: 0 },
      { x: 270, y: -25 },
    ]),
    1.5,
  );
  const r = recognizeShape(pts);
  assert.equal(r.tool, 'arrow');
  assert.ok(Math.abs(r.points[1].x - 300) < 12 && Math.abs(r.points[1].y) < 12, JSON.stringify(r.points[1]));
});

test('closed outlines: rectangle, ellipse and diamond are told apart', async () => {
  const { recognizeShape } = await load();
  const rect = along(
    [
      { x: 0, y: 0 },
      { x: 240, y: 0 },
      { x: 240, y: 140 },
      { x: 0, y: 140 },
      { x: 6, y: 8 },
    ],
    30,
  );
  const ell = Array.from({ length: 120 }, (_, i) => ({
    x: 120 + 120 * Math.cos((i / 118) * Math.PI * 2),
    y: 70 + 70 * Math.sin((i / 118) * Math.PI * 2),
  }));
  const dia = along(
    [
      { x: 120, y: 0 },
      { x: 240, y: 70 },
      { x: 120, y: 140 },
      { x: 0, y: 70 },
      { x: 118, y: 4 },
    ],
    30,
  );
  const a = recognizeShape(jitter(rect, 3)),
    b = recognizeShape(jitter(ell, 3)),
    c = recognizeShape(jitter(dia, 3));
  assert.deepEqual([a.tool, b.tool, c.tool], ['rect', 'ellipse', 'diamond']);
  assert.ok(Math.abs(a.points[1].x - a.points[0].x - 240) < 12, 'rectangle takes the bounding box');
  assert.ok(Math.abs(b.points[1].y - b.points[0].y - 140) < 12);
});

test('scribbles, dots and tiny strokes stay pen strokes', async () => {
  const { recognizeShape } = await load();
  const scribble = Array.from({ length: 80 }, (_, i) => ({
    x: i * 4 + rnd() * 30,
    y: Math.sin(i / 3) * 60 + rnd() * 30,
  }));
  assert.equal(recognizeShape(scribble).tool, 'pen');
  assert.equal(
    recognizeShape([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]).tool,
    'pen',
  );
  assert.equal(
    recognizeShape(
      jitter(
        along([
          { x: 0, y: 0 },
          { x: 8, y: 3 },
        ]),
        0.5,
      ),
    ).tool,
    'pen',
  );
});
