'use strict';
// Terminal sessions: ConPTY (node-pty) + headless xterm buffer so agents can read
// the real screen text (`omaestri check`, `omaestri ask`) and idle detection.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const persistence = require('./persistence');

let pty;
let HeadlessTerminal;
function lazyDeps() {
  if (!pty) pty = require('node-pty');
  if (!HeadlessTerminal) HeadlessTerminal = require('@xterm/headless').Terminal;
}

const IDLE_MS = 2000;
const RING_MAX = 256 * 1024;

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.id = opts.id;
    this.workspaceId = opts.workspaceId;
    this.name = opts.name;
    this.agentType = opts.agentType || 'generic_shell';
    this.command = opts.command || '';
    this.workingDirectory = opts.workingDirectory;
    this.roleName = opts.roleName || null;
    this.status = 'idle';
    this.lastOutputAt = 0;
    this.activeTask = false;
    this.ring = '';
    this.alive = false;
    this.exitCode = null;
    this.cols = 100;
    this.rows = 30;
    this._idleTimer = null;
    this.exited = false; // the child process is gone (onExit fired)
    this._killRequested = false;
    this.disposed = false;
    this._exitWaiters = [];
  }

  get isIdle() {
    return this.status === 'idle';
  }

  start(env, shellPath, shellArgs, initialReplay) {
    lazyDeps();
    this.headless = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    if (initialReplay) {
      this.ring = initialReplay;
      this.headless.write(initialReplay);
    }
    const cwd = fs.existsSync(this.workingDirectory || '') ? this.workingDirectory : os.homedir();
    this.pty = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
      useConpty: true,
    });
    this.alive = true;
    this.pty.onData((data) => this._onData(data));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.alive = false;
      this.exitCode = exitCode;
      clearTimeout(this._idleTimer);
      this._setStatus('idle');
      this.emit('exit', exitCode);
      for (const w of this._exitWaiters.splice(0)) w();
    });
  }

  _onData(data) {
    if (this.disposed) return;
    this.lastOutputAt = Date.now();
    this.ring += data;
    if (this.ring.length > RING_MAX) {
      let cut = this.ring.slice(this.ring.length - RING_MAX);
      const nl = cut.indexOf('\n');
      this.ring = nl >= 0 ? cut.slice(nl + 1) : cut;
    }
    this.headless.write(data);
    this._setStatus('running');
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this.activeTask = false;
      this._setStatus('idle');
      this.emit('idle');
    }, IDLE_MS);
    this.emit('data', data);
  }

  _setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.emit('status', status);
    }
  }

  write(text) {
    if (this.alive) this.pty.write(text);
  }

  resize(cols, rows) {
    if (!cols || !rows || cols < 2 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    try {
      if (this.alive) this.pty.resize(cols, rows);
      this.headless.resize(cols, rows);
    } catch {
      /* resize races with exit */
    }
  }

  markActiveTask() {
    this.activeTask = true;
  }

  // Plain screen text (scrollback + viewport), trailing blank lines trimmed.
  screenText() {
    if (!this.headless) return '';
    const buf = this.headless.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      // wrapped lines are joined to the previous one
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  recentOutput(n = 20) {
    const lines = this.screenText().split('\n');
    return lines.slice(-n).join('\n');
  }

  // Resolves when the child process has really exited (or after `ms`, so shutdown can never hang).
  whenExited(ms = 2000) {
    if (this.exited || !this.pty) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this._exitWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // Idempotent. node-pty's ConPTY addon asserts (and kills the process with a dialog) when a pty that has already
  // exited is killed, so: kill at most once, never after onExit, and only while the child still exists.
  dispose() {
    clearTimeout(this._idleTimer);
    if (this.pty && !this.exited && !this._killRequested) {
      this._killRequested = true;
      let childAlive = false;
      try {
        process.kill(this.pty.pid, 0);
        childAlive = true;
      } catch {
        /* the child already ended */
      }
      if (childAlive) {
        try {
          this.pty.kill();
        } catch {
          /* already gone */
        }
      }
    }
    this.alive = false;
    this.disposed = true;
    // the headless buffer is released only once the pty can no longer deliver data
    const releaseBuffer = () => {
      try {
        this.headless && this.headless.dispose();
      } catch {
        /* ignore */
      }
      this.headless = null;
    };
    if (this.exited || !this.pty) releaseBuffer();
    else this.whenExited(2500).then(releaseBuffer);
  }
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // nodeId -> Session
    this.serverPort = 0;
    this.cliDir = '';
    this.nodeBinary = process.execPath;
  }

  configure({ serverPort, cliDir, nodeBinary }) {
    this.serverPort = serverPort;
    this.cliDir = cliDir;
    if (nodeBinary) this.nodeBinary = nodeBinary;
  }

  get(id) {
    return this.sessions.get(id);
  }

  buildEnv(session, extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.MAESTRI_TERMINAL_ID = session.id;
    env.OMAESTRI_TERMINAL_ID = session.id;
    env.MAESTRI_SERVER_PORT = String(this.serverPort);
    env.MAESTRI_SOCKET = `tcp://127.0.0.1:${this.serverPort}`;
    env.MAESTRI_NODE = this.nodeBinary;
    env.MAESTRI_CLI = path.join(this.cliDir, 'omaestri.cmd');
    if (session.name) env.OMAESTRI_AGENT_NAME = session.name;
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
    env[key] = `${this.cliDir}${path.delimiter}${env[key] || ''}`;
    return env;
  }

  // Start (or return the running) session for a terminal node.
  ensure(node, workspaceId, prefs, opts = {}) {
    const tc = node.content.terminal._0;
    const id = node.id;
    if (this.sessions.has(id)) return this.sessions.get(id);

    const session = new Session({
      id,
      workspaceId,
      name: tc.name,
      agentType: tc.agentType,
      command: tc.command,
      workingDirectory: expandHome(tc.workingDirectory) || os.homedir(),
      roleName: opts.roleName,
    });
    this.sessions.set(id, session);

    const shell = resolveShell(tc, prefs.defaultShell, this.serverPort);
    let replay = '';
    if (tc.scrollbackFile) {
      try {
        const f = path.join(persistence.paths.terminalsDir(workspaceId), tc.scrollbackFile);
        replay = fs.readFileSync(f, 'utf8');
        if (replay) replay += '\r\n\x1b[2m── restored scrollback ──\x1b[0m\r\n';
      } catch {
        /* no scrollback yet */
      }
    }
    session.start(this.buildEnv(session, opts.env), shell.path, shell.args, replay);

    // Launch the agent command inside the shell (after the prompt is up).
    const cmd = tc.command && tc.command.trim();
    if (cmd && !opts.skipCommand) {
      setTimeout(() => session.write(cmd + '\r'), 700);
    }
    session.on('status', (s) => this.emit('status', id, s));
    session.on('data', (d) => this.emit('data', id, d));
    session.on('exit', (c) => this.emit('exit', id, c));
    session.on('idle', () => this.emit('idle', id));
    return session;
  }

  write(id, text) {
    const s = this.sessions.get(id);
    if (s) s.write(text);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.dispose();
    s.removeAllListeners();
    this.sessions.delete(id);
  }

  // Write the raw ring buffer of every session of a workspace to terminals/<id>.scrollback.
  persistScrollback(workspaceId, doc) {
    const dir = persistence.paths.terminalsDir(workspaceId);
    for (const node of doc.payload.nodes) {
      const tc = node.content && node.content.terminal && node.content.terminal._0;
      if (!tc) continue;
      const s = this.sessions.get(node.id);
      if (!s || !s.ring) continue;
      try {
        persistence.ensureDir(dir);
        const file = `${node.id}.scrollback`;
        persistence.writeFileAtomic(path.join(dir, file), s.ring);
        tc.scrollbackFile = file;
        tc.scrollbackLineCount = s.ring.split('\n').length;
      } catch {
        /* disk full etc. — non-fatal */
      }
    }
  }

  // Stops every shell and waits (bounded) for the children to really exit, so the app never quits with live ptys.
  async disposeAll() {
    const all = [...this.sessions.values()];
    for (const id of [...this.sessions.keys()]) this.remove(id);
    await Promise.all(all.map((s) => s.whenExited(2000)));
  }
}

// Local shell, WSL distro or SSH host (with a reverse tunnel so remote agents can reach the CLI server).
function resolveShell(tc, defaultShell, serverPort) {
  const remote = tc.remote;
  if (remote && remote.kind === 'wsl') {
    const args = remote.distro ? ['-d', remote.distro] : [];
    if (tc.workingDirectory && fs.existsSync(tc.workingDirectory)) args.push('--cd', tc.workingDirectory);
    return { path: 'wsl.exe', args };
  }
  if (remote && remote.kind === 'docker') {
    return {
      path: 'docker.exe',
      args: require('./docker').runArgs(remote, {
        terminalId: tc.id,
        cwd: tc.workingDirectory && fs.existsSync(tc.workingDirectory) ? tc.workingDirectory : '',
      }),
    };
  }
  if (remote && remote.kind === 'ssh') {
    const args = ['-t'];
    if (serverPort) args.push('-R', `${serverPort}:127.0.0.1:${serverPort}`);
    if (remote.port && Number(remote.port) !== 22) args.push('-p', String(remote.port));
    args.push(remote.user ? `${remote.user}@${remote.host}` : remote.host);
    return { path: 'ssh.exe', args };
  }
  const shellPath = tc.shellPath;
  let sh = shellPath && !shellPath.startsWith('/') ? shellPath : defaultShell || 'powershell.exe';
  const base = path.basename(sh).toLowerCase();
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'powershell' || base === 'pwsh') {
    return { path: sh, args: ['-NoLogo'] };
  }
  return { path: sh, args: Array.isArray(tc.shellArgs) ? tc.shellArgs : [] };
}

module.exports = { TerminalManager, Session, expandHome, resolveShell };
