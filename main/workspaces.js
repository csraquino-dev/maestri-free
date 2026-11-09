'use strict';
// Workspace manager: manifest, app-state, in-memory documents, dirty tracking,
// node/connection helpers shared by IPC handlers and the renderer bridge.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const persistence = require('./persistence');

const { uuid, now } = persistence;
const crossFloor = require('./cross-floor');
const cableTies = require('./cable-ties');

const NOTE_DEFAULT = { w: 260, h: 150 };
const TERMINAL_DEFAULT = { w: 640, h: 400 };
const PORTAL_DEFAULT = { w: 640, h: 440 };
const FILETREE_DEFAULT = { w: 280, h: 360 };

// ------------------------------------------------------------ frame helpers
const frameRect = (f) => ({ x: f[0][0], y: f[0][1], w: f[1][0], h: f[1][1] });
const rectFrame = (r) => [
  [r.x, r.y],
  [r.w, r.h],
];

class Workspaces extends EventEmitter {
  constructor() {
    super();
    this.manifest = null;
    this.appState = null;
    this.docs = new Map(); // id -> document
    this.dirty = new Set();
    this.activeId = null;
    this.crashed = false;
  }

  load() {
    persistence.init();
    this.manifest = persistence.loadManifest();
    this.appState = persistence.loadAppState();
    this.crashed = this.appState.cleanShutdown === false;
    this.appState.cleanShutdown = false; // flipped to true on a normal quit
    persistence.saveAppState(this.appState);
    // Drop manifest entries whose files vanished? keep them – user may restore backups.
    if (!this.manifest.workspaces.length) {
      this.create({ name: 'My Workspace', workingDirectory: os.homedir() });
    }
    const wanted = this.appState.activeWorkspaceId;
    const id = this.manifest.workspaces.find((w) => w.id === wanted) ? wanted : this.manifest.workspaces[0].id;
    this.open(id);
  }

  list() {
    return this.manifest.workspaces;
  }

  entry(id) {
    return this.manifest.workspaces.find((w) => w.id === id);
  }

  create({ name, workingDirectory, icon = 'folder', color = 'blue' }) {
    const id = uuid();
    const t = now();
    const entry = {
      id,
      name,
      workingDirectory,
      icon,
      color,
      isPinned: false,
      locationType: 'local',
      createdAt: t,
      lastOpenedAt: null,
    };
    const doc = persistence.newDocument(persistence.newPayload({ id, name, workingDirectory }));
    doc.payload.icon = icon;
    persistence.ensureDir(persistence.paths.notesDir(id));
    persistence.ensureDir(persistence.paths.terminalsDir(id));
    persistence.saveWorkspace(doc);
    this.docs.set(id, doc);
    this.manifest.workspaces.push(entry);
    persistence.saveManifest(this.manifest);
    return entry;
  }

  update(id, fields) {
    const e = this.entry(id);
    if (!e) return null;
    Object.assign(e, fields);
    const doc = this.getDoc(id);
    if (doc) {
      for (const k of ['name', 'icon', 'workingDirectory', 'isPinned']) if (k in fields) doc.payload[k] = fields[k];
      this.markDirty(id);
    }
    persistence.saveManifest(this.manifest);
    return e;
  }

  remove(id) {
    this.manifest.workspaces = this.manifest.workspaces.filter((w) => w.id !== id);
    this.docs.delete(id);
    this.dirty.delete(id);
    persistence.deleteWorkspaceFiles(id);
    if (!this.manifest.workspaces.length) this.create({ name: 'My Workspace', workingDirectory: os.homedir() });
    persistence.saveManifest(this.manifest);
    if (this.activeId === id) this.open(this.manifest.workspaces[0].id);
  }

  getDoc(id) {
    if (!this.docs.has(id)) {
      const doc = persistence.loadWorkspace(id);
      if (!doc) return null;
      this.docs.set(id, doc);
    }
    return this.docs.get(id);
  }

  get activeDoc() {
    return this.activeId ? this.getDoc(this.activeId) : null;
  }

