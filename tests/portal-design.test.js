'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../main/portal-design');

const PNG =
  'data:image/png;base64,' +
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString('base64');

test('only terminals connected to that portal are targets', () => {
  const doc = {
    payload: {
      portalConnections: [
        { terminalId: 'a', portalNodeId: 'p1' },
        { terminalId: 'b', portalNodeId: 'p2' },
        { terminalId: 'a', portalNodeId: 'p1' },
      ],
    },
  };
  assert.deepEqual(D.connectedTerminalIds(doc, 'p1'), ['a']);
  assert.deepEqual(D.connectedTerminalIds(doc, 'nope'), []);
});

test('the prompt names the page, element, styles, screenshot and the request', () => {
  const p = D.buildPrompt({
    url: 'http://localhost:3000/',
    title: 'Loja',
    element: {
      selector: '#buy',
      rect: { x: 40, y: 40, w: 120, h: 40 },
      text: 'Comprar',
      html: '<button id="buy">Comprar</button>',
      styles: { color: 'rgb(0, 0, 0)', display: 'block', border: '' },
    },
    others: [{ selector: 'body > div' }],
    instruction: 'make it green',
    screenshot: 'C:/x/shot.png',
  });
  for (const part of [
    '[Portal design]',
    'Loja — http://localhost:3000/',
    'Selected element: #buy  (40,40 120×40)',
    'Text: Comprar',
    'color: rgb(0, 0, 0); display: block',
    'HTML: <button id="buy">',
    'Nearby candidates: body > div',
    'Screenshot: C:/x/shot.png',
    'Request: make it green',
  ])
    assert.ok(p.includes(part), `missing ${part}\n${p}`);
  assert.ok(!p.includes('border:'), 'empty style values are skipped');
  assert.match(D.buildPrompt({ url: 'u' }), /Request: \(look at the selected element\)/);
});

test('screenshots must really be PNGs and land in the screenshots folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-pd-'));
  try {
    const f = D.saveScreenshot(dir, PNG);
    assert.ok(f && fs.existsSync(f) && f.startsWith(dir));
    assert.equal(
      D.saveScreenshot(dir, 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64')),
      null,
    );
    assert.equal(D.saveScreenshot(dir, null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send delivers the prompt to every connected terminal and reports how many accepted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-pd-'));
  try {
    const doc = {
      payload: {
        portalConnections: [
          { terminalId: 't1', portalNodeId: 'p' },
          { terminalId: 't2', portalNodeId: 'p' },
        ],
      },
    };
    const got = [];
    const deliver = async (tid, text) => {
      got.push([tid, text]);
      return { ok: tid === 't1' };
    };
    const r = await D.send({
      doc,
      portalId: 'p',
      payload: {
        url: 'u',
        element: { selector: 'h1', rect: { x: 0, y: 0, w: 1, h: 1 } },
        instruction: 'bigger',
        png: PNG,
      },
      deliver,
      screenshotsDir: dir,
    });
    assert.equal(r.ok, true);
    assert.equal(r.sentTo, 1);
    assert.equal(r.connected, 2);
    assert.equal(got.length, 2);
    assert.match(got[0][1], /Request: bigger/);
    assert.ok(r.screenshot && fs.existsSync(r.screenshot));
    const none = await D.send({
      doc: { payload: { portalConnections: [] } },
      portalId: 'p',
      payload: { url: 'u' },
      deliver,
      screenshotsDir: dir,
    });
    assert.equal(none.ok, false);
    assert.equal(none.connected, 0);
    const copy = await D.send({
      doc,
      portalId: 'p',
      payload: { url: 'u' },
      deliver,
      screenshotsDir: dir,
      copyOnly: true,
    });
    assert.equal(copy.ok, true);
    assert.equal(got.length, 2, 'copy does not deliver');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
