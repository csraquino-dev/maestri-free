'use strict';
// Backups: a single self-describing JSON bundle with every workspace (document + note files),
// preferences and routines. Hourly auto-backup, manual backup, export and import.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');

const FORMAT = 'open-maestri-backup';
const dir = () => path.join(persistence.paths.root, 'backups');
const KEEP = 24;

function collect({ workspaces, prefs, routines }) {
  const items = [];
  for (const e of workspaces.list()) {
    const doc = workspaces.getDoc(e.id);
    if (!doc) continue;
    const notes = {};
    const nd = persistence.paths.notesDir(e.id);
    if (fs.existsSync(nd)) {
      for (const f of fs.readdirSync(nd)) {
        const p = path.join(nd, f);
        if (fs.statSync(p).isFile() && /\.(md|txt)$/i.test(f)) notes[f] = fs.readFileSync(p, 'utf8');
      }
    }
    items.push({ entry: e, document: doc, notes });
  }
  return {
    format: FORMAT,
    version: 1,
    createdAt: persistence.now(),
    preferences: prefs(),
    routines: routines.items,
    workspaces: items,
  };
}

function createBackups(ctx) {
  const write = (file, bundle) => persistence.writeFileAtomic(file, JSON.stringify(bundle));
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  function now(reason = 'manual') {
    ctx.save();
    const bundle = collect(ctx);
    bundle.reason = reason;
    const file = path.join(dir(), `backup-${stamp()}-${reason}.json`);
    write(file, bundle);
    prune();
    return { file, createdAt: bundle.createdAt, workspaces: bundle.workspaces.length };
  }

  function list() {
    if (!fs.existsSync(dir())) return [];
    return fs
      .readdirSync(dir())
      .filter((f) => /^backup-.*\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir(), f));
        return { name: f, file: path.join(dir(), f), size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  function prune() {
    for (const b of list().slice(KEEP)) fs.rmSync(b.file, { force: true });
  }

  function exportTo(target) {
    ctx.save();
    write(target, collect(ctx));
    return target;
  }

  // Merge a bundle: workspaces with the same id are replaced, others are added.
  function importFrom(file) {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!b || b.format !== FORMAT || !Array.isArray(b.workspaces)) throw new Error('not an open-maestri backup file');
    const replaced = [];
    for (const w of b.workspaces) {
      const id = w.entry && w.entry.id;
      if (!id || !/^[0-9A-Fa-f-]{36}$/.test(id) || !w.document || !w.document.payload) continue; // ids become folder names: validate
      const nd = persistence.paths.notesDir(id);
      persistence.ensureDir(nd);
      persistence.ensureDir(persistence.paths.terminalsDir(id));
      for (const [name, text] of Object.entries(w.notes || {})) {
        if (name !== path.basename(name)) continue; // no path traversal
        fs.writeFileSync(path.join(nd, name), String(text));
      }
      persistence.saveWorkspace(w.document);
      const idx = ctx.workspaces.manifest.workspaces.findIndex((x) => x.id === id);
      if (idx >= 0) {
        ctx.workspaces.manifest.workspaces[idx] = w.entry;
        replaced.push(id);
      } else ctx.workspaces.manifest.workspaces.push(w.entry);
      ctx.workspaces.docs.delete(id);
      ctx.workspaces.dirty.delete(id);
    }
    persistence.saveManifest(ctx.workspaces.manifest);
    if (Array.isArray(b.routines)) {
      const have = new Set(ctx.routines.items.map((r) => r.id));
      for (const r of b.routines) if (!have.has(r.id)) ctx.routines.items.push(r);
      ctx.routines.save();
    }
    return { workspaces: b.workspaces.length, replaced };
  }

  function autoStart() {
    const l = list();
    if (!l.length || Date.now() - Date.parse(l[0].mtime) > 3600 * 1000) {
      try {
        now('auto');
      } catch (e) {
        console.error('auto backup failed', e);
      }
    }
    const t = setInterval(() => {
      try {
        now('auto');
      } catch (e) {
        console.error('auto backup failed', e);
      }
    }, 3600 * 1000);
    t.unref();
    return t;
  }

  return { now, list, exportTo, importFrom, autoStart, dir };
}

module.exports = { createBackups };
