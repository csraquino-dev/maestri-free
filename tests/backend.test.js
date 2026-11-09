'use strict';
// End-to-end backend test (no Electron): real ConPTY shells, real HTTP server, real CLI process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-test-'));
process.env.OPEN_MAESTRI_HOME = home;
// keep the test from writing skills into the real ~/.claude
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));

const { createCore } = require('../main/core');

let core;
let A; // manager terminal node
let B; // worker terminal node
const cli = path.join(__dirname, '..', 'cli', 'omaestri.js');

function omaestri(terminalId, ...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: terminalId },
        timeout: 60000,
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout.trim(), err: stderr.trim() }),
    );
  });
}

test.before(async () => {
  core = await createCore();
  const ws = core.workspaces;
  const doc = ws.activeDoc;
  A = ws.addTerminal(doc, { name: 'Boss', workingDirectory: os.tmpdir(), isManager: true });
  B = ws.addTerminal(doc, { name: 'Builder', workingDirectory: os.tmpdir() }, A.id);
  ws.connect(doc, A.id, B.id);
  core.startWorkspaceTerminals(ws.activeId);
  await new Promise((r) => setTimeout(r, 3500)); // let PowerShell print its prompt
});

test.after(async () => {
  await core.shutdown();
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI refuses to run outside open-maestri terminals', async () => {
  const r = await new Promise((resolve) =>
    execFile(process.execPath, [cli, 'list'], { env: { PATH: process.env.PATH } }, (err, o, e) =>
      resolve({ code: err && err.code, err: e }),
    ),
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /only available inside open-maestri terminals/);
});

test('list shows self and connected agent', async () => {
  const r = await omaestri(A.id, 'list');
  assert.match(r.out, /You:\n {2}- name: "Boss"/);
  assert.match(r.out, /Connected agents:\n {2}- name: "Builder"/);
});

test('ask runs a command in the target shell and returns its output', async () => {
  const r = await omaestri(A.id, 'ask', 'Builder', 'Write-Output ("pong-" + (6*7))');
  assert.equal(r.code, 0);
  assert.match(r.out, /pong-42/);
});

test('check reads recent output of the target', async () => {
  const r = await omaestri(A.id, 'check', 'Builder', '10');
  assert.match(r.out, /pong-42/);
});

test('ask supports stdin argument "-"', async () => {
  const out = await new Promise((resolve) => {
    const cp = execFile(
      process.execPath,
      [cli, 'ask', 'Builder', '-'],
      { env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: A.id }, timeout: 60000 },
      (e, stdout) => resolve(stdout),
    );
    cp.stdin.end('Write-Output "special & % ^ chars ok"');
  });
  assert.match(out, /special & % \^ chars ok/);
});

test('note create/write/read/edit round trip, connected to caller', async () => {
  const created = await omaestri(A.id, 'note', 'create', 'first line');
  assert.match(created.out, /^Note-[0-9A-F]{8}$/);
  const name = created.out;
  assert.equal((await omaestri(A.id, 'note', 'write', name, 'alpha\nbeta\ngamma')).out, 'OK');
  assert.equal((await omaestri(A.id, 'note', 'edit', name, 'beta', 'BETA')).out, 'OK');
  const read = await omaestri(A.id, 'note', 'read', name);
  assert.match(read.out, /1\talpha\n2\tBETA\n3\tgamma/);
  const part = await omaestri(A.id, 'note', 'read', name, '2', '1');
  assert.equal(part.out, '2\tBETA');
  const list = await omaestri(A.id, 'list');
  assert.ok(list.out.includes(`- name: "${name}"`));
  // the note is a real node + connection in the persisted workspace
  core.save();
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, 'workspaces', core.workspaces.activeId, 'workspace.json'), 'utf8'),
  );
  assert.equal(saved.type, 'workspace');
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.payload.nodes.some((n) => n.content.stickyNote));
  assert.ok(saved.payload.noteConnections.length >= 1);
});

test('note chain: agent reaches notes linked note→note', async () => {
  const doc = core.workspaces.activeDoc;
  const n1 = core.workspaces.addNote(doc, { name: 'Spec', content: 'spec text', anchorId: A.id });
  const n2 = core.workspaces.addNote(doc, { name: 'Details', content: 'detail text', anchorId: n1.id });
  core.workspaces.connect(doc, A.id, n1.id);
  core.workspaces.connect(doc, n1.id, n2.id);
  assert.match((await omaestri(A.id, 'note', 'read', 'Details')).out, /detail text/);
});

test('recruit requires Maestro mode, then creates + connects an agent', async () => {
  const denied = await omaestri(B.id, 'recruit', 'Nope');
  assert.match(denied.out, /not in Maestro mode/);
  const ok = await omaestri(A.id, 'recruit', 'Helper', '--preset', 'generic_shell');
  assert.match(ok.out, /Recruited 'Helper' with preset 'Shell'/);
  const list = await omaestri(A.id, 'list');
  assert.match(list.out, /"Helper"/);
  const gone = await omaestri(A.id, 'dismiss', 'Helper');
  assert.match(gone.out, /Dismissed 'Helper'/);
  assert.doesNotMatch((await omaestri(A.id, 'list')).out, /"Helper"/);
});

test('role + preset commands', async () => {
  assert.match((await omaestri(A.id, 'preset', 'list')).out, /claude_code: Claude Code \(claude\)/);
  assert.match((await omaestri(A.id, 'role', 'create', 'Reviewer', 'Review carefully')).out, /created/);
  assert.match((await omaestri(A.id, 'role', 'show', 'reviewer')).out, /Prompt: Review carefully/);
  assert.match((await omaestri(A.id, 'role', 'assign', 'Builder', 'Reviewer')).out, /assigned/);
});

test('unknown terminal id / command errors are reported', async () => {
  const r = await omaestri('00000000-0000-0000-0000-000000000000', 'list');
  assert.match(r.out, /error: missing terminal ID/);
  assert.match((await omaestri(A.id, 'bogus')).out, /unknown command 'bogus'/);
});

test('server only accepts POST /cli', async () => {
  const res = await fetch(`http://127.0.0.1:${core.port()}/nope`);
  assert.equal(res.status, 404);
});
