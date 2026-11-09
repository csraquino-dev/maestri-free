'use strict';
// Prompter backend: file index for @-mentions, mention targets (connected nodes, floors, routines…)
// and delivery of the composed prompt to a terminal.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.open-maestri',
  '.cache',
  '.idea',
  '.vs',
  'coverage',
]);
const MAX_FILES = 8000;
const MAX_DEPTH = 8;

// Async + time-boxed: a huge folder (e.g. a home directory) returns what it found in time, flagged as truncated,
// and never blocks the main process.
async function fileIndex(root, { budgetMs = 1200 } = {}) {
  const files = [];
  let truncated = false;
  if (!root || !fs.existsSync(root)) return { files, truncated, error: 'missing' };
  const deadline = Date.now() + budgetMs;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    if (Date.now() > deadline) return { files, truncated: true };
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github' && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) return { files, truncated: true };
        files.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  }
  return { files, truncated };
}

function createPrompter({ workspaces, terminals, routines }) {
  function mentionTargets(wsId, terminalId) {
    const doc = workspaces.getDoc(wsId);
    if (!doc) return null;
    const conns = workspaces.connectionsOf(doc, terminalId);
    const name = (n) => {
      const i = n.content[Object.keys(n.content)[0]]._0;
      return i.name || (i.fileName || '').replace(/\.md$/i, '');
    };
    const pick = (ids, filter) =>
      ids
        .map((id) => workspaces.findNode(doc, id))
        .filter(Boolean)
        .filter(filter);
    return {
      agents: pick(conns.agents, (n) => n.content.terminal).map((n) => ({ id: n.id, name: name(n) })),
      notes: pick(conns.notes, (n) => n.content.stickyNote).map((n) => ({
        id: n.id,
        name: name(n),
        path: workspaces.notePath(doc, n),
      })),
      portals: pick(conns.portals, (n) => n.content.portal).map((n) => ({
        id: n.id,
        name: name(n),
        url: n.content.portal._0.currentURL,
      })),
      floors: [{ id: null, name: 'Ground' }, ...doc.payload.floors.map((f) => ({ id: f.id, name: f.name }))],
      workspaces: workspaces.list().map((w) => ({ id: w.id, name: w.name })),
      routines: routines ? routines.list(wsId).map((r) => ({ id: r.id, name: r.name })) : [],
    };
  }

  async function deliver(terminalId, text) {
    const s = terminals.get(terminalId);
    if (!s || !s.alive) return { ok: false, reason: 'notRunning' };
    const body = String(text).replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!body) return { ok: false, reason: 'empty' };
    s.markActiveTask();
    if (body.includes('\n')) {
      s.write(`\x1b[200~${body}\x1b[201~`); // bracketed paste keeps multi-line prompts in one piece
      await new Promise((r) => setTimeout(r, 120));
      s.write('\r');
    } else {
      s.write(body + '\r');
    }
    return { ok: true };
  }

  return { mentionTargets, deliver, fileIndex };
}

module.exports = { createPrompter, fileIndex };
