'use strict';
// Workspace duplicate / export / import. Floors are not copied (their git worktrees belong to the original),
// every id is re-generated so the copy is fully independent, notes are copied with their files.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');

const FORMAT = 'open-maestri-workspace';
const CONNECTIONS = [
  ['connections', ['terminalIdA', 'terminalIdB']],
  ['noteConnections', ['terminalId', 'noteNodeId']],
  ['portalConnections', ['terminalId', 'portalNodeId']],
  ['noteToNoteConnections', ['noteNodeIdA', 'noteNodeIdB']],
  ['portalToPortalConnections', ['portalIdA', 'portalIdB']],
];

function readNotes(wsId) {
  const dir = persistence.paths.notesDir(wsId);
  const notes = {};
  if (!fs.existsSync(dir)) return notes;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile() && /\.(md|txt)$/i.test(f)) notes[f] = fs.readFileSync(p, 'utf8');
  }
  return notes;
}

// Build a fresh, independent workspace from a document + its notes.
function materialize(workspaces, doc, notes, { name, color = 'blue' }) {
  const payload = JSON.parse(JSON.stringify(doc.payload));
  const newId = persistence.uuid();
  const ids = new Map();
  const nid = (old) => {
    if (!ids.has(old)) ids.set(old, persistence.uuid());
    return ids.get(old);
  };
  const keep = new Set(payload.nodes.filter((n) => !n.floorId).map((n) => n.id)); // Ground only
  payload.nodes = payload.nodes
    .filter((n) => keep.has(n.id))
    .map((n) => {
      const id = nid(n.id);
      const inner = n.content.terminal ? n.content.terminal._0 : n.content.portal ? n.content.portal._0 : null;
      if (inner) inner.id = id;
      if (n.content.terminal) {
        n.content.terminal._0.scrollbackFile = null;
        n.content.terminal._0.scrollbackLineCount = 0;
        n.content.terminal._0.status = 'idle';
      }
      return { ...n, id, floorId: null };
    });
  for (const [list, fields] of CONNECTIONS) {
    payload[list] = (payload[list] || [])
      .filter((c) => fields.every((f) => keep.has(c[f])))
      .map((c) => {
        const out = { ...c, id: persistence.uuid() };
        for (const f of fields) out[f] = nid(c[f]);
        return out;
      });
  }
  payload.floors = [];
  payload.crossFloorConnections = [];
  payload.cableTies = [];
  payload.id = newId;
  payload.name = name;
  payload.isPinned = false;
  payload.createdAt = persistence.now();
  payload.lastOpenedAt = null;
  const entry = {
    id: newId,
    name,
    workingDirectory: payload.workingDirectory,
    icon: payload.icon || 'folder',
    color,
    isPinned: false,
    locationType: payload.locationType || 'local',
    createdAt: payload.createdAt,
    lastOpenedAt: null,
  };
  const nd = persistence.paths.notesDir(newId);
  persistence.ensureDir(nd);
  persistence.ensureDir(persistence.paths.terminalsDir(newId));
  for (const [file, text] of Object.entries(notes || {})) {
    if (file !== path.basename(file)) continue; // never write outside the notes folder
    fs.writeFileSync(path.join(nd, file), String(text));
  }
  const document = persistence.newDocument(payload);
  persistence.saveWorkspace(document);
  workspaces.docs.set(newId, document);
  workspaces.manifest.workspaces.push(entry);
  persistence.saveManifest(workspaces.manifest);
  return entry;
}

function createWorkspaceIO({ workspaces, save }) {
  return {
    duplicate(id, name) {
      save && save();
      const doc = workspaces.getDoc(id);
      if (!doc) throw new Error('workspace not found');
      const e = workspaces.entry(id);
      return materialize(workspaces, doc, readNotes(id), {
        name: name || `${doc.payload.name} (copy)`,
        color: (e && e.color) || 'blue',
      });
    },
    exportTo(id, file) {
      save && save();
      const doc = workspaces.getDoc(id);
      if (!doc) throw new Error('workspace not found');
      const e = workspaces.entry(id) || {};
      persistence.writeFileAtomic(
        file,
        JSON.stringify({
          format: FORMAT,
          version: 1,
          exportedAt: persistence.now(),
          color: e.color || 'blue',
          document: doc,
          notes: readNotes(id),
        }),
      );
      return file;
    },
    importFrom(file) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        !raw ||
        raw.format !== FORMAT ||
        !raw.document ||
        !raw.document.payload ||
        !Array.isArray(raw.document.payload.nodes)
      )
        throw new Error('not an open-maestri workspace file');
      return materialize(workspaces, raw.document, raw.notes, {
        name: raw.document.payload.name || 'Imported',
        color: raw.color || 'blue',
      });
    },
  };
}

module.exports = { createWorkspaceIO, FORMAT };
