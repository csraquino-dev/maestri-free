'use strict';
// Portal (embedded browser) automation. Each portal node is an Electron <webview>;
// the renderer registers its guest webContents id and we drive it from here.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');

const INTERACTIVE = 'a,button,input,select,textarea,[role]';

// Shared page-side helpers, injected before every command.
const PRELUDE = `
const __SEL = ${JSON.stringify(INTERACTIVE)};
const __els = () => Array.from(document.querySelectorAll(__SEL));
const __resolve = (ref) => {
  if (typeof ref === 'string' && /^@e\\d+$/.test(ref)) return __els()[parseInt(ref.slice(2), 10) - 1] || null;
  if (typeof ref === 'string' && /^\\d+\\s*,\\s*\\d+$/.test(ref)) {
    const [x, y] = ref.split(',').map(Number);
    return document.elementFromPoint(x, y);
  }
  try { return document.querySelector(ref); } catch { return null; }
};
const __center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
const __setValue = (el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  setter && setter.set ? setter.set.call(el, v) : (el.value = v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
`;

const SNAPSHOT_JS = `(() => { ${PRELUDE}
  const els = __els();
  const idx = new Map(els.map((e, i) => [e, i + 1]));
  const roleOf = (e) => {
    const r = e.getAttribute('role'); if (r) return r;
    const t = e.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') { const ty = (e.type || 'text').toLowerCase(); return ty === 'checkbox' ? 'checkbox' : ty === 'radio' ? 'radio' : (ty === 'submit' || ty === 'button') ? 'button' : 'textbox'; }
    return t;
  };
  const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const nameOf = (e) => clip(e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || '', 80);
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const lines = ['page: ' + document.title, 'url: ' + location.href, ''];
  const walk = document.querySelectorAll(__SEL + ',h1,h2,h3,h4,h5,h6');
  for (const e of walk) {
    if (!visible(e)) continue;
    if (idx.has(e)) {
      let l = '[@e' + idx.get(e) + '] ' + roleOf(e);
      const n = nameOf(e); if (n) l += ' "' + n + '"';
      if (e.tagName === 'A' && e.href) l += ' href=' + clip(e.href, 100);
      if ('value' in e && e.value && e.type !== 'password' && roleOf(e) === 'textbox') l += ' value="' + clip(e.value, 60) + '"';
      if (e.type === 'checkbox' || e.type === 'radio') l += e.checked ? ' [checked]' : ' [unchecked]';
      if (e.disabled) l += ' [disabled]';
      lines.push(l);
    } else {
      lines.push('heading(' + e.tagName.slice(1) + ') "' + clip(e.innerText, 100) + '"');
    }
  }
  return lines.join('\\n');
})()`;

function normalizeUrl(u) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  return 'https://' + u;
}

