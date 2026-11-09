'use strict';
// Routines, Floors (real git worktrees), Backups and Undo/Redo — against real shells and a real git repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-feat-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-repo-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }).trim();
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@t.t');
git(repo, 'config', 'user.name', 'T');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'init');

const { createCore } = require('../main/core');
const R = require('../main/routines');
let core, A, B;
const cli = path.join(__dirname, '..', 'cli', 'omaestri.js');
const sh = (tid, ...args) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: tid }, timeout: 90000 },
      (e, o, er) => resolve({ out: o.trim(), err: er.trim() }),
    ),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  core = await createCore();
  const ws = core.workspaces;
  ws.update(ws.activeId, { workingDirectory: repo });
  const doc = ws.activeDoc;
  A = ws.addTerminal(doc, { name: 'Boss', workingDirectory: repo, isManager: true });
  B = ws.addTerminal(doc, { name: 'Builder', workingDirectory: repo }, A.id);
  ws.connect(doc, A.id, B.id);
  core.startWorkspaceTerminals(ws.activeId);
  await sleep(3500);
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* git objects are read-only on Windows; temp dir is cleaned by the OS */
  }
});

// ------------------------------------------------------------------ routines
test('schedule parsing', () => {
  assert.equal(R.parseDuration('45s'), 45);
  assert.equal(R.parseDuration('1h30m'), 5400);
  assert.equal(R.parseDuration('5'), 300); // bare number = minutes
  assert.equal(R.parseDuration('abc'), null);
  assert.deepEqual(R.parseTime('09:05'), { hour: 9, minute: 5 });
  assert.equal(R.parseTime('25:00'), null);
  assert.deepEqual(R.parseWeekly('mon,wed,fri@09:00'), { weekdays: [1, 3, 5], hour: 9, minute: 0 });
  assert.equal(R.parseWeekly('foo@09:00'), null);
});

test('nextRun: daily, weekly, interval, once', () => {
  const from = new Date(2026, 5, 10, 10, 0, 0).getTime(); // Wed 10:00
  const at = (ms) => new Date(ms);
  const d = at(R.nextRun({ schedule: { kind: 'daily', hour: 9, minute: 0 } }, from));
  assert.equal(d.getDate(), 11);
  assert.equal(d.getHours(), 9);
  const d2 = at(R.nextRun({ schedule: { kind: 'daily', hour: 11, minute: 0 } }, from));
  assert.equal(d2.getDate(), 10);
  const w = at(R.nextRun({ schedule: { kind: 'weekly', weekdays: [1], hour: 8, minute: 0 } }, from)); // Monday
  assert.equal(w.getDay(), 1);
  assert.ok(
    R.nextRun({ schedule: { kind: 'interval', seconds: 60 }, createdAt: new Date(from).toISOString() }, from) >=
      from + 1000,
  );
  assert.equal(R.nextRun({ schedule: { kind: 'once', at: new Date(from - 1000).toISOString() } }, from), null);
});

test('routine CLI: create, run into a terminal, list, disable, delete', async () => {
  const c = await sh(
    A.id,
    'routine',
    'create',
    'Ping',
    '--command',
    'Write-Output "routine-ran-ok"',
    '--every',
    '1h',
    '--terminal',
    'Builder',
  );
  assert.match(c.out, /Created routine "Ping": every 1h/);
  assert.match((await sh(A.id, 'routine', 'list')).out, /Ping \| every 1h \| terminal/);
  await sleep(2500); // terminal must be idle
  const run = await sh(A.id, 'routine', 'run', 'Ping');
  assert.match(run.out, /Ran "Ping": sentToTerminal/);
  await sleep(2500);
  assert.match(core.terminals.get(B.id).screenText(), /routine-ran-ok/);
  assert.match((await sh(A.id, 'routine', 'show', 'Ping')).out, /runs: 1/);
  assert.match((await sh(A.id, 'routine', 'disable', 'Ping')).out, /Disabled/);
  assert.match((await sh(A.id, 'routine', 'delete', 'Ping')).out, /Deleted/);
  assert.match((await sh(A.id, 'routine', 'list')).out, /No routines/);
});

test('routine CLI validation errors match Maestri wording', async () => {
  assert.match(
    (await sh(A.id, 'routine', 'create', 'X', '--every', 'soon', '--command', 'a')).out,
    /Invalid --every "soon"/,
  );
  assert.match((await sh(A.id, 'routine', 'create', 'X', '--command', 'a')).out, /needs a schedule/);
  assert.match((await sh(A.id, 'routine', 'create', 'X', '--every', '1m')).out, /needs a command/);
  assert.match(
    (await sh(A.id, 'routine', 'create', 'X', '--every', '1m', '--daily', '09:00', '--command', 'a')).out,
    /Specify only one schedule/,
  );
});

