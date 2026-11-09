// Cable ties: a small collar that gathers several ropes through one point, side by side.
// Pure geometry (no DOM) so it can be unit-tested; ropes.js feeds it the live rope pins and applies the result.
export const RIBBON_SPACING = 4;
export const TIED_SLACK = 1.04;
export const MIN_LASSO_LENGTH = 12;
const SEGMENT_COUNT = 20;

export const tieSpread = (memberCount) => Math.max(memberCount - 1, 0) * RIBBON_SPACING;

export function lateralOffsets(memberCount) {
  const mid = (memberCount - 1) / 2;
  return Array.from({ length: memberCount }, (_, i) => (i - mid) * RIBBON_SPACING);
}

// Direction a rope flows through `through`: the average of the way in and the way out.
export function flowDirection(pinStart, pinEnd, through) {
  const inDx = through.x - pinStart.x,
    inDy = through.y - pinStart.y;
  const outDx = pinEnd.x - through.x,
    outDy = pinEnd.y - through.y;
  const inLen = Math.hypot(inDx, inDy),
    outLen = Math.hypot(outDx, outDy);
  if (inLen <= 1e-3 || outLen <= 1e-3) return null;
  const flow = { x: inDx / inLen + outDx / outLen, y: inDy / inLen + outDy / outLen };
  return Math.hypot(flow.x, flow.y) <= 1e-3 ? null : flow;
}

// Shared tangent (along the ropes) and perpendicular (across them) of several flow vectors, all pointed the same way.
export function tieAxes(chords) {
  let sx = 0,
    sy = 0,
    ref = null;
  for (const c of chords) {
    const len = Math.hypot(c.x, c.y);
    if (len <= 1e-3) continue;
    let u = { x: c.x / len, y: c.y / len };
    if (ref) {
      if (u.x * ref.x + u.y * ref.y < 0) u = { x: -u.x, y: -u.y };
    } else ref = u;
    sx += u.x;
    sy += u.y;
  }
  const len = Math.hypot(sx, sy);
  if (len <= 1e-3) return { tangent: { x: 1, y: 0 }, perp: { x: 0, y: 1 } };
  const tangent = { x: sx / len, y: sy / len };
  return { tangent, perp: { x: -tangent.y, y: tangent.x } };
}

export function tieHitTest({ point, position, tangent, perp, memberCount, zoom }) {
  const dx = point.x - position.x,
    dy = point.y - position.y;
  const along = dx * perp.x + dy * perp.y;
  const across = dx * tangent.x + dy * tangent.y;
  return Math.abs(along) <= tieSpread(memberCount) / 2 + 18 / zoom && Math.abs(across) <= 10 / zoom;
}

export function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y },
    s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const u = (qp.x * r.y - qp.y * r.x) / den;
  const t = (qp.x * s.y - qp.y * s.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * r.x, y: a.y + t * r.y } : null;
}

export function polylineIntersection(points, a, b) {
  for (let i = 0; i < points.length - 1; i++) {
    const hit = segmentIntersection(a, b, points[i], points[i + 1]);
    if (hit) return hit;
  }
  return null;
}

// Ties still holding at least one live rope, with the position/axes they currently have.
export function resolveCableTies(ties, pinsByRope, dragged) {
  const out = [];
  for (const tie of ties) {
    if (!Number.isFinite(tie.position.x) || !Number.isFinite(tie.position.y)) continue;
    const memberRopeIds = tie.memberConnectionIds.filter((id) => pinsByRope.has(id));
    if (!memberRopeIds.length) continue;
    const position = dragged && dragged.id === tie.id ? dragged.position : tie.position;
    const flows = memberRopeIds.map((id) => {
      const p = pinsByRope.get(id);
      return (
        flowDirection(p.pinStart, p.pinEnd, position) || { x: p.pinEnd.x - p.pinStart.x, y: p.pinEnd.y - p.pinStart.y }
      );
    });
    const axes = tieAxes(flows);
    out.push({
      id: tie.id,
      position: { x: position.x, y: position.y },
      memberRopeIds,
      tangent: axes.tangent,
      perp: axes.perp,
    });
  }
  return out;
}

// rope id -> [{ point, tangent }]: where each member rope must pass (members lie side by side across the collar).
export function cableTieConstraints(resolved) {
  const targets = new Map();
  for (const tie of resolved) {
    const offsets = lateralOffsets(tie.memberRopeIds.length);
    tie.memberRopeIds.forEach((ropeId, i) => {
      const c = {
        point: { x: tie.position.x + tie.perp.x * offsets[i], y: tie.position.y + tie.perp.y * offsets[i] },
        tangent: tie.tangent,
      };
      if (targets.has(ropeId)) targets.get(ropeId).push(c);
      else targets.set(ropeId, [c]);
    });
  }
  return targets;
}

