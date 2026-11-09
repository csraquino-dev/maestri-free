'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, webContents, Notification, Menu, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const persistence = require('./persistence');
const { createCore } = require('./core');
const { expandHome } = require('./terminals');
const { createPrompter } = require('./prompter');
const { createSavedPrompts } = require('./saved-prompts');
const { createWorkspaceIO } = require('./workspace-io');
const { createPartituras } = require('./partituras');
const gitOps = require('./git-ops');

const SELFTEST = process.argv.includes('--selftest');
// the self-test must not inherit (or leave behind) browser storage such as saved draw/prompter state
if (SELFTEST) app.setPath('userData', path.join(os.tmpdir(), `omaestri-selftest-userdata-${process.pid}`));
let win = null;
let core = null;

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

// ---------------------------------------------------------------- helpers
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

function listDir(dir) {
  const full = expandHome(dir);
  const out = [];
  for (const d of fs.readdirSync(full, { withFileTypes: true })) {
    if (d.name === '.git' || d.name === 'node_modules') continue;
    out.push({ name: d.name, path: path.join(full, d.name), dir: d.isDirectory() });
  }
  out.sort((a, b) =>
    a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1,
  );
  return out;
}

const safeExternal = (url) => /^https?:\/\//i.test(url);

function notePathFor(wsId, nodeId) {
  const doc = core.workspaces.getDoc(wsId);
  const node = doc && core.workspaces.findNode(doc, nodeId);
  if (!node || !node.content.stickyNote) throw new Error('note not found');
  return core.workspaces.notePath(doc, node);
}

