'use strict';
// Persistence layer: same on-disk layout as open-maestri (macOS) so data stays
// compatible:  ~/.open-maestri/{manifest,preferences,app-state}.json + workspaces/{uuid}/...
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const CANVAS_INITIAL_ORIGIN = { x: 9800, y: 8500 };

const root = process.env.OPEN_MAESTRI_HOME || path.join(os.homedir(), '.open-maestri');

const uuid = () => crypto.randomUUID().toUpperCase();
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Crash-safe write: write .tmp then atomically replace (equivalent of replaceItem).
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse rename over an open file; fall back to copy+unlink.
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

// Swift's .sortedKeys + .prettyPrinted
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
const stringify = (obj) => JSON.stringify(sortKeys(obj), null, 2);

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const writeJSON = (file, obj) => writeFileAtomic(file, stringify(obj));

const p = {
  root,
  manifest: () => path.join(root, 'manifest.json'),
  prefs: () => path.join(root, 'preferences.json'),
  appState: () => path.join(root, 'app-state.json'),
  runDir: () => path.join(root, 'run'),
  workspaceDir: (id) => path.join(root, 'workspaces', id),
  workspaceFile: (id) => path.join(root, 'workspaces', id, 'workspace.json'),
  notesDir: (id) => path.join(root, 'workspaces', id, 'notes'),
  terminalsDir: (id) => path.join(root, 'workspaces', id, 'terminals'),
  screenshotsDir: () => path.join(root, 'screenshots'),
};

// ---------------------------------------------------------------- defaults

const DEFAULT_PRESETS = () => [
  {
    id: uuid(),
    name: 'Claude Code',
    command: 'claude',
    icon: 'seal',
    agentType: 'claude_code',
    color: '#007AFF',
    isActive: true,
    isBuiltIn: true,
  },
  {
    id: uuid(),
    name: 'Codex',
    command: 'codex',
    icon: 'brain',
    agentType: 'codex',
    color: '#5856D6',
    isActive: true,
    isBuiltIn: true,
  },
  {
    id: uuid(),
    name: 'Gemini CLI',
    command: 'gemini',
    icon: 'sparkle',
    agentType: 'gemini_cli',
    color: '#34C759',
    isActive: true,
    isBuiltIn: true,
  },
  {
    id: uuid(),
    name: 'OpenCode',
    command: 'opencode',
    icon: 'rectangle.portrait',
    agentType: 'open_code',
    color: '#FF9500',
    isActive: true,
    isBuiltIn: true,
  },
  {
    id: uuid(),
    name: 'Shell',
    command: '',
    icon: 'terminal',
    agentType: 'generic_shell',
    color: '#8E8E93',
    isActive: true,
    isBuiltIn: true,
  },
];

const DEFAULT_SKILL_PATHS = () => [
  { id: uuid(), name: 'Claude Code', path: '~/.claude/skills', icon: 'gearshape', isActive: true, isBuiltIn: true },
  { id: uuid(), name: 'Agent Skills', path: '~/.agents/skills', icon: 'doc.text', isActive: true, isBuiltIn: true },
  { id: uuid(), name: 'Hermes', path: '~/.hermes/skills', icon: 'paperplane', isActive: true, isBuiltIn: true },
  {
    id: uuid(),
    name: 'Antigravity',
    path: '~/.gemini/antigravity-cli/skills',
    icon: 'sparkle',
    isActive: true,
    isBuiltIn: true,
  },
];

const DEFAULT_PREFS = () => ({
  schemaVersion: 1,
  agentPresets: DEFAULT_PRESETS(),
  rolePresets: [],
  skillPaths: DEFAULT_SKILL_PATHS(),
  terminalFontFamily: 'Cascadia Mono, Consolas, monospace',
  terminalFontSize: 13,
  terminalTheme: 'dark',
  canvasBackground: 'dotGrid',
  defaultNoteColor: '#FEFDE8',
  preferredIDE: 'cursor',
  language: 'pt-BR',
  shortcuts: { customKeys: {} },
  sshEnabled: false,
  sshTunnelPort: 7433,
  sshHost: '',
  sshUser: '',
  sshPort: 22,
  sshScriptPath: '~/.local/bin/omaestri',
  sshAddToPath: true,
  metalRendererEnabled: false,
  scrollbackMemoryLimit: false,
  optionAsMeta: false,
  autosaveIntervalSeconds: 30,
  defaultShell: 'powershell.exe',
  ropeRouting: 'avoidNodes', // avoidNodes | behindNodes | circuit
});

