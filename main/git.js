'use strict';
const { execFile } = require('child_process');

// Never throws: resolves {code, stdout, stderr}.
function git(cwd, args, { timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const cp = execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && err.code === 'ENOENT' ? 'git not found in PATH' : '')),
        });
      },
    );
    if (input != null) cp.stdin.end(input);
  });
}

const out = (r) => r.stdout.trim();

module.exports = { git, out };