  open(id) {
    const doc = this.getDoc(id);
    if (!doc) throw new Error(`workspace ${id} not found`);
    this.activeId = id;
    doc.payload.lastOpenedAt = now();
    const e = this.entry(id);
    if (e) e.lastOpenedAt = doc.payload.lastOpenedAt;
    this.appState.activeWorkspaceId = id;
    this.appState.lastOpenedAt = now();
    this.appState.recentWorkspaceIds = [id, ...(this.appState.recentWorkspaceIds || []).filter((x) => x !== id)].slice(
      0,
      10,
    );
    persistence.saveAppState(this.appState);
    persistence.saveManifest(this.manifest);
    this.markDirty(id);
    return doc;
  }

  markDirty(id) {
    this.dirty.add(id);
  }

  // Replace renderer-owned fields of the document (renderer is the editor for layout).
  applyFromRenderer(id, patch) {
    const doc = this.getDoc(id);
    if (!doc) return;
    const pl = doc.payload;
    for (const k of [
      'nodes',
      'connections',
      'noteConnections',
      'portalConnections',
      'portalToPortalConnections',
      'noteToNoteConnections',
      'drawings',
      'canvasOrigin',
      'canvasZoom',
    ]) {
      if (k in patch) pl[k] = patch[k];
    }
    this.markDirty(id);
  }

  saveDirty(beforeSave) {
    for (const id of [...this.dirty]) {
      const doc = this.docs.get(id);
      if (!doc) continue;
      if (beforeSave) beforeSave(id, doc);
      try {
        persistence.saveWorkspace(doc);
        this.dirty.delete(id);
      } catch (err) {
        console.error('save failed', id, err);
      }
    }
  }

  shutdownClean() {
    this.appState.cleanShutdown = true;
    persistence.saveAppState(this.appState);
  }

  // main-initiated change → renderer re-renders
  changed(id) {
    this.markDirty(id);
    this.emit('changed', id);
  }

  // ----------------------------------------------------------- node lookups
  findNode(doc, id) {
    return doc.payload.nodes.find((n) => n.id === id);
  }

  workspaceOfNode(nodeId) {
    for (const [id, doc] of this.docs) if (doc.payload.nodes.some((n) => n.id === nodeId)) return id;
    for (const e of this.manifest.workspaces) {
      const doc = this.getDoc(e.id);
      if (doc && doc.payload.nodes.some((n) => n.id === nodeId)) return e.id;
    }
    return null;
  }

  terminalNode(doc, id) {
    const n = this.findNode(doc, id);
    return n && n.content.terminal ? n : null;
  }

  noteNameOf(node) {
    const sn = node.content.stickyNote && node.content.stickyNote._0;
    if (!sn) return null;
    return (sn.fileName || 'Note.md').replace(/\.md$/i, '');
  }

  portalNameOf(node) {
    const p = node.content.portal && node.content.portal._0;
    return p ? p.name : null;
  }

