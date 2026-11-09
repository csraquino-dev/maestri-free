'use strict';
// Saved prompts: markdown files (optional `description:` frontmatter) — global ones in ~/.open-maestri/prompts,
// workspace-scoped ones in workspaces/<id>/prompts. The file name (kebab-case) is the prompt's name.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');

const MAX_BYTES = 256 * 1024;
const EXT = '.md';

const slug = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'prompt';

function createSavedPrompts({ rootDir = persistence.paths.root, workspaceIds = () => [] } = {}) {
  const globalDir = () => path.join(rootDir, 'prompts');
  const wsDir = (id) => path.join(rootDir, 'workspaces', id, 'prompts');
  const dirOf = (workspaceId) => (workspaceId ? wsDir(workspaceId) : globalDir());
  let lastDeleted = null;

  function parse(file, workspaceId) {
    const raw = fs.readFileSync(file, 'utf8');
    let description = '';
    let text = raw;
    if (raw.startsWith('---')) {
      const end = raw.indexOf('\n---', 3);
      if (end < 0) {
        const e = new Error('unclosedFrontmatter');
        e.code = 'unclosedFrontmatter';
        throw e;
      }
      const front = raw.slice(3, end);
      const m = /^\s*description:\s*(.*)$/m.exec(front);
      description = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      text = raw.slice(end + 4).replace(/^\r?\n/, '');
    }
    const name = path.basename(file, EXT);
    return {
      id: `${workspaceId || 'global'}:${name}`,
      name,
      description,
      text: text.replace(/\s+$/, ''),
      workspaceId: workspaceId || null,
    };
  }

  function readDir(dir, workspaceId) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(EXT)) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        out.push(parse(p, workspaceId));
      } catch {
        /* a broken file never hides the others */
      }
    }
    return out;
  }

  // Prompts visible from a workspace: its own first, then the global ones.
  function visible(workspaceId) {
    return [...(workspaceId ? readDir(wsDir(workspaceId), workspaceId) : []), ...readDir(globalDir(), null)];
  }

  function all() {
    return [...workspaceIds().flatMap((id) => readDir(wsDir(id), id)), ...readDir(globalDir(), null)];
  }

  function availableName(name, workspaceId, excludingId = null) {
    const base = slug(name);
    const taken = new Set(
      readDir(dirOf(workspaceId), workspaceId)
        .filter((p) => p.id !== excludingId)
        .map((p) => p.name),
    );
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now()}`;
  }

  function save({ id = null, name, description = '', text, workspaceId = null }) {
    if (!String(text || '').trim()) {
      const e = new Error('emptyText');
      e.code = 'emptyText';
      throw e;
    }
    const finalName = availableName(name, workspaceId, id);
    const dir = dirOf(workspaceId);
    persistence.ensureDir(dir);
    const front = description.trim() ? `---\ndescription: ${description.trim().replace(/\n/g, ' ')}\n---\n` : '';
    persistence.writeFileAtomic(path.join(dir, finalName + EXT), front + String(text).trim() + '\n');
    // renamed or moved between scopes: remove the old file
    if (id) {
      const old = all().find((p) => p.id === id);
      const newId = `${workspaceId || 'global'}:${finalName}`;
      if (old && old.id !== newId) fs.rmSync(path.join(dirOf(old.workspaceId), old.name + EXT), { force: true });
    }
    return parse(path.join(dir, finalName + EXT), workspaceId);
  }

  function remove(id) {
    const p = all().find((x) => x.id === id);
    if (!p) return false;
    lastDeleted = p;
    fs.rmSync(path.join(dirOf(p.workspaceId), p.name + EXT), { force: true });
    return true;
  }

  function undoDelete() {
    if (!lastDeleted) return null;
    const p = lastDeleted;
    lastDeleted = null;
    return save({ name: p.name, description: p.description, text: p.text, workspaceId: p.workspaceId });
  }

  return { visible, all, save, remove, undoDelete, availableName, slug, globalDir };
}

module.exports = { createSavedPrompts, slug };
