// Smart draw: turns a hand-drawn stroke into the shape it was meant to be (line, arrow, rectangle, ellipse, diamond),
// or leaves it as a pen stroke. Pure geometry, no DOM.
//
// Closed strokes are told apart by the "norm" that stays constant along the outline once it is scaled into the unit
// square around its bounding box: ellipse -> Euclidean, rectangle -> max(|u|,|v|), diamond -> |u|+|v|. The norm with
// the smallest spread wins; if even that is too uneven, it was a scribble and stays a pen stroke.
const RESAMPLE = 72;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i]);
  return n;
}

export function resample(pts, count = RESAMPLE) {
  const total = pathLength(pts);
  if (total === 0) return pts.slice(0, 1);
  const step = total / (count - 1);
  const out = [{ ...pts[0] }];
  let acc = 0,
    prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i],
      d = dist(prev, cur);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(p);
      prev = p;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < count) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, count);
}

const cv = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return Infinity;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m;
};

function bounds(pts) {
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// -> { tool: 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'diamond', points }
export function recognizeShape(raw) {
  const pen = { tool: 'pen', points: raw };
  if (!raw || raw.length < 3) return pen;
  const total = pathLength(raw);
  const b = bounds(raw);
  if (total < 24 || Math.max(b.w, b.h) < 16) return pen;
  const first = raw[0],
    last = raw[raw.length - 1];
  const chord = dist(first, last);

  // ---- open strokes: straight line, or a line ending in an arrow head
  if (chord / total > 0.88) return { tool: 'line', points: [first, last] };
  const pts = resample(raw);
  let tipIndex = 0,
    far = 0;
  for (const p of pts) far = Math.max(far, dist(first, p));
  tipIndex = pts.findIndex((p) => dist(first, p) >= far * 0.97); // first arrival at the tip (the barbs come back to it)
  const toTip = pathLength(pts.slice(0, tipIndex + 1));
  const afterTip = pathLength(pts.slice(tipIndex));
  if (
    tipIndex >= pts.length * 0.6 &&
    tipIndex < pts.length - 3 &&
    toTip > 0 &&
    far / toTip > 0.9 &&
    afterTip / (toTip + afterTip) > 0.08 &&
    afterTip / (toTip + afterTip) < 0.45
  ) {
    return { tool: 'arrow', points: [first, pts[tipIndex]] };
  }

  // ---- closed strokes: rectangle / ellipse / diamond
  const closed = chord / total < 0.2 && b.w > 20 && b.h > 20;
  if (!closed) return pen;
  const cx = (b.x0 + b.x1) / 2,
    cy = (b.y0 + b.y1) / 2;
  const uv = pts.map((p) => ({ u: (p.x - cx) / (b.w / 2), v: (p.y - cy) / (b.h / 2) }));
  const spread = {
    ellipse: cv(uv.map(({ u, v }) => Math.hypot(u, v))),
    rect: cv(uv.map(({ u, v }) => Math.max(Math.abs(u), Math.abs(v)))),
    diamond: cv(uv.map(({ u, v }) => Math.abs(u) + Math.abs(v))),
  };
  const [tool, best] = Object.entries(spread).sort((a, c) => a[1] - c[1])[0];
  if (best > 0.2) return pen;
  return {
    tool,
    points: [
      { x: b.x0, y: b.y0 },
      { x: b.x1, y: b.y1 },
    ],
  };
}
