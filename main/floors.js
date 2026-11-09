'use strict';
// Floors: isolated git-worktree levels of a workspace. Every floor has its own canvas
// (nodes carry `floorId`; null/absent = Ground). Compatible with workspace.json `floors`.
const fs = require('fs');
const crossFloor = require('./cross-floor');
const path = require('path');
const { execFile } = require('child_process');
const persistence = require('./persistence');
const { git, out } = require('./git');

const slug = (s) =>
  String(s)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'floor';

function createFloors({ workspaces, terminals }) {
  const docOf = (wsId) => {
    const d = workspaces.getDoc(wsId);
    if (!d) throw new Error('workspace not found');
    return d;
  };
  const floorOf = (doc, ref) => {
    const q = String(ref).toLowerCase();
    return (
      doc.payload.floors.find((f) => f.id === ref || f.name.toLowerCase() === q) ||
      doc.payload.floors.find((f) => f.name.toLowerCase().includes(q))
    );
  };

  async function repoRoot(dir) {
    const r = await git(dir, ['rev-parse', '--show-toplevel']);
    return r.code === 0 ? out(r) : null;
  }

  async function info(wsId) {
    const doc = docOf(wsId);
    const dir = doc.payload.workingDirectory;
    const root = await repoRoot(dir);
    if (!root) return { isRepo: false, dir };
    const wt = await git(root, ['worktree', 'list', '-h']);
    const branch = out(await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']));
    const list = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return {
      isRepo: true,
      root,
      branch,
      branches: out(list).split('\n').filter(Boolean),
      worktreeSupported: wt.code === 0,
    };
  }

  async function runHook(floor, hooks, phase, env = {}) {
    const results = [];
    for (const cmd of hooks || []) {
      if (!String(cmd).trim()) continue;
      const res = await new Promise((resolve) => {
        execFile(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', cmd],
          {
            cwd: floor.worktreePath,
            windowsHide: true,
            timeout: 10 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            env: {
              ...process.env,
              MAESTRI_FLOOR_NAME: floor.name,
              MAESTRI_FLOOR_BRANCH: floor.branchName,
              MAESTRI_FLOOR_PATH: floor.worktreePath,
              ...env,
            },
          },
          (err, stdout, stderr) =>
            resolve({
              command: cmd,
              phase,
              code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
              output: String(stdout) + String(stderr),
            }),
        );
      });
      results.push(res);
      if (res.code !== 0) break;
    }
    return results;
  }

  async function create(wsId, { name, branch, existingBranch = false, runSetup }) {
    const doc = docOf(wsId);
    name = String(name || '').trim();
    if (!name) throw new Error('floor name required');
    if (doc.payload.floors.some((f) => f.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`a floor named "${name}" already exists`);
    const inf = await info(wsId);
    if (!inf.isRepo) throw new Error(`not a git repository: ${doc.payload.workingDirectory}`);
    if (!inf.worktreeSupported) throw new Error('this git does not support worktrees');
    branch = String(branch || `floor/${slug(name)}`).trim();
    const wtPath = path.join(inf.root, '.open-maestri', 'floors', slug(name));
    if (fs.existsSync(wtPath)) throw new Error(`folder already exists: ${wtPath}`);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const args = existingBranch
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '-b', branch, wtPath, 'HEAD'];
    const r = await git(inf.root, args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'git worktree add failed');
    // keep the worktrees out of `git status` without touching tracked files
    try {
      const excl = path.join(inf.root, '.git', 'info', 'exclude');
      const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
      if (!/^\.open-maestri\/?$/m.test(cur))
        fs.appendFileSync(excl, `${cur.endsWith('\n') || !cur ? '' : '\n'}.open-maestri/\n`);
    } catch {
      /* non-fatal */
    }
    const floor = {
      id: persistence.uuid(),
      name,
      branchName: branch,
      worktreePath: wtPath,
      hooks: { setup: [], run: [], teardown: [], autoRunSetup: false },
      createdAt: persistence.now(),
    };
    doc.payload.floors.push(floor);
    workspaces.markDirty(wsId);
    let hookResults = [];
    if (runSetup) hookResults = await runHook(floor, floor.hooks.setup, 'setup');
    return { floor, hookResults };
  }

  async function remove(wsId, ref, { deleteBranch = false } = {}) {
    const doc = docOf(wsId);
    const floor = floorOf(doc, ref);
    if (!floor) throw new Error(`floor '${ref}' not found`);
    const teardown = fs.existsSync(floor.worktreePath) ? await runHook(floor, floor.hooks.teardown, 'teardown') : [];
    for (const n of doc.payload.nodes.filter((x) => x.floorId === floor.id)) {
      terminals.remove(n.id);
      workspaces.removeNode(doc, n.id);
    }
    crossFloor.dropFloor(doc, floor.id);
    const root = (await repoRoot(doc.payload.workingDirectory)) || doc.payload.workingDirectory;
    const warnings = [];
    const r = await git(root, ['worktree', 'remove', '--force', floor.worktreePath]);
    if (r.code !== 0) warnings.push((r.stderr || r.stdout).trim());
    if (deleteBranch) {
      const b = await git(root, ['branch', '-D', floor.branchName]);
      if (b.code !== 0) warnings.push((b.stderr || b.stdout).trim());
    }
    doc.payload.floors = doc.payload.floors.filter((f) => f.id !== floor.id);
    workspaces.markDirty(wsId);
    return { floor, teardown, warnings };
  }

  async function status(wsId, ref) {
    const doc = docOf(wsId);
    const floor = floorOf(doc, ref);
    if (!floor) throw new Error(`floor '${ref}' not found`);
    const inf = await info(wsId);
    const dirty = out(await git(floor.worktreePath, ['status', '--porcelain']))
      .split('\n')
      .filter(Boolean).length;
    const ahead = inf.isRepo
      ? out(await git(inf.root, ['rev-list', '--count', `${inf.branch}..${floor.branchName}`]))
      : '?';
    const behind = inf.isRepo
      ? out(await git(inf.root, ['rev-list', '--count', `${floor.branchName}..${inf.branch}`]))
      : '?';
    return {
      floor,
      target: inf.branch,
      dirtyFiles: dirty,
      ahead: Number(ahead) || 0,
      behind: Number(behind) || 0,
      exists: fs.existsSync(floor.worktreePath),
    };
  }

  async function landPreview(wsId, ref) {
    const doc = docOf(wsId);
    const floor = floorOf(doc, ref);
    if (!floor) throw new Error(`floor '${ref}' not found`);
    const inf = await info(wsId);
    if (!inf.isRepo) throw new Error('not a git repository');
    const st = await status(wsId, ref);
    const log = out(await git(inf.root, ['log', '--oneline', `${inf.branch}..${floor.branchName}`]));
    const stat = out(await git(inf.root, ['diff', '--stat', `${inf.branch}...${floor.branchName}`]));
    const mainDirty = out(await git(inf.root, ['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .filter(Boolean).length;
    return { ...st, commits: log ? log.split('\n') : [], diffStat: stat, targetDirty: mainDirty };
  }

  async function land(wsId, ref, { removeAfter = false, deleteBranch = false } = {}) {
    const doc = docOf(wsId);
    const floor = floorOf(doc, ref);
    if (!floor) throw new Error(`floor '${ref}' not found`);
    const inf = await info(wsId);
    if (!inf.isRepo) throw new Error('not a git repository');
    const pre = await landPreview(wsId, ref);
    if (pre.dirtyFiles) throw new Error(`the floor has ${pre.dirtyFiles} uncommitted file(s); commit them first`);
    if (pre.targetDirty)
      throw new Error(`the target branch '${inf.branch}' has uncommitted changes; commit or stash them first`);
    if (!pre.commits.length) throw new Error('nothing to land: the floor has no new commits');
    const m = await git(inf.root, ['merge', '--no-ff', '-m', `Landing: ${floor.name}`, floor.branchName]);
    if (m.code !== 0) {
      await git(inf.root, ['merge', '--abort']);
      throw new Error(`merge conflict, nothing was changed:\n${(m.stdout + m.stderr).trim()}`);
    }
    let removed = null;
    if (removeAfter) removed = await remove(wsId, floor.id, { deleteBranch });
    return { landed: floor.name, target: inf.branch, commits: pre.commits.length, removed };
  }

  const hooks = {
    run: (wsId, ref, phase) => {
      const doc = docOf(wsId);
      const floor = floorOf(doc, ref);
      if (!floor) throw new Error(`floor '${ref}' not found`);
      return runHook(floor, floor.hooks[phase] || [], phase);
    },
  };

  function update(wsId, id, fields) {
    const doc = docOf(wsId);
    const f = doc.payload.floors.find((x) => x.id === id);
    if (!f) throw new Error('floor not found');
    if (fields.name) f.name = String(fields.name).trim() || f.name;
    if (fields.hooks) f.hooks = { setup: [], run: [], teardown: [], autoRunSetup: false, ...f.hooks, ...fields.hooks };
    workspaces.markDirty(wsId);
    return f;
  }

  return { info, create, remove, status, landPreview, land, hooks, update, floorOf };
}

module.exports = { createFloors };