// ------------------------------------------------------------------- api

function init() {
  ensureDir(root);
  ensureDir(p.runDir());
  ensureDir(path.join(root, 'workspaces'));
}

function loadPrefs() {
  const stored = readJSON(p.prefs(), {});
  return { ...DEFAULT_PREFS(), ...stored };
}
const savePrefs = (prefs) => writeJSON(p.prefs(), prefs);

function loadAppState() {
  return {
    schemaVersion: 1,
    type: 'appState',
    activeWorkspaceId: null,
    hasCompletedOnboarding: false,
    hasSeenFloorOnboarding: false,
    cleanShutdown: true,
    lastOpenedAt: null,
    recentWorkspaceIds: [],
    ...readJSON(p.appState(), {}),
  };
}
const saveAppState = (s) => writeJSON(p.appState(), s);

function loadManifest() {
  return {
    schemaVersion: 1,
    type: 'appState',
    app: 'open-maestri',
    appVersion: '1.0.0',
    dataFormat: 2,
    workspaces: [],
    files: {},
    ...readJSON(p.manifest(), {}),
  };
}
const saveManifest = (m) => writeJSON(p.manifest(), m);

function newPayload({ id = uuid(), name, workingDirectory }) {
  const t = now();
  return {
    id,
    name,
    icon: 'folder',
    isPinned: false,
    locationType: 'local',
    workingDirectory,
    preferredIDE: 'cursor',
    syncConfigFiles: false,
    canvasOrigin: [CANVAS_INITIAL_ORIGIN.x, CANVAS_INITIAL_ORIGIN.y],
    canvasZoom: 1,
    nodes: [],
    connections: [],
    noteConnections: [],
    portalConnections: [],
    portalToPortalConnections: [],
    noteToNoteConnections: [],
    crossFloorConnections: [],
    cableTies: [],
    floors: [],
    drawings: [],
    createdAt: t,
    lastOpenedAt: null,
    lastModifiedAt: t,
  };
}

function loadWorkspace(id) {
  const doc = readJSON(p.workspaceFile(id), null);
  if (!doc || !doc.payload) return null;
  const pl = doc.payload;
  for (const k of [
    'nodes',
    'connections',
    'noteConnections',
    'portalConnections',
    'portalToPortalConnections',
    'noteToNoteConnections',
    'crossFloorConnections',
    'cableTies',
    'floors',
    'drawings',
  ]) {
    if (!Array.isArray(pl[k])) pl[k] = [];
  }
  // canvasOrigin may be stored as {x,y} (CGPoint JSON) or [x,y]; normalise to [x,y] arrays
  if (pl.canvasOrigin && !Array.isArray(pl.canvasOrigin)) pl.canvasOrigin = [pl.canvasOrigin.x, pl.canvasOrigin.y];
  if (!pl.canvasOrigin) pl.canvasOrigin = [CANVAS_INITIAL_ORIGIN.x, CANVAS_INITIAL_ORIGIN.y];
  if (!pl.canvasZoom) pl.canvasZoom = 1;
  return doc;
}

function saveWorkspace(doc) {
  doc.payload.lastModifiedAt = now();
  writeJSON(p.workspaceFile(doc.payload.id), doc);
}

function newDocument(payload) {
  return { payload, schemaVersion: SCHEMA_VERSION, type: 'workspace' };
}

function deleteWorkspaceFiles(id) {
  fs.rmSync(p.workspaceDir(id), { recursive: true, force: true });
}

module.exports = {
  paths: p,
  uuid,
  now,
  init,
  ensureDir,
  writeFileAtomic,
  loadPrefs,
  savePrefs,
  loadAppState,
  saveAppState,
  loadManifest,
  saveManifest,
  newPayload,
  newDocument,
  loadWorkspace,
  saveWorkspace,
  deleteWorkspaceFiles,
  readJSON,
  writeJSON,
  CANVAS_INITIAL_ORIGIN,
};
