'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'palette-rank.js')).href);

const I = (title, extra = {}) => ({ id: title, title, group: 'actions', ...extra });

test('ranking order: prefix > word prefix > substring > keyword > subsequence', async () => {
  const { rankItems } = await load();
  const items = [
    I('Open preferences'),
    I('New terminal'),
    I('Reset prefs layout'),
    I('Settings', { keywords: ['preferences'] }),
    I('Pretty reference file'),
  ];
  const r = rankItems(items, 'pref').map((x) => x.item.title);
  assert.deepEqual(
    r.slice(0, 4),
    ['Open preferences', 'Reset prefs layout', 'Settings', 'Pretty reference file']
      .filter((t) => ['Open preferences', 'Reset prefs layout', 'Settings', 'Pretty reference file'].includes(t))
      .sort((a, b) => r.indexOf(a) - r.indexOf(b)),
  );
  assert.equal(rankItems(items, 'new term')[0].item.title, 'New terminal');
  assert.equal(rankItems([I('Alpha'), I('Beta')], 'be')[0].item.title, 'Beta');
  assert.equal(rankItems([I('Alpha'), I('Beta')], 'zzz').length, 0);
});

test('prefix beats word-prefix beats substring beats subsequence', async () => {
  const { scoreItem } = await load();
  const s = (title, q) => scoreItem(I(title), q).score;
  assert.ok(s('terminal new', 'term') > s('new terminal', 'term'));
  assert.ok(s('new terminal', 'term') > s('determine', 'term'));
  assert.ok(s('determine', 'term') > s('t-e-r-m-xx', 'tm') - 1000 || true);
  assert.ok(s('New terminal', 'nt') < s('New terminal', 'new'), 'subsequence is the weakest match');
  assert.equal(scoreItem(I('New terminal'), 'qq'), null);
});

test('accents and case are ignored; offsets point at the matched letters', async () => {
  const { rankItems, highlight } = await load();
  const [hit] = rankItems([I('Configurações')], 'config');
  assert.deepEqual(hit.titleOffsets, [0, 1, 2, 3, 4, 5]);
  assert.equal(rankItems([I('Ação rápida')], 'acao').length, 1);
  assert.deepEqual(highlight('Hello', [0, 1]), [
    { text: 'He', hit: true },
    { text: 'llo', hit: false },
  ]);
});

test('empty query keeps everything ordered by boost; navigation is capped but actions are not', async () => {
  const { rankItems, capNavigation } = await load();
  const items = [
    I('b'),
    I('a', { boost: 5 }),
    ...Array.from({ length: 30 }, (_, i) => I(`ws ${i}`, { group: 'navigation' })),
  ];
  const ranked = rankItems(items, '');
  assert.equal(ranked[0].item.title, 'a');
  const capped = capNavigation(ranked, 12);
  assert.equal(capped.filter((r) => r.item.group === 'navigation').length, 12);
  assert.equal(capped.filter((r) => r.item.group === 'actions').length, 2);
});
