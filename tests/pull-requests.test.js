'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPullRequests, checksState } = require('../main/pull-requests');

test('checks summary: failure wins, then pending, else success; none when empty', () => {
  assert.equal(checksState([]), 'none');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'success');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(checksState([{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }]), 'failure');
  assert.equal(checksState([{ state: 'ERROR' }]), 'failure');
});

test('list maps gh JSON and passes the state through', async () => {
  let seen;
  const pr = createPullRequests({
    exec: async (args, cwd) => {
      seen = [args, cwd];
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'Fix',
            state: 'OPEN',
            isDraft: true,
            headRefName: 'f',
            baseRefName: 'main',
            author: { login: 'me' },
            url: 'u',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          },
        ]),
      };
    },
  });
  const l = await pr.list('C:\\r', 'merged');
  assert.deepEqual(l[0], {
    number: 7,
    title: 'Fix',
    state: 'OPEN',
    draft: true,
    head: 'f',
    base: 'main',
    author: 'me',
    url: 'u',
    updatedAt: undefined,
    checks: 'success',
  });
  assert.ok(seen[0].includes('merged') && seen[1] === 'C:\\r');
  await assert.rejects(pr.list('x', 'bogus'), /invalid state/);
});

test('create validates title and branches, and returns the PR url', async () => {
  let args;
  const pr = createPullRequests({
    exec: async (a) => {
      args = a;
      return { code: 0, stdout: 'Creating...\nhttps://github.com/o/r/pull/9\n' };
    },
  });
  assert.deepEqual(await pr.create('x', { title: 'T', base: 'main', head: 'feat/x', draft: true }), {
    url: 'https://github.com/o/r/pull/9',
  });
  assert.ok(args.includes('--draft') && args.includes('feat/x'));
  await assert.rejects(pr.create('x', { title: ' ' }), /title is required/);
  await assert.rejects(pr.create('x', { title: 'T', base: '--web' }), /invalid branch/);
  await assert.rejects(pr.create('x', { title: 'T', head: 'a b' }), /invalid branch/);
});

test('gh errors surface as readable messages', async () => {
  const bad = (stderr) => createPullRequests({ exec: async () => ({ code: 1, stdout: '', stderr }) });
  await assert.rejects(bad('To get started with GitHub CLI, please run:  gh auth login').list('x'), /not signed in/);
  await assert.rejects(bad('no git remotes found').list('x'), /no git remotes/);
});
