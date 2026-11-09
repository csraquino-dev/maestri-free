'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const send = (ch, ...a) => ipcRenderer.send(ch, ...a);
const sub = (ch, cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('maestri', {
  init: () => invoke('app:init'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openWorkspace: (id) => invoke('ws:open', id),
  listWorkspaces: () => invoke('ws:list'),
  duplicateWorkspace: (id) => invoke('ws:duplicate', id),
  exportWorkspace: (id) => invoke('ws:export', id),
  importWorkspace: (file) => invoke('ws:import', file),
  sidebarGet: () => invoke('sidebar:get'),
  sidebarSet: (l) => invoke('sidebar:set', l),
  workspaceStats: () => invoke('ws:stats'),
  createWorkspace: (o) => invoke('ws:create', o),
  updateWorkspace: (id, f) => invoke('ws:update', id, f),
  removeWorkspace: (id) => invoke('ws:remove', id),

  addNode: (ws, kind, opts) => invoke('node:add', ws, kind, opts),
  removeNodes: (ws, ids) => invoke('node:remove', ws, ids),
  connect: (ws, a, b) => invoke('conn:add', ws, a, b),
  stackOp: (ws, op, args) => invoke('stack:op', ws, op, args),
  git: (op, ...args) => invoke(`git:${op}`, ...args),
  partituraCapture: (ws, ids, meta) => invoke('partitura:capture', ws, ids, meta),
  partituraSave: (p, scope, edits) => invoke('partitura:save', p, scope, edits),
  partituraList: (ws) => invoke('partitura:list', ws),
  partituraPlace: (ws, id, at, floorId) => invoke('partitura:place', ws, id, at, floorId),
  partituraRemove: (id, ws) => invoke('partitura:remove', id, ws),
  partituraExport: (id, ws) => invoke('partitura:export', id, ws),
  partituraImport: (ws, scope) => invoke('partitura:import', ws, scope),
  bandOp: (ws, op, args) => invoke('band:op', ws, op, args),
  tieCreate: (ws, tie, floorId) => invoke('tie:create', ws, tie, floorId),
  tieMove: (ws, id, position) => invoke('tie:move', ws, id, position),
  tieDelete: (ws, id) => invoke('tie:delete', ws, id),
  removeConnection: (ws, list, id) => invoke('conn:remove', ws, list, id),
  patchNodes: (ws, patches, view) => send('node:patch', ws, patches, view),
  saveRopes: (ws, shapes) => send('rope:save', ws, shapes),

  termAttach: (ws, id) => invoke('term:attach', ws, id),
  termWrite: (id, data) => send('term:write', id, data),
  termResize: (id, c, r) => send('term:resize', id, c, r),
  termRestart: (ws, id) => invoke('term:restart', ws, id),

  noteRead: (ws, id) => invoke('note:read', ws, id),
  noteWrite: (ws, id, t) => invoke('note:write', ws, id, t),
  notePasteImage: (ws, id, bytes, ext) => invoke('note:pasteImage', ws, id, bytes, ext),
  noteImport: (ws, p) => invoke('note:import', ws, p),

  listDir: (d) => invoke('fs:list', d),
  gitStatus: (r) => invoke('fs:gitStatus', r),
  gitDiff: (r, f) => invoke('fs:gitDiff', r, f),
  pickDir: () => invoke('dialog:dir'),
  pickFile: (f) => invoke('dialog:file', f),
  openPath: (p) => invoke('shell:open', p),
  revealPath: (p) => invoke('shell:reveal', p),
  openExternal: (u) => invoke('shell:external', u),
  openInIDE: (ws) => invoke('ide:open', ws),

  historyCheckpoint: (id) => invoke('history:checkpoint', id),
  historyState: (id) => invoke('history:state', id),
  undo: (id) => invoke('history:undo', id),
  redo: (id) => invoke('history:redo', id),

  floorInfo: (id) => invoke('floor:info', id),
  floorCreate: (id, o) => invoke('floor:create', id, o),
  floorRemove: (id, ref, o) => invoke('floor:remove', id, ref, o),
  floorUpdate: (id, fid, f) => invoke('floor:update', id, fid, f),
  floorStatus: (id, ref) => invoke('floor:status', id, ref),
  floorLandPreview: (id, ref) => invoke('floor:landPreview', id, ref),
  floorLand: (id, ref, o) => invoke('floor:land', id, ref, o),
  floorRunHooks: (id, ref, phase) => invoke('floor:runHooks', id, ref, phase),

  routineList: (id) => invoke('routine:list', id),
  routineCreate: (o) => invoke('routine:create', o),
  routineUpdate: (id, f) => invoke('routine:update', id, f),
  routineRemove: (id) => invoke('routine:remove', id),
  routineSetEnabled: (id, on) => invoke('routine:setEnabled', id, on),
  routineRunNow: (id) => invoke('routine:runNow', id),
  routineClearHistory: () => invoke('routine:clearHistory'),

  backupNow: () => invoke('backup:now'),
  backupList: () => invoke('backup:list'),
  backupReveal: () => invoke('backup:reveal'),
  backupExport: () => invoke('backup:export'),
  backupImport: () => invoke('backup:import'),
  backupRestore: (f) => invoke('backup:restore', f),

  listShells: () => invoke('agent:listShells'),
  listWslDistros: () => invoke('agent:listWslDistros'),

  prompterTargets: (ws, id) => invoke('prompter:targets', ws, id),
  prompterFileIndex: (ws, id) => invoke('prompter:fileIndex', ws, id),
  prompterDeliver: (id, text) => invoke('prompter:deliver', id, text),
  promptsVisible: (ws) => invoke('prompts:visible', ws),
  promptsAll: () => invoke('prompts:all'),
  promptsSave: (p) => invoke('prompts:save', p),
  promptsDelete: (id) => invoke('prompts:delete', id),
  promptsUndoDelete: () => invoke('prompts:undoDelete'),
  promptsAvailableName: (n, ws, ex) => invoke('prompts:availableName', n, ws, ex),

  getPrefs: () => invoke('prefs:get'),
  setPrefs: (p) => invoke('prefs:set', p),

  prList: (root, state) => invoke('pr:list', root, state),
  prCreate: (root, o) => invoke('pr:create', root, o),
  dockerTest: (cfg) => invoke('docker:test', cfg),
  chatRead: (ws, tid) => invoke('chat:read', ws, tid),
  chatSend: (ws, tid, thread, text, files) => invoke('chat:send', ws, tid, thread, text, files),
  chatMarkRead: (ws, tid, thread) => invoke('chat:markRead', ws, tid, thread),
  chatClear: (ws, tid, thread) => invoke('chat:clear', ws, tid, thread),
  chatSearch: (ws, tid, q, thread) => invoke('chat:search', ws, tid, q, thread),
  chatAttachment: (ws, tid, id) => invoke('chat:attachment', ws, tid, id),
  portalDesignSend: (ws, portalId, payload, opts) => invoke('portalDesign:send', ws, portalId, payload, opts),
  portalRegister: (id, wc) => send('portal:register', id, wc),
  portalUnregister: (id) => send('portal:unregister', id),
  portalState: (id, st) => send('portal:state', id, st),

  on: {
    docChanged: (cb) => sub('doc:changed', cb),
    noteChanged: (cb) => sub('note:changed', cb),
    connStatus: (cb) => sub('conn:status', cb),
    chatMessage: (cb) => sub('chat:message', cb),
    termData: (cb) => sub('term:data', cb),
    termStatus: (cb) => sub('term:status', cb),
    termExit: (cb) => sub('term:exit', cb),
    prefs: (cb) => sub('prefs', cb),
    routinesChanged: (cb) => sub('routines:changed', cb),
    toast: (cb) => sub('toast', cb),
  },
});
