// Rope physics (pure, DOM-free so it can be unit-tested).
// Behaviour and constants were derived from static analysis of the Maestri renderer with REA:
// a 21-point Verlet chain, fixed 60 Hz steps (max 4 per frame), 8 distance-constraint passes,
// light damping + gravity, and a "sleep when settled / wake when something moves" loop.
export const SEGMENT_COUNT = 20;
export const POINT_COUNT = SEGMENT_COUNT + 1;
export const GRAVITY_Y = 1600;
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 4;
export const MAX_FRAME_DELTA = MAX_SUBSTEPS * FIXED_DT;
export const DAMPING = 0.965;
export const SLACK_FACTOR = 1.05;
export const CONSTRAINT_ITERATIONS = 8;
export const OBSTACLE_PADDING = 20;
export const OBSTACLE_CORNER_ZONE = OBSTACLE_PADDING * 1.5;
export const OBSTACLE_BLEND = 0.4;
export const SLEEP_THRESHOLD = 0.5;
export const GRACE_SECONDS = 0.5;
export const MAX_AWAKE_SECONDS = 10;
export const NEARBY_WAKE_DISTANCE = 80;
export const ELBOW_EDGE_INSET = 12;
export const ELBOW_CORNER_RADIUS = 10;
import { resolveTieClamps, tieConstraintsEqual } from './cable-ties.js';

// ------------------------------------------------------------------ geometry
export const rectCenter = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function edgeMidpoints(r) {
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  return [
    { x: mx, y: r.y },
    { x: mx, y: r.y + r.h },
    { x: r.x, y: my },
    { x: r.x + r.w, y: my },
  ];
}

// The rope is pinned to the pair of edge midpoints that are closest to each other.
export function closestEdgePins(a, b) {
  let best = { start: rectCenter(a), end: rectCenter(b) };
  let bestD = Infinity;
  for (const pa of edgeMidpoints(a)) {
    for (const pb of edgeMidpoints(b)) {
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d < bestD) {
        bestD = d;
        best = { start: pa, end: pb };
      }
    }
  }
  return best;
}

export function closestEdgeMidpointToPoint(r, p) {
  let best = rectCenter(r);
  let bestD = Infinity;
  for (const c of edgeMidpoints(r)) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// A relaxed rope between two pins: a parabolic sag of ~12% of the span (at least 20px).
export function staticRopePoints(start, end) {
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const sagAmount = Math.max(span * 0.12, 20);
  const pts = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const t = i / (POINT_COUNT - 1);
    pts.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t + sagAmount * 4 * t * (1 - t) });
  }
  return pts;
}

// Push a point out of padded node rectangles (nearest side, or radially around a corner).
export function pushOutOfObstacles(p, obstacles) {
  for (const r of obstacles) {
    const minX = r.x - OBSTACLE_PADDING,
      maxX = r.x + r.w + OBSTACLE_PADDING;
    const minY = r.y - OBSTACLE_PADDING,
      maxY = r.y + r.h + OBSTACLE_PADDING;
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
    const toL = p.x - minX,
      toR = maxX - p.x,
      toT = p.y - minY,
      toB = maxY - p.y;
    const nl = toL < OBSTACLE_CORNER_ZONE,
      nr = toR < OBSTACLE_CORNER_ZONE,
      nt = toT < OBSTACLE_CORNER_ZONE,
      nb = toB < OBSTACLE_CORNER_ZONE;
    let tx = p.x,
      ty = p.y;
    if ((nl || nr) && (nt || nb)) {
      const cx = nl ? minX : maxX,
        cy = nt ? minY : maxY;
      const dx = p.x - cx,
        dy = p.y - cy,
        d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        tx = cx + (dx / d) * OBSTACLE_PADDING;
        ty = cy + (dy / d) * OBSTACLE_PADDING;
      }
    } else {
      const m = Math.min(toL, toR, toT, toB);
      if (m === toL) tx = minX;
      else if (m === toR) tx = maxX;
      else if (m === toT) ty = minY;
      else ty = maxY;
    }
    p.x += (tx - p.x) * OBSTACLE_BLEND;
    p.y += (ty - p.y) * OBSTACLE_BLEND;
  }
}

