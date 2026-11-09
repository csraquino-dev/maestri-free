'use strict';
// Partituras: a saved selection (terminals with their commands and roles, notes with their text, portals, stacks,
// bands, drawings and the connections between them) that can be placed again in any workspace.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');
const { frameRect, rectFrame } = require('./workspaces');

const FORMAT = 'open-maestri-partitura';
const CONNECTION_LISTS = [
  ['connections', ['terminalIdA', 'terminalIdB']],
  ['noteConnections', ['terminalId', 'noteNodeId']],
  ['portalConnections', ['terminalId', 'portalNodeId']],
  ['noteToNoteConnections', ['noteNodeIdA', 'noteNodeIdB']],
  ['portalToPortalConnections', ['portalIdA', 'portalIdB']],
];
const clone = (x) => JSON.parse(JSON.stringify(x));

function createPartituras({ workspaces, prefs, savePrefs, rootDir = persistence.paths.root }) {
  const globalDir = () => path.join(rootDir, 'partituras');
  const wsDir = (id) => path.join(rootDir, 'workspaces', id, 'partituras');
  const dirOf = (workspaceId) => (workspaceId ? wsDir(workspaceId) : globalDir());

  // ids of the selection plus the pages / terminals hidden inside selected stacks and bands
  function expand(doc, ids) {
    const out = new Set(ids);
    for (const n of doc.payload.nodes) {
      if (!out.has(n.id)) continue;
      if (n.content.noteStack) n.content.noteStack._0.memberNodeIds.forEach((m) => out.add(m));
      if (n.content.band) n.content.band._0.memberNodeIds.forEach((m) => out.add(m));
    }
    return out;
  }

  function capture(wsId, ids, { name, description = '' } = {}) {
    const doc = workspaces.getDoc(wsId);
    if (!doc) throw new Error('workspace not found');
    const all = expand(doc, ids);
    const nodes = clone(doc.payload.nodes.filter((n) => all.has(n.id)));
    if (!nodes.length) throw new Error('nothing selected');
    const noteTexts = {};
    const roles = [];
    for (const n of nodes) {
      n.floorId = null;
      if (n.content.terminal) {
        const t = n.content.terminal._0;
        t.scrollbackFile = null;
        t.scrollbackLineCount = 0;
        t.status = 'idle';
        const role = t.assignedRoleId && prefs().rolePresets.find((r) => r.id === t.assignedRoleId);
        if (role && !roles.some((r) => r.id === role.id)) roles.push(clone(role));
      }
      if (n.content.stickyNote) {
        const file = workspaces.notePath(doc, workspaces.findNode(doc, n.id));
        noteTexts[n.id] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      }
    }
    const frames = nodes.map((n) => frameRect(n.frame));
    const origin = { x: Math.min(...frames.map((f) => f.x)), y: Math.min(...frames.map((f) => f.y)) };
    const payload = { nodes };
    for (const [list, fields] of CONNECTION_LISTS)
      payload[list] = clone((doc.payload[list] || []).filter((c) => fields.every((f) => all.has(c[f]))));
    return {
      format: FORMAT,
      version: 1,
      id: persistence.uuid(),
      name: String(name || 'Partitura').trim(),
      description,
      createdAt: persistence.now(),
      origin,
      payload,
      noteTexts,
      roles,
    };
  }

  // commands the terminals of a partitura will run; the dialog lets the user review / edit them before saving
  const commandsOf = (p) =>
    p.payload.nodes
      .filter((n) => n.content.terminal)
      .map((n) => ({ nodeId: n.id, name: n.content.terminal._0.name, command: n.content.terminal._0.command }));

  function save(p, workspaceId = null) {
    if (!p || p.format !== FORMAT) throw new Error('not a partitura');
    const dir = dirOf(workspaceId);
    persistence.ensureDir(dir);
    const rec = { ...p, workspaceId: workspaceId || null };
    persistence.writeFileAtomic(path.join(dir, `${p.id}.json`), JSON.stringify(rec));
    return rec;
  }

  function list(workspaceId) {
    const read = (dir) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .flatMap((f) => {
              try {
                const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                return p.format === FORMAT ? [p] : [];
              } catch {
                return [];
              }
            })
        : [];
    return [...(workspaceId ? read(wsDir(workspaceId)) : []), ...read(globalDir())].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt,
      workspaceId: p.workspaceId || null,
      terminals: p.payload.nodes.filter((n) => n.content.terminal).length,
      notes: p.payload.nodes.filter((n) => n.content.stickyNote).length,
      nodes: p.payload.nodes.length,
    }));
  }

  function load(id, workspaceId) {
    for (const dir of [workspaceId && wsDir(workspaceId), globalDir()].filter(Boolean)) {
      const f = path.join(dir, `${id}.json`);
      if (id === path.basename(id) && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    return null;
  }

  function remove(id, workspaceId) {
    for (const dir of [workspaceId && wsDir(workspaceId), globalDir()].filter(Boolean)) {
      const f = path.join(dir, `${id}.json`);
      if (id === path.basename(id) && fs.existsSync(f)) {
        fs.rmSync(f, { force: true });
        return true;
      }
    }
    return false;
  }

  function exportTo(id, workspaceId, file) {
    const p = load(id, workspaceId);
    if (!p) throw new Error('partitura not found');
    persistence.writeFileAtomic(file, JSON.stringify(p));
    return file;
  }

  function importFrom(file, workspaceId = null) {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p || p.format !== FORMAT || !p.payload || !Array.isArray(p.payload.nodes))
      throw new Error('not a partitura file');
    return save({ ...p, id: persistence.uuid() }, workspaceId);
  }

  // Place a partitura into a workspace with its top-left corner at `at`. Every id is regenerated.
  function place(wsId, p, at, floorId = null) {
    const doc = workspaces.getDoc(wsId);
    if (!doc) throw new Error('workspace not found');
    const ids = new Map();
    const nid = (old) => {
      if (!ids.has(old)) ids.set(old, persistence.uuid());
      return ids.get(old);
    };
    const dx = Math.round(at.x - p.origin.x),
      dy = Math.round(at.y - p.origin.y);
    const created = [];
    const taken = new Set(
      doc.payload.nodes.filter((n) => n.content.stickyNote).map((n) => workspaces.noteNameOf(n).toLowerCase()),
    );
    const noteDir = persistence.paths.notesDir(wsId);
    persistence.ensureDir(noteDir);
    for (const src of p.payload.nodes) {
      const n = clone(src);
      n.id = nid(src.id);
      n.floorId = floorId || null;
      n.zIndex = workspaces.nextZ(doc);
      const f = frameRect(n.frame);
      n.frame = rectFrame({ x: f.x + dx, y: f.y + dy, w: f.w, h: f.h });
      if (n.content.terminal) n.content.terminal._0.id = n.id;
      if (n.content.portal) n.content.portal._0.id = n.id;
      if (n.content.noteStack) {
        const d = n.content.noteStack._0;
        d.memberNodeIds = d.memberNodeIds.map(nid);
        d.frontNoteId = d.frontNoteId && nid(d.frontNoteId);
      }
      if (n.content.band) {
        const d = n.content.band._0;
        d.memberNodeIds = d.memberNodeIds.map(nid);
        d.shownMemberId = d.shownMemberId && nid(d.shownMemberId);
      }
      if (n.content.stickyNote) {
        const sn = n.content.stickyNote._0;
        let base = (sn.fileName || 'Note.md').replace(/\.md$/i, '');
        let name = base;
        for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
        taken.add(name.toLowerCase());
        sn.fileName = `${name}.md`;
        sn.storageMode = { managed: {} };
        fs.writeFileSync(path.join(noteDir, sn.fileName), (p.noteTexts && p.noteTexts[src.id]) || '');
      }
      doc.payload.nodes.push(n);
      created.push(n.id);
    }
    for (const [list, fields] of CONNECTION_LISTS) {
      for (const c of p.payload[list] || []) {
        if (!fields.every((f) => ids.has(c[f]))) continue;
        const out = { ...clone(c), id: persistence.uuid(), createdAt: persistence.now(), ropePoints: [] };
        for (const f of fields) out[f] = nid(c[f]);
        doc.payload[list].push(out);
      }
    }
    // roles the partitura carries and this installation does not have yet
    const current = prefs();
    let added = 0;
    for (const r of p.roles || [])
      if (!current.rolePresets.some((x) => x.id === r.id)) {
        current.rolePresets.push(r);
        added++;
      }
    if (added) savePrefs(current);
    workspaces.markDirty(wsId);
    return { nodeIds: created, rolesAdded: added, doc };
  }

  return { capture, commandsOf, save, list, load, remove, exportTo, importFrom, place, globalDir };
}

module.exports = { createPartituras, FORMAT };
