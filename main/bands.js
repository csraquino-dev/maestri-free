'use strict';
// Bands: several terminals grouped into one node with a member list on the side and the shown terminal on the right.
// The member terminals stay in the document (their PTYs keep running, ropes and the omaestri CLI keep working);
// they are just not drawn on the canvas. Connecting something to a band connects it to every member.
const { frameRect, rectFrame } = require('./workspaces');

const isTerminal = (n) => !!(n && n.content.terminal);
const isBand = (n) => !!(n && n.content.band);
const data = (n) => n.content.band._0;
const MIN_W = 760,
  MIN_H = 420;

function createBands(workspaces) {
  const memberIds = (doc) => {
    const s = new Set();
    for (const n of doc.payload.nodes) if (isBand(n)) data(n).memberNodeIds.forEach((id) => s.add(id));
    return s;
  };
  const bandOf = (doc, id) => doc.payload.nodes.find((n) => isBand(n) && data(n).memberNodeIds.includes(id)) || null;
  const get = (doc, id) => {
    const n = workspaces.findNode(doc, id);
    if (!isBand(n)) throw new Error('not a band');
    return n;
  };
  const shownOf = (d) =>
    d.shownMemberId && d.memberNodeIds.includes(d.shownMemberId) ? d.shownMemberId : d.memberNodeIds[0] || null;

  // everything connected to one member is connected to all of them
  function syncConnections(doc, band) {
    const members = data(band).memberNodeIds;
    const pl = doc.payload;
    const notes = new Set(),
      portals = new Set();
    for (const c of pl.noteConnections) if (members.includes(c.terminalId)) notes.add(c.noteNodeId);
    for (const c of pl.portalConnections) if (members.includes(c.terminalId)) portals.add(c.portalNodeId);
    for (const m of members) {
      for (const n of notes) workspaces.connect(doc, m, n);
      for (const p of portals) workspaces.connect(doc, m, p);
    }
  }

  function fit(doc, band, ids) {
    const r = frameRect(band.frame);
    for (const id of ids) {
      const n = workspaces.findNode(doc, id);
      if (n) n.frame = rectFrame(r);
    }
  }

  return {
    memberIds,
    bandOf,
    shownOf,

    create(doc, ids, name) {
      const taken = memberIds(doc);
      const list = [...new Set(ids)].filter((id) => isTerminal(workspaces.findNode(doc, id)) && !taken.has(id));
      if (list.length < 2) throw new Error('select at least two terminals that are not already in a band');
      const first = workspaces.findNode(doc, list[0]);
      const r = frameRect(first.frame);
      const rect = { x: r.x, y: r.y, w: Math.max(r.w, MIN_W), h: Math.max(r.h, MIN_H) };
      const node = workspaces.makeNode(
        doc,
        {
          __content: {
            band: {
              _0: {
                name: name || 'Banda',
                hasCustomName: !!name,
                memberNodeIds: list,
                shownMemberId: list[0],
                listWidth: 190,
              },
            },
          },
        },
        rect,
        first.floorId || null,
      );
      doc.payload.nodes.push(node);
      fit(doc, node, list);
      syncConnections(doc, node);
      return node;
    },

    addTerminals(doc, bandId, ids) {
      const band = get(doc, bandId);
      const taken = memberIds(doc);
      let n = 0;
      for (const id of ids) {
        if (taken.has(id) || !isTerminal(workspaces.findNode(doc, id))) continue;
        data(band).memberNodeIds.push(id);
        taken.add(id);
        n++;
      }
      fit(doc, band, data(band).memberNodeIds);
      if (n) syncConnections(doc, band);
      return n;
    },

    // a brand-new terminal born inside the band (cloned from the shown one unless options say otherwise)
    addNewMember(doc, bandId, opts = {}) {
      const band = get(doc, bandId);
      const d = data(band);
      const base = workspaces.findNode(doc, shownOf(d));
      const bc = base ? base.content.terminal._0 : {};
      const node = workspaces.addTerminal(doc, {
        name: opts.name || `Terminal ${d.memberNodeIds.length + 1}`,
        agentType: opts.agentType || 'generic_shell',
        command: opts.command || '',
        workingDirectory: opts.workingDirectory || bc.workingDirectory || '',
        shellPath: opts.shellPath || bc.shellPath,
        shellArgs: opts.shellArgs || bc.shellArgs,
        remote: opts.remote || bc.remote,
        color: opts.color || bc.color,
        floorId: band.floorId || null,
        rect: frameRect(band.frame),
      });
      d.memberNodeIds.push(node.id);
      d.shownMemberId = node.id;
      syncConnections(doc, band);
      return node;
    },

    setShown(doc, bandId, id) {
      const d = data(get(doc, bandId));
      if (!d.memberNodeIds.includes(id)) throw new Error('that terminal is not in the band');
      d.shownMemberId = id;
    },

    moveMember(doc, bandId, id, beforeId) {
      const d = data(get(doc, bandId));
      const i = d.memberNodeIds.indexOf(id);
      if (i < 0) throw new Error('that terminal is not in the band');
      d.memberNodeIds.splice(i, 1);
      const j = beforeId ? d.memberNodeIds.indexOf(beforeId) : -1;
      d.memberNodeIds.splice(j < 0 ? d.memberNodeIds.length : j, 0, id);
    },

    rename(doc, bandId, name) {
      const d = data(get(doc, bandId));
      d.name = String(name).trim() || d.name;
      d.hasCustomName = true;
    },

    setListWidth(doc, bandId, w) {
      data(get(doc, bandId)).listWidth = Math.max(120, Math.min(360, Math.round(Number(w) || 190)));
    },

    // take one terminal out of the band onto the canvas; a band with a single terminal left dissolves
    removeMember(doc, bandId, id) {
      const band = get(doc, bandId);
      const d = data(band);
      const i = d.memberNodeIds.indexOf(id);
      if (i < 0) throw new Error('that terminal is not in the band');
      d.memberNodeIds.splice(i, 1);
      if (d.shownMemberId === id) d.shownMemberId = d.memberNodeIds[0] || null;
      const n = workspaces.findNode(doc, id);
      const r = frameRect(band.frame);
      n.frame = rectFrame(workspaces.freeRect(doc, r.w, r.h, r, band.floorId || null));
      if (d.memberNodeIds.length < 2) this.dissolve(doc, bandId);
      return n;
    },

    dissolve(doc, bandId) {
      const band = get(doc, bandId);
      const r = frameRect(band.frame);
      data(band).memberNodeIds.forEach((id, i) => {
        const n = workspaces.findNode(doc, id);
        if (n) n.frame = rectFrame({ x: r.x + i * 40, y: r.y + i * 40, w: r.w, h: r.h });
      });
      doc.payload.nodes = doc.payload.nodes.filter((n) => n.id !== bandId);
    },

    // keepTerminals=false closes every terminal in the band; returns their ids so the caller can stop the PTYs
    remove(doc, bandId, { keepTerminals = true } = {}) {
      const band = get(doc, bandId);
      if (keepTerminals) {
        this.dissolve(doc, bandId);
        return [];
      }
      const ids = [...data(band).memberNodeIds];
      for (const id of ids) workspaces.removeNode(doc, id);
      workspaces.removeNode(doc, bandId);
      return ids;
    },
  };
}

module.exports = { createBands, isBand };