export function tieConstraintsEqual(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every(
    (l, i) =>
      l.point.x === b[i].point.x &&
      l.point.y === b[i].point.y &&
      l.tangent.x === b[i].tangent.x &&
      l.tangent.y === b[i].tangent.y,
  );
}

// For one rope with tie targets: the length it must have, a rest length per segment, and the points to hold in place
// (the tie point plus its neighbours, lined up along the tie tangent so the rope leaves the collar straight).
export function resolveTieClamps(pinStart, pinEnd, points, targets) {
  const count = points.length;
  const chordX = pinEnd.x - pinStart.x,
    chordY = pinEnd.y - pinStart.y;
  const chordLength = Math.hypot(chordX, chordY);
  if (!targets.length) return { dist: chordLength, pins: [], segmentLengths: null };
  const progress = (p) => (p.x - pinStart.x) * chordX + (p.y - pinStart.y) * chordY;
  const ordered = [...targets].sort((a, b) => progress(a.point) - progress(b.point));
  const legs = [];
  let prev = pinStart,
    routed = 0;
  for (const c of ordered) {
    const leg = Math.hypot(c.point.x - prev.x, c.point.y - prev.y);
    legs.push(leg);
    routed += leg;
    prev = c.point;
  }
  routed += Math.hypot(pinEnd.x - prev.x, pinEnd.y - prev.y);
  const dist = Math.max(chordLength, routed);
  if (routed <= 1e-3) return { dist, pins: [], segmentLengths: null };
  const centers = [];
  let cumulative = 0,
    lastIndex = -1;
  ordered.forEach((c, k) => {
    cumulative += legs[k];
    const index = Math.min(Math.max(Math.round((cumulative / routed) * SEGMENT_COUNT), lastIndex + 3, 1), count - 2);
    if (index <= lastIndex) return;
    lastIndex = index;
    centers.push({ index, point: c.point, tangent: c.tangent });
  });
  if (!centers.length) return { dist, pins: [], segmentLengths: null };
  const segmentLengths = new Array(count - 1).fill(0);
  let spanStartIndex = 0,
    spanStartPoint = pinStart;
  for (const w of [...centers, { index: count - 1, point: pinEnd }]) {
    const span = Math.hypot(w.point.x - spanStartPoint.x, w.point.y - spanStartPoint.y);
    const per = (Math.max(span, 1) * TIED_SLACK) / (w.index - spanStartIndex);
    for (let s = spanStartIndex; s < w.index; s++) segmentLengths[s] = per;
    spanStartIndex = w.index;
    spanStartPoint = w.point;
  }
  const pins = [];
  for (const c of centers) {
    const a = points[Math.max(c.index - 1, 0)],
      b = points[Math.min(c.index + 1, count - 1)];
    const sign = (b.x - a.x) * c.tangent.x + (b.y - a.y) * c.tangent.y >= 0 ? 1 : -1;
    const dx = c.tangent.x * sign,
      dy = c.tangent.y * sign;
    if (c.index - 1 >= 1)
      pins.push({
        index: c.index - 1,
        target: { x: c.point.x - dx * segmentLengths[c.index - 1], y: c.point.y - dy * segmentLengths[c.index - 1] },
      });
    pins.push({ index: c.index, target: c.point });
    if (c.index + 1 <= count - 2)
      pins.push({
        index: c.index + 1,
        target: { x: c.point.x + dx * segmentLengths[c.index], y: c.point.y + dy * segmentLengths[c.index] },
      });
  }
  return { dist, pins, segmentLengths };
}

// A lasso line drawn across ropes -> the tie to create (null when it crosses nothing).
// `ropes`: Map(id -> { points, pinStart, pinEnd }).
export function tieFromLasso(ropes, start, end, makeId, nowIso) {
  if (Math.hypot(end.x - start.x, end.y - start.y) <= MIN_LASSO_LENGTH) return null;
  const crossings = [];
  for (const [id, r] of ropes) {
    const hit = polylineIntersection(r.points, start, end);
    if (hit) crossings.push({ ropeId: id, point: hit });
  }
  if (!crossings.length) return null;
  const centroid = {
    x: crossings.reduce((s, c) => s + c.point.x, 0) / crossings.length,
    y: crossings.reduce((s, c) => s + c.point.y, 0) / crossings.length,
  };
  const chords = crossings.map((c) => {
    const r = ropes.get(c.ropeId);
    return (
      flowDirection(r.pinStart, r.pinEnd, centroid) || { x: r.pinEnd.x - r.pinStart.x, y: r.pinEnd.y - r.pinStart.y }
    );
  });
  const axes = tieAxes(chords);
  const proj = (p) => (p.x - centroid.x) * axes.perp.x + (p.y - centroid.y) * axes.perp.y;
  const ordered = [...crossings].sort((a, b) => proj(a.point) - proj(b.point));
  return { id: makeId(), position: centroid, memberConnectionIds: ordered.map((c) => c.ropeId), createdAt: nowIso };
}