// --------------------------------------------------------------------- IPC
function registerIpc() {
  const trusted = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('untrusted sender');
      return fn(...args);
    });
  const on = (channel, fn) =>
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) fn(...args);
    });

  const ws = () => core.workspaces;
  const docOut = (id) => ws().getDoc(id);

  handle('app:init', () => ({
    workspaces: ws().list(),
    activeId: ws().activeId,
    doc: ws().activeDoc,
    prefs: core.ui.prefs(),
    crashed: ws().crashed,
    home: persistence.paths.root,
    port: core.port(),
    homedir: os.homedir(),
    platform: process.platform,
  }));

  handle('ws:list', () => ws().list());
  const wsio = createWorkspaceIO({ workspaces: ws(), save: () => core.save() });
  handle('ws:duplicate', (id) => {
    const entry = wsio.duplicate(id);
    return { entry, workspaces: ws().list() };
  });
  handle('ws:export', async (id) => {
    const e = ws().entry(id);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${(e && e.name) || 'workspace'}.maestri-workspace.json`,
      filters: [{ name: 'Workspace', extensions: ['json'] }],
    });
    if (r.canceled) return { canceled: true };
    wsio.exportTo(id, r.filePath);
    return { file: r.filePath };
  });
  handle('ws:import', async (file) => {
    let f = file;
    if (!f) {
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Workspace', extensions: ['json'] }],
      });
      if (r.canceled) return { canceled: true };
      f = r.filePaths[0];
    }
    try {
      const entry = wsio.importFrom(f);
      return { entry, workspaces: ws().list() };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('sidebar:get', () => persistence.readJSON(path.join(persistence.paths.root, 'sidebar-layout.json'), {}));
  handle('sidebar:set', (layout) => {
    if (layout && typeof layout === 'object')
      persistence.writeJSON(path.join(persistence.paths.root, 'sidebar-layout.json'), layout);
    return true;
  });
  // live numbers for the sidebar rows: terminals, how many are working, and the floors of every workspace
  handle('ws:stats', () => {
    const out = {};
    for (const e of ws().list()) {
      const doc = ws().getDoc(e.id);
      if (!doc) continue;
      const terms = doc.payload.nodes.filter((n) => n.content.terminal);
      out[e.id] = {
        terminals: terms.length,
        running: terms.filter((n) => {
          const s = core.terminals.get(n.id);
          return s && s.alive && s.status === 'running';
        }).length,
        floors: doc.payload.floors.map((f) => ({ id: f.id, name: f.name })),
      };
    }
    return out;
  });

  handle('ws:open', (id) => {
    const doc = ws().open(id);
    core.startWorkspaceTerminals(id);
    return { doc, workspaces: ws().list() };
  });
  handle('ws:create', (opts) => {
    const e = ws().create(opts);
    return { entry: e, workspaces: ws().list() };
  });
  handle('ws:update', (id, fields) => {
    ws().update(id, fields);
    return ws().list();
  });
  handle('ws:remove', (id) => {
    const doc = ws().getDoc(id);
    if (doc) for (const n of doc.payload.nodes) core.terminals.remove(n.id);
    ws().remove(id);
    return { workspaces: ws().list(), activeId: ws().activeId, doc: ws().activeDoc };
  });

  // Structural operations go through main (authoritative); renderer replaces its doc.
  handle('node:add', (wsId, kind, opts = {}) => {
    ws().checkpoint(wsId);
    const doc = docOut(wsId);
    let node;
    const prefs = core.ui.prefs();
    const rect = opts.rect;
    if (kind === 'terminal') {
      const preset = prefs.agentPresets.find((p) => p.id === opts.presetId) || null;
      const cwd = opts.workingDirectory || doc.payload.workingDirectory || os.homedir();
      node = ws().addTerminal(doc, {
        name: opts.name || (preset ? preset.name : 'Shell'),
        agentType: preset ? preset.agentType : opts.agentType || 'generic_shell',
        command: opts.command != null ? opts.command : preset ? preset.command : '',
        workingDirectory: cwd,
        color: preset ? preset.color : opts.color,
        isManager: !!opts.isManager,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        remote: opts.remote,
        roleId: opts.roleId,
        floorId: opts.floorId || null,
        rect,
      });
      const role = opts.roleId && prefs.rolePresets.find((r) => r.id === opts.roleId);
      if (role) core.handlers.injectRole(role, cwd);
      core.terminals.ensure(node, wsId, prefs);
    } else if (kind === 'note') {
      node = ws().addNote(doc, {
        name: opts.name || `Note-${persistence.uuid().slice(0, 8)}`,
        content: opts.content || '',
        rect,
        color: prefs.defaultNoteColor,
        floorId: opts.floorId || null,
      });
    } else if (kind === 'portal') {
      node = ws().addPortal(doc, {
        name: opts.name || `Portal-${persistence.uuid().slice(0, 6)}`,
        url: opts.url || '',
        rect,
        floorId: opts.floorId || null,
      });
    } else if (kind === 'fileTree') {
      node = ws().addFileTree(doc, {
        name: opts.name || path.basename(opts.rootPath || doc.payload.workingDirectory) || 'Files',
        rootPath: opts.rootPath || doc.payload.workingDirectory,
        rect,
        floorId: opts.floorId || null,
      });
    } else if (kind === 'text') {
      node = ws().addText(doc, { text: opts.text || 'Text', rect, floorId: opts.floorId || null });
    } else if (kind === 'shape') {
      node = ws().addShape(doc, {
        shapeType: opts.shapeType || 'rect',
        rect,
        floorId: opts.floorId || null,
        style: opts.style,
      });
    } else if (kind === 'stroke') {
      node = ws().addStroke(doc, {
        strokeType: opts.strokeType || 'line',
        rect,
        floorId: opts.floorId || null,
        style: opts.style,
        start: opts.start,
        end: opts.end,
      });
    } else if (kind === 'freehand') {
      node = ws().addFreehand(doc, {
        points: opts.points,
        freehandType: opts.freehandType,
        style: opts.style,
        floorId: opts.floorId || null,
      });
    } else {
      throw new Error(`unknown node kind ${kind}`);
    }
    ws().markDirty(wsId);
    return { doc, nodeId: node.id };
  });

  handle('node:remove', (wsId, ids) => {
    ws().checkpoint(wsId);
    const doc = docOut(wsId);
    for (const id of ids) {
      core.terminals.remove(id);
      core.portals.unregister(id);
      ws().removeNode(doc, id);
    }
    ws().markDirty(wsId);
    return doc;
  });

  // note stacks (fichário): generic operation entry point, returns the authoritative document
  handle('stack:op', (wsId, op, a = {}) => {
    const doc = docOut(wsId);
    ws().checkpoint(wsId);
    const S = core.stacks;
    let result = null;
    try {
      switch (op) {
        case 'create':
          result = S.create(doc, a.ids, a.name).id;
          break;
        case 'addNotes':
          result = S.addNotes(doc, a.stackId, a.ids);
          break;
        case 'addPage':
          result = S.addPage(doc, a.stackId).id;
          break;
        case 'setFront':
          S.setFront(doc, a.stackId, a.noteId);
          break;
        case 'moveMember':
          S.moveMember(doc, a.stackId, a.noteId, a.beforeId);
          break;
        case 'rename':
          S.rename(doc, a.stackId, a.name);
          break;
        case 'spill':
          result = S.spill(doc, a.stackId, a.noteId).id;
          break;
        case 'unstackAll':
          S.unstackAll(doc, a.stackId);
          break;
        case 'toggleUniformColor':
          result = S.toggleUniformColor(doc, a.stackId);
          break;
        case 'remove':
          S.remove(doc, a.stackId, { keepNotes: a.keepNotes !== false });
          break;
        default:
          throw new Error(`unknown stack operation ${op}`);
      }
    } catch (e) {
      return { ok: false, error: e.message, doc };
    }
    ws().markDirty(wsId);
    return { ok: true, result, doc };
  });

  // bands (several terminals in one node)
  handle('band:op', (wsId, op, a = {}) => {
    const doc = docOut(wsId);
    ws().checkpoint(wsId);
    const Bd = core.bands;
    let result = null;
    try {
      switch (op) {
        case 'create':
          result = Bd.create(doc, a.ids, a.name).id;
          break;
        case 'addTerminals':
          result = Bd.addTerminals(doc, a.bandId, a.ids);
          break;
        case 'addNewMember': {
          const n = Bd.addNewMember(doc, a.bandId, a.opts || {});
          core.terminals.ensure(n, wsId, core.ui.prefs());
          result = n.id;
          break;
        }
        case 'setShown':
          Bd.setShown(doc, a.bandId, a.id);
          break;
        case 'moveMember':
          Bd.moveMember(doc, a.bandId, a.id, a.beforeId);
          break;
        case 'rename':
          Bd.rename(doc, a.bandId, a.name);
          break;
        case 'setListWidth':
          Bd.setListWidth(doc, a.bandId, a.width);
          break;
        case 'removeMember':
          result = Bd.removeMember(doc, a.bandId, a.id).id;
          break;
        case 'dissolve':
          Bd.dissolve(doc, a.bandId);
          break;
        case 'remove':
          for (const id of Bd.remove(doc, a.bandId, { keepTerminals: a.keepTerminals !== false }))
            core.terminals.remove(id);
          break;
        default:
          throw new Error(`unknown band operation ${op}`);
      }
    } catch (e) {
      return { ok: false, error: e.message, doc };
    }
    ws().markDirty(wsId);
    return { ok: true, result, doc };
  });

  handle('conn:add', (wsId, a, b) => {
    ws().checkpoint(wsId);
    const doc = docOut(wsId);
    const c = ws().connect(doc, a, b);
    ws().markDirty(wsId);
    return { doc, ok: !!c };
  });
  handle('conn:remove', (wsId, list, id) => {
    ws().checkpoint(wsId);
    const doc = docOut(wsId);
    const pl = doc.payload;
    if (list === 'crossFloorConnections') {
      require('./cross-floor').drop(doc, (c) => c.id === id);
      require('./cable-ties').prune(doc);
      ws().markDirty(wsId);
      return doc;
    }
    if (Array.isArray(pl[list])) pl[list] = pl[list].filter((c) => c.id !== id);
    require('./cable-ties').prune(doc);
    ws().markDirty(wsId);
    return doc;
  });

  // cable ties (collars gathering ropes)
  handle('tie:create', (wsId, tie, floorId) => {
    try {
      ws().checkpoint(wsId);
      const doc = docOut(wsId);
      require('./cable-ties').create(doc, tie, floorId);
      ws().markDirty(wsId);
      return { ok: true, doc };
    } catch (e) {
      return { ok: false, error: e.message, doc: docOut(wsId) };
    }
  });
  handle('tie:move', (wsId, id, position) => {
    const doc = docOut(wsId);
    const t = require('./cable-ties').move(doc, id, position);
    if (t) ws().markDirty(wsId);
    return { ok: !!t };
  });
  handle('tie:delete', (wsId, id) => {
    ws().checkpoint(wsId);
    const doc = docOut(wsId);
    const ok = require('./cable-ties').remove(doc, id);
    ws().markDirty(wsId);
    return { ok, doc };
  });

  // Layout/content patches from renderer: {nodeId: {frame, zIndex, isLocked, content}}
  on('node:patch', (wsId, patches, view) => {
    const doc = ws().getDoc(wsId);
    if (!doc) return;
    for (const [id, p] of Object.entries(patches || {})) {
      const n = ws().findNode(doc, id);
      if (!n) continue;
      for (const k of ['frame', 'zIndex', 'isLocked', 'content', 'floorId']) if (k in p) n[k] = p[k];
      n.lastModifiedAt = persistence.now();
      if (p.content && p.content.terminal) {
        const s = core.terminals.get(id);
        if (s) {
          s.name = p.content.terminal._0.name;
          s.roleName = s.roleName;
        }
      }
    }
    if (view) {
      if (view.origin) doc.payload.canvasOrigin = view.origin;
      if (view.zoom) doc.payload.canvasZoom = view.zoom;
    }
    ws().markDirty(wsId);
  });

  // rope shapes (21 points per connection) saved when the physics settles
  on('rope:save', (wsId, shapes) => {
    const doc = ws().getDoc(wsId);
    if (!doc || !shapes || typeof shapes !== 'object') return;
    const lists = [
      'connections',
      'noteConnections',
      'portalConnections',
      'noteToNoteConnections',
      'portalToPortalConnections',
    ];
    for (const [id, pts] of Object.entries(shapes)) {
      if (
        !Array.isArray(pts) ||
        pts.length !== 21 ||
        !pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
      )
        continue;
      for (const l of lists) {
        const c = doc.payload[l].find((x) => x.id === id);
        if (c) {
          c.ropePoints = pts;
          break;
        }
      }
    }
    ws().markDirty(wsId);
  });

  // terminals
  handle('term:attach', (wsId, nodeId) => {
    const doc = ws().getDoc(wsId);
    const node = doc && ws().terminalNode(doc, nodeId);
    if (!node) return null;
    const s = core.terminals.ensure(node, wsId, core.ui.prefs());
    return { ring: s.ring, cols: s.cols, rows: s.rows, status: s.status, alive: s.alive };
  });
  on('term:write', (id, data) => core.terminals.write(id, String(data)));
  on('term:resize', (id, cols, rows) => {
    const s = core.terminals.get(id);
    if (s) s.resize(cols, rows);
  });
  handle('term:restart', (wsId, nodeId) => {
    core.terminals.remove(nodeId);
    const doc = ws().getDoc(wsId);
    const node = doc && ws().terminalNode(doc, nodeId);
    if (!node) return null;
    const s = core.terminals.ensure(node, wsId, core.ui.prefs());
    return { ring: '', cols: s.cols, rows: s.rows };
  });

  // notes
  handle('note:read', (wsId, nodeId) => {
    const f = notePathFor(wsId, nodeId);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  });
  handle('note:write', (wsId, nodeId, text) => {
    persistence.writeFileAtomic(notePathFor(wsId, nodeId), String(text));
    return true;
  });
  handle('note:pasteImage', (wsId, nodeId, bytes, ext) => {
    const f = notePathFor(wsId, nodeId);
    const dir = path.join(path.dirname(f), `${path.basename(f, '.md')}-assets`);
    persistence.ensureDir(dir);
    const safeExt = /^(png|jpg|jpeg|gif|webp)$/i.test(ext) ? ext.toLowerCase() : 'png';
    const file = path.join(dir, `img-${Date.now()}.${safeExt}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return require('url').pathToFileURL(file).href;
  });
  handle('note:import', async (wsId, filePath) => {
    const doc = ws().getDoc(wsId);
    const text = fs.readFileSync(filePath, 'utf8');
    const name = path.basename(filePath).replace(/\.(md|txt)$/i, '');
    ws().addNote(doc, { name, content: text });
    ws().markDirty(wsId);
    return doc;
  });

  // filesystem / git / dialogs
  handle('fs:list', (dir) => listDir(dir));
  handle('fs:gitStatus', async (root) => {
    const out = await git(expandHome(root), ['status', '--porcelain=v1', '-z']);
    if (out == null) return null;
    const map = {};
    for (const entry of out.split('\0')) {
      if (entry.length < 4) continue;
      map[entry.slice(3).replace(/\//g, path.sep)] = entry.slice(0, 2).trim() || '?';
    }
    const branch = ((await git(expandHome(root), ['rev-parse', '--abbrev-ref', 'HEAD'])) || '').trim();
    return { branch, files: map };
  });
  handle('fs:gitDiff', async (root, rel) => (await git(expandHome(root), ['diff', '--', rel])) || '');
  handle('dialog:dir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (filters) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:open', (p) => shell.openPath(String(p)));
  handle('shell:reveal', (p) => shell.showItemInFolder(String(p)));
  handle('shell:external', (url) => (safeExternal(url) ? shell.openExternal(url) : false));
  handle('ide:open', (wsId) => {
    const doc = ws().getDoc(wsId);
    const ide = (doc.payload.preferredIDE || core.ui.prefs().preferredIDE || 'cursor').toLowerCase();
    const cmd = { cursor: 'cursor', vscode: 'code', code: 'code', windsurf: 'windsurf' }[ide] || 'code';
    execFile(
      process.env.ComSpec || 'cmd.exe',
      ['/c', cmd, doc.payload.workingDirectory],
      { windowsHide: true },
      () => {},
    );
    return true;
  });

  // ----------------------------------------------------------- undo / redo
  const hist = (id) => ({ ...ws().historyState(id) });
  handle('history:checkpoint', (id) => {
    ws().checkpoint(id);
    return hist(id);
  });
  handle('history:state', (id) => hist(id));
  const applyHistory = (id, res) => {
    if (!res) return null;
    for (const nid of res.removed) core.terminals.remove(nid);
    core.startWorkspaceTerminals(id);
    return { doc: ws().getDoc(id), ...hist(id) };
  };
  handle('history:undo', (id) => applyHistory(id, ws().undo(id)));
  handle('history:redo', (id) => applyHistory(id, ws().redo(id)));

  // ------------------------------------------------------------------ floors
  const wrap = async (fn) => {
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  handle('floor:info', (id) => core.floors.info(id));
  handle('floor:create', (id, o) =>
    wrap(async () => {
      ws().checkpoint(id);
      const r = await core.floors.create(id, o);
      return { floor: r.floor, hookResults: r.hookResults, doc: ws().getDoc(id) };
    }),
  );
  handle('floor:remove', (id, ref, o) =>
    wrap(async () => {
      ws().checkpoint(id);
      const r = await core.floors.remove(id, ref, o);
      return { warnings: r.warnings, teardown: r.teardown, doc: ws().getDoc(id) };
    }),
  );
  handle('floor:update', (id, floorId, fields) =>
    wrap(async () => {
      core.floors.update(id, floorId, fields);
      return { doc: ws().getDoc(id) };
    }),
  );
  handle('floor:status', (id, ref) => wrap(async () => ({ status: await core.floors.status(id, ref) })));
  handle('floor:landPreview', (id, ref) => wrap(async () => ({ preview: await core.floors.landPreview(id, ref) })));
  handle('floor:land', (id, ref, o) =>
    wrap(async () => {
      ws().checkpoint(id);
      const r = await core.floors.land(id, ref, o);
      return { result: r, doc: ws().getDoc(id) };
    }),
  );
  handle('floor:runHooks', (id, ref, phase) =>
    wrap(async () => ({ results: await core.floors.hooks.run(id, ref, phase) })),
  );

  // ---------------------------------------------------------------- routines
  const rt = () => core.routines;
  handle('routine:list', (id) => ({
    routines: rt().list(id),
    history: rt()
      .history.filter((h) => !id || h.workspaceId === id)
      .slice(-100)
      .reverse(),
  }));
  handle('routine:create', (o) => wrap(async () => ({ routine: rt().create(o) })));
  handle('routine:update', (id, f) => wrap(async () => ({ routine: rt().update(id, f) })));
  handle('routine:remove', (id) => {
    rt().remove(id);
    return true;
  });
  handle('routine:setEnabled', (id, on) => wrap(async () => ({ routine: rt().setEnabled(id, on) })));
  handle('routine:runNow', (id) => wrap(async () => ({ result: await rt().runNow(id) })));
  handle('routine:clearHistory', () => {
    rt().clearHistory();
    return true;
  });

  // ----------------------------------------------------------------- backups
  handle('backup:now', () => wrap(async () => ({ backup: core.backups.now('manual') })));
  handle('backup:list', () => core.backups.list());
  handle('backup:reveal', () => shell.openPath(core.backups.dir()));
  handle('backup:export', () =>
    wrap(async () => {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `open-maestri-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Backup', extensions: ['json'] }],
      });
      if (r.canceled) return { canceled: true };
      return { file: core.backups.exportTo(r.filePath) };
    }),
  );
  const reloadAfterImport = () => {
    for (const e of ws().list())
      for (const n of ws().getDoc(e.id)?.payload.nodes || [])
        if (n.content.terminal && !core.terminals.get(n.id)) {
          /* started on open */
        }
    return { workspaces: ws().list(), activeId: ws().activeId, doc: ws().getDoc(ws().activeId) };
  };
  const doImport = (file) =>
    wrap(async () => {
      const res = core.backups.importFrom(file);
      for (const id of res.replaced) {
        const old = ws().docs.get(id);
        if (old) for (const n of old.payload.nodes) core.terminals.remove(n.id);
      }
      const active = ws().activeId;
      if (!ws().getDoc(active)) ws().open(ws().list()[0].id);
      core.startWorkspaceTerminals(ws().activeId);
      return { ...res, ...reloadAfterImport() };
    });
  handle('backup:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Backup', extensions: ['json'] }],
    });
    if (r.canceled) return { ok: true, canceled: true };
    return doImport(r.filePaths[0]);
  });
  handle('backup:restore', (file) => {
    if (path.dirname(path.resolve(file)) !== path.resolve(core.backups.dir()))
      return { ok: false, error: 'not a backup in the backups folder' };
    return doImport(file);
  });

  // ----------------------------------------------------------- shells / wsl
  handle('agent:listShells', async () => {
    const found = [];
    const add = (id, label, p) => found.push({ id, label, path: p });
    add('powershell', 'Windows PowerShell', 'powershell.exe');
    const where = (exe) =>
      new Promise((resolve) =>
        execFile('where.exe', [exe], { windowsHide: true }, (e, out) =>
          resolve(e ? null : String(out).split(/\r?\n/)[0].trim()),
        ),
      );
    if (await where('pwsh.exe')) add('pwsh', 'PowerShell 7', 'pwsh.exe');
    add('cmd', 'Prompt de Comando', 'cmd.exe');
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) =>
      fs.existsSync(p),
    );
    if (gitBash) add('gitbash', 'Git Bash', gitBash);
    return found;
  });
  handle(
    'agent:listWslDistros',
    () =>
      new Promise((resolve) => {
        execFile('wsl.exe', ['-l', '-q'], { windowsHide: true, encoding: 'buffer', timeout: 8000 }, (err, stdout) => {
          if (err) return resolve([]);
          const text = Buffer.from(stdout)
            .toString('utf16le')
            .replace(/\u0000/g, '');
          resolve(
            text
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
        });
      }),
  );

  // ------------------------------------------------------------- git (changes panel)
  const gitCall =
    (fn) =>
    async (root, ...rest) => {
      try {
        return { ok: true, value: await fn(expandHome(root), ...rest) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };
  const G = {
    status: gitOps.status,
    diff: gitOps.diff,
    stage: gitOps.stage,
    unstage: gitOps.unstage,
    discard: gitOps.discard,
    commit: gitOps.commit,
    log: gitOps.log,
    branches: gitOps.branches,
    checkout: gitOps.checkout,
    stashes: gitOps.stashes,
    stashPush: gitOps.stashPush,
    stashPop: gitOps.stashPop,
  };
  for (const [name, fn] of Object.entries(G)) handle(`git:${name}`, gitCall(fn));

  // ------------------------------------------------------------------ partituras
  const partituras = createPartituras({
    workspaces: ws(),
    prefs: () => core.ui.prefs(),
    savePrefs: (p) => core.ui.savePrefs(p),
  });
  handle('partitura:capture', (wsId, ids, meta) => {
    try {
      const p = partituras.capture(wsId, ids, meta);
      return { ok: true, partitura: p, commands: partituras.commandsOf(p) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  handle('partitura:save', (p, scope, commandEdits) => {
    try {
      for (const n of p.payload.nodes)
        if (n.content.terminal && commandEdits && typeof commandEdits[n.id] === 'string')
          n.content.terminal._0.command = commandEdits[n.id];
      return { ok: true, partitura: partituras.save(p, scope || null) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  handle('partitura:list', (wsId) => partituras.list(wsId));
  handle('partitura:place', (wsId, id, at, floorId) => {
    try {
      const p = partituras.load(id, wsId);
      if (!p) return { ok: false, error: 'partitura not found' };
      ws().checkpoint(wsId);
      const r = partituras.place(wsId, p, at, floorId || null);
      core.startWorkspaceTerminals(wsId);
      return { ok: true, doc: r.doc, nodeIds: r.nodeIds, rolesAdded: r.rolesAdded };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  handle('partitura:remove', (id, wsId) => partituras.remove(id, wsId));
  handle('partitura:export', async (id, wsId) => {
    const p = partituras.load(id, wsId);
    if (!p) return { ok: false, error: 'partitura not found' };
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${p.name}.partitura.json`,
      filters: [{ name: 'Partitura', extensions: ['json'] }],
    });
    if (r.canceled) return { ok: true, canceled: true };
    partituras.exportTo(id, wsId, r.filePath);
    return { ok: true, file: r.filePath };
  });
  handle('partitura:import', async (wsId, scope) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Partitura', extensions: ['json'] }],
    });
    if (r.canceled) return { ok: true, canceled: true };
    try {
      return { ok: true, partitura: partituras.importFrom(r.filePaths[0], scope ? wsId : null) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ------------------------------------------------------- prompter + saved prompts
  const prompter = createPrompter({ workspaces: ws(), terminals: core.terminals, routines: core.routines });
  const savedPrompts = createSavedPrompts({
    workspaceIds: () =>
      ws()
        .list()
        .map((w) => w.id),
  });
  const rootOfTerminal = (wsId, tid) => {
    const doc = ws().getDoc(wsId);
    const n = doc && ws().terminalNode(doc, tid);
    const dir = (n && n.content.terminal._0.workingDirectory) || (doc && doc.payload.workingDirectory);
    return expandHome(dir);
  };
  handle('prompter:targets', (wsId, tid) => prompter.mentionTargets(wsId, tid));
  handle('prompter:fileIndex', (wsId, tid) => prompter.fileIndex(rootOfTerminal(wsId, tid)));
  handle('prompter:deliver', (tid, text) => prompter.deliver(tid, text));
  const prs = require('./pull-requests').createPullRequests();
  const prCall =
    (fn) =>
    async (root, ...rest) => {
      try {
        return { ok: true, value: await fn(expandHome(root), ...rest) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };
  handle(
    'pr:list',
    prCall((r, s) => prs.list(r, s)),
  );
  handle(
    'pr:create',
    prCall((r, o) => prs.create(r, o)),
  );
  handle('docker:test', (cfg) => require('./docker').test(cfg || {}));
  // chat mode
  handle('chat:read', (wsId, tid) => core.chat.read(wsId, tid));
  handle('chat:send', async (wsId, tid, thread, text, files) => {
    try {
      return await core.chat.send(wsId, tid, thread, text, files || []);
    } catch (e) {
      return { ok: false, reason: 'error', error: e.message };
    }
  });
  handle('chat:markRead', (wsId, tid, thread) => core.chat.markRead(wsId, tid, thread));
  handle('chat:clear', (wsId, tid, thread) => core.chat.clear(wsId, tid, thread));
  handle('chat:search', (wsId, tid, q, thread) => core.chat.search(wsId, tid, q, thread));
  handle('chat:attachment', (wsId, tid, id) => {
    const p = core.chat.attachmentPath(wsId, tid, id);
    if (!p) return null;
    const ext = path.extname(p).toLowerCase().slice(1);
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    return { path: p, dataUrl: mime ? `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` : null };
  });
  handle('portalDesign:send', async (wsId, portalId, payload, opts) => {
    const doc = ws().getDoc(wsId);
    if (!doc) return { ok: false, error: 'workspace not found' };
    return require('./portal-design').send({
      doc,
      portalId,
      payload: payload || {},
      deliver: (tid, text) => prompter.deliver(tid, text),
      screenshotsDir: persistence.paths.screenshotsDir(),
      copyOnly: !!(opts && opts.copyOnly),
    });
  });
  handle('prompts:visible', (wsId) => savedPrompts.visible(wsId));
  handle('prompts:all', () => savedPrompts.all());
  handle('prompts:save', (p) => {
    try {
      return { ok: true, prompt: savedPrompts.save(p) };
    } catch (e) {
      return { ok: false, code: e.code || 'ioError', error: e.message };
    }
  });
  handle('prompts:delete', (id) => savedPrompts.remove(id));
  handle('prompts:undoDelete', () => savedPrompts.undoDelete());
  handle('prompts:availableName', (name, wsId, excluding) => savedPrompts.availableName(name, wsId, excluding));

  // prefs
  handle('prefs:get', () => core.ui.prefs());
  handle('prefs:set', (p) => {
    core.ui.savePrefs(p);
    require('./core').installSkills(p);
    return true;
  });

  // portals
  on('portal:register', (nodeId, wcId) => core.portals.register(nodeId, wcId));
  on('portal:unregister', (nodeId) => core.portals.unregister(nodeId));
  on('portal:state', (nodeId, st) => core.portals.setState(nodeId, st));
}

// ------------------------------------------------------------------ window
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'open-maestri',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#1b1c1f',
    autoHideMenuBar: true,
    show: !SELFTEST,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never let the app shell navigate away or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Harden <webview> guests: no preload, no node, isolated.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^(https?:|about:blank|file:)/i.test(params.src || 'about:blank')) e.preventDefault();
  });
  win.webContents.on('did-attach-webview', (e, guest) => {
    // links that want a new window navigate the portal instead
    guest.setWindowOpenHandler(({ url }) => {
      if (safeExternal(url)) guest.loadURL(url);
      return { action: 'deny' };
    });
  });
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // Deny every permission request from portals (camera, mic, geolocation, notifications...).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));

  core = await createCore({
    getWebContents: (id) => webContents.fromId(id),
    nodeBinary: process.execPath,
    cliDir: app.isPackaged ? path.join(process.resourcesPath, 'cli') : path.join(__dirname, '..', 'cli'),
  });
  registerIpc();

  core.events.on('docChanged', (id) => {
    const doc = core.workspaces.getDoc(id);
    // terminals created by CLI (recruit) must be running
    core.startWorkspaceTerminals(id);
    send('doc:changed', id, doc);
  });
  core.events.on('noteChanged', (nodeId) => send('note:changed', nodeId));
  core.events.on('chatMessage', (wsId, tid, thread, msg, summary) =>
    send('chat:message', wsId, tid, thread, msg, summary),
  );
  core.events.on('connectionStatus', (wsId, connId, status) => send('conn:status', wsId, connId, status));
  core.events.on('termData', (id, data) => send('term:data', id, data));
  core.events.on('termStatus', (id, status) => send('term:status', id, status));
  core.events.on('termExit', (id, code) => send('term:exit', id, code));
  core.events.on('prefs', (p) => send('prefs', p));
  core.events.on('routinesChanged', () => send('routines:changed'));
  core.events.on('notify', (n) => {
    if (Notification.isSupported()) new Notification({ title: n.title, body: n.body }).show();
    send('toast', `${n.title}: ${n.body}`);
  });

  // Attention: agent finished a long task while the window is in the background.
  const busySince = new Map();
  core.events.on('termStatus', (id, status) => {
    if (status === 'running') busySince.set(id, Date.now());
    else {
      const t = busySince.get(id);
      busySince.delete(id);
      const s = core.terminals.get(id);
      if (
        t &&
        Date.now() - t > 5000 &&
        s &&
        s.agentType !== 'generic_shell' &&
        win &&
        !win.isFocused() &&
        Notification.isSupported()
      ) {
        new Notification({ title: `${s.name} terminou`, body: 'O agente está esperando por você.' })
          .on('click', () => win && win.show())
          .show();
      }
    }
  });

  createWindow();
  core.startWorkspaceTerminals(core.workspaces.activeId);
  if (SELFTEST) require('./selftest').run({ win, core, app });
});

app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !core) return;
  quitting = true;
  e.preventDefault();
  core.shutdown().finally(() => app.exit(0));
});
