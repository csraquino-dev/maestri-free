'use strict';
// Docker sandbox terminals: the agent runs inside a throw-away container with the working folder mounted.
const { spawn } = require('child_process');

const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/;
const SHELL_RE = /^[a-zA-Z0-9_./][a-zA-Z0-9_./-]{0,99}$/;
const DEFAULT_IMAGE = 'node:22';

function validate(cfg) {
  const image = String((cfg && cfg.image) || DEFAULT_IMAGE).trim();
  const shell = String((cfg && cfg.shell) || '/bin/bash').trim();
  if (!IMAGE_RE.test(image)) throw new Error(`invalid Docker image name: ${image}`);
  if (!SHELL_RE.test(shell)) throw new Error(`invalid shell path: ${shell}`);
  return {
    image,
    shell,
    mount: !cfg || cfg.mount !== false,
    network: cfg && cfg.network === 'none' ? 'none' : 'bridge',
  };
}

// `docker run` arguments for a sandbox terminal. cwd is only mounted when asked for.
function runArgs(cfg, { terminalId = '', cwd = '' } = {}) {
  const c = validate(cfg);
  const args = ['run', '-it', '--rm'];
  const short = String(terminalId)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase();
  if (short) args.push('--name', `omaestri-${short}`);
  if (c.network === 'none') args.push('--network', 'none');
  if (c.mount && cwd) args.push('-v', `${cwd}:/workspace`, '-w', '/workspace');
  args.push(c.image, c.shell);
  return args;
}

function defaultExec(args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '',
      err = '';
    let child;
    try {
      child = spawn('docker', args, { windowsHide: true });
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
    }, timeout);
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
        stdout: out,
        stderr: e.code === 'ENOENT' ? 'docker is not installed or not on PATH' : e.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

// Is the Docker daemon reachable, and is the image already here?
async function test(cfg, exec = defaultExec) {
  let c;
  try {
    c = validate(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const v = await exec(['version', '--format', '{{.Server.Version}}']);
  if (v.code !== 0)
    return { ok: false, error: (v.stderr || v.stdout || 'docker did not answer').trim().split('\n')[0] };
  const i = await exec(['image', 'inspect', c.image, '--format', '{{.Id}}']);
  return { ok: true, version: v.stdout.trim(), imagePresent: i.code === 0, image: c.image };
}

module.exports = { validate, runArgs, test, DEFAULT_IMAGE };
