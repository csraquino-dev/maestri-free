'use strict';
// Cable ties (braçadeiras): collars gathering several connection ropes. Stored as payload.cableTies:
// { id, floorId, position:{x,y}, memberConnectionIds:[ropeId], createdAt }.

function liveRopeIds(doc) {
  const pl = doc.payload;
  const ids = new Set();
  for (const k of [
    'connections',
    'noteConnections',
    'portalConnections',
    'noteToNoteConnections',
    'portalToPortalConnections',
  ])
    for (const c of pl[k] || []) ids.add(c.id);
  for (const c of pl.crossFloorConnections || []) {
    ids.add(c.id);
    ids.add(c.id + '#B');
  }
  return ids;
}

// Drop members whose rope no longer exists; a tie with no members left disappears.
function prune(doc) {
  const live = liveRopeIds(doc);
  doc.payload.cableTies = (doc.payload.cableTies || [])
    .map((t) => ({ ...t, memberConnectionIds: t.memberConnectionIds.filter((id) => live.has(id)) }))
    .filter((t) => t.memberConnectionIds.length > 0);
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function create(doc, tie, floorId) {
  if (!tie || typeof tie.id !== 'string' || !tie.position || !finite(tie.position.x) || !finite(tie.position.y))
    throw new Error('invalid tie');
  const live = liveRopeIds(doc);
  const members = [...new Set((tie.memberConnectionIds || []).filter((id) => live.has(id)))];
  if (!members.length) throw new Error('a tie needs at least one rope');
  const pl = doc.payload;
  pl.cableTies = pl.cableTies || [];
  // a rope belongs to a single tie on a floor: new ties take over their ropes
  for (const t of pl.cableTies)
    if ((t.floorId || null) === (floorId || null))
      t.memberConnectionIds = t.memberConnectionIds.filter((id) => !members.includes(id));
  const made = {
    id: tie.id,
    floorId: floorId || null,
    position: { x: tie.position.x, y: tie.position.y },
    memberConnectionIds: members,
    createdAt: tie.createdAt || new Date().toISOString(),
  };
  pl.cableTies.push(made);
  prune(doc);
  return made;
}

function move(doc, id, position) {
  const t = (doc.payload.cableTies || []).find((x) => x.id === id);
  if (!t || !position || !finite(position.x) || !finite(position.y)) return null;
  t.position = { x: position.x, y: position.y };
  return t;
}

function remove(doc, id) {
  const before = (doc.payload.cableTies || []).length;
  doc.payload.cableTies = (doc.payload.cableTies || []).filter((x) => x.id !== id);
  return before !== doc.payload.cableTies.length;
}

module.exports = { create, move, remove, prune, liveRopeIds };