  // Everything directly connected to a terminal.
  connectionsOf(doc, tid) {
    const pl = doc.payload;
    const out = { agents: [], notes: [], portals: [] };
    out.agents.push(...crossFloor.peersOf(doc, tid));
    for (const c of pl.connections) {
      if (c.terminalIdA === tid) out.agents.push(c.terminalIdB);
      else if (c.terminalIdB === tid) out.agents.push(c.terminalIdA);
    }
    for (const c of pl.noteConnections) if (c.terminalId === tid) out.notes.push(c.noteNodeId);
    for (const c of pl.portalConnections) if (c.terminalId === tid) out.portals.push(c.portalNodeId);
    // note chains: agents traverse the entire chain
    const seen = new Set(out.notes);
    const queue = [...out.notes];
    while (queue.length) {
      const cur = queue.shift();
      for (const c of pl.noteToNoteConnections) {
        const other = c.noteNodeIdA === cur ? c.noteNodeIdB : c.noteNodeIdB === cur ? c.noteNodeIdA : null;
        if (other && !seen.has(other)) {
          seen.add(other);
          out.notes.push(other);
          queue.push(other);
        }
      }
    }
    // portals linked portal↔portal share the connected terminal's reach
    const pseen = new Set(out.portals);
    const pq = [...out.portals];
    while (pq.length) {
      const cur = pq.shift();
      for (const c of pl.portalToPortalConnections) {
        const other = c.portalIdA === cur ? c.portalIdB : c.portalIdB === cur ? c.portalIdA : null;
        if (other && !pseen.has(other)) {
          pseen.add(other);
          out.portals.push(other);
          pq.push(other);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- creation
  nextZ(doc) {
    return doc.payload.nodes.reduce((m, n) => Math.max(m, n.zIndex || 0), 0) + 1;
  }

  makeNode(doc, content, rect, floorId = null) {
    const t = now();
    return {
      floorId: floorId || null, // null = Ground (extra field; ignored by the macOS app)
      id: content.__id || uuid(),
      frame: rectFrame(rect),
      content: content.__content,
      zIndex: this.nextZ(doc),
      isLocked: false,
      createdAt: t,
      lastModifiedAt: t,
    };
  }

  terminalContent({
    id,
    name,
    agentType = 'generic_shell',
    command = '',
    workingDirectory = '',
    color,
    isManager = false,
    shellPath,
    shellArgs,
    remote,
    roleId,
  }) {
    return {
      agentType,
      command,
      name,
      icon: 'terminal',
      color: color || '#007AFF',
      id,
      shellPath: shellPath || 'powershell.exe',
      workingDirectory,
      status: 'idle',
      isManager,
      monitorWithOmbro: false,
      autoScrollLocked: false,
      shortcutMode: { kind: 'automatic' },
      assignedRoleId: roleId || null,
      scrollbackFile: null,
      scrollbackLineCount: 0,
      lastActiveAt: null,
      themeId: null,
      fontFamily: null,
      fontSize: null,
      ...(shellArgs && shellArgs.length ? { shellArgs } : {}),
      ...(remote ? { remote } : {}),
    };
  }

  floorOfAnchor(doc, anchorId, explicit) {
    if (explicit !== undefined) return explicit || null;
    const a = anchorId && this.findNode(doc, anchorId);
    return (a && a.floorId) || null;
  }

  // Free spot near an anchor rect that doesn't overlap existing nodes (same floor only).
  freeRect(doc, w, h, anchor, floorId = null) {
    const pad = 40;
    const rects = doc.payload.nodes
      .filter((n) => (n.floorId || null) === (floorId || null))
      .map((n) => frameRect(n.frame));
    const overlaps = (r) =>
      rects.some(
        (o) => r.x < o.x + o.w + pad && r.x + r.w + pad > o.x && r.y < o.y + o.h + pad && r.y + r.h + pad > o.y,
      );
    const base = anchor || { x: doc.payload.canvasOrigin[0] + 120, y: doc.payload.canvasOrigin[1] + 120, w: 0, h: 0 };
    const candidates = [
      { x: base.x, y: base.y + base.h + pad },
      { x: base.x + base.w + pad, y: base.y },
      { x: base.x - w - pad, y: base.y },
      { x: base.x, y: base.y - h - pad },
    ];
    for (const c of candidates) {
      const r = { x: c.x, y: c.y, w, h };
      if (!overlaps(r)) return r;
    }
    let r = { x: base.x, y: base.y + base.h + pad, w, h };
    for (let i = 0; i < 60 && overlaps(r); i++) r = { x: r.x + w + pad, y: r.y, w, h };
    return r;
  }

  addTerminal(doc, opts, anchorId) {
    const id = opts.id || uuid();
    const floorId = this.floorOfAnchor(doc, anchorId, opts.floorId);
    const anchor = anchorId && this.findNode(doc, anchorId) ? frameRect(this.findNode(doc, anchorId).frame) : null;
    const rect = opts.rect || this.freeRect(doc, TERMINAL_DEFAULT.w, TERMINAL_DEFAULT.h, anchor, floorId);
    const floor = floorId && doc.payload.floors.find((f) => f.id === floorId);
    const tcOpts = { ...opts, id };
    if (floor && (!opts.workingDirectory || opts.workingDirectory === doc.payload.workingDirectory))
      tcOpts.workingDirectory = floor.worktreePath;
    const node = this.makeNode(
      doc,
      { __id: id, __content: { terminal: { _0: this.terminalContent(tcOpts) } } },
      rect,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  addNote(doc, { name, content = '', anchorId, rect, color, floorId: fl }) {
    const id = uuid();
    const floorId = this.floorOfAnchor(doc, anchorId, fl);
    const dir = persistence.paths.notesDir(doc.payload.id);
    persistence.ensureDir(dir);
    const fileName = `${name}.md`;
    const file = path.join(dir, fileName);
    if (!fs.existsSync(file) || content) fs.writeFileSync(file, content);
    const anchor = anchorId && this.findNode(doc, anchorId) ? frameRect(this.findNode(doc, anchorId).frame) : null;
    const r = rect || this.freeRect(doc, NOTE_DEFAULT.w, NOTE_DEFAULT.h, anchor, floorId);
    const node = this.makeNode(
      doc,
      {
        __id: id,
        __content: {
          stickyNote: {
            _0: {
              color: color || '#FEFDE8',
              fileName,
              fontSize: 14,
              hasCustomName: false,
              isPreviewing: false,
              storageMode: { managed: {} },
            },
          },
        },
      },
      r,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  addPortal(doc, { name, url = '', anchorId, rect, floorId: fl }) {
    const id = uuid();
    const floorId = this.floorOfAnchor(doc, anchorId, fl);
    const anchor = anchorId && this.findNode(doc, anchorId) ? frameRect(this.findNode(doc, anchorId).frame) : null;
    const r = rect || this.freeRect(doc, PORTAL_DEFAULT.w, PORTAL_DEFAULT.h, anchor, floorId);
    const content = {
      id,
      name,
      currentURL: url,
      source: url ? { url: { _0: url } } : {},
      status: 'idle',
      chromeHidden: false,
      storageScope: 'isolated',
    };
    const node = this.makeNode(doc, { __id: id, __content: { portal: { _0: content } } }, r, floorId);
    doc.payload.nodes.push(node);
    return node;
  }

  addFileTree(doc, { name, rootPath, rect, floorId: fl }) {
    const floorId = fl || null;
    const r = rect || this.freeRect(doc, FILETREE_DEFAULT.w, FILETREE_DEFAULT.h, null, floorId);
    const node = this.makeNode(
      doc,
      { __content: { fileTree: { _0: { name, rootPath, viewMode: 'list' } } } },
      r,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  addText(doc, { text = 'Text', rect, floorId: fl }) {
    const floorId = fl || null;
    const r = rect || this.freeRect(doc, 200, 40, null, floorId);
    const node = this.makeNode(
      doc,
      {
        __content: {
          text: {
            _0: { text, fontSize: 18, fontWeight: 'regular', color: '#1a1a1a', alignment: 'left', fontFamily: 'sans' },
          },
        },
      },
      r,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  // Shapes (rect / ellipse / diamond) and strokes (line / arrow), Maestri-compatible content.
  addShape(doc, { shapeType = 'rect', rect, floorId: fl, style = {} }) {
    const floorId = fl || null;
    const r = rect || this.freeRect(doc, 200, 140, null, floorId);
    const color = style.color || 'blue';
    const node = this.makeNode(
      doc,
      {
        __content: {
          shape: {
            _0: {
              shapeType,
              fillColor: color,
              strokeColor: color,
              strokeWidth: style.width || 2,
              strokeStyle: style.pattern || 'solid',
              fillStyle: style.fill === 'solid' ? 'solid' : 'none',
              text: '',
              fontSize: 16,
              rotation: 0,
            },
          },
        },
      },
      r,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  addStroke(doc, { strokeType = 'line', rect, floorId: fl, style = {}, start = [0, 0.5], end = [1, 0.5] }) {
    const floorId = fl || null;
    const r = rect || this.freeRect(doc, 220, 80, null, floorId);
    const arrow = strokeType === 'arrow';
    const control = arrow ? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] : null;
    const node = this.makeNode(
      doc,
      {
        __content: {
          stroke: {
            _0: {
              strokeType,
              startPoint: start,
              endPoint: end,
              controlPoint: control,
              strokeColor: style.color || 'blue',
              strokeWidth: style.width || 2,
              strokeStyle: style.pattern || 'solid',
            },
          },
        },
      },
      r,
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  // Free-hand pen / highlighter. `points` are world coordinates; they are stored normalised (0..1) inside
  // a frame that tightly wraps them (plus the stroke width), like Maestri's freehand content.
  addFreehand(doc, { points, freehandType = 'pen', style = {}, floorId: fl }) {
    if (!Array.isArray(points) || points.length < 2) throw new Error('a freehand stroke needs at least two points');
    const floorId = fl || null;
    const width = style.width || (freehandType === 'highlighter' ? 12 : 3);
    const pad = Math.ceil(width / 2) + 2;
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]);
    const x = Math.min(...xs) - pad,
      y = Math.min(...ys) - pad;
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2,
      h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    const norm = points.map((p) => [
      Math.round(((p[0] - x) / w) * 10000) / 10000,
      Math.round(((p[1] - y) / h) * 10000) / 10000,
    ]);
    const node = this.makeNode(
      doc,
      {
        __content: {
          freehand: {
            _0: {
              freehandType,
              points: norm,
              strokeColor: style.color || 'blue',
              strokeWidth: width,
              opacity: freehandType === 'highlighter' ? 0.4 : 1,
              rotation: 0,
            },
          },
        },
      },
      { x: Math.round(x), y: Math.round(y), w: Math.max(8, Math.round(w)), h: Math.max(8, Math.round(h)) },
      floorId,
    );
    doc.payload.nodes.push(node);
    return node;
  }

  // ------------------------------------------------------------- undo / redo
  _hist(id) {
    if (!this.history) this.history = new Map();
    if (!this.history.has(id)) this.history.set(id, { undo: [], redo: [] });
    return this.history.get(id);
  }

  _snap(doc) {
    const pl = doc.payload;
    return JSON.stringify({
      nodes: pl.nodes,
      connections: pl.connections,
      noteConnections: pl.noteConnections,
      portalConnections: pl.portalConnections,
      portalToPortalConnections: pl.portalToPortalConnections,
      noteToNoteConnections: pl.noteToNoteConnections,
      crossFloorConnections: pl.crossFloorConnections,
      cableTies: pl.cableTies,
      floors: pl.floors,
      drawings: pl.drawings,
    });
  }

  // Call BEFORE an undoable change.
  checkpoint(id) {
    const doc = this.getDoc(id);
    if (!doc) return;
    const h = this._hist(id);
    const snap = this._snap(doc);
    if (h.undo[h.undo.length - 1] === snap) return;
    h.undo.push(snap);
    if (h.undo.length > 60) h.undo.shift();
    h.redo = [];
  }

  _restore(id, snap) {
    const doc = this.getDoc(id);
    const before = new Set(doc.payload.nodes.map((n) => n.id));
    Object.assign(doc.payload, JSON.parse(snap));
    const after = new Set(doc.payload.nodes.map((n) => n.id));
    this.markDirty(id);
    return { removed: [...before].filter((x) => !after.has(x)), added: [...after].filter((x) => !before.has(x)) };
  }

  undo(id) {
    const h = this._hist(id);
    const doc = this.getDoc(id);
    if (!h.undo.length) return null;
    h.redo.push(this._snap(doc));
    return this._restore(id, h.undo.pop());
  }

  redo(id) {
    const h = this._hist(id);
    const doc = this.getDoc(id);
    if (!h.redo.length) return null;
    h.undo.push(this._snap(doc));
    return this._restore(id, h.redo.pop());
  }

  historyState(id) {
    const h = this._hist(id);
    return { canUndo: h.undo.length > 0, canRedo: h.redo.length > 0 };
  }

  // Connect two nodes; returns the connection record or null if invalid/duplicate.
  connect(doc, aId, bId) {
    const a = this.findNode(doc, aId);
    const b = this.findNode(doc, bId);
    if (!a || !b || aId === bId) return null;
    // a note stack / a band is connected through each of its members
    for (const [group, other] of [
      [a, bId],
      [b, aId],
    ]) {
      const key = group.content.noteStack ? 'noteStack' : group.content.band ? 'band' : null;
      if (key) {
        let first = null;
        for (const m of group.content[key]._0.memberNodeIds) {
          const c = this.connect(doc, m, other);
          first = first || c;
        }
        return first;
      }
    }
    if (a.content.terminal && b.content.terminal && (a.floorId || null) !== (b.floorId || null))
      return crossFloor.connect(this, doc, aId, bId);
    const kind = (n) =>
      n.content.terminal ? 'terminal' : n.content.stickyNote ? 'note' : n.content.portal ? 'portal' : null;
    const ka = kind(a);
    const kb = kind(b);
    if (!ka || !kb) return null;
    const pl = doc.payload;
    const base = () => ({ id: uuid(), createdAt: now(), ropePoints: [] });
    const has = (arr, f) => arr.some(f);
    if (ka === 'terminal' && kb === 'terminal') {
      if (
        has(
          pl.connections,
          (c) => (c.terminalIdA === aId && c.terminalIdB === bId) || (c.terminalIdA === bId && c.terminalIdB === aId),
        )
      )
        return null;
      const c = { ...base(), terminalIdA: aId, terminalIdB: bId };
      pl.connections.push(c);
      return c;
    }
    if ((ka === 'terminal' && kb === 'note') || (ka === 'note' && kb === 'terminal')) {
      const [t, n] = ka === 'terminal' ? [aId, bId] : [bId, aId];
      if (has(pl.noteConnections, (c) => c.terminalId === t && c.noteNodeId === n)) return null;
      const c = { ...base(), terminalId: t, noteNodeId: n };
      pl.noteConnections.push(c);
      return c;
    }
    if ((ka === 'terminal' && kb === 'portal') || (ka === 'portal' && kb === 'terminal')) {
      const [t, p] = ka === 'terminal' ? [aId, bId] : [bId, aId];
      if (has(pl.portalConnections, (c) => c.terminalId === t && c.portalNodeId === p)) return null;
      const c = { ...base(), terminalId: t, portalNodeId: p };
      pl.portalConnections.push(c);
      return c;
    }
    if (ka === 'note' && kb === 'note') {
      if (
        has(
          pl.noteToNoteConnections,
          (c) => (c.noteNodeIdA === aId && c.noteNodeIdB === bId) || (c.noteNodeIdA === bId && c.noteNodeIdB === aId),
        )
      )
        return null;
      const c = { ...base(), noteNodeIdA: aId, noteNodeIdB: bId };
      pl.noteToNoteConnections.push(c);
      return c;
    }
    if (ka === 'portal' && kb === 'portal') {
      if (
        has(
          pl.portalToPortalConnections,
          (c) => (c.portalIdA === aId && c.portalIdB === bId) || (c.portalIdA === bId && c.portalIdB === aId),
        )
      )
        return null;
      const c = { ...base(), portalIdA: aId, portalIdB: bId };
      pl.portalToPortalConnections.push(c);
      return c;
    }
    return null; // note↔portal is not a valid pairing
  }

  // Remove every connection touching a node.
  disconnectNode(doc, id) {
    const pl = doc.payload;
    crossFloor.dropNode(doc, id);
    pl.connections = pl.connections.filter((c) => c.terminalIdA !== id && c.terminalIdB !== id);
    pl.noteConnections = pl.noteConnections.filter((c) => c.terminalId !== id && c.noteNodeId !== id);
    pl.portalConnections = pl.portalConnections.filter((c) => c.terminalId !== id && c.portalNodeId !== id);
    pl.noteToNoteConnections = pl.noteToNoteConnections.filter((c) => c.noteNodeIdA !== id && c.noteNodeIdB !== id);
    pl.portalToPortalConnections = pl.portalToPortalConnections.filter((c) => c.portalIdA !== id && c.portalIdB !== id);
  }

  removeNode(doc, id) {
    this.disconnectNode(doc, id);
    cableTies.prune(doc);
    for (const s of doc.payload.nodes) {
      if (s.content.noteStack) {
        const d = s.content.noteStack._0;
        const i = d.memberNodeIds.indexOf(id);
        if (i >= 0) {
          d.memberNodeIds.splice(i, 1);
          if (d.frontNoteId === id) d.frontNoteId = d.memberNodeIds[0] || null;
        }
      }
    }
    for (const s of doc.payload.nodes) {
      if (s.content.band) {
        const d = s.content.band._0;
        const i = d.memberNodeIds.indexOf(id);
        if (i >= 0) {
          d.memberNodeIds.splice(i, 1);
          if (d.shownMemberId === id) d.shownMemberId = d.memberNodeIds[0] || null;
        }
      }
    }
    doc.payload.nodes = doc.payload.nodes.filter(
      (n) =>
        !(
          (n.content.noteStack && n.content.noteStack._0.memberNodeIds.length === 0) ||
          (n.content.band && n.content.band._0.memberNodeIds.length === 0)
        ),
    );
    doc.payload.nodes = doc.payload.nodes.filter((n) => n.id !== id);
  }

  notePath(doc, node) {
    const sn = node.content.stickyNote._0;
    const mode = sn.storageMode || {};
    if (mode.custom) return mode.custom._0;
    return path.join(persistence.paths.notesDir(doc.payload.id), sn.fileName);
  }
}

module.exports = { Workspaces, frameRect, rectFrame };