// ---------------------------------------------------------------------- rope
export class Rope {
  constructor(start, end, restored) {
    this.pinStart = { ...start };
    this.pinEnd = { ...end };
    this.points =
      restored && restored.length === POINT_COUNT
        ? restored.map((p) => ({ x: p.x, y: p.y }))
        : staticRopePoints(start, end);
    this.prev = this.points.map((p) => ({ ...p }));
    this.lastMovement = 0;
    this.tieTargets = []; // [{point, tangent}] — cable ties this rope passes through
  }

  // Jump straight to the relaxed shape (used when motion is reduced).
  snapTo(start, end) {
    this.pinStart = { ...start };
    this.pinEnd = { ...end };
    this.points = staticRopePoints(start, end);
    this.prev = this.points.map((p) => ({ ...p }));
    this.lastMovement = 0;
  }

  settle(steps, obstacles = []) {
    for (let i = 0; i < steps; i++) this.step(FIXED_DT, obstacles);
    this.lastMovement = 0;
  }

  step(dt, obstacles = []) {
    const pts = this.points,
      prev = this.prev,
      n = pts.length,
      last = n - 1;
    const g = GRAVITY_Y * dt * dt;
    for (let i = 1; i < last; i++) {
      const c = pts[i],
        p = prev[i];
      const vx = (c.x - p.x) * DAMPING,
        vy = (c.y - p.y) * DAMPING;
      prev[i] = { x: c.x, y: c.y };
      pts[i] = { x: c.x + vx, y: c.y + vy + g };
    }
    pts[0] = { ...this.pinStart };
    prev[0] = { ...this.pinStart };
    pts[last] = { ...this.pinEnd };
    prev[last] = { ...this.pinEnd };

    const tie = this.tieTargets.length ? resolveTieClamps(this.pinStart, this.pinEnd, pts, this.tieTargets) : null;
    const chord = tie ? tie.dist : Math.hypot(this.pinEnd.x - this.pinStart.x, this.pinEnd.y - this.pinStart.y);
    const rest = Math.max(chord * SLACK_FACTOR, 40) / SEGMENT_COUNT;
    const holdTies = () => {
      if (tie)
        for (const p of tie.pins) {
          pts[p.index] = { x: p.target.x, y: p.target.y };
          prev[p.index] = { x: p.target.x, y: p.target.y };
        }
    };
    for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i],
          b = pts[i + 1];
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.hypot(dx, dy);
        if (d < 1e-3) continue;
        const want = tie && tie.segmentLengths ? tie.segmentLengths[i] : rest;
        const diff = ((d - want) / d) * 0.5;
        const ox = dx * diff,
          oy = dy * diff;
        if (i !== 0) {
          a.x += ox;
          a.y += oy;
        }
        if (i + 1 !== last) {
          b.x -= ox;
          b.y -= oy;
        }
      }
      if (obstacles.length) for (let i = 1; i < last; i++) pushOutOfObstacles(pts[i], obstacles);
      holdTies();
      pts[0] = { ...this.pinStart };
      pts[last] = { ...this.pinEnd };
    }
    let movement = 0;
    for (let i = 1; i < last; i++) movement += Math.abs(pts[i].x - prev[i].x) + Math.abs(pts[i].y - prev[i].y);
    this.lastMovement = movement;
  }
}

// ----------------------------------------------------------------- the world
// Owns every rope of the visible canvas plus the fixed-step accumulator and the sleep logic.
export class RopeWorld {
  constructor() {
    this.ropes = new Map();
    this.obstacles = new Map();
    this.obstacleSig = new Map();
    this.accumulator = 0;
    this.last = 0;
    this.running = false;
    this.awakeAt = 0;
    this.removed = new Map(); // ropes that left the canvas, so their shape can be saved
  }

