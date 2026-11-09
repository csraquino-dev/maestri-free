'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../main/docker');
const { resolveShell } = require('../main/terminals');

test('a sandbox terminal runs the shell in a throw-away container with the folder mounted at /workspace', () => {
  const a = D.runArgs({ image: 'python:3.12', shell: '/bin/bash' }, { terminalId: 'ABCD1234-FFFF', cwd: 'C:\\proj' });
  assert.deepEqual(a, [
    'run',
    '-it',
    '--rm',
    '--name',
    'omaestri-abcd1234',
    '-v',
    'C:\\proj:/workspace',
    '-w',
    '/workspace',
    'python:3.12',
    '/bin/bash',
  ]);
});

test('options: no mount, no network, defaults', () => {
  const a = D.runArgs({ mount: false, network: 'none' }, { cwd: 'C:\\proj' });
  assert.deepEqual(a, ['run', '-it', '--rm', '--network', 'none', 'node:22', '/bin/bash']);
});

test('image and shell are validated so they can never smuggle docker flags', () => {
  for (const image of ['--privileged', '-v /:/host', 'img name', 'a;b', '$(x)', '']) {
    if (image === '') continue; // empty falls back to the default image
    assert.throws(() => D.runArgs({ image }, {}), /invalid Docker image/, image);
  }
  assert.throws(() => D.runArgs({ shell: '/bin/sh -c x' }, {}), /invalid shell/);
  assert.throws(() => D.runArgs({ shell: '--rm' }, {}), /invalid shell/);
});

test('resolveShell turns a docker remote into docker.exe with those arguments', () => {
  const r = resolveShell(
    {
      remote: { kind: 'docker', image: 'node:22', shell: '/bin/sh', mount: true },
      workingDirectory: require('os').tmpdir(),
      id: 'ID-12345678',
    },
    'powershell.exe',
    1234,
  );
  assert.equal(r.path, 'docker.exe');
  assert.deepEqual(r.args.slice(-2), ['node:22', '/bin/sh']);
  assert.ok(r.args.includes(require('os').tmpdir() + ':/workspace'));
});

test('test(): daemon down, image missing, image present', async () => {
  const exec = (script) => async (args) => script[args[0]](args);
  assert.deepEqual(
    await D.test(
      {},
      exec({ version: () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\nmore' }) }),
    ),
    { ok: false, error: 'Cannot connect to the Docker daemon' },
  );
  assert.deepEqual(
    await D.test(
      { image: 'x/y:1' },
      exec({
        version: () => ({ code: 0, stdout: '27.0.1\n', stderr: '' }),
        image: () => ({ code: 1, stdout: '', stderr: 'no such image' }),
      }),
    ),
    { ok: true, version: '27.0.1', imagePresent: false, image: 'x/y:1' },
  );
  assert.equal(
    (
      await D.test(
        {},
        exec({
          version: () => ({ code: 0, stdout: '27\n', stderr: '' }),
          image: () => ({ code: 0, stdout: 'sha256:abc', stderr: '' }),
        }),
      )
    ).imagePresent,
    true,
  );
  assert.equal((await D.test({ image: '--bad' }, exec({}))).ok, false);
});