function createPortals({ workspaces, getWebContents }) {
  const registry = new Map(); // nodeId -> webContents id
  const states = new Map(); // nodeId -> {url,title}
  const logs = new Map(); // nodeId -> array
  const logging = new Set();

  const register = (nodeId, wcId) => {
    registry.set(nodeId, wcId);
    // attach console capture lazily
    const wc = getWebContents(wcId);
    if (wc && !wc.__omaestriLogs) {
      wc.__omaestriLogs = true;
      wc.on('console-message', (e, level, message, line, source) => {
        if (!logging.has(nodeId)) return;
        const arr = logs.get(nodeId) || [];
        arr.push(
          `[${['verbose', 'info', 'warning', 'error'][level] || level}] ${message}${source ? ` (${source}:${line})` : ''}`,
        );
        if (arr.length > 500) arr.shift();
        logs.set(nodeId, arr);
      });
    }
  };
  const unregister = (nodeId) => {
    registry.delete(nodeId);
    states.delete(nodeId);
  };
  const setState = (nodeId, s) => states.set(nodeId, { ...(states.get(nodeId) || {}), ...s });
  const info = (nodeId) => states.get(nodeId);

  async function wcFor(nodeId) {
    for (let i = 0; i < 80; i++) {
      const id = registry.get(nodeId);
      const wc = id != null ? getWebContents(id) : null;
      if (wc && !wc.isDestroyed()) return wc;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('WebView not ready');
  }

  const run = async (wc, body, vars = {}) => {
    const code = `(async () => { ${PRELUDE} const V = ${JSON.stringify(vars)}; ${body} })()`;
    return wc.executeJavaScript(code, true);
  };
  const str = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

  function waitLoad(wc, ms = 15000) {
    return new Promise((resolve) => {
      let t;
      const done = () => {
        clearTimeout(t);
        wc.off('did-stop-loading', done);
        wc.off('did-fail-load', done);
        resolve();
      };
      wc.once('did-stop-loading', done);
      wc.once('did-fail-load', done);
      t = setTimeout(done, ms);
    });
  }

  function resolvePortal(ctx, name) {
    const conns = workspaces.connectionsOf(ctx.doc, ctx.node.id);
    const q = String(name).toLowerCase();
    const nodes = conns.portals.map((id) => workspaces.findNode(ctx.doc, id)).filter(Boolean);
    return (
      nodes.find((n) => workspaces.portalNameOf(n).toLowerCase() === q) ||
      nodes.find((n) => workspaces.portalNameOf(n).toLowerCase().includes(q))
    );
  }

  async function handle(args, ctx) {
    const sub = args[1];
    if (!sub) return 'error: usage: omaestri portal <subcommand> ...';

    if (sub === 'create') {
      if (args.length < 3) return 'error: usage: omaestri portal create "URL" ["Name"]';
      const url = normalizeUrl(args[2]);
      const name = args[3] || `Portal-${persistence.uuid().slice(0, 6)}`;
      const node = workspaces.addPortal(ctx.doc, { name, url, anchorId: ctx.node.id });
      workspaces.connect(ctx.doc, ctx.node.id, node.id);
      workspaces.changed(ctx.wsId);
      return `Created portal '${name}' [${node.id.slice(0, 8)}]`;
    }

    if (args.length < 3) return `error: usage: omaestri portal ${sub} "PortalName" ...`;
    const node = resolvePortal(ctx, args[2]);
    if (!node) return `error: portal '${args[2]}' not found`;
    const wc = await wcFor(node.id);
    const rest = args.slice(3);
    const ref = rest[0];

    switch (sub) {
      case 'edit':
      case 'navigate': {
        let url = sub === 'navigate' ? rest[0] : null;
        if (sub === 'edit') for (let i = 0; i < rest.length; i++) if (rest[i] === '--url') url = rest[i + 1];
        if (!url) return `error: usage: omaestri portal ${sub} "PortalName" ${sub === 'edit' ? '--url URL' : '"URL"'}`;
        const target = normalizeUrl(url);
        const loaded = waitLoad(wc);
        wc.loadURL(target).catch(() => {});
        await loaded;
        node.content.portal._0.currentURL = wc.getURL();
        workspaces.markDirty(ctx.wsId);
        return sub === 'edit' ? 'reloaded' : `navigated to ${wc.getURL()}`;
      }
      case 'back':
        wc.navigationHistory.goBack();
        await waitLoad(wc, 5000);
        return `navigated back: ${wc.getURL()}`;
      case 'forward':
        wc.navigationHistory.goForward();
        await waitLoad(wc, 5000);
        return `navigated forward: ${wc.getURL()}`;
      case 'reload':
      case 'refresh':
        wc.reload();
        await waitLoad(wc);
        return `reloaded ${wc.getURL()}`;
      case 'screenshot': {
        const img = await wc.capturePage();
        const png = img.toPNG();
        let out = null;
        for (let i = 0; i < rest.length; i++) if (rest[i] === '--out' || rest[i] === '--file') out = rest[i + 1];
        if (out) {
          fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
          fs.writeFileSync(out, png);
          return `saved ${path.resolve(out)} (${png.length} bytes)`;
        }
        return png.length ? png.toString('base64') : 'error: screenshot failed';
      }
      case 'snapshot':
        return str(await run(wc, `return ${SNAPSHOT_JS}`));
      case 'html':
        return str(await run(wc, 'return document.documentElement.outerHTML'));
      case 'text': {
        if (!ref) return 'error: usage: omaestri portal text "PortalName" @e1';
        return str(
          await run(
            wc,
            'const el = __resolve(V.ref); return el ? (el.innerText || el.value || el.textContent) : "error: element not found";',
            { ref },
          ),
        );
      }
      case 'info': {
        const r = await run(
          wc,
          'return { url: location.href, title: document.title, viewport: innerWidth + "x" + innerHeight, readyState: document.readyState };',
        );
        return `url: ${r.url}\ntitle: ${r.title}\nviewport: ${r.viewport}\nstate: ${r.readyState}`;
      }
      case 'click': {
        if (!ref) return 'error: usage: omaestri portal click "PortalName" @e1';
        const pt = await run(
          wc,
          'const el = __resolve(V.ref); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); await new Promise(r => setTimeout(r, 60)); return __center(el);',
          { ref },
        );
        if (!pt) return `error: element '${ref}' not found`;
        try {
          wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
          wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        } catch {
          await run(wc, 'const el = __resolve(V.ref); el && el.click();', { ref });
        }
        return `clicked ${ref}`;
      }
      case 'fill': {
        if (rest.length < 2) return 'error: usage: omaestri portal fill "PortalName" @e1 "value"';
        const ok = await run(
          wc,
          'const el = __resolve(V.ref); if (!el) return false; el.scrollIntoView({block:"center"}); el.focus(); __setValue(el, V.value); return true;',
          { ref, value: rest[1] },
        );
        return ok ? `filled ${ref}` : `error: element '${ref}' not found`;
      }
      case 'type': {
        if (!ref) return 'error: usage: omaestri portal type "PortalName" "text"';
        wc.focus();
        await wc.insertText(rest.join(' '));
        return `typed ${rest.join(' ').length} chars`;
      }
      case 'key': {
        if (!ref) return 'error: usage: omaestri portal key "PortalName" "Enter"';
        const mods = [];
        let key = ref;
        if (key.includes('+')) {
          const parts = key.split('+');
          key = parts.pop();
          mods.push(...parts.map((m) => m.toLowerCase()));
        }
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
        if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
        wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
        return `pressed ${ref}`;
      }
      case 'hover': {
        if (!ref) return 'error: usage: omaestri portal hover "PortalName" @e1';
        const pt = await run(
          wc,
          'const el = __resolve(V.ref); if (!el) return null; el.scrollIntoView({block:"center"}); return __center(el);',
          { ref },
        );
        if (!pt) return `error: element '${ref}' not found`;
        wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
        return `hovered ${ref}`;
      }
      case 'scroll': {
        const dir = (ref || 'down').toLowerCase();
        const amount = parseInt(rest[1], 10) || 300;
        const d = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[dir];
        if (!d) return 'error: usage: omaestri portal scroll "PortalName" up|down|left|right [amount]';
        await run(wc, 'window.scrollBy(V.dx, V.dy);', { dx: d[0], dy: d[1] });
        return `scrolled ${dir} ${amount}`;
      }
      case 'drag': {
        if (rest.length < 2) return 'error: usage: omaestri portal drag "PortalName" @e1 @e2';
        const pts = await run(
          wc,
          'const a = __resolve(V.a), b = __resolve(V.b); if (!a || !b) return null; return { a: __center(a), b: __center(b) };',
          { a: rest[0], b: rest[1] },
        );
        if (!pts) return 'error: element not found';
        wc.sendInputEvent({ type: 'mouseMove', x: pts.a.x, y: pts.a.y });
        wc.sendInputEvent({ type: 'mouseDown', x: pts.a.x, y: pts.a.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i++)
          wc.sendInputEvent({
            type: 'mouseMove',
            x: pts.a.x + ((pts.b.x - pts.a.x) * i) / 8,
            y: pts.a.y + ((pts.b.y - pts.a.y) * i) / 8,
            modifiers: ['leftButtonDown'],
          });
        wc.sendInputEvent({ type: 'mouseUp', x: pts.b.x, y: pts.b.y, button: 'left', clickCount: 1 });
        return `dragged ${rest[0]} to ${rest[1]}`;
      }
      case 'wait': {
        if (!ref) return 'error: usage: omaestri portal wait "PortalName" @e1 [timeoutMs]';
        if (/^\d+$/.test(ref)) {
          await new Promise((r) => setTimeout(r, Math.min(parseInt(ref, 10), 60000)));
          return 'waited';
        }
        const timeout = parseInt(rest[1], 10) || 10000;
        const ok = await run(
          wc,
          'const end = Date.now() + V.t; while (Date.now() < end) { if (__resolve(V.ref)) return true; await new Promise(r => setTimeout(r, 100)); } return false;',
          { ref, t: timeout },
        );
        return ok ? `found ${ref}` : `error: timeout waiting for ${ref}`;
      }
      case 'evaluate': {
        if (!ref) return 'error: usage: omaestri portal evaluate "PortalName" "js"';
        const r = await wc.executeJavaScript(rest.join(' '), true);
        return str(r);
      }
      case 'select': {
        if (rest.length < 2) return 'error: usage: omaestri portal select "PortalName" @e1 "Option Text"';
        const ok = await run(
          wc,
          'const el = __resolve(V.ref); if (!el) return "error: element not found"; const o = Array.from(el.options || []).find(o => o.text === V.opt || o.value === V.opt); if (!o) return "error: option not found"; __setValue(el, o.value); return "selected " + o.text;',
          { ref, opt: rest[1] },
        );
        return ok;
      }
      case 'check':
      case 'uncheck': {
        if (!ref) return `error: usage: omaestri portal ${sub} "PortalName" @e1`;
        return str(
          await run(
            wc,
            'const el = __resolve(V.ref); if (!el) return "error: element not found"; if (el.checked !== V.want) el.click(); return "ok";',
            { ref, want: sub === 'check' },
          ),
        );
      }
      case 'focus':
        return str(
          await run(
            wc,
            'const el = __resolve(V.ref); if (!el) return "error: element not found"; el.focus(); return "focused";',
            { ref },
          ),
        );
      case 'scrollintoview':
        return str(
          await run(
            wc,
            'const el = __resolve(V.ref); if (!el) return "error: element not found"; el.scrollIntoView({block:"center"}); return "ok";',
            { ref },
          ),
        );
      case 'selectall':
        wc.focus();
        wc.selectAll();
        return 'ok';
      case 'clear':
        return str(
          await run(
            wc,
            'const el = __resolve(V.ref); if (!el) return "error: element not found"; el.focus(); __setValue(el, ""); return "cleared";',
            { ref },
          ),
        );
      case 'logs-start':
        logging.add(node.id);
        logs.set(node.id, []);
        return 'logging started';
      case 'logs': {
        const l = logs.get(node.id) || [];
        return l.length ? l.join('\n') : '(no logs)';
      }
      default:
        return `error: unknown portal subcommand '${sub}'`;
    }
  }

  return { handle, register, unregister, setState, info };
}

module.exports = { createPortals, normalizeUrl };
