'use strict';
// Inter-agent IPC server: HTTP on 127.0.0.1 (dynamic port), single route POST /cli.
// Windows has no practical equivalent of the macOS unix socket, so the CLI uses TCP
// via MAESTRI_SERVER_PORT. Loopback only — never reachable from other machines.
const http = require('http');
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');

const MAX_BODY = 4 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function startServer(route) {
  const server = http.createServer((req, res) => {
    // Only accept loopback peers (defence in depth; we also bind to 127.0.0.1).
    const peer = req.socket.remoteAddress || '';
    if (!(peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/cli') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end('payload too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      let args = [];
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (Array.isArray(body.args)) args = body.args.map(String);
      } catch {
        /* handled below */
      }
      const raw = String(req.headers['x-terminal-id'] || '');
      const tid = UUID_RE.test(raw) ? raw.toUpperCase() : null;
      const out = args.length ? await route(args, tid) : 'error: missing args';
      const buf = Buffer.from(out, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        Connection: 'close',
      });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      try {
        persistence.ensureDir(persistence.paths.runDir());
        fs.writeFileSync(path.join(persistence.paths.runDir(), 'port'), String(port));
      } catch {
        /* informational only */
      }
      resolve({ server, port });
    });
  });
}

module.exports = { startServer };
