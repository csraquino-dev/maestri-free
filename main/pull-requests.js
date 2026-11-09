'use strict';
// Pull requests through the GitHub CLI (`gh`): list, create, and read the CI state of a repository's PRs.
const { spawn } = require('child_process');

function defaultExec(args, cwd) {
  return new Promise((resolve) => {
    let out = '',
      err = '',
      child;
    try {
      child = spawn('gh', args, { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve({ code: -2, stdout: out, stderr: 'timed out' });
    }, 30000);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: '',
        stderr: e.code === 'ENOENT' ? 'gh (GitHub CLI) is not installed or not on PATH' : e.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

// Summarise a statusCheckRollup: 'success' | 'failure' | 'pending' | 'none'.
function checksState(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  let pending = false;
  for (const c of rollup) {
    const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v))
      return 'failure';
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) pending = true;
  }
  return pending ? 'pending' : 'success';
}

const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

function createPullRequests({ exec = defaultExec } = {}) {
  const run = async (args, cwd) => {
    const r = await exec(args, cwd);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || 'gh failed').trim().split('\n')[0];
      throw new Error(
        /auth login|not logged/i.test(msg) ? 'gh is not signed in. Run "gh auth login" in a terminal.' : msg,
      );
    }
    return r.stdout;
  };

  async function list(cwd, state = 'open') {
    if (!['open', 'closed', 'merged', 'all'].includes(state)) throw new Error('invalid state');
    const out = await run(
      [
        'pr',
        'list',
        '--state',
        state,
        '--limit',
        '50',
        '--json',
        'number,title,state,isDraft,headRefName,baseRefName,author,url,updatedAt,statusCheckRollup',
      ],
      cwd,
    );
    return JSON.parse(out || '[]').map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      draft: !!p.isDraft,
      head: p.headRefName,
      base: p.baseRefName,
      author: p.author && p.author.login,
      url: p.url,
      updatedAt: p.updatedAt,
      checks: checksState(p.statusCheckRollup),
    }));
  }

  async function create(cwd, { title, body = '', base, head, draft = false } = {}) {
    title = String(title || '').trim();
    if (!title) throw new Error('title is required');
    const args = ['pr', 'create', '--title', title, '--body', String(body)];
    for (const [flag, v] of [
      ['--base', base],
      ['--head', head],
    ])
      if (v) {
        if (!REF_RE.test(v) || v.startsWith('-')) throw new Error(`invalid branch name: ${v}`);
        args.push(flag, v);
      }
    if (draft) args.push('--draft');
    const out = (await run(args, cwd)).trim().split('\n').pop();
    return { url: out };
  }

  async function status(cwd) {
    const out = await run(['pr', 'status', '--json', 'currentBranch'], cwd).catch(() => null);
    return out ? JSON.parse(out) : null;
  }

  return { list, create, status };
}

module.exports = { createPullRequests, checksState };