  // connections: [{id, from, to, saved:[{x,y}]|null}] ; frames: Map(nodeId -> {x,y,w,h})
  // moving: Set of node ids currently dragged/resized (nearby ropes are woken as well)
  sync(connections, frames, { moving = new Set(), avoidNodes = true, now = 0 } = {}) {
    let wake = false;
    const incoming = new Set(connections.map((c) => c.id));
    for (const [id, rope] of this.ropes) {
      if (!incoming.has(id)) {
        this.removed.set(id, rope);
        this.ropes.delete(id);
        this.obstacles.delete(id);
        this.obstacleSig.delete(id);
      }
    }
    const regions = [];
    for (const id of moving) {
      const r = frames.get(id);
      if (r)
        regions.push({
          x: r.x - NEARBY_WAKE_DISTANCE,
          y: r.y - NEARBY_WAKE_DISTANCE,
          w: r.w + NEARBY_WAKE_DISTANCE * 2,
          h: r.h + NEARBY_WAKE_DISTANCE * 2,
        });
    }
    for (const c of connections) {
      const a = frames.get(c.from),
        b = frames.get(c.to);
      if (!a || !b) continue;
      const { start, end } = closestEdgePins(a, b);
      let rope = this.ropes.get(c.id);
      if (!rope) {
        const restored = c.saved && c.saved.length === POINT_COUNT ? c.saved : null;
        rope = new Rope(start, end, restored);
        this.ropes.set(c.id, rope);
        if (!restored)
          wake = true; // a brand-new rope drapes itself
        else if (pinsDrifted(rope.points, start, end)) {
          rope.pinStart = { ...start };
          rope.pinEnd = { ...end };
          wake = true;
        }
      } else if (pinsDrifted(rope.points, start, end) || !samePin(rope.pinStart, start) || !samePin(rope.pinEnd, end)) {
        rope.pinStart = { ...start };
        rope.pinEnd = { ...end };
        wake = true;
      }
      if (avoidNodes) {
        const obs = [];
        for (const [id, r] of frames) if (id !== c.from && id !== c.to) obs.push(r);
        const sig = obs.map((r) => `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}`).join(';');
        if (this.obstacleSig.get(c.id) !== sig) {
          this.obstacleSig.set(c.id, sig);
          this.obstacles.set(c.id, obs);
          if (sig) wake = true;
        }
      } else if (this.obstacles.has(c.id)) {
        this.obstacles.delete(c.id);
        this.obstacleSig.delete(c.id);
        wake = true;
      }
      // a dragged node near a resting rope wakes it so it can swing out of the way
      if (!wake && regions.length) {
        const xs = [rope.points[0].x, rope.points[10].x, rope.points[20].x],
          ys = [rope.points[0].y, rope.points[10].y, rope.points[20].y];
        if (regions.some((g) => xs.some((x, i) => x >= g.x && x <= g.x + g.w && ys[i] >= g.y && ys[i] <= g.y + g.h)))
          wake = true;
      }
    }
    if (wake) this.wake(now);
    return wake;
  }

  // rope id -> [{point, tangent}] from cable ties. Returns true when something changed (so the world must wake).
  setTies(targets, now = 0) {
    let changed = false;
    for (const [id, rope] of this.ropes) {
      const next = targets.get(id) || [];
      if (!tieConstraintsEqual(rope.tieTargets, next)) {
        rope.tieTargets = next;
        changed = true;
      }
    }
    if (changed) this.wake(now);
    return changed;
  }

  wake(now) {
    this.awakeAt = now;
    if (this.running) return;
    this.running = true;
    this.last = now;
    this.accumulator = 0;
  }

  // Advance the simulation. Returns { stepped, asleep }.
  tick(now) {
    if (!this.running) return { stepped: false, asleep: true };
    const delta = Math.min((now - this.last) / 1000, MAX_FRAME_DELTA);
    this.last = now;
    this.accumulator += delta;
    let stepped = false,
      sub = 0;
    while (this.accumulator >= FIXED_DT && sub < MAX_SUBSTEPS) {
      for (const [id, rope] of this.ropes) rope.step(FIXED_DT, this.obstacles.get(id) || []);
      this.accumulator -= FIXED_DT;
      sub++;
      stepped = true;
    }
    if (this.accumulator > FIXED_DT) this.accumulator = 0;
    let total = 0;
    for (const r of this.ropes.values()) total += r.lastMovement;
    const awake = (now - this.awakeAt) / 1000;
    const settled = total < SLEEP_THRESHOLD || awake > MAX_AWAKE_SECONDS;
    if (this.ropes.size === 0 || (awake > GRACE_SECONDS && settled)) {
      this.running = false;
      return { stepped, asleep: true };
    }
    return { stepped, asleep: false };
  }

