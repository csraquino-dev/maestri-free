'use strict';
// Electron-free composition root, so the whole backend can be exercised from plain Node tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const persistence = require('./persistence');
const { Workspaces } = require('./workspaces');
const { TerminalManager, expandHome } = require('./terminals');
const { createPortals } = require('./portals');
const { createHandlers } = require('./handlers');
const { startServer } = require('./server');
const { Routines } = require('./routines');
const { createFloors } = require('./floors');
const { createBackups } = require('./backups');
const { createStacks } = require('./stacks');
const { createBands } = require('./bands');
const { createChat } = require('./chat');
const { createPrompter } = require('./prompter');

const ROOT = path.join(__dirname, '..');

// Idempotent: writes bundled skills into every active skill directory, never overwriting.
function installSkills(prefs, log = () => {}) {
  const src = path.join(ROOT, 'assets', 'skills');
  if (!fs.existsSync(src)) return;
  for (const sp of prefs.skillPaths.filter((s) => s.isActive)) {
    const dest = expandHome(sp.path);
    for (const name of fs.readdirSync(src)) {
      const target = path.join(dest, name, 'SKILL.md');
      if (fs.existsSync(target)) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(src, name, 'SKILL.md'), target);
        log(`skill ${name} -> ${dest}`);
      } catch (err) {
        log(`skill install failed (${dest}): ${err.message}`);
      }
    }
  }
}

async function createCore({
  getWebContents = () => null,
  nodeBinary = process.execPath,
  cliDir = path.join(ROOT, 'cli'),
} = {}) {
  const events = new EventEmitter();
  const workspaces = new Workspaces();
  const terminals = new TerminalManager();
  let prefs = persistence.loadPrefs();
  let port = 0;

  const ui = {
    prefs: () => prefs,
    savePrefs: (p) => {
      prefs = p;
      persistence.savePrefs(p);
      events.emit('prefs', p);
    },
    port: () => port,
    connectionStatus: (wsId, connId, status) => events.emit('connectionStatus', wsId, connId, status),
    noteChanged: (nodeId) => events.emit('noteChanged', nodeId),
  };

  workspaces.load();
  workspaces.on('changed', (id) => events.emit('docChanged', id));

  const portals = createPortals({ workspaces, getWebContents, ui });
  const routines = new Routines({ workspaces, terminals, prefs: () => prefs });
  const floors = createFloors({ workspaces, terminals });
  const stacks = createStacks(workspaces);
  const bands = createBands(workspaces);
  const prompterForChat = createPrompter({ workspaces, terminals, routines });
  const chat = createChat({
    dirOf: (wsId) => persistence.paths.workspaceDir(wsId),
    deliver: (tid, text) => prompterForChat.deliver(tid, text),
    events,
  });
  const handlers = createHandlers({ workspaces, terminals, portals, ui, routines, floors, chat });
  const { server, port: p } = await startServer(handlers.route);
  port = p;
  terminals.configure({ serverPort: port, cliDir, nodeBinary });

  terminals.on('status', (id, status) => events.emit('termStatus', id, status));
  terminals.on('data', (id, data) => events.emit('termData', id, data));
  terminals.on('exit', (id, code) => events.emit('termExit', id, code));
  terminals.on('idle', (id) => events.emit('termIdle', id));

  installSkills(prefs, (m) => console.log('[skills]', m));

  routines.on('changed', () => events.emit('routinesChanged'));
  routines.on('notify', (n) => events.emit('notify', n));
  routines.start();

  // Start every terminal of a workspace (lazy on first open).
  function startWorkspaceTerminals(wsId) {
    const doc = workspaces.getDoc(wsId);
    if (!doc) return;
    for (const node of doc.payload.nodes) {
      if (node.content.terminal) {
        try {
          terminals.ensure(node, wsId, prefs, { skipCommand: false });
        } catch (err) {
          console.error('terminal start failed', node.id, err.message);
        }
      }
    }
  }

  function save() {
    workspaces.saveDirty((id, doc) => terminals.persistScrollback(id, doc));
  }

  const timer = setInterval(save, Math.max(5, prefs.autosaveIntervalSeconds || 30) * 1000);
  timer.unref();

  const backups = createBackups({ workspaces, routines, prefs: () => prefs, save });
  const backupTimer = process.env.OPEN_MAESTRI_NO_AUTOBACKUP ? null : backups.autoStart();

  async function shutdown() {
    clearInterval(timer);
    backupTimer && clearInterval(backupTimer);
    routines.stop();
    save();
    workspaces.shutdownClean();
    await terminals.disposeAll();
    await new Promise((r) => server.close(() => r()));
  }

  return {
    events,
    workspaces,
    terminals,
    portals,
    handlers,
    routines,
    floors,
    backups,
    stacks,
    bands,
    chat,
    ui,
    port: () => port,
    save,
    shutdown,
    startWorkspaceTerminals,
    home: os.homedir(),
  };
}

module.exports = { createCore, installSkills };
