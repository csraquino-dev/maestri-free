'use strict';
// Connections between terminals that live on different floors (Maestri "crossFloorConnections").
// A connection has one small connector node on each floor, placed next to its terminal and joined to it by a rope;
// the connector names the floor and terminal on the other side. Agents can talk across floors like on one canvas.
const { uuid, now } = require('./persistence');

const frameRect = (f) => ({ x: f[0][0], y: f[0][1], w: f[1][0], h: f[1][1] });

const CONNECTOR = { w: 200, h: 40 };

function floorName(doc, floorId) {
  if (!floorId) return 'Ground';
  const f = doc.payload.floors.find((x) => x.id === floorId);
  return f ? f.name : 'Floor';
}

function terminalName(node) {
  return node && node.content.terminal ? node.content.terminal._0.name : '';
}

// Create a cross-floor connection between two terminals on different floors. Returns null when it doesn't apply.
function connect(ws, doc, aId, bId) {
  const a = ws.findNode(doc, aId);
  const b = ws.findNode(doc, bId);
  if (!a || !b || !a.content.terminal || !b.content.terminal) return null;
  const fa = a.floorId || null;
  const fb = b.floorId || null;
  if (fa === fb) return null;
  const pl = doc.payload;
  if (
    pl.crossFloorConnections.some(
      (c) => (c.terminalIdA === aId && c.terminalIdB === bId) || (c.terminalIdA === bId && c.terminalIdB === aId),
    )
  )
    return null;
  const id = uuid();
  const mk = (self, peer, floorId, peerFloorId, side) => {
    const rect = ws.freeRect(doc, CONNECTOR.w, CONNECTOR.h, frameRect(self.frame), floorId);
    const node = ws.makeNode(
      doc,
      {
        __content: {
          crossFloorConnector: {
            _0: {
              connectionId: id,
              side,
              peerFloorId,
              peerTerminalId: peer.id,
              peerName: terminalName(peer),
              peerFloorName: floorName(doc, peerFloorId),
            },
          },
        },
      },
      rect,
      floorId,
    );
    pl.nodes.push(node);
    return node;
  };
  const ca = mk(a, b, fa, fb, 'A');
  const cb = mk(b, a, fb, fa, 'B');
  const c = {
    id,
    createdAt: now(),
    floorIdA: fa,
    floorIdB: fb,
    terminalIdA: aId,
    terminalIdB: bId,
    connectorNodeIdA: ca.id,
    connectorNodeIdB: cb.id,
    ropePointsA: [],
    ropePointsB: [],
  };
  pl.crossFloorConnections.push(c);
  return c;
}

// Drop connections (and their connector nodes) touching any of the node ids / floor ids.
function drop(doc, pred) {
  const pl = doc.payload;
  const gone = pl.crossFloorConnections.filter(pred);
  if (!gone.length) return 0;
  const connectors = new Set(gone.flatMap((c) => [c.connectorNodeIdA, c.connectorNodeIdB]));
  pl.crossFloorConnections = pl.crossFloorConnections.filter((c) => !gone.includes(c));
  pl.nodes = pl.nodes.filter((n) => !connectors.has(n.id));
  return gone.length;
}

function dropNode(doc, id) {
  return drop(
    doc,
    (c) => c.terminalIdA === id || c.terminalIdB === id || c.connectorNodeIdA === id || c.connectorNodeIdB === id,
  );
}

function dropFloor(doc, floorId) {
  return drop(doc, (c) => c.floorIdA === floorId || c.floorIdB === floorId);
}

// Keep connector labels in step with renames (terminal or floor).
function refreshLabels(doc) {
  for (const c of doc.payload.crossFloorConnections) {
    for (const [nodeId, peerId, peerFloor] of [
      [c.connectorNodeIdA, c.terminalIdB, c.floorIdB],
      [c.connectorNodeIdB, c.terminalIdA, c.floorIdA],
    ]) {
      const n = doc.payload.nodes.find((x) => x.id === nodeId);
      const peer = doc.payload.nodes.find((x) => x.id === peerId);
      if (!n || !n.content.crossFloorConnector) continue;
      const d = n.content.crossFloorConnector._0;
      d.peerName = terminalName(peer) || d.peerName;
      d.peerFloorName = floorName(doc, peerFloor);
    }
  }
}

// Terminals on other floors this terminal is joined to.
function peersOf(doc, tid) {
  const out = [];
  for (const c of doc.payload.crossFloorConnections) {
    if (c.terminalIdA === tid) out.push(c.terminalIdB);
    else if (c.terminalIdB === tid) out.push(c.terminalIdA);
  }
  return out;
}

module.exports = { connect, drop, dropNode, dropFloor, refreshLabels, peersOf, CONNECTOR };