  // Run the solver to rest without animating (used by tests and reduced motion).
  settleAll(steps = 240) {
    for (const [id, rope] of this.ropes) rope.settle(steps, this.obstacles.get(id) || []);
  }

  takeRemoved() {
    const r = this.removed;
    this.removed = new Map();
    return r;
  }
}

const samePin = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
export function pinsDrifted(points, start, end) {
  const f = points[0],
    l = points[points.length - 1];
  if (!f || !l) return true;
  return Math.hypot(f.x - start.x, f.y - start.y) > 1 || Math.hypot(l.x - end.x, l.y - end.y) > 1;
}

// ------------------------------------------------------------------- paths
const n2 = (v) => v.toFixed(2);

// Catmull-Rom → cubic Bézier, like the original's smooth rope path.
export function buildSmoothPath(points) {
  if (points.length < 2) return '';
  let d = `M ${n2(points[0].x)} ${n2(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[Math.max(i - 2, 0)],
      p1 = points[i - 1],
      p2 = points[i],
      p3 = points[Math.min(i + 1, points.length - 1)];
    d += ` C ${n2(p1.x + (p2.x - p0.x) / 6)} ${n2(p1.y + (p2.y - p0.y) / 6)}, ${n2(p2.x - (p3.x - p1.x) / 6)} ${n2(p2.y - (p3.y - p1.y) / 6)}, ${n2(p2.x)} ${n2(p2.y)}`;
  }
  return d;
}

// "circuit" routing: orthogonal elbows between the facing sides.
function sharedCross(aLo, aHi, bLo, bHi, preferred) {
  const lo = Math.max(aLo, bLo),
    hi = Math.min(aHi, bHi);
  if (lo > hi) return null;
  const inset = Math.min(ELBOW_EDGE_INSET, (hi - lo) / 2);
  return Math.min(Math.max(preferred, lo + inset), hi - inset);
}
export function orthogonalRoute(a, b) {
  const am = rectCenter(a),
    bm = rectCenter(b);
  const dx = bm.x - am.x,
    dy = bm.y - am.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? a.x + a.w : a.x,
      ex = dx >= 0 ? b.x : b.x + b.w;
    const y = sharedCross(a.y, a.y + a.h, b.y, b.y + b.h, (am.y + bm.y) / 2);
    if (y !== null)
      return [
        { x: sx, y },
        { x: ex, y },
      ];
    const s = { x: sx, y: am.y },
      e = { x: ex, y: bm.y },
      mx = (s.x + e.x) / 2;
    return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  const sy = dy >= 0 ? a.y + a.h : a.y,
    ey = dy >= 0 ? b.y : b.y + b.h;
  const x = sharedCross(a.x, a.x + a.w, b.x, b.x + b.w, (am.x + bm.x) / 2);
  if (x !== null)
    return [
      { x, y: sy },
      { x, y: ey },
    ];
  const s = { x: am.x, y: sy },
    e = { x: bm.x, y: ey },
    my = (s.y + e.y) / 2;
  return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
}

export function buildElbowPath(pts, radius = ELBOW_CORNER_RADIUS) {
  if (!pts.length) return '';
  let d = `M ${n2(pts[0].x)} ${n2(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1],
      c = pts[i],
      q = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y),
      l2 = Math.hypot(q.x - c.x, q.y - c.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) {
      d += ` L ${n2(c.x)} ${n2(c.y)}`;
      continue;
    }
    const a = { x: c.x - ((c.x - p.x) / l1) * r, y: c.y - ((c.y - p.y) / l1) * r };
    const b = { x: c.x + ((q.x - c.x) / l2) * r, y: c.y + ((q.y - c.y) / l2) * r };
    d += ` L ${n2(a.x)} ${n2(a.y)} Q ${n2(c.x)} ${n2(c.y)} ${n2(b.x)} ${n2(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${n2(last.x)} ${n2(last.y)}`;
}
