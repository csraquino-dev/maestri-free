'use strict';
// Git operations behind the file tree's "Changes" panel. Everything goes through execFile (no shell) and every path
// is validated to stay inside the repository.
const fs = require('fs');
const path = require('path');
const { git, out } = require('./git');

// Operations that write to the repository run one at a time per repo: two quick clicks (or two panels) must not
// fight over .git/index.lock.
const queues = new Map();
function exclusive(rootKey, fn) {
  const prev = queues.get(rootKey) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  queues.set(rootKey, tail);
  tail.then(() => {
    if (queues.get(rootKey) === tail) queues.delete(rootKey);
  });
  return run;
}
const locked =
  (impl) =>
  async (dir, ...rest) => {
    const root = await repoRoot(dir);
    if (!root) throw new Error('not a git repository');
    return exclusive(root.toLowerCase(), () => impl(dir, ...rest));
  };

async function repoRoot(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? path.normalize(out(r)) : null;
}

function inside(root, rel) {
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  return !!r && !r.startsWith('..') && !path.isAbsolute(r) ? full : null;
}
const safePaths = (root, paths) => {
  const list = (paths || []).map((p) => String(p));
  if (!list.length) throw new Error('no files given');
  for (const p of list) if (!inside(root, p)) throw new Error(`path outside the repository: ${p}`);
  return list;
};
const fail = (r) => {
  throw new Error((r.stderr || r.stdout || 'git failed').trim());
};

async function status(dir) {
  const root = await repoRoot(dir);
  if (!root) return { isRepo: false };
  const r = await git(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
  if (r.code !== 0) fail(r);
  const parts = r.stdout.split('\0').filter((x) => x.length);
  let branch = '',
    upstream = null,
    ahead = 0,
    behind = 0,
    detached = false;
  const head = parts.shift() || '';
  if (head.startsWith('## ')) {
    const h = head.slice(3);
    if (h.startsWith('HEAD (no branch)')) {
      detached = true;
      branch = 'HEAD';
    } else if (h.startsWith('No commits yet on ')) branch = h.slice(18);
    else {
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
      branch = m[1];
      upstream = m[2] || null;
      const a = /ahead (\d+)/.exec(m[3] || ''),
        b = /behind (\d+)/.exec(m[3] || '');
      ahead = a ? +a[1] : 0;
      behind = b ? +b[1] : 0;
    }
  }
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    const x = e[0],
      y = e[1];
    let file = e.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = parts[++i]; // rename: next field is the original path
    files.push({
      path: file.replace(/\\/g, '/'),
      from,
      index: x === ' ' || x === '?' ? '' : x,
      worktree: y === ' ' ? '' : y,
      untracked: x === '?' && y === '?',
      staged: x !== ' ' && x !== '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'),
    });
  }
  return { isRepo: true, root, branch, upstream, ahead, behind, detached, files };
}

async function diff(dir, rel, staged = false) {
  const root = await repoRoot(dir);
  if (!root) throw new Error('not a git repository');
  const [p] = safePaths(root, [rel]);
  const st = await status(root);
  const f = st.files.find((x) => x.path === rel.replace(/\\/g, '/'));
  if (f && f.untracked) {
    const full = inside(root, p);
    const text = fs.readFileSync(full, 'utf8');
    return (
      `new file: ${rel}\n` +
      text
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')
    );
  }
  const r = await git(root, ['diff', ...(staged ? ['--cached'] : []), '--no-color', '--', p]);
  if (r.code !== 0) fail(r);
  return r.stdout;
}

async function stageImpl(dir, paths) {
  const root = await repoRoot(dir);
  const list = safePaths(root, paths);
  const r = await git(root, ['add', '--', ...list]);
  if (r.code !== 0) fail(r);
}

async function unstageImpl(dir, paths) {
  const root = await repoRoot(dir);
  const list = safePaths(root, paths);
  let r = await git(root, ['restore', '--staged', '--', ...list]);
  if (r.code !== 0) r = await git(root, ['rm', '--cached', '-q', '--', ...list]); // repository without commits yet
  if (r.code !== 0) fail(r);
}

// Throws away local changes of the given files. Untracked files are deleted from disk.
async function discardImpl(dir, paths) {
  const root = await repoRoot(dir);
  const list = safePaths(root, paths);
  const st = await status(root);
  const untracked = new Set(st.files.filter((f) => f.untracked).map((f) => f.path));
  const tracked = list.filter((p) => !untracked.has(p.replace(/\\/g, '/')));
  if (tracked.length) {
    const r = await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
    if (r.code !== 0) fail(r);
  }
  for (const p of list) if (untracked.has(p.replace(/\\/g, '/'))) fs.rmSync(inside(root, p), { force: true });
}

async function commitImpl(dir, message) {
  const root = await repoRoot(dir);
  const msg = String(message || '').trim();
  if (!msg) throw new Error('commit message is empty');
  const st = await status(root);
  if (!st.files.some((f) => f.staged)) throw new Error('nothing is staged');
  const r = await git(root, ['commit', '-m', msg]);
  if (r.code !== 0) fail(r);
  return out(await git(root, ['rev-parse', '--short', 'HEAD']));
}

async function log(dir, n = 30) {
  const root = await repoRoot(dir);
  const r = await git(root, [
    'log',
    `-n${Math.min(200, Math.max(1, n | 0))}`,
    '--pretty=format:%h%x1f%an%x1f%ar%x1f%s',
  ]);
  if (r.code !== 0) return []; // no commits yet
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, when, subject] = l.split('\x1f');
      return { hash, author, when, subject };
    });
}

async function branches(dir) {
  const root = await repoRoot(dir);
  const r = await git(root, ['for-each-ref', '--format=%(refname:short)%1f%(HEAD)', 'refs/heads']);
  if (r.code !== 0) fail(r);
  const list = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, head] = l.split('\x1f');
      return { name, current: head === '*' };
    });
  return list;
}

async function checkoutImpl(dir, branch, { create = false } = {}) {
  const root = await repoRoot(dir);
  if (!/^[\w][\w./-]*$/.test(branch)) throw new Error('invalid branch name');
  const r = await git(root, ['checkout', ...(create ? ['-b'] : []), branch]);
  if (r.code !== 0) fail(r);
}

async function stashes(dir) {
  const root = await repoRoot(dir);
  const r = await git(root, ['stash', 'list', '--pretty=format:%gd%x1f%s']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, subject] = l.split('\x1f');
      return { ref, subject };
    });
}
async function stashPushImpl(dir, message = '') {
  const root = await repoRoot(dir);
  const r = await git(root, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
  if (r.code !== 0) fail(r);
  if (/No local changes/i.test(r.stdout + r.stderr)) throw new Error('no local changes to stash');
}
async function stashPopImpl(dir, ref = 'stash@{0}') {
  const root = await repoRoot(dir);
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('invalid stash reference');
  const r = await git(root, ['stash', 'pop', ref]);
  if (r.code !== 0) fail(r);
}

const stage = locked(stageImpl),
  unstage = locked(unstageImpl),
  discard = locked(discardImpl),
  commit = locked(commitImpl);
const checkout = locked(checkoutImpl),
  stashPush = locked(stashPushImpl),
  stashPop = locked(stashPopImpl);

module.exports = {
  repoRoot,
  status,
  diff,
  stage,
  unstage,
  discard,
  commit,
  log,
  branches,
  checkout,
  stashes,
  stashPush,
  stashPop,
};
