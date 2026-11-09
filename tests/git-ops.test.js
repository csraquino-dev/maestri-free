'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../main/git-ops');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-gitops-'));
const sh = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const w = (rel, text) => {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
test.after(() => {
  try {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* read-only git objects */
  }
});

test('a folder that is not a repository is reported, not thrown', async () => {
  assert.deepEqual(await G.status(os.tmpdir()), { isRepo: false });
});

test('status: branch, untracked, modified, staged, renamed — with forward-slash paths', async () => {
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@t.t');
  sh('config', 'user.name', 'T');
  w('a.txt', 'one\n');
  w('src/b.txt', 'bee\n');
  sh('add', '.');
  sh('commit', '-q', '-m', 'init');
  let st = await G.status(repo);
  assert.equal(st.isRepo, true);
  assert.equal(st.branch, 'main');
  assert.equal(st.files.length, 0);
  w('a.txt', 'one\ntwo\n');
  w('src/new.txt', 'n\n');
  sh('mv', 'src/b.txt', 'src/c.txt');
  st = await G.status(repo);
  const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
  assert.equal(by['a.txt'].worktree, 'M');
  assert.equal(by['a.txt'].staged, false);
  assert.equal(by['src/new.txt'].untracked, true);
  assert.equal(by['src/c.txt'].index, 'R');
  assert.equal(by['src/c.txt'].from, 'src/b.txt');
});

test('diff of tracked, staged and untracked files', async () => {
  assert.match(await G.diff(repo, 'a.txt'), /\+two/);
  assert.match(await G.diff(repo, 'src/new.txt'), /^new file: src\/new\.txt\n\+n/);
  await G.stage(repo, ['a.txt']);
  assert.equal(await G.diff(repo, 'a.txt'), '', 'nothing left unstaged');
  assert.match(await G.diff(repo, 'a.txt', true), /\+two/);
});

test('stage / unstage / commit (needs a message and something staged)', async () => {
  sh('reset', '-q'); // `git mv` had staged the rename; start from a clean index
  await G.unstage(repo, ['a.txt']);
  let st = await G.status(repo);
  assert.equal(st.files.find((f) => f.path === 'a.txt').staged, false);
  await assert.rejects(G.commit(repo, 'x'), /nothing is staged/);
  await G.stage(repo, ['a.txt', 'src/new.txt']);
  await assert.rejects(G.commit(repo, '   '), /message is empty/);
  const hash = await G.commit(repo, 'add two and new');
  assert.match(hash, /^[0-9a-f]{7,}$/);
  const log = await G.log(repo, 5);
  assert.equal(log[0].subject, 'add two and new');
  assert.equal(log[0].author, 'T');
  st = await G.status(repo);
  assert.deepEqual(
    st.files.map((f) => f.path).sort(),
    ['src/b.txt', 'src/c.txt'],
    'the unstaged rename (deleted + untracked) is left',
  );
});

test('discard restores tracked files and deletes untracked ones', async () => {
  w('a.txt', 'garbage\n');
  w('junk.txt', 'junk\n');
  await G.discard(repo, ['a.txt', 'junk.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\ntwo\n');
  assert.ok(!fs.existsSync(path.join(repo, 'junk.txt')));
});

test('paths are confined to the repository', async () => {
  await assert.rejects(G.stage(repo, ['../outside.txt']), /outside the repository/);
  await assert.rejects(G.discard(repo, [path.join(os.tmpdir(), 'x.txt')]), /outside the repository/);
  await assert.rejects(G.diff(repo, '..\\..\\x'), /outside the repository/);
  await assert.rejects(G.stage(repo, []), /no files given/);
});

test('branches: list, create + switch, reject unsafe names', async () => {
  assert.deepEqual(
    (await G.branches(repo)).map((b) => [b.name, b.current]),
    [['main', true]],
  );
  await G.checkout(repo, 'feature/login', { create: true });
  const b = await G.branches(repo);
  assert.equal(b.find((x) => x.current).name, 'feature/login');
  await G.checkout(repo, 'main');
  await assert.rejects(G.checkout(repo, '--orphan x'), /invalid branch name/);
  await assert.rejects(G.checkout(repo, 'no-such-branch'), /./);
});

test('stash: push (including untracked), list, pop', async () => {
  w('a.txt', 'stash me\n');
  w('fresh.txt', 'untracked\n');
  await G.stashPush(repo, 'wip');
  assert.equal(
    (await G.status(repo)).files.filter((f) => f.path === 'a.txt' || f.path === 'fresh.txt').length,
    0,
    'both the tracked change and the untracked file were stashed',
  );
  const list = await G.stashes(repo);
  assert.equal(list.length, 1);
  assert.match(list[0].subject, /wip/);
  await G.stashPop(repo, list[0].ref);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'stash me\n');
  assert.ok(fs.existsSync(path.join(repo, 'fresh.txt')));
  await assert.rejects(G.stashPop(repo, 'stash@{0};rm'), /invalid stash reference/);
});

test('concurrent writes are serialised (no index.lock errors)', async () => {
  const names = ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt', 'p6.txt'];
  for (const f of names) w(f, f);
  const results = await Promise.allSettled(names.map((f) => G.stage(repo, [f])));
  assert.deepEqual(
    results.map((r) => r.status),
    Array(6).fill('fulfilled'),
    JSON.stringify(results.map((r) => r.reason && r.reason.message)),
  );
  await Promise.all(['p1.txt', 'p2.txt', 'p3.txt'].map((f) => G.unstage(repo, [f])));
  const st = await G.status(repo);
  assert.equal(st.files.filter((f) => f.staged && /^p[456]/.test(f.path)).length, 3);
});
