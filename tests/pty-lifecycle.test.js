'use strict';
// Regression: node-pty's ConPTY addon aborts the whole process ("Assertion failed! remove_pty_baton(baton->id)")
// when a pty that already exited is killed again. These scenarios must never take the process down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-pty-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');

let core, ws, doc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawn = (name, opts = {}) => {
  const n = ws.addTerminal(doc, { name, workingDirectory: os.tmpdir(), shellPath: opts.shellPath });
  const s = core.terminals.ensure(n, ws.activeId, core.ui.prefs());
  return { n, s };
};

test.before(async () => {
  core = await createCore();
  ws = core.workspaces;
  doc = ws.activeDoc;
});
test.after(async () => {
  await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

test('disposing the same session many times only kills once and never throws', async () => {
  const { n, s } = spawn('twice');
  await sleep(1500);
  s.dispose();
  s.dispose();
  s.dispose();
  core.terminals.remove(n.id);
  core.terminals.remove(n.id);
  await s.whenExited(3000);
  assert.equal(s.exited, true);
  s.dispose(); // after exit: must be a no-op
});

test('a shell that exits by itself and is then removed does not crash', async () => {
  const { n, s } = spawn('selfexit', { shellPath: 'cmd.exe' });
  await sleep(1200);
  s.write('exit\r');
  await s.whenExited(5000);
  assert.equal(s.exited, true);
  core.terminals.remove(n.id);
  core.terminals.remove(n.id);
});

test('rapid create / remove / restart cycles survive (30 iterations)', async () => {
  for (let i = 0; i < 30; i++) {
    const { n } = spawn(`burst-${i}`, { shellPath: i % 2 ? 'cmd.exe' : 'powershell.exe' });
    if (i % 3 === 0) await sleep(60);
    core.terminals.remove(n.id);
    if (i % 5 === 0) {
      // restart the way the UI does: remove then ensure again
      const again = core.terminals.ensure(n, ws.activeId, core.ui.prefs());
      core.terminals.remove(n.id);
      void again;
    }
  }
  await sleep(1500);
  assert.ok(true, 'process still alive');
});

test('write / resize on a disposed or exited session are ignored', async () => {
  const { n, s } = spawn('late');
  await sleep(1200);
  core.terminals.remove(n.id);
  await s.whenExited(3000);
  s.write('echo nope\r');
  s.resize(120, 40);
  s.markActiveTask();
  assert.equal(s.alive, false);
});

test('shutdown waits for every shell to exit (no live ptys left behind)', async () => {
  const live = [spawn('a'), spawn('b'), spawn('c')];
  await sleep(1500);
  await core.terminals.disposeAll();
  for (const { s } of live) assert.equal(s.exited, true);
  assert.equal(core.terminals.sessions.size, 0);
});