test('reminder routine with end-repeat count disables itself and emits a notification', async () => {
  const notes = [];
  core.events.on('notify', (n) => notes.push(n));
  assert.match(
    (
      await sh(
        A.id,
        'routine',
        'create',
        'Stretch',
        '--reminder',
        '--command',
        'Stand up',
        '--every',
        '1h',
        '--count',
        '1',
      )
    ).out,
    /Created/,
  );
  assert.match((await sh(A.id, 'routine', 'run', 'Stretch')).out, /reminder/);
  assert.equal(notes[0].title, 'Stretch');
  const r = core.routines.list().find((x) => x.name === 'Stretch');
  assert.equal(r.enabled, false);
  assert.equal(r.runCount, 1);
  assert.ok(core.routines.history.some((h) => h.routineName === 'Stretch' && h.outcome === 'reminder'));
});

test('scheduler tick fires due routines and records history', async () => {
  const r = core.routines.create({
    name: 'Due',
    workspaceId: core.workspaces.activeId,
    terminalId: null,
    command: 'now',
    schedule: { kind: 'interval', seconds: 1 },
  });
  r.nextRunAt = new Date(Date.now() - 1000).toISOString();
  await core.routines.tick();
  assert.equal(core.routines.get('Due').runCount, 1);
  core.routines.remove(r.id);
});

// ------------------------------------------------------------------- floors
test('floor create makes a real git worktree and a Ground-isolated canvas', async () => {
  const c = await sh(A.id, 'floor', 'create', 'Feature X');
  assert.match(c.out, /Created floor "Feature X" on branch floor\/Feature-X/);
  const doc = core.workspaces.activeDoc;
  const floor = doc.payload.floors[0];
  assert.ok(fs.existsSync(path.join(floor.worktreePath, 'a.txt')), 'worktree checked out');
  assert.match(git(repo, 'worktree', 'list'), /Feature-X/);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /\.open-maestri/);
  // duplicate name rejected
  assert.match((await sh(A.id, 'floor', 'create', 'feature x')).out, /already exists/);
  // a terminal created on that floor works inside the worktree and inherits the floor from its anchor
  const t = core.workspaces.addTerminal(doc, { name: 'Dev', floorId: floor.id });
  assert.equal(t.floorId, floor.id);
  assert.equal(t.content.terminal._0.workingDirectory, floor.worktreePath);
  const n = core.workspaces.addNote(doc, { name: 'FloorNote', anchorId: t.id });
  assert.equal(n.floorId, floor.id);
  assert.equal(core.workspaces.addNote(doc, { name: 'GroundNote', anchorId: A.id }).floorId, null);
  const list = await sh(A.id, 'floor', 'list');
  assert.match(list.out, /Ground: \d+ nodes/);
  assert.match(list.out, /Feature X \| branch floor\/Feature-X \| 2 nodes/);
});

