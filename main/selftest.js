'use strict';
// `npm run selftest`: boots the real UI, builds a small canvas through the same code paths the CLI
// uses, drives the portal through `omaestri portal ...`, saves a screenshot and a JSON report.
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run({ win, core, app }) {
  const out = process.env.SELFTEST_OUT || path.join(os.tmpdir(), 'omaestri-selftest');
  fs.mkdirSync(out, { recursive: true });
  const report = { steps: [], consoleErrors: [], ok: true };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    if (!ok) report.ok = false;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2 && !/Electron Security Warning|Autofill/.test(message))
      report.consoleErrors.push(`${message} (${path.basename(source)}:${line})`);
  });

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    for (let i = 0; i < 50; i++) {
      if (await win.webContents.executeJavaScript('!!window.__omaestri')) break;
      await sleep(100);
    }
    step('renderer booted', await win.webContents.executeJavaScript('!!window.__omaestri'));

    const ws = core.workspaces;
    const id = ws.activeId;
    const doc = ws.activeDoc;
    const boss = ws.addTerminal(doc, {
      name: 'Boss',
      workingDirectory: os.homedir(),
      isManager: true,
      rect: { x: 9900, y: 8600, w: 620, h: 380 },
    });
    const worker = ws.addTerminal(doc, {
      name: 'Builder',
      workingDirectory: os.homedir(),
      rect: { x: 10600, y: 8600, w: 520, h: 380 },
    });
    const note = ws.addNote(doc, {
      name: 'Spec',
      content: '# Spec\n\n- item **one**\n- item two',
      rect: { x: 9900, y: 9060, w: 300, h: 200 },
    });
    const fixture = require('url').pathToFileURL(path.join(__dirname, '..', 'tests', 'fixtures', 'portal.html')).href;
    const portal = ws.addPortal(doc, { name: 'Browser', url: fixture, rect: { x: 10300, y: 9060, w: 560, h: 380 } });
    ws.addFileTree(doc, {
      name: 'Project',
      rootPath: path.join(__dirname, '..'),
      rect: { x: 10920, y: 9060, w: 260, h: 380 },
    });
    ws.connect(doc, boss.id, worker.id);
    ws.connect(doc, boss.id, note.id);
    ws.connect(doc, boss.id, portal.id);
    ws.changed(id);
    core.startWorkspaceTerminals(id);
    await sleep(5000);

    const counts = await win.webContents.executeJavaScript(
      `({nodes: document.querySelectorAll('.node').length, xterms: document.querySelectorAll('.node.terminal .xterm').length, webviews: document.querySelectorAll('webview').length, ropes: document.querySelectorAll('path.rope').length, ftRows: document.querySelectorAll('.ft-row').length})`,
    );
    step('nodes rendered', counts.nodes === 5, JSON.stringify(counts));
    step('xterm mounted for both terminals', counts.xterms === 2);
    step('webview mounted', counts.webviews === 1);
    step('ropes drawn', counts.ropes === 3);
    step('file tree populated', counts.ftRows > 3);

    // terminal output visible in the DOM (rendered by xterm)
    core.terminals.write(worker.id, 'Write-Output "ui-test-marker"\r');
    await sleep(2000);
    const termText = core.terminals.get(worker.id).screenText();
    step('worker shell produced output', /ui-test-marker/.test(termText));

    // portal automation through the real CLI router
    const call = (...a) => core.handlers.route(a, boss.id);
    const snap = await call('portal', 'snapshot', 'Browser');
    step(
      'portal snapshot lists elements',
      /\[@e\d+\] button "Click me"/.test(snap),
      snap.split('\n').slice(0, 6).join(' | '),
    );
    const input = /\[@e(\d+)\] textbox/.exec(snap);
    const button = /\[@e(\d+)\] button "Click me"/.exec(snap);
    if (input)
      step('portal fill', /filled/.test(await call('portal', 'fill', 'Browser', `@e${input[1]}`, 'hello windows')));
    if (button) step('portal click', /clicked/.test(await call('portal', 'click', 'Browser', `@e${button[1]}`)));
    await sleep(400);
    step(
      'portal evaluate sees click + fill',
      (await call('portal', 'evaluate', 'Browser', 'document.getElementById("out").textContent')) ===
        'clicked:hello windows',
    );
    step('portal info', /title: Portal Fixture/.test(await call('portal', 'info', 'Browser')));
    const shot = await call('portal', 'screenshot', 'Browser');
    step('portal screenshot returns PNG base64', shot.startsWith('iVBOR'), `${shot.length} chars`);

    // canvas interaction: drag node via synthetic mouse events
    const moved = await win.webContents.executeJavaScript(`(async () => {
      const h = document.querySelector('.node.note .node-head'); const n = window.__omaestri.S.doc.payload.nodes.find(x => x.content.stickyNote);
      const before = n.frame[0][0]; const r = h.getBoundingClientRect();
      h.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, button:0, clientX:r.left+20, clientY:r.top+10}));
      window.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+120, clientY:r.top+10}));
      window.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
      return n.frame[0][0] - before; })()`);
    step('node drag moves the node', moved > 50, `dx=${moved}`);

    win.showInactive(); // a hidden window does not repaint, so screenshots would be stale
    await sleep(500);
    const fit = await win.webContents.executeJavaScript(
      '(() => { const vp = document.getElementById("viewport").getBoundingClientRect(); window.__omaestri.canvas.fitAll(); return { zoom: window.__omaestri.S.view.zoom, vw: vp.width, vh: vp.height, label: document.getElementById("zoom-label").textContent }; })()',
    );
    step('fit changes zoom to show every node', fit.zoom < 1 && fit.zoom > 0.1, JSON.stringify(fit));
    await sleep(800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, 'ui.png'), img.toPNG());
    step('screenshot saved', true, path.join(out, 'ui.png'));

    // ---- Portuguese UI + SVG icons
    const ui = await win.webContents.executeJavaScript(`(() => {
      const txt = (s) => (document.querySelector(s) || {}).textContent;
      return {
        lang: document.documentElement.lang,
        terminalBtn: txt('[data-add=terminal]'), routines: document.getElementById('btn-routines').title, prefs: document.getElementById('btn-prefs').title, ws: txt('.side-label'),
        ground: txt('.floor-tab'), undoTitle: document.getElementById('btn-undo').title,
        svgCount: document.querySelectorAll('.ico svg').length,
        oldGlyphs: /[▣▤▦◍⚙↻✕✎＋⌁⤢]/.test(document.body.innerText),
      }; })()`);
    step(
      'UI is in Portuguese',
      ui.lang === 'pt-BR' &&
        ui.routines.trim() === 'Rotinas' &&
        ui.prefs.trim() === 'Preferências' &&
        ui.ws === 'Espaços de trabalho' &&
        ui.ground.trim().startsWith('Térreo') &&
        /Desfazer/.test(ui.undoTitle),
      JSON.stringify(ui),
    );
    step('icons are SVG (no text glyphs)', ui.svgCount > 25 && !ui.oldGlyphs, `svg=${ui.svgCount}`);

    // ---- floors: real git repo → worktree → separate canvas
    const { execFileSync } = require('child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-st-repo-'));
    const g = (...a) => execFileSync('git', a, { cwd: repo, windowsHide: true, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    core.workspaces.update(id, { workingDirectory: repo });
    const fl = await core.floors.create(id, { name: 'Feature A' });
    core.workspaces.addNote(core.workspaces.activeDoc, { name: 'OnFloor', floorId: fl.floor.id });
    core.workspaces.changed(id);
    await sleep(800);
    const f1 = await win.webContents.executeJavaScript(`(async () => { const o = window.__omaestri;
      const tabs = [...document.querySelectorAll('.floor-tab')].map(t => t.textContent);
      o.setFloor(${JSON.stringify(fl.floor.id)}); await new Promise(r => setTimeout(r, 400));
      const onFloor = document.querySelectorAll('.node').length;
      o.setFloor(null); await new Promise(r => setTimeout(r, 400));
      return { tabs, onFloor, ground: document.querySelectorAll('.node').length }; })()`);
    step(
      'floor tab appears and canvases are separate',
      f1.tabs.length === 2 && /Feature A/.test(f1.tabs[1]) && f1.onFloor === 1 && f1.ground === 5,
      JSON.stringify(f1),
    );

    // ---- routines dialog + undo
    core.routines.create({
      name: 'Daily check',
      workspaceId: id,
      terminalId: worker.id,
      command: 'echo hi',
      schedule: { kind: 'daily', hour: 9, minute: 30 },
    });
    const rd = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('btn-routines').click(); await new Promise(r => setTimeout(r, 500));
      const m = document.querySelector('.modal'); return { title: m && m.querySelector('h3').textContent, body: m && m.innerText }; })()`);
    step(
      'routines dialog lists the routine in Portuguese',
      rd.title === 'Rotinas' && /Daily check/.test(rd.body) && /todo dia às 09:30/.test(rd.body),
      JSON.stringify(rd).slice(0, 200),
    );
    win.showInactive();
    fs.writeFileSync(path.join(out, 'routines.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('.modal .btn-x').click()`);
    const before = await win.webContents.executeJavaScript('window.__omaestri.S.doc.payload.nodes.length');
    await win.webContents.executeJavaScript(`window.__omaestri.addNode('note')`);
    await sleep(500);
    await win.webContents.executeJavaScript(`document.getElementById('btn-undo').click()`);
    await sleep(600);
    const after = await win.webContents.executeJavaScript('window.__omaestri.S.doc.payload.nodes.length');
    step('undo button reverts the last structural change', before === after, `${before} -> ${after}`);
    await win.webContents.executeJavaScript(`window.__omaestri.setFloor(${JSON.stringify(fl.floor.id)})`);
    await sleep(500);
    fs.writeFileSync(path.join(out, 'floor.png'), (await win.webContents.capturePage()).toPNG());
    // ---- floor overview + cross-floor connection
    core.workspaces.addTerminal(core.workspaces.activeDoc, {
      name: 'FloorT',
      workingDirectory: os.tmpdir(),
      floorId: fl.floor.id,
    });
    core.workspaces.changed(id);
    await sleep(500);
    const ov = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const o = window.__omaestri;
      o.setFloor(null); await wait(300);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await wait(500);
      const m = document.querySelector('.ov');
      if (!m) return { opened: false };
      const cards = m.querySelectorAll('.ov-card').length;
      const chips = [...m.querySelectorAll('.ov-chip')];
      const ground = chips.find(c => !c.closest('.ov-card').querySelector('.ov-branch'));
      const other = chips.find(c => c.textContent.includes('FloorT'));
      ground.click(); await wait(200); other.click(); await wait(700);
      const links = m.querySelectorAll('.ov-rope').length;
      const conns = o.S.doc.payload.crossFloorConnections.length;
      document.querySelector('.ov .btn-x').click(); await wait(300);
      await wait(400);
      const connectorsOnGround = document.querySelectorAll('.node.connector').length;
      const label = (document.querySelector('.node.connector .cf-label') || {}).textContent;
      const ropes = document.querySelectorAll('#ropes .rope').length;
      return { opened: true, cards, links, conns, connectorsOnGround, label, ropes }; })()`);
    step(
      'floor overview: opens with Ctrl+Shift+\\, connects terminals across floors, connector + rope on the floor',
      ov.opened &&
        ov.cards === 2 &&
        ov.links === 1 &&
        ov.conns === 1 &&
        ov.connectorsOnGround === 1 &&
        /FloorT/.test(ov.label || '') &&
        ov.ropes >= 1,
      JSON.stringify(ov),
    );
    fs.writeFileSync(path.join(out, 'overview-ground.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(
      `(async () => { const o = window.__omaestri; document.dispatchEvent(new KeyboardEvent('keydown', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 500)); })()`,
    );
    fs.writeFileSync(path.join(out, 'overview.png'), (await win.webContents.capturePage()).toPNG());
    const cut = await win.webContents
      .executeJavaScript(`(async () => { const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.ov-rope-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(700);
      const left = window.__omaestri.S.doc.payload.crossFloorConnections.length;
      const conn = window.__omaestri.S.doc.payload.nodes.filter(n => n.content.crossFloorConnector).length;
      document.querySelector('.ov .btn-x').click(); await wait(200);
      return { left, conn }; })()`);
    step(
      'clicking the link in the overview cuts the connection and its connectors',
      cut.left === 0 && cut.conn === 0,
      JSON.stringify(cut),
    );
    await core.floors.remove(id, 'Feature A', { deleteBranch: true });
    core.workspaces.changed(id);
    await sleep(500);
    step(
      'deleting a floor falls back to Ground',
      await win.webContents.executeJavaScript('window.__omaestri.S.floorId === null'),
    );

    // ---- cable tie: Alt+drag a line across a rope, drag the collar, delete it
    const tie = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const o = window.__omaestri;
      const rope = document.querySelector('#ropes .rope');
      if (!rope) return { ropes: 0 };
      const mid = rope.getPointAtLength(rope.getTotalLength() / 2);
      const m = rope.getScreenCTM();
      const sx = mid.x * m.a + mid.y * m.c + m.e, sy = mid.x * m.b + mid.y * m.d + m.f;
      const vp = document.getElementById('viewport');
      const ev = (type, x, y, extra = {}) => new MouseEvent(type, { clientX: x, clientY: y, button: 0, altKey: true, bubbles: true, cancelable: true, ...extra });
      vp.dispatchEvent(ev('mousedown', sx - 60, sy - 60));
      window.dispatchEvent(ev('mousemove', sx, sy)); window.dispatchEvent(ev('mouseup', sx + 60, sy + 60));
      await wait(900);
      const created = o.S.doc.payload.cableTies.length;
      const glyphs = document.querySelectorAll('#ropes .tie').length;
      const before = o.S.doc.payload.cableTies[0] && { ...o.S.doc.payload.cableTies[0].position };
      const hit = document.querySelector('#ropes .tie-hit');
      if (!hit) return { ropes: 1, created, glyphs };
      const r = hit.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      hit.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 40, clientY: cy + 25, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: cx + 40, clientY: cy + 25, bubbles: true }));
      await wait(900);
      const after = o.S.doc.payload.cableTies[0] && { ...o.S.doc.payload.cableTies[0].position };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); await wait(800);
      const left = o.S.doc.payload.cableTies.length;
      return { ropes: 1, created, glyphs, moved: !!(before && after && (before.x !== after.x || before.y !== after.y)), left }; })()`);
    step(
      'cable tie: Alt+drag gathers a rope, the collar can be dragged and deleted',
      tie.created === 1 && tie.glyphs === 1 && tie.moved === true && tie.left === 0,
      JSON.stringify(tie),
    );

    // ---- portal design mode: pick an element of the page and send it to the connected agent
    const dsg = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nodeEl = document.querySelector('.node.portal[data-id="' + ${JSON.stringify(portal.id)} + '"]');
      if (!nodeEl) return { node: false };
      const wv = nodeEl.querySelector('webview');
      const btn = [...nodeEl.querySelectorAll('.portal-bar button')].find(b => (b.title || '').startsWith('Modo design'));
      if (!btn || !wv) return { node: true, btn: !!btn, wv: !!wv };
      btn.click(); await wait(300);
      const overlay = nodeEl.querySelector('.design-overlay');
      const rect = JSON.parse(await wv.executeJavaScript('JSON.stringify((() => { const b = document.querySelector("button").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })())'));
      const o = overlay.getBoundingClientRect();
      const sx = o.width / overlay.offsetWidth;
      const cx = o.left + (rect.x + rect.w / 2) * sx, cy = o.top + (rect.y + rect.h / 2) * sx;
      const ev = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 });
      overlay.dispatchEvent(ev('mousedown')); overlay.dispatchEvent(ev('mouseup')); await wait(900);
      const panel = nodeEl.querySelector('.design-panel');
      const label = panel && panel.querySelector('.design-sel') && panel.querySelector('.design-sel').textContent;
      const shown = !!panel && !panel.hidden;
      nodeEl.querySelector('.design-text').value = 'torne o botão verde';
      nodeEl.querySelector('.design-panel .btn-primary').click(); await wait(2000);
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
      return { node: true, btn: true, shown, label, toasts }; })()`);
    const shots = fs.existsSync(path.join(process.env.OPEN_MAESTRI_HOME || os.homedir(), 'screenshots'))
      ? fs
          .readdirSync(path.join(process.env.OPEN_MAESTRI_HOME || os.homedir(), 'screenshots'))
          .filter((f) => f.startsWith('portal-design-'))
      : [];
    step(
      'portal design mode: picks the element, sends prompt + screenshot to the connected agent',
      dsg.shown && /#go/.test(dsg.label || '') && /Enviado a 1 agente/.test(dsg.toasts || '') && shots.length >= 1,
      JSON.stringify(dsg).slice(0, 300) + ' shots=' + shots.length,
    );

    // ---- chat mode: message the agent from a chat view, receive its `omaestri say` replies as bubbles
    const chatUi = async (js) => win.webContents.executeJavaScript(js);
    await chatUi(
      `(async () => { document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(worker.id)} + '"] .chat-btn').click(); await new Promise(r => setTimeout(r, 600)); })()`,
    );
    const chat1 = await chatUi(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const n = document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(worker.id)} + '"]');
      const view = n.querySelector('.chat');
      const input = n.querySelector('.chat-input');
      input.value = 'olá agente'; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await wait(900);
      return { open: !view.hidden, dots: n.querySelectorAll('.thread-dot').length, userBubbles: n.querySelectorAll('.bubble.user').length, typing: !n.querySelector('.chat-typing').hidden, termHidden: getComputedStyle(n.querySelector('.term-wrap')).display === 'none' }; })()`);
    const chatTerm = core.terminals.get(worker.id).screenText();
    core.chat.say(id, worker.id, { text: 'Tudo **pronto**, veja `isto`.' });
    await sleep(700);
    const chat2 = await chatUi(`(async () => {
      const n = document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(worker.id)} + '"]');
      const agent = n.querySelector('.bubble.agent');
      const r = { agent: !!agent, strong: !!(agent && agent.querySelector('strong')), code: !!(agent && agent.querySelector('code')), typing: !n.querySelector('.chat-typing').hidden };
      n.querySelector('.chat-btn').click(); await new Promise(res => setTimeout(res, 500)); // back to the terminal
      r.backToTerm = getComputedStyle(n.querySelector('.term-wrap')).display !== 'none';
      return r; })()`);
    core.chat.say(id, worker.id, { text: 'resposta enquanto o chat está fechado' });
    await sleep(600);
    const chat3 = await chatUi(`(async () => {
      const n = document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(worker.id)} + '"]');
      const badge = n.querySelector('.chat-badge');
      const r = { badge: !badge.hidden && badge.textContent === '1' };
      n.querySelector('.chat-btn').click(); await new Promise(res => setTimeout(res, 700));
      r.cleared = badge.hidden; r.bubbles = n.querySelectorAll('.bubble').length;
      n.querySelector('.chat-btn').click(); await new Promise(res => setTimeout(res, 300));
      return r; })()`);
    step(
      'chat mode: message reaches the terminal under the Maestri Chat header, agent reply renders as markdown, unread badge works',
      chat1.open &&
        chat1.dots === 7 &&
        chat1.userBubbles === 1 &&
        chat1.termHidden &&
        /Maestri Chat/.test(chatTerm) &&
        /thread: blue/.test(chatTerm) &&
        chat2.agent &&
        chat2.strong &&
        chat2.code &&
        !chat2.typing &&
        chat2.backToTerm &&
        chat3.badge &&
        chat3.cleared &&
        chat3.bubbles === 3,
      JSON.stringify({ chat1, chat2, chat3 }) + ' term=' + /Maestri Chat/.test(chatTerm),
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('#main-pill .gbtn[title^="Adicionar terminal"]').click(); const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect(); vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 330, clientY: r.bottom - 60 }))`,
    );
    await sleep(900);
    fs.writeFileSync(path.join(out, 'new-terminal.png'), (await win.webContents.capturePage()).toPNG());
    const dlg = await win.webContents.executeJavaScript(`(document.querySelector('.modal') || {}).innerText || ''`);
    step(
      'new terminal dialog offers Local / WSL / SSH',
      /Local/.test(dlg) && /WSL/.test(dlg) && /SSH/.test(dlg) && /Novo terminal/.test(dlg),
      dlg.slice(0, 80).replace(/\n/g, ' | '),
    );
    await win.webContents.executeJavaScript(`document.querySelector('.modal .btn-x').click()`);
    try {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* read-only git objects */
    }

    // ---- floating glass chrome (contextual toolbar) ----------------------------------------
    await win.webContents.executeJavaScript(`window.__omaestri.select([]); window.__omaestri.canvas.fitAll()`);
    await sleep(500);
    const main = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#main-pill .gbtn')].map(b => b.title)`,
    );
    step(
      'main glass pill has the 8 Maestri tools',
      main.length === 8 &&
        /Selecionar/.test(main[0]) &&
        /terminal/i.test(main[1]) &&
        /nota/i.test(main[2]) &&
        /portal/i.test(main[5]),
      main.join(' | '),
    );
    step(
      'contextual pill is hidden with no selection',
      await win.webContents.executeJavaScript(`!document.querySelector('.ctx-pill')`),
    );
    await win.webContents.executeJavaScript(`window.__omaestri.select([${JSON.stringify(boss.id)}])`);
    await sleep(600);
    const ctx = await win.webContents
      .executeJavaScript(`(() => { const p = document.querySelector('#ctx-slot .ctx-pill'); if (!p) return null;
      return { titles: [...p.querySelectorAll('.gbtn')].map(b => b.title), badge: (p.querySelector('.badge-btn') || {}).textContent, glass: p.classList.contains('glass'), radius: getComputedStyle(p).borderRadius, divs: p.querySelectorAll('.gdiv').length }; })()`);
    step(
      'selecting a terminal springs in its toolbar: edit | prompter | chat | connect+badge | restart | delete',
      !!ctx &&
        ctx.titles.join('|') ===
          'Editar terminal|Mostrar prompter (Ctrl+Shift+P)|Conversar com o agente (Ctrl+J)|Conectar|Reiniciar terminal|Excluir terminal' &&
        ctx.badge === '3' &&
        ctx.glass &&
        ctx.divs === 4,
      JSON.stringify(ctx),
    );
    win.showInactive();
    await sleep(300);
    fs.writeFileSync(path.join(out, 'chrome.png'), (await win.webContents.capturePage()).toPNG());
    const pop = await win.webContents
      .executeJavaScript(`(async () => { document.querySelector('#ctx-slot .badge-btn').click(); await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.pop .pop-row')].map(r => r.textContent.trim()); document.querySelectorAll('.pop').forEach(n => n.remove()); return rows; })()`);
    step(
      'connections badge lists the 3 connected nodes',
      pop.length === 3 && pop.some((r) => /Builder/.test(r)) && pop.some((r) => /Spec/.test(r)),
      pop.join(' | '),
    );
    await win.webContents.executeJavaScript(`window.__omaestri.select([${JSON.stringify(note.id)}])`);
    await sleep(500);
    const noteBar = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title)`,
    );
    step(
      'note selection shows the note toolbar (font, markdown, connect, delete)',
      noteBar.includes('Negrito') && noteBar.includes('Bloco de código') && noteBar.includes('Excluir nota'),
      noteBar.length + ' buttons',
    );
    await win.webContents.executeJavaScript(`window.__omaestri.select([${JSON.stringify(portal.id)}])`);
    await sleep(500);
    const portalBar = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title)`,
    );
    step(
      'portal selection shows reload / connect / address bar / edit / close',
      portalBar.includes('Recarregar') &&
        portalBar.includes('Ocultar barra de endereço') &&
        portalBar.includes('Fechar portal'),
      portalBar.join(' | '),
    );
    await win.webContents.executeJavaScript(`window.__omaestri.select([])`);
    await sleep(400);
    step(
      'contextual pill disappears after deselecting',
      await win.webContents.executeJavaScript(`!document.querySelector('.ctx-pill')`),
    );

    // ---- rope physics: dashed, swings while a node moves, then falls asleep and is saved -------
    const rope0 = await win.webContents
      .executeJavaScript(`(() => { const p = document.querySelector('#ropes path.rope'); const cs = getComputedStyle(p);
      return { n: document.querySelectorAll('#ropes path.rope').length, dash: cs.strokeDasharray, width: cs.strokeWidth, cap: cs.strokeLinecap, d: p.getAttribute('d').slice(0, 60), segs: (p.getAttribute('d').match(/ C /g) || []).length }; })()`);
    step(
      'ropes are dashed 8/6, 2px, rounded, 20 bezier segments',
      rope0.n === 3 &&
        /8px,? 6px/.test(rope0.dash) &&
        parseFloat(rope0.width) === 2 &&
        rope0.cap === 'round' &&
        rope0.segs === 20,
      JSON.stringify(rope0),
    );
    const swing = await win.webContents.executeJavaScript(`(async () => {
      const id = ${JSON.stringify(worker.id)};
      const head = document.querySelector('.node[data-id="' + id + '"] .node-head'); const r = head.getBoundingClientRect();
      const lengthOf = () => [...document.querySelectorAll('#ropes path.rope')].map(p => p.getAttribute('d')).join('|');
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 40, clientY: r.top + 10 }));
      const samples = [];
      for (let i = 1; i <= 8; i++) { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 + i * 14 })); await new Promise(res => setTimeout(res, 40)); samples.push(lengthOf()); }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise(res => setTimeout(res, 120)); const a = lengthOf(); await new Promise(res => setTimeout(res, 120)); const b = lengthOf();
      return { distinct: new Set(samples).size, stillMovingAfterRelease: a !== b }; })()`);
    step(
      'dragging a node makes the ropes swing (animation frames differ)',
      swing.distinct >= 5 && swing.stillMovingAfterRelease,
      JSON.stringify(swing),
    );
    await sleep(11500);
    const rest = await win.webContents
      .executeJavaScript(`(async () => { const l = () => [...document.querySelectorAll('#ropes path.rope')].map(p => p.getAttribute('d')).join('|');
      const a = l(); await new Promise(r => setTimeout(r, 400)); const b = l();
      const doc = window.__omaestri.S.doc.payload; return { asleep: a === b, saved: doc.connections.every((c) => Array.isArray(c.ropePoints) && c.ropePoints.length === 21) }; })()`);
    step(
      'rope falls asleep within 10 s and its 21-point shape is saved',
      rest.asleep && rest.saved,
      JSON.stringify(rest),
    );

    // ---- tools: arm "note", click the empty canvas -> node is placed there; Esc disarms ------------
    const place = await win.webContents.executeJavaScript(`(async () => {
      const S = window.__omaestri.S; const n0 = S.doc.payload.nodes.length;
      document.querySelector('#main-pill .gbtn[title^="Adicionar nota"]').click(); const armed = S.mode;
      const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect();
      vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + 280, clientY: r.bottom - 90 }));
      await new Promise(res => setTimeout(res, 700)); return { armed, after: S.mode, added: S.doc.payload.nodes.length - n0 }; })()`);
    step(
      'arming a tool then clicking the canvas places the node',
      place.armed === 'note' && place.after === 'select' && place.added === 1,
      JSON.stringify(place),
    );

    // ---- connect mode from the toolbar: click Conectar, then click another node ------------------
    const conn = await win.webContents.executeJavaScript(`(async () => {
      const S = window.__omaestri.S; const pl = S.doc.payload; const last = pl.nodes[pl.nodes.length - 1];
      window.__omaestri.select([last.id]); await new Promise(res => setTimeout(res, 500));
      const before = pl.noteConnections.length;
      document.querySelector('#ctx-slot .gbtn[title="Conectar"]').click();
      const preview = !!document.querySelector('#overlay .rope-preview') || document.getElementById('viewport').classList.contains('connecting');
      const target = document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(worker.id)} + '"] .node-body');
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise(res => setTimeout(res, 700)); return { preview, added: S.doc.payload.noteConnections.length - before }; })()`);
    step(
      'Connect button -> click another node creates the connection',
      conn.preview && conn.added === 1,
      JSON.stringify(conn),
    );

    // ---- sidebar: search, groups, drag & drop, floors rows, resize ----------------------------
    const other = core.workspaces.create({ name: 'Billing API', workingDirectory: os.tmpdir() });
    core.workspaces.create({ name: 'Website', workingDirectory: os.tmpdir() });
    await win.webContents.executeJavaScript('window.__omaestri.sidebar.refresh()');
    await sleep(500);
    const sb1 = await win.webContents.executeJavaScript(
      `(() => ({ rows: [...document.querySelectorAll('#ws-list .sb-row')].map(r => r.textContent.trim()), search: !!document.querySelector('.sb-search input'), foot: [...document.querySelectorAll('.side-foot button')].map(b => b.title || b.textContent.trim()) }))()`,
    );
    step(
      'sidebar lists workspaces with search + footer (new group / routines / preferences)',
      sb1.search && sb1.rows.length >= 3 && sb1.foot.length === 3 && /Nov[oa] grupo/.test(sb1.foot[0]),
      JSON.stringify(sb1),
    );
    await win.webContents.executeJavaScript(
      `(() => { const i = document.getElementById('sb-search'); i.value = 'billing'; i.dispatchEvent(new Event('input')); })()`,
    );
    await sleep(200);
    const filtered = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ws-list .sb-row')].map(r => r.textContent.trim())`,
    );
    step(
      'sidebar search filters workspaces',
      filtered.length === 1 && /Billing API/.test(filtered[0]),
      filtered.join('|'),
    );
    await win.webContents.executeJavaScript(
      `(() => { const i = document.getElementById('sb-search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`,
    );
    const grp = await win.webContents.executeJavaScript(`(async () => {
      const sbm = window.__omaestri.sidebar; sbm.createGroup('Clientes'); sbm.moveWorkspace(${JSON.stringify(other.id)}, { kind: 'group', groupId: sbm.layout().groups[0].id, beforeId: null });
      await new Promise(r => setTimeout(r, 300));
      const g = document.querySelector('#ws-list .sb-group'); return { name: g && g.querySelector('.sb-head-row .ws-name').textContent, kids: g ? [...g.querySelectorAll('.sb-children .sb-row')].map(r => r.textContent.trim()) : [] }; })()`);
    step(
      'groups hold workspaces (Clientes → Billing API)',
      grp.name === 'Clientes' && grp.kids.length === 1 && /Billing API/.test(grp.kids[0]),
      JSON.stringify(grp),
    );
    const w0 = await win.webContents.executeJavaScript(
      `document.getElementById('sidebar').getBoundingClientRect().width`,
    );
    await win.webContents.executeJavaScript(
      `(() => { const h = document.getElementById('sb-resize'); h.setPointerCapture = () => {}; h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 260, pointerId: 1 })); h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 360, pointerId: 1 })); h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); })()`,
    );
    const w1 = await win.webContents.executeJavaScript(
      `document.getElementById('sidebar').getBoundingClientRect().width`,
    );
    step('sidebar width is resizable (200–480)', w1 > w0 + 50 && w1 <= 480, w0 + ' -> ' + w1);

    // ---- prompter: toolbar toggle, composer, @mention, saved prompt menu, delivery ---------------------
    await win.webContents.executeJavaScript(`window.__omaestri.select([${JSON.stringify(worker.id)}])`);
    await sleep(500);
    const pBtn = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title)`,
    );
    step(
      'terminal toolbar has the prompter toggle',
      pBtn.some((x) => /prompter/i.test(x)),
      pBtn.join(' | '),
    );
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ctx-slot .gbtn')].find(b => /Mostrar prompter/.test(b.title)).click()`,
    );
    await sleep(500);
    const pr1 = await win.webContents.executeJavaScript(
      `(() => { const n = document.querySelector('.node.terminal[data-id="${worker.id}"]'); const a = n.querySelector('.pr-input'); return { overlay: n.classList.contains('prompter-overlay'), input: !!a, ph: a && a.placeholder, focus: document.activeElement === a }; })()`,
    );
    step(
      'prompter opens as overlay with a focused composer',
      pr1.overlay && pr1.input && /Prompt para Builder/.test(pr1.ph) && pr1.focus,
      JSON.stringify(pr1),
    );
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#ctx-slot .gbtn')].find(b => /Encaixar o prompter/.test(b.title)).click()`,
    );
    await sleep(500);
    const below = await win.webContents.executeJavaScript(
      `document.querySelector('.node.terminal[data-id="${worker.id}"]').classList.contains('prompter-below')`,
    );
    step('second click docks the prompter below the terminal', below);
    const at = await win.webContents
      .executeJavaScript(`(async () => { const a = document.querySelector('.node.terminal[data-id="${worker.id}"] .pr-input'); a.focus(); a.value = 'ver @Bos'; a.setSelectionRange(8, 8); a.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700)); return [...document.querySelectorAll('.pr-menu .pr-opt .pr-lab, .pr-menu .pr-sec')].map(n => n.textContent); })()`);
    step(
      '@ opens the mention menu listing connected agents',
      at.includes('Conectados') && at.includes('Boss'),
      at.slice(0, 6).join(' | '),
    );
    const sl = await win.webContents
      .executeJavaScript(`(async () => { const a = document.querySelector('.node.terminal[data-id="${worker.id}"] .pr-input'); a.value = '/'; a.setSelectionRange(1, 1); a.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500)); return [...document.querySelectorAll('.pr-menu .pr-opt .pr-lab')].map(n => n.textContent); })()`);
    step(
      '/ opens the saved-prompts menu with "create new" first',
      sl.length >= 1 && /Novo prompt salvo/.test(sl[0]),
      sl.join(' | '),
    );
    const sent = await win.webContents
      .executeJavaScript(`(async () => { const a = document.querySelector('.node.terminal[data-id="${worker.id}"] .pr-input'); a.value = 'Write-Output "from-prompter-ui"'; a.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 200));
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 1500)); return { cleared: a.value === '' }; })()`);
    step(
      'Enter sends the prompt to the terminal and clears the composer',
      sent.cleared && /from-prompter-ui/.test(core.terminals.get(worker.id).screenText()),
      JSON.stringify(sent),
    );
    win.showInactive();
    fs.writeFileSync(path.join(out, 'prompter.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(
      `(() => { const a = document.querySelector('.node.terminal[data-id="${worker.id}"] .pr-input'); a && a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); window.__omaestri.select([]); })()`,
    );
    await sleep(300);
    step('Esc closes the prompter', await win.webContents.executeJavaScript(`!document.querySelector('.prompter')`));

    // ---- command palette ------------------------------------------------------------------------
    const pal = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('btn-palette').click(); await new Promise(r => setTimeout(r, 300));
      const inp = document.querySelector('.pal-input'); const first = [...document.querySelectorAll('.pal-row .pal-title')].map(n => n.textContent);
      inp.value = 'novo termi'; inp.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 200));
      const top = document.querySelector('.pal-row.on .pal-title'); return { open: true, count: first.length, top: top && top.textContent, sections: [...document.querySelectorAll('.pal-sec')].map(n => n.textContent) }; })()`);
    step(
      'Ctrl+K palette lists actions + navigation and ranks "novo termi" → Novo terminal',
      pal.open && pal.count > 10 && pal.top === 'Novo terminal' && pal.sections.includes('Ações'),
      JSON.stringify(pal).slice(0, 220),
    );
    fs.writeFileSync(path.join(out, 'palette.png'), (await win.webContents.capturePage()).toPNG());
    const flow = await win.webContents.executeJavaScript(`(async () => {
      const card = document.querySelector('.pal'); const inp = document.querySelector('.pal-input');
      inp.value = 'enviar prompt'; inp.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 150));
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 200));
      const targets = [...document.querySelectorAll('.pal-row .pal-title')].map(n => n.textContent);
      const pick = [...document.querySelectorAll('.pal-row')].find(r => /Builder/.test(r.textContent)); pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 200));
      const comp = document.querySelector('.pal-compose'); comp.value = 'Write-Output "from-palette"'; comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 1800));
      return { targets, closed: !document.querySelector('.pal') }; })()`);
    step(
      'palette flow: send prompt → pick terminal → compose → delivered',
      flow.targets.includes('Builder') &&
        flow.closed &&
        /from-palette/.test(core.terminals.get(worker.id).screenText()),
      JSON.stringify(flow),
    );

    // ---- drawing: pen / arrow / filled rectangle drawn with the mouse, then restyled from the selection toolbar ----
    const draw1 = await win.webContents.executeJavaScript(`(async () => {
      const S = window.__omaestri.S; const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect();
      document.querySelector('#main-pill .gbtn[title^="Formas"]').click(); await new Promise(res => setTimeout(res, 400));
      const bar = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      const drag = async (pts) => { vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + pts[0][0], clientY: r.top + pts[0][1] }));
        for (const p of pts.slice(1)) { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + p[0], clientY: r.top + p[1] })); await new Promise(res => setTimeout(res, 15)); }
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await new Promise(res => setTimeout(res, 500)); };
      const n0 = S.doc.payload.nodes.length;
      await drag(Array.from({ length: 14 }, (_, i) => [260 + i * 18, 520 + Math.sin(i / 2) * 30]));
      const kinds1 = S.doc.payload.nodes.slice(n0).map(n => Object.keys(n.content)[0]);
      const pen = S.doc.payload.nodes.slice(n0).find(n => n.content.freehand);
      document.querySelector('#ctx-slot .gbtn[title="Seta"]').click(); await new Promise(res => setTimeout(res, 200));
      await drag([[300, 640], [420, 700]]);
      const arrow = S.doc.payload.nodes.find(n => n.content.stroke && n.content.stroke._0.strokeType === 'arrow');
      document.querySelector('#ctx-slot .gbtn[title="Retângulo"]').click(); await new Promise(res => setTimeout(res, 200));
      document.querySelector('#ctx-slot .gbtn[title="Preenchimento"]').click(); await new Promise(res => setTimeout(res, 200));
      await drag([[500, 600], [620, 690]]);
      const rect = S.doc.payload.nodes.find(n => n.content.shape && n.content.shape._0.shapeType === 'rect' && n.content.shape._0.fillStyle === 'solid');
      return { bar, kinds1, penPoints: pen && pen.content.freehand._0.points.length, penColor: pen && pen.content.freehand._0.strokeColor, penType: pen && pen.content.freehand._0.freehandType, arrow: !!arrow, rect: !!rect, mode: S.mode }; })()`);
    step(
      'draw toolbar offers pen, highlighter, line, arrow, shapes + colour / thickness controls',
      [
        'Caneta',
        'Marca-texto',
        'Linha',
        'Seta',
        'Retângulo',
        'Elipse',
        'Losango',
        'Cor',
        'Mais fina',
        'Mais grossa',
      ].every((x) => draw1.bar.includes(x)),
      draw1.bar.join(' | '),
    );
    step(
      'dragging in draw mode paints a freehand stroke (pen, normalised points)',
      draw1.kinds1.includes('freehand') &&
        draw1.penPoints >= 8 &&
        draw1.penColor === '#0a84ff' &&
        draw1.penType === 'pen',
      JSON.stringify(draw1).slice(0, 220),
    );
    step(
      'arrow and filled rectangle tools create stroke / shape nodes',
      draw1.arrow && draw1.rect && draw1.mode === 'draw',
    );
    const smart = await win.webContents.executeJavaScript(`(async () => {
      const S = window.__omaestri.S; const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect();
      const btn = [...document.querySelectorAll('#ctx-slot .gbtn')].find(b => b.title.startsWith('Desenho inteligente'));
      if (!btn) return { btn: false };
      btn.click(); await new Promise(res => setTimeout(res, 200));
      const pts = Array.from({ length: 70 }, (_, i) => [700 + 110 * Math.cos((i / 68) * Math.PI * 2) + (i % 3), 560 + 60 * Math.sin((i / 68) * Math.PI * 2) + (i % 2)]);
      const n0 = S.doc.payload.nodes.length;
      vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + pts[0][0], clientY: r.top + pts[0][1] }));
      for (const p of pts.slice(1)) { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + p[0], clientY: r.top + p[1] })); await new Promise(res => setTimeout(res, 8)); }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await new Promise(res => setTimeout(res, 600));
      const made = S.doc.payload.nodes.slice(n0);
      const line = [[300, 300], [380, 330], [460, 361], [540, 392]];
      const n1 = S.doc.payload.nodes.length;
      vp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: r.left + line[0][0], clientY: r.top + line[0][1] }));
      for (const p of line.slice(1)) { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + p[0], clientY: r.top + p[1] })); await new Promise(res => setTimeout(res, 8)); }
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await new Promise(res => setTimeout(res, 600));
      const made2 = S.doc.payload.nodes.slice(n1);
      return { btn: true, ellipse: made.some(n => n.content.shape && n.content.shape._0.shapeType === 'ellipse'), line: made2.some(n => n.content.stroke && n.content.stroke._0.strokeType === 'line') }; })()`);
    step(
      'smart draw turns a wobbly circle into an ellipse and a straight drag into a line',
      smart.btn && smart.ellipse && smart.line,
      JSON.stringify(smart),
    );
    win.showInactive();
    await sleep(300);
    fs.writeFileSync(path.join(out, 'draw.png'), (await win.webContents.capturePage()).toPNG());
    const draw2 = await win.webContents.executeJavaScript(`(async () => {
      const S = window.__omaestri.S;
      document.querySelector('#main-pill .gbtn[title^="Formas"]').click(); await new Promise(res => setTimeout(res, 300));
      const pen = S.doc.payload.nodes.find(n => n.content.freehand); window.__omaestri.select([pen.id]); await new Promise(res => setTimeout(res, 500));
      const titles = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      const w0 = pen.content.freehand._0.strokeWidth; document.querySelector('#ctx-slot .gbtn[title="Mais grossa"]').click(); await new Promise(res => setTimeout(res, 300));
      const w1 = S.doc.payload.nodes.find(n => n.id === pen.id).content.freehand._0.strokeWidth; window.__omaestri.select([]); return { titles, w0, w1, mode: S.mode }; })()`);
    step(
      'selecting a drawing shows its style toolbar; "Mais grossa" widens the stroke',
      draw2.mode === 'select' && draw2.w1 === draw2.w0 + 1 && draw2.titles.includes('Cor'),
      JSON.stringify(draw2).slice(0, 200),
    );

    // ---- note stacks (fichário) --------------------------------------------------------------------
    const nA = core.workspaces.addNote(core.workspaces.activeDoc, {
      name: 'Pilha A',
      content: 'conteúdo A',
      rect: { x: 9900, y: 9700, w: 260, h: 170 },
    });
    const nB = core.workspaces.addNote(core.workspaces.activeDoc, {
      name: 'Pilha B',
      content: 'conteúdo B',
      rect: { x: 10200, y: 9700, w: 260, h: 170 },
    });
    core.workspaces.connect(core.workspaces.activeDoc, boss.id, nA.id);
    core.workspaces.changed(id);
    await sleep(700);
    const stk = await win.webContents.executeJavaScript(`(async () => {
      const o = window.__omaestri; const wait = (ms) => new Promise(r => setTimeout(r, ms));
      o.select([${JSON.stringify(nA.id)}, ${JSON.stringify(nB.id)}]); await wait(500);
      const bar = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      document.querySelector('#ctx-slot .gbtn[title="Arquivar notas em um fichário"]').click(); await wait(900);
      const stackEl = document.querySelector('.node.stack');
      const tabs = stackEl ? [...stackEl.querySelectorAll('.stack-tab')].map(b => b.textContent) : [];
      const hiddenMembers = !document.querySelector('.node.note[data-id="' + ${JSON.stringify(nA.id)} + '"]') && !document.querySelector('.node.note[data-id="' + ${JSON.stringify(nB.id)} + '"]');
      const text = stackEl && stackEl.querySelector('textarea.note-edit') ? stackEl.querySelector('textarea.note-edit').value : null;
      const ropeToStack = document.querySelectorAll('#ropes path.rope').length;
      const toolbar = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      return { bar, tabs, hiddenMembers, text, ropeToStack, toolbar }; })()`);
    step(
      'two selected notes offer "Arquivar notas" and become one stack with tabs',
      stk.bar.includes('Arquivar notas em um fichário') &&
        stk.tabs.length === 2 &&
        stk.hiddenMembers &&
        stk.text === 'conteúdo A',
      JSON.stringify(stk).slice(0, 260),
    );
    step(
      'a selected stack gets the note toolbar plus stack actions',
      [
        'Nova página',
        'Renomear fichário',
        'Negrito',
        'Mesma cor em todas as páginas',
        'Tirar esta página do fichário',
        'Desempilhar todas as páginas',
        'Excluir fichário',
      ].every((x) => stk.toolbar.includes(x)),
      stk.toolbar.join(' | '),
    );
    const stk2 = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const stackEl = () => document.querySelector('.node.stack');
      document.querySelector('#ctx-slot .gbtn[title="Nova página"]').click(); await wait(800);
      const tabs3 = [...stackEl().querySelectorAll('.stack-tab')].map(b => b.textContent);
      stackEl().querySelectorAll('.stack-tab')[1].click(); await wait(700);
      const textB = stackEl().querySelector('textarea.note-edit').value;
      const S = window.__omaestri.S; const conns = S.doc.payload.noteConnections.filter(c => c.terminalId === ${JSON.stringify(boss.id)}).length;
      return { tabs3, textB, conns }; })()`);
    step(
      'new page + switching tabs shows the other note; every page stays connected to the agent',
      stk2.tabs3.length === 3 && stk2.textB === 'conteúdo B' && stk2.conns >= 4,
      JSON.stringify(stk2),
    );
    win.showInactive();
    await sleep(300);
    await win.webContents.executeJavaScript('window.__omaestri.canvas.fitAll()');
    await sleep(900);
    fs.writeFileSync(path.join(out, 'stack.png'), (await win.webContents.capturePage()).toPNG());
    const un = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#ctx-slot .gbtn[title="Desempilhar todas as páginas"]').click(); await wait(800);
      return { stacks: document.querySelectorAll('.node.stack').length, notes: document.querySelectorAll('.node.note').length }; })()`);
    step('unstacking brings every page back onto the canvas', un.stacks === 0 && un.notes >= 3, JSON.stringify(un));

    // ---- bands: group terminals, switch the shown one, ropes collapse to the band -------------------
    const bt1 = core.workspaces.addTerminal(core.workspaces.activeDoc, {
      name: 'Front',
      workingDirectory: os.homedir(),
      rect: { x: 9800, y: 10000, w: 520, h: 330 },
    });
    const bt2 = core.workspaces.addTerminal(core.workspaces.activeDoc, {
      name: 'Back',
      workingDirectory: os.homedir(),
      rect: { x: 10400, y: 10000, w: 520, h: 330 },
    });
    core.workspaces.connect(core.workspaces.activeDoc, bt1.id, nA.id);
    core.workspaces.changed(id);
    core.startWorkspaceTerminals(id);
    await sleep(3500);
    const bnd = await win.webContents.executeJavaScript(`(async () => {
      const o = window.__omaestri; const wait = (ms) => new Promise(r => setTimeout(r, ms));
      o.select([${JSON.stringify(bt1.id)}, ${JSON.stringify(bt2.id)}]); await wait(500);
      const bar = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      document.querySelector('#ctx-slot .gbtn[title="Agrupar terminais em uma banda"]').click(); await wait(1500);
      const band = document.querySelector('.node.band');
      const rows = band ? [...band.querySelectorAll('.band-row')].map(r => r.textContent.trim()) : [];
      const xterms = band ? band.querySelectorAll('.xterm').length : 0;
      const hidden = !document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(bt1.id)} + '"]') && !document.querySelector('.node.terminal[data-id="' + ${JSON.stringify(bt2.id)} + '"]');
      const toolbar = [...document.querySelectorAll('#ctx-slot .gbtn')].map(b => b.title);
      return { bar, rows, xterms, hidden, toolbar }; })()`);
    step(
      'two terminals can be grouped: list on the left, one shown terminal, members hidden',
      bnd.bar.includes('Agrupar terminais em uma banda') &&
        bnd.rows.join('|') === 'Front|Back' &&
        bnd.xterms === 1 &&
        bnd.hidden,
      JSON.stringify(bnd).slice(0, 260),
    );
    step(
      'a selected band shows the terminal toolbar + band actions',
      [
        'Editar terminal',
        'Conectar',
        'Reiniciar terminal',
        'Renomear banda',
        'Novo terminal nesta banda',
        'Desfazer a banda',
        'Excluir banda',
      ].every((x) => bnd.toolbar.includes(x)),
      bnd.toolbar.join(' | '),
    );
    const bnd2 = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const band = () => document.querySelector('.node.band');
      band().querySelectorAll('.band-row')[1].click(); await wait(1200);
      const on = band().querySelector('.band-row.on').textContent.trim();
      const prompt = band().querySelectorAll('.xterm').length;
      document.querySelector('#ctx-slot .gbtn[title="Novo terminal nesta banda"]').click(); await wait(1500);
      const rows3 = [...band().querySelectorAll('.band-row')].map(r => r.textContent.trim());
      return { on, prompt, rows3 }; })()`);
    step(
      'switching the shown terminal and adding a terminal inside the band',
      bnd2.on === 'Back' && bnd2.prompt === 1 && bnd2.rows3.length === 3,
      JSON.stringify(bnd2),
    );
    win.showInactive();
    await sleep(300);
    await win.webContents.executeJavaScript('window.__omaestri.canvas.fitAll()');
    await sleep(900);
    fs.writeFileSync(path.join(out, 'band.png'), (await win.webContents.capturePage()).toPNG());
    const bnd3 = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#ctx-slot .gbtn[title="Desfazer a banda"]').click(); await wait(1000);
      return { bands: document.querySelectorAll('.node.band').length, terminals: document.querySelectorAll('.node.terminal').length }; })()`);
    step(
      'dissolving the band returns every terminal to the canvas',
      bnd3.bands === 0 && bnd3.terminals >= 5,
      JSON.stringify(bnd3),
    );

    // ---- partituras: save a selection, place it again ------------------------------------------
    const prt = await win.webContents.executeJavaScript(`(async () => {
      const o = window.__omaestri; const wait = (ms) => new Promise(r => setTimeout(r, ms)); const S = o.S;
      await window.__omaestri.canvas.fitAll();
      o.select([${JSON.stringify(boss.id)}, ${JSON.stringify(worker.id)}]); await wait(600);
      const btn = [...document.querySelectorAll('#ctx-slot .gbtn')].find(b => b.title === 'Salvar como partitura'); if (!btn) return { error: 'no button' };
      btn.click(); await wait(900);
      const dlg = document.querySelector('.modal'); const title = dlg.querySelector('h3').textContent;
      const cmdRows = dlg.querySelectorAll('.list-row').length;
      const nameInput = dlg.querySelector('input[type=text]'); nameInput.value = 'Time Boss+Builder'; nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      [...dlg.querySelectorAll('.btn-primary')].pop().click(); await wait(800);
      const n0 = S.doc.payload.nodes.length;
      document.getElementById('btn-palette').click(); await wait(300);
      const inp = document.querySelector('.pal-input'); inp.value = 'abrir partituras'; inp.dispatchEvent(new Event('input', { bubbles: true })); await wait(200);
      document.querySelector('.pal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(700);
      const listed = [...document.querySelectorAll('.modal .routine .r-title')].map(n => n.textContent);
      [...document.querySelectorAll('.modal .routine .btn-primary')][0].click(); await wait(1500);
      return { title, cmdRows, listed, added: S.doc.payload.nodes.length - n0 }; })()`);
    step(
      'partitura: selection saved with its commands, listed in the library and placed again',
      prt.title === 'Salvar como partitura' &&
        prt.cmdRows === 2 &&
        prt.listed.includes('Time Boss+Builder') &&
        prt.added === 2,
      JSON.stringify(prt),
    );

    // ---- git changes panel -------------------------------------------------------------------------
    const grepo = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-st-git-'));
    const gg = (...a) => execFileSync('git', a, { cwd: grepo, windowsHide: true, encoding: 'utf8' });
    gg('init', '-q', '-b', 'main');
    gg('config', 'user.email', 't@t.t');
    gg('config', 'user.name', 'T');
    fs.writeFileSync(path.join(grepo, 'a.txt'), ['um', ''].join('\n'));
    gg('add', '.');
    gg('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(grepo, 'a.txt'), ['um', 'dois', ''].join('\n'));
    fs.writeFileSync(path.join(grepo, 'novo.txt'), 'x');
    core.workspaces.update(id, { workingDirectory: grepo });
    core.workspaces.changed(id);
    await sleep(500);
    const gitui = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.getElementById('btn-palette').click(); await wait(300);
      const inp = document.querySelector('.pal-input'); inp.value = 'alterações do git'; inp.dispatchEvent(new Event('input', { bubbles: true })); await wait(200);
      document.querySelector('.pal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(1500);
      const m = document.querySelector('.modal'); const branch = m.querySelector('.git-head select').value;
      const rows = [...m.querySelectorAll('.git-file .git-path')].map(n => n.textContent);
      m.querySelector('.git-file .git-path').click(); await wait(700);
      const diff = m.querySelector('.git-diff').textContent;
      const boxes = [...m.querySelectorAll('.git-file input[type=checkbox]')]; boxes.forEach(b => b.click()); await wait(1500);
      const staged = [...m.querySelectorAll('.git-sec')].map(n => n.textContent);
      const msg = m.querySelector('.git-msg'); msg.value = 'dois e novo'; msg.dispatchEvent(new Event('input', { bubbles: true }));
      const commit = [...m.querySelectorAll('.btn-primary')].find(b => b.textContent.includes('Commit')); const enabled = !commit.disabled; commit.click(); await wait(1800);
      const clean = !!m.querySelector('.empty');
      return { branch, rows, diffAdds: diff.includes('+dois'), staged, enabled, clean }; })()`);
    const lastCommit = gg('log', '-1', '--pretty=%s').trim();
    step(
      'git panel: branch, changed files, diff, stage all, commit',
      gitui.branch === 'main' &&
        gitui.rows.length === 2 &&
        gitui.diffAdds &&
        gitui.enabled &&
        gitui.clean &&
        lastCommit === 'dois e novo',
      JSON.stringify(gitui).slice(0, 260) + ' | ' + lastCommit,
    );
    fs.writeFileSync(path.join(out, 'git.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('.modal .btn-x').click()`);
    core.workspaces.update(id, { workingDirectory: os.tmpdir() });
    try {
      fs.rmSync(grepo, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* read-only git objects */
    }

    // persistence round trip
    core.save();
    const saved = JSON.parse(fs.readFileSync(require('./persistence').paths.workspaceFile(id), 'utf8'));
    step('workspace.json persisted', saved.payload.nodes.length >= 5 && saved.payload.connections.length >= 1);
    step('no renderer console errors', report.consoleErrors.length === 0, report.consoleErrors.join(' | '));
  } catch (err) {
    step('selftest crashed', false, err && err.stack);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? 'SELFTEST OK' : 'SELFTEST FAILED');
  try {
    await core.shutdown();
  } catch {
    /* exit anyway */
  }
  app.exit(report.ok ? 0 : 1);
}

module.exports = { run };
