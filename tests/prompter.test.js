'use strict';
// Saved prompts, prompt ranking and the prompter backend (file index, mention targets, delivery to a real shell).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-pr-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));

const { createSavedPrompts } = require('../main/saved-prompts');
const { fileIndex, createPrompter } = require('../main/prompter');
const { createCore } = require('../main/core');
const rank = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'prompt-rank.js')).href);

test.after(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

// ------------------------------------------------------------------ saved prompts
test('saved prompts: save, read back, scope, rename, delete + undo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-sp-'));
  const ws = 'AAAAAAAA-0000-0000-0000-000000000001';
  const sp = createSavedPrompts({ rootDir: root, workspaceIds: () => [ws] });
  const a = sp.save({ name: 'Code Review!', description: 'Review a diff', text: 'Review this diff carefully.' });
  assert.equal(a.name, 'code-review');
  assert.equal(a.description, 'Review a diff');
  assert.equal(a.workspaceId, null);
  assert.match(
    fs.readFileSync(path.join(root, 'prompts', 'code-review.md'), 'utf8'),
    /^---\ndescription: Review a diff\n---\nReview this diff carefully\.\n$/,
  );
  const b = sp.save({ name: 'Deploy', text: 'Deploy to staging', workspaceId: ws });
  assert.equal(b.id, `${ws}:deploy`);
  assert.deepEqual(
    sp.visible(ws).map((p) => p.name),
    ['deploy', 'code-review'],
    'workspace prompts first, then global',
  );
  assert.deepEqual(
    sp.visible(null).map((p) => p.name),
    ['code-review'],
    'global only elsewhere',
  );
  assert.equal(sp.availableName('Code Review', null), 'code-review-2');
  assert.equal(sp.availableName('Code Review', null, a.id), 'code-review', 'editing keeps its own name');
  const renamed = sp.save({ id: a.id, name: 'Review PR', description: '', text: 'x' });
  assert.equal(renamed.name, 'review-pr');
  assert.ok(!fs.existsSync(path.join(root, 'prompts', 'code-review.md')), 'old file removed on rename');
  assert.ok(sp.remove(renamed.id));
  assert.deepEqual(sp.visible(null), []);
  assert.equal(sp.undoDelete().name, 'review-pr');
  assert.equal(sp.visible(null).length, 1);
  assert.throws(
    () => sp.save({ name: 'x', text: '   ' }),
    (e) => e.code === 'emptyText',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('saved prompts: a broken file never hides the others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-sp-'));
  const sp = createSavedPrompts({ rootDir: root });
  sp.save({ name: 'ok', text: 'fine' });
  fs.writeFileSync(path.join(root, 'prompts', 'bad.md'), '---\ndescription: never closed\nbody');
  assert.deepEqual(
    sp.visible(null).map((p) => p.name),
    ['ok'],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('prompt ranking: starts-with, contains, description, text; workspace before global', async () => {
  const { rankSavedPrompts, savedPromptRows } = await rank();
  const P = (name, extra = {}) => ({ name, description: '', text: '', workspaceId: null, ...extra });
  const list = [
    P('write-tests'),
    P('test-plan'),
    P('refactor', { description: 'make tests pass' }),
    P('docs', { text: 'document the tests' }),
    P('unit-testing', { workspaceId: 'w' }),
  ];
  assert.deepEqual(
    rankSavedPrompts(list, 'test').map((p) => p.name),
    ['unit-testing', 'test-plan', 'write-tests', 'refactor', 'docs'],
  );
  assert.deepEqual(rankSavedPrompts(list, 'zzz'), []);
  assert.equal(rankSavedPrompts(list, '  ').length, 5);
  assert.deepEqual(
    rankSavedPrompts(list, 'test plan').map((p) => p.name),
    ['test-plan'],
    'dashes match spaces',
  );
  assert.equal(savedPromptRows([], '', null)[0].kind, 'create');
  assert.deepEqual(savedPromptRows([], 'zzz', null), []);
  assert.deepEqual(
    savedPromptRows(list, '', list[0]).map((r) => r.kind),
    ['edit', 'delete'],
  );
});

// ------------------------------------------------------------------------ file index
test('file index skips noise, uses forward slashes and truncates huge trees', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-fi-'));
  const w = (rel, t = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, t);
  };
  w('src/app.js');
  w('src/lib/util.js');
  w('README.md');
  w('node_modules/pkg/index.js');
  w('.git/config');
  w('dist/out.js');
  w('.github/workflows/ci.yml');
  const idx = await fileIndex(root);
  assert.deepEqual(idx.files.sort(), ['.github/workflows/ci.yml', 'README.md', 'src/app.js', 'src/lib/util.js']);
  assert.equal(idx.truncated, false);
  assert.equal((await fileIndex(path.join(root, 'nope'))).error, 'missing');
  const tiny = await fileIndex(root, { budgetMs: -1 });
  assert.equal(tiny.truncated, true, 'an exhausted time budget returns a partial, flagged result');
  fs.rmSync(root, { recursive: true, force: true });
});

// ----------------------------------------------------------- targets + delivery
test('mention targets and delivery to a terminal (single line and multi-line)', async () => {
  const core = await createCore();
  const ws = core.workspaces;
  const doc = ws.activeDoc;
  const A = ws.addTerminal(doc, { name: 'Boss', workingDirectory: os.tmpdir() });
  const B = ws.addTerminal(doc, { name: 'Builder', workingDirectory: os.tmpdir() }, A.id);
  const N = ws.addNote(doc, { name: 'Spec', content: 'hello', anchorId: A.id });
  ws.connect(doc, A.id, B.id);
  ws.connect(doc, A.id, N.id);
  core.startWorkspaceTerminals(ws.activeId);
  await new Promise((r) => setTimeout(r, 3500));
  const p = createPrompter({ workspaces: ws, terminals: core.terminals, routines: core.routines });
  const t = p.mentionTargets(ws.activeId, A.id);
  assert.deepEqual(
    t.agents.map((x) => x.name),
    ['Builder'],
  );
  assert.equal(t.notes[0].name, 'Spec');
  assert.ok(fs.existsSync(t.notes[0].path));
  assert.equal(t.floors[0].name, 'Ground');

  assert.deepEqual(await p.deliver(B.id, 'Write-Output "single-line-ok"'), { ok: true });
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(core.terminals.get(B.id).screenText(), /single-line-ok/);
  assert.deepEqual(await p.deliver(B.id, 'Write-Output "multi-1"\nWrite-Output "multi-2"'), { ok: true });
  await new Promise((r) => setTimeout(r, 2500));
  const screen = core.terminals.get(B.id).screenText();
  assert.match(screen, /multi-1/);
  assert.match(screen, /multi-2/);
  assert.deepEqual(await p.deliver(B.id, '   '), { ok: false, reason: 'empty' });
  core.terminals.remove(B.id);
  assert.deepEqual(await p.deliver(B.id, 'x'), { ok: false, reason: 'notRunning' });
  await core.shutdown();
});