test('floor status, land refuses dirty work, then merges commits (--no-ff)', async () => {
  const floor = core.workspaces.activeDoc.payload.floors[0];
  assert.match((await sh(A.id, 'floor', 'status', 'Feature X')).out, /0 ahead/);
  fs.writeFileSync(path.join(floor.worktreePath, 'b.txt'), 'two\n');
  assert.match((await sh(A.id, 'floor', 'land', 'Feature X')).out, /uncommitted file/);
  git(floor.worktreePath, 'add', '.');
  git(floor.worktreePath, 'commit', '-q', '-m', 'add b');
  assert.match((await sh(A.id, 'floor', 'status', 'Feature X')).out, /1 ahead, 0 behind main, 0 uncommitted/);
  const pre = await core.floors.landPreview(core.workspaces.activeId, 'Feature X');
  assert.equal(pre.commits.length, 1);
  assert.match(pre.diffStat, /b\.txt/);
  const landed = await sh(A.id, 'floor', 'land', 'Feature X');
  assert.match(landed.out, /Landed "Feature X" onto main \(1 commit/);
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  assert.match(git(repo, 'log', '--oneline', '-n', '3'), /Landing: Feature X/);
});

test('floor delete removes worktree, branch (optional) and its nodes', async () => {
  const doc = core.workspaces.activeDoc;
  const floor = doc.payload.floors[0];
  const r = await sh(A.id, 'floor', 'delete', 'Feature X', '--delete-branch');
  assert.match(r.out, /Deleted floor "Feature X"/);
  assert.ok(!fs.existsSync(floor.worktreePath));
  assert.doesNotMatch(git(repo, 'branch'), /Feature-X/);
  assert.equal(doc.payload.floors.length, 0);
  assert.ok(!doc.payload.nodes.some((n) => n.floorId === floor.id));
  assert.match((await sh(A.id, 'floor', 'status', 'nope')).out, /not found/);
});

test('floor hooks run in the worktree with MAESTRI_FLOOR_* env', async () => {
  const id = core.workspaces.activeId;
  const { floor } = await core.floors.create(id, { name: 'Hooky', runSetup: false });
  core.floors.update(id, floor.id, { hooks: { setup: ['echo %MAESTRI_FLOOR_NAME%> setup.txt'] } });
  const res = await core.floors.hooks.run(id, 'Hooky', 'setup');
  assert.equal(res[0].code, 0);
  assert.match(fs.readFileSync(path.join(floor.worktreePath, 'setup.txt'), 'utf8'), /Hooky/);
  await core.floors.remove(id, 'Hooky', { deleteBranch: true });
});

test('floors refuse non-git workspaces', async () => {
  const other = core.workspaces.create({ name: 'NoGit', workingDirectory: os.tmpdir() });
  await assert.rejects(core.floors.create(other.id, { name: 'x' }), /not a git repository/);
});

// ------------------------------------------------------------------- backups
test('backup → mutate → restore brings notes and nodes back', async () => {
  const doc = core.workspaces.activeDoc;
  const id = core.workspaces.activeId;
  const note = core.workspaces.addNote(doc, { name: 'Keep', content: 'precious' });
  core.workspaces.markDirty(id);
  const b = core.backups.now('test');
  assert.ok(fs.existsSync(b.file));
  core.workspaces.removeNode(doc, note.id);
  fs.writeFileSync(path.join(home, 'workspaces', id, 'notes', 'Keep.md'), 'ruined');
  core.workspaces.markDirty(id);
  core.save();
  const res = core.backups.importFrom(b.file);
  assert.ok(res.replaced.includes(id));
  const back = core.workspaces.getDoc(id);
  assert.ok(back.payload.nodes.some((n) => n.id === note.id));
  assert.equal(fs.readFileSync(path.join(home, 'workspaces', id, 'notes', 'Keep.md'), 'utf8'), 'precious');
  assert.ok(core.backups.list().length >= 1);
});

test('backup import rejects foreign files and path traversal ids', () => {
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'nope' }));
  assert.throws(() => core.backups.importFrom(bad), /not an open-maestri backup/);
  fs.writeFileSync(
    bad,
    JSON.stringify({
      format: 'open-maestri-backup',
      workspaces: [{ entry: { id: '..\\..\\evil' }, document: { payload: {} }, notes: {} }],
    }),
  );
  const before = core.workspaces.list().length;
  core.backups.importFrom(bad);
  assert.equal(core.workspaces.list().length, before);
});

// ---------------------------------------------------------------- undo / redo
test('undo/redo restore structure', () => {
  const ws = core.workspaces;
  const id = ws.activeId;
  const doc = ws.activeDoc;
  const before = doc.payload.nodes.length;
  ws.checkpoint(id);
  const n = ws.addNote(doc, { name: 'Oops' });
  assert.equal(doc.payload.nodes.length, before + 1);
  const u = ws.undo(id);
  assert.deepEqual(u.removed, [n.id]);
  assert.equal(ws.getDoc(id).payload.nodes.length, before);
  assert.ok(ws.historyState(id).canRedo);
  const r = ws.redo(id);
  assert.deepEqual(r.added, [n.id]);
  assert.equal(ws.getDoc(id).payload.nodes.length, before + 1);
});

// -------------------------------------------------------------- shapes / ssh
test('shapes and strokes use Maestri-compatible content', () => {
  const doc = core.workspaces.activeDoc;
  const s = core.workspaces.addShape(doc, { shapeType: 'ellipse' });
  assert.equal(s.content.shape._0.shapeType, 'ellipse');
  const a = core.workspaces.addStroke(doc, { strokeType: 'arrow' });
  assert.deepEqual(a.content.stroke._0.controlPoint, [0.5, 0.5]);
});

test('remote terminals resolve WSL / SSH launch commands (with CLI reverse tunnel)', () => {
  const { resolveShell } = require('../main/terminals');
  const wsl = resolveShell(
    { remote: { kind: 'wsl', distro: 'Ubuntu' }, workingDirectory: os.tmpdir() },
    'powershell.exe',
    1234,
  );
  assert.equal(wsl.path, 'wsl.exe');
  assert.deepEqual(wsl.args.slice(0, 2), ['-d', 'Ubuntu']);
  const ssh = resolveShell({ remote: { kind: 'ssh', host: 'box', user: 'me', port: 2222 } }, 'powershell.exe', 4321);
  assert.equal(ssh.path, 'ssh.exe');
  assert.deepEqual(ssh.args, ['-t', '-R', '4321:127.0.0.1:4321', '-p', '2222', 'me@box']);
  const local = resolveShell({ shellPath: 'cmd.exe' }, 'powershell.exe', 1);
  assert.deepEqual(local, { path: 'cmd.exe', args: [] });
});
