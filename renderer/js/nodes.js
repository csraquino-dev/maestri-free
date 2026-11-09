// Node views: one controller per canvas node type. Dragging/resizing/connecting is handled
// by canvas.js through event delegation on the data-* hooks created here.
import { el, kindOf, inner, rectOf, debounce, toast } from './util.js';
import { S, api, patchNode, node as getNode, setDoc, flush } from './store.js';
import { themeFor } from './themes.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { createComposer } from './prompter.js';
import { attachDesign } from './portal-design.js';
import { createChatView } from './chat.js';

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export const NAMED_COLORS = {
  blue: '#0a84ff',
  red: '#ff453a',
  green: '#30d158',
  orange: '#ff9f0a',
  purple: '#bf5af2',
  pink: '#ff375f',
  cyan: '#64d2ff',
  yellow: '#ffd60a',
  gray: '#8e8e93',
  black: '#1c1c1e',
  white: '#ffffff',
};
export const colorOf = (c, fb = '#0a84ff') => (/^#/.test(c) ? c : NAMED_COLORS[c] || fb);

function shell(node, extraClass, { connectable, headless = false }) {
  const titleEl = el('span', { class: 'node-title' });
  const head = el('div', { class: 'node-head', dataset: { drag: node.id } }, titleEl);
  const body = el('div', { class: 'node-body' });
  const root = el(
    'div',
    { class: `node ${extraClass}`, dataset: { id: node.id } },
    headless ? null : head,
    body,
    connectable
      ? el('div', { class: 'port', title: t('Drag onto another node to connect'), dataset: { port: node.id } })
      : null,
    EDGES.map((e) => el('div', { class: `resize ${e}`, dataset: { resize: e, id: node.id } })),
  );
  return { root, head, body, titleEl };
}

const btn = (ic, title, fn) =>
  el(
    'button',
    {
      class: 'btn',
      title,
      onclick: (e) => {
        e.stopPropagation();
        fn(e);
      },
    },
    icon(ic, 14),
  );
const closeBtn = (node, ctx) => btn('x', t('Close'), () => ctx.remove([node.id]));
const editBtn = (node, ctx) => btn('pencil', t('Edit'), () => ctx.edit(node.id));

// ------------------------------------------------------------------ terminal
function terminalView(node, ctx) {
  const sh = shell(node, 'terminal', { connectable: true });
  const status = el('span', { class: 'status-dot' });
  const badges = el('span', { class: 'badges' });
  const restart = btn('rotate-cw', t('Restart shell'), () => doRestart());
  const chatBadge = el('b', { class: 'chat-badge', hidden: true });
  const chatBtn = el(
    'button',
    {
      class: 'btn chat-btn',
      title: t('Chat with the agent (Ctrl+J)'),
      onclick: (e) => {
        e.stopPropagation();
        toggleChat();
      },
    },
    icon('message-square', 14),
    chatBadge,
  );
  sh.head.prepend(status);
  sh.head.append(badges, chatBtn, restart, editBtn(node, ctx), closeBtn(node, ctx));

  const wrap = el('div', { class: 'term-wrap' });
  const chat = createChatView({
    node,
    name: () => inner(current).name || t('Terminal'),
    onUnread: (n) => {
      chatBadge.textContent = String(n);
      chatBadge.hidden = !n;
    },
  });
  sh.body.append(wrap, chat.el);
  function toggleChat() {
    if (chat.isOpen()) {
      chat.hide();
      sh.root.classList.remove('chat-on');
      setTimeout(() => {
        try {
          fit && fit.fit();
        } catch {
          /* ignore */
        }
        term && term.focus();
      }, 30);
    } else {
      sh.root.classList.add('chat-on');
      chat.show();
    }
  }
  let term = null;
  let fit = null;
  let attached = false;
  let exitedBar = null;
  let ro = null;
  let current = node;

  const opts = () => {
    const tc = inner(current);
    const p = S.prefs;
    return {
      fontFamily: tc.fontFamily || p.terminalFontFamily || 'Cascadia Mono, Consolas, monospace',
      fontSize: tc.fontSize || p.terminalFontSize || 13,
      theme: themeFor(tc.themeId || p.terminalTheme, systemDark()),
    };
  };

  // ---- prompter (composer under / over the terminal)
  let composer = null;
  const syncPrompter = () => {
    const p = S.prompter;
    const on_ = p.terminalId === node.id && p.placement !== 'off';
    sh.root.classList.toggle('prompter-overlay', on_ && p.placement === 'overlay');
    sh.root.classList.toggle('prompter-below', on_ && p.placement === 'below');
    if (on_ && !composer) {
      composer = createComposer(node, () => inner(current).name || t('Terminal'));
      sh.body.append(composer.el);
      composer.mount();
      setTimeout(() => composer && composer.focus(), 30);
    } else if (!on_ && composer) {
      composer.destroy();
      composer.el.remove();
      composer = null;
    }
  };
  S.listeners.prompter.push(syncPrompter);

  function paintHead() {
    const tc = inner(current);
    sh.titleEl.textContent = tc.name || t('Terminal');
    composer && composer.refreshName();
    sh.head.style.borderBottom = `2px solid ${tc.color || '#0a84ff'}`;
    badges.replaceChildren();
    if (tc.isManager)
      badges.append(
        el(
          'span',
          { class: 'badge maestro', title: t('Maestro mode: can recruit agents') },
          icon('crown', 11),
          'Maestro',
        ),
      );
    if (tc.remote)
      badges.append(
        el(
          'span',
          {
            class: 'badge',
            title: tc.remote.kind === 'ssh' ? `${tc.remote.user || ''}@${tc.remote.host}` : tc.remote.distro || 'WSL',
          },
          icon(tc.remote.kind === 'ssh' ? 'server' : 'container', 11),
          tc.remote.kind === 'ssh' ? 'SSH' : 'WSL',
        ),
      );
    const role = tc.assignedRoleId && S.prefs.rolePresets.find((r) => r.id === tc.assignedRoleId);
    if (role) badges.append(el('span', { class: 'badge' }, role.name));
  }

  function build() {
    const o = opts();
    term = new Terminal({
      ...o,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: !!S.prefs.optionAsMeta,
      windowsMode: true,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(wrap);
    term.onData((d) => api.termWrite(node.id, d));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.ctrlKey && k === 'v') {
        navigator.clipboard
          .readText()
          .then((tx) => tx && term.paste(tx))
          .catch(() => {});
        return false;
      }
      return true;
    });
    const doFit = debounce(() => {
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      api.termResize(node.id, term.cols, term.rows);
    }, 60);
    ro = new ResizeObserver(doFit);
    ro.observe(wrap);
  }

  async function attach() {
    const res = await api.termAttach(S.wsId, node.id);
    if (!res) return;
    if (res.ring) term.write(res.ring);
    attached = true;
    setStatus(res.status);
    if (!res.alive) showExited();
    try {
      fit.fit();
      api.termResize(node.id, term.cols, term.rows);
    } catch {
      /* not laid out yet */
    }
  }

  function showExited() {
    if (exitedBar) return;
    exitedBar = el(
      'div',
      { class: 'term-exited' },
      el('span', {}, t('Process exited.')),
      el('button', { onclick: () => doRestart() }, t('Restart')),
    );
    sh.body.append(exitedBar);
  }
  async function doRestart() {
    exitedBar && exitedBar.remove();
    exitedBar = null;
    attached = false;
    term.reset();
    await api.termRestart(S.wsId, node.id);
    attached = true;
    try {
      fit.fit();
      api.termResize(node.id, term.cols, term.rows);
    } catch {
      /* ignore */
    }
    term.focus();
  }
  function setStatus(s) {
    status.classList.toggle('running', s === 'running');
    status.title = s === 'running' ? t('Working') : t('Idle');
  }

  return {
    el: sh.root,
    mount() {
      build();
      paintHead();
      attach();
      syncPrompter();
      chat.subscribe();
    },
    prompter() {
      return composer;
    },
    toggleChat,
    chatOpen: () => chat.isOpen(),
    update(n) {
      current = n;
      paintHead();
      if (term) {
        const o = opts();
        term.options.fontFamily = o.fontFamily;
        term.options.fontSize = o.fontSize;
        term.options.theme = o.theme;
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
    },
    data(d) {
      if (attached && term) term.write(d);
    },
    restart() {
      return doRestart();
    },
    status: setStatus,
    exit() {
      showExited();
    },
    focus() {
      term && term.focus();
    },
    destroy() {
      const i = S.listeners.prompter.indexOf(syncPrompter);
      if (i >= 0) S.listeners.prompter.splice(i, 1);
      composer && composer.destroy();
      ro && ro.disconnect();
      term && term.dispose();
      chat.destroy();
    },
  };
}

// ---------------------------------------------------------------------- note
function noteView(node, ctx) {
  const sh = shell(node, 'note', { connectable: true });
  const area = el('textarea', { class: 'note-edit', spellcheck: false, placeholder: t('Write Markdown…') });
  const preview = el('div', { class: 'note-preview', hidden: true });
  const toggle = btn('eye', t('Raw / formatted'), () => setPreview(!inner(current).isPreviewing, true));
  const color = el('input', {
    type: 'color',
    style: { display: 'none' },
    oninput: () => patchNode(node.id, { content: withNote({ color: color.value }) }),
  });
  const palette = btn('palette', t('Color'), () => color.click());
  sh.head.append(toggle, palette, color, closeBtn(node, ctx));
  sh.body.append(area, preview);
  let current = node;
  let loaded = false;

  const withNote = (fields) => {
    const c = JSON.parse(JSON.stringify(getNode(node.id).content));
    Object.assign(c.stickyNote._0, fields);
    return c;
  };

  let removed = false;
  // The node may be gone (closed / undone) by the time a pending save fires: never surface that as an error.
  const save = debounce(async () => {
    if (removed || !getNode(node.id)) return;
    try {
      await api.noteWrite(S.wsId, node.id, area.value);
    } catch {
      /* note was removed meanwhile */
    }
  }, 400);
  area.addEventListener('input', save);
  area.addEventListener('blur', () => save.flush());
  area.addEventListener('paste', async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const blob = item.getAsFile();
    const url = await api.notePasteImage(
      S.wsId,
      node.id,
      new Uint8Array(await blob.arrayBuffer()),
      item.type.split('/')[1],
    );
    const s = area.selectionStart;
    area.setRangeText(`![image](${url})`, s, area.selectionEnd, 'end');
    save();
  });
  area.addEventListener('keydown', (e) => e.stopPropagation());

  function renderPreview() {
    const html = DOMPurify.sanitize(marked.parse(area.value || '', { gfm: true, breaks: true }), {
      ADD_ATTR: ['target'],
    });
    preview.innerHTML = html;
    preview.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternal(a.href);
      });
    });
  }
  function setPreview(on, persist) {
    if (on) renderPreview();
    area.hidden = on;
    preview.hidden = !on;
    toggle.replaceChildren(icon(on ? 'pencil' : 'eye', 14));
    if (persist) patchNode(node.id, { content: withNote({ isPreviewing: on }) });
  }
  async function reload() {
    if (document.activeElement === area) return;
    area.value = await api.noteRead(S.wsId, node.id);
    if (inner(current).isPreviewing) renderPreview();
  }

  const paint = () => {
    const sn = inner(current);
    sh.titleEl.textContent = (sn.fileName || 'Note.md').replace(/\.md$/i, '');
    sh.root.style.setProperty(
      '--note',
      /^#/.test(sn.color)
        ? sn.color
        : { yellow: '#fefde8', blue: '#e4f0ff', green: '#e6f7e6', pink: '#ffe6ef' }[sn.color] || '#fefde8',
    );
    area.style.fontSize = `${sn.fontSize || 14}px`;
    if (/^#/.test(sn.color)) color.value = sn.color;
  };

  return {
    el: sh.root,
    async mount() {
      paint();
      area.value = await api.noteRead(S.wsId, node.id);
      loaded = true;
      setPreview(!!inner(current).isPreviewing, false);
    },
    update(n) {
      current = n;
      paint();
    },
    external() {
      if (loaded) reload();
    },
    focus() {
      area.focus();
    },
    fontSize(d) {
      patchNode(node.id, {
        content: withNote({ fontSize: Math.min(40, Math.max(8, (inner(current).fontSize || 14) + d)) }),
      });
    },
    togglePreview() {
      setPreview(!inner(current).isPreviewing, true);
    },
    pickColor() {
      color.click();
    },
    format(kind) {
      if (inner(current).isPreviewing) setPreview(false, true);
      applyFormat(area, kind);
      area.dispatchEvent(new Event('input'));
      area.focus();
    },
    destroy() {
      if (getNode(node.id)) save.flush();
      removed = true;
    },
  };
}

// Markdown formatting helpers for the contextual note toolbar (operate on the raw textarea).
function applyFormat(area, kind) {
  const { selectionStart: s, selectionEnd: e, value } = area;
  const sel = value.slice(s, e);
  const wrap = (mark) => {
    const wrapped = sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2;
    const next = wrapped ? sel.slice(mark.length, sel.length - mark.length) : `${mark}${sel || ''}${mark}`;
    area.setRangeText(next, s, e, 'select');
    if (!sel) {
      const c = s + mark.length;
      area.setSelectionRange(c, c);
    }
  };
  const linePrefix = (prefix) => {
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const lineEnd = value.indexOf('\n', e);
    const end = lineEnd < 0 ? value.length : lineEnd;
    const lines = value
      .slice(start, end)
      .split('\n')
      .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : prefix + l));
    area.setRangeText(lines.join('\n'), start, end, 'end');
  };
  if (kind === 'bold') wrap('**');
  else if (kind === 'italic') wrap('*');
  else if (kind === 'code') wrap('`');
  else if (kind === 'heading') {
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const m = /^(#{1,3}) /.exec(value.slice(start));
    const next = !m ? '# ' : m[1].length >= 3 ? '' : '#'.repeat(m[1].length + 1) + ' ';
    area.setRangeText(next, start, start + (m ? m[0].length : 0), 'end');
  } else if (kind === 'todo') linePrefix('- [ ] ');
  else if (kind === 'bullet') linePrefix('- ');
  else if (kind === 'codeblock') area.setRangeText('```\n' + sel + '\n```', s, e, 'end');
}

// ----------------------------------------------------------------- file tree
function fileTreeView(node, ctx) {
  const sh = shell(node, 'filetree', { connectable: false });
  const refresh = btn('refresh-cw', t('Refresh'), () => build());
  const open = btn('external-link', t('Open folder'), () => api.openPath(inner(current).rootPath));
  const gitBtn = btn('git-branch', t('Git changes'), () => ctx.git && ctx.git(inner(current).rootPath));
  sh.head.append(gitBtn, refresh, open, editBtn(node, ctx), closeBtn(node, ctx));
  const box = el('div', { class: 'ft' });
  sh.body.append(box);
  let current = node;
  let git = null;

  const gitBadge = (p) => {
    if (!git) return null;
    const root = inner(current).rootPath.replace(/^~/, S.env.homedir);
    const rel = p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, '') : p;
    const s = git.files[rel] || Object.entries(git.files).find(([k]) => k.startsWith(rel + '\\'))?.[1];
    return s ? el('span', { class: `git git-${s[0]}` }, s[0]) : null;
  };

  async function expand(row, entry, depth) {
    const isOpen = row.dataset.open === '1';
    const arrow = row.querySelector('.arrow');
    if (isOpen) {
      row.dataset.open = '0';
      arrow.replaceChildren(icon('chevron-right', 12));
      let n = row.nextSibling;
      while (n && +n.dataset.depth > depth) {
        const nx = n.nextSibling;
        n.remove();
        n = nx;
      }
      return;
    }
    row.dataset.open = '1';
    arrow.replaceChildren(icon('chevron-down', 12));
    try {
      const items = await api.listDir(entry.path);
      let anchor = row;
      for (const it of items) {
        const r = makeRow(it, depth + 1);
        anchor.after(r);
        anchor = r;
      }
    } catch (err) {
      toast(t('Cannot read folder: {msg}', { msg: err.message }));
    }
  }
  function makeRow(entry, depth) {
    const arrow = el('span', { class: 'arrow' }, entry.dir ? icon('chevron-right', 12) : null);
    return el(
      'div',
      {
        class: 'ft-row',
        dataset: { depth },
        style: { paddingLeft: `${depth * 14 + 4}px` },
        onclick: function () {
          entry.dir && expand(this, entry, depth);
        },
        ondblclick: () => !entry.dir && api.openPath(entry.path),
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          api.revealPath(entry.path);
        },
      },
      arrow,
      icon(entry.dir ? 'folder' : 'file-text', 14, entry.dir ? 'ft-dir' : 'ft-file'),
      el('span', { class: 'ft-name' }, entry.name),
      gitBadge(entry.path),
    );
  }
  async function build() {
    box.replaceChildren(el('div', { class: 'ft-branch' }, t('Loading…')));
    const root = inner(current).rootPath;
    try {
      git = await api.gitStatus(root);
      const items = await api.listDir(root);
      box.replaceChildren();
      if (git && git.branch)
        box.append(
          el(
            'div',
            { class: 'ft-branch' },
            icon('git-branch', 12),
            ` ${git.branch} · ${t('{n} changed', { n: Object.keys(git.files).length })}`,
          ),
        );
      for (const it of items) box.append(makeRow(it, 0));
      if (!items.length) box.append(el('div', { class: 'ft-branch' }, t('(empty)')));
    } catch (err) {
      box.replaceChildren(
        el('div', { class: 'ft-branch' }, t('Cannot read {path}: {msg}', { path: root, msg: err.message })),
      );
    }
  }
  const paint = () => {
    sh.titleEl.textContent = inner(current).name;
  };
  return {
    el: sh.root,
    mount() {
      paint();
      build();
    },
    update(n) {
      const changed = inner(n).rootPath !== inner(current).rootPath;
      current = n;
      paint();
      if (changed) build();
    },
    destroy() {},
  };
}

// -------------------------------------------------------------------- portal
function portalView(node, ctx) {
  const sh = shell(node, 'portal', { connectable: true });
  sh.head.append(editBtn(node, ctx), closeBtn(node, ctx));
  const back = el('button', { title: t('Back') }, icon('arrow-left', 14));
  const fwd = el('button', { title: t('Forward') }, icon('arrow-right', 14));
  const reload = el('button', { title: t('Reload') }, icon('rotate-cw', 14));
  const url = el('input', { type: 'text', spellcheck: false, placeholder: t('Enter URL…') });
  const designBtn = el(
    'button',
    { title: t('Design mode: pick an element and send it to the agent') },
    icon('scan-search', 14),
  );
  const bar = el('div', { class: 'portal-bar' }, back, fwd, reload, url, designBtn);
  const body = el('div', { class: 'portal-body' }, bar);
  sh.body.append(body);
  let wv = null;
  let design = null;
  let current = node;

  const norm = (u) => {
    u = u.trim();
    if (!u) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    if (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(u)) return `http://${u}`;
    return `https://${u}`;
  };

  function create() {
    const pc = inner(current);
    const partition = pc.storageScope === 'shared' ? 'persist:portal-shared' : `persist:portal-${node.id}`;
    wv = document.createElement('webview');
    wv.setAttribute('partition', partition);
    wv.setAttribute('allowpopups', 'false');
    wv.setAttribute('src', pc.currentURL || 'about:blank');
    wv.addEventListener('dom-ready', () => api.portalRegister(node.id, wv.getWebContentsId()));
    const sync = () => {
      try {
        const u = wv.getURL();
        if (document.activeElement !== url) url.value = u === 'about:blank' ? '' : u;
        api.portalState(node.id, { url: u, title: wv.getTitle() });
        back.disabled = !wv.canGoBack();
        fwd.disabled = !wv.canGoForward();
        const c = JSON.parse(JSON.stringify(getNode(node.id).content));
        if (c.portal._0.currentURL !== u && u !== 'about:blank') {
          c.portal._0.currentURL = u;
          patchNode(node.id, { content: c }, { silent: true });
        }
      } catch {
        /* webview not ready */
      }
    };
    ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading'].forEach((ev) =>
      wv.addEventListener(ev, sync),
    );
    wv.addEventListener('page-title-updated', (e) => {
      sh.titleEl.textContent = e.title || inner(current).name;
    });
    body.append(wv);
    design = attachDesign({ body, wv, node, designBtn });
  }

  designBtn.onclick = () => design && design.toggle();
  back.onclick = () => wv && wv.canGoBack() && wv.goBack();
  fwd.onclick = () => wv && wv.canGoForward() && wv.goForward();
  reload.onclick = () => wv && wv.reload();
  url.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const u = norm(url.value);
      if (u && wv) wv.loadURL(u);
    }
  });

  return {
    el: sh.root,
    mount() {
      sh.titleEl.textContent = inner(current).name;
      bar.hidden = !!inner(current).chromeHidden;
      create();
    },
    update(n) {
      current = n;
      bar.hidden = !!inner(n).chromeHidden;
      if (!wv || !wv.getTitle()) sh.titleEl.textContent = inner(n).name;
    },
    reload() {
      wv && wv.reload();
    },
    toggleChrome() {
      const c = JSON.parse(JSON.stringify(getNode(node.id).content));
      c.portal._0.chromeHidden = !c.portal._0.chromeHidden;
      patchNode(node.id, { content: c });
    },
    destroy() {
      api.portalUnregister(node.id);
    },
  };
}

// ---------------------------------------------------------------------- text
function textView(node) {
  const sh = shell(node, 'textnode', { connectable: false, headless: true });
  const area = el('textarea', { class: 'text-edit', spellcheck: false, placeholder: t('Text') });
  const grip = el(
    'div',
    { class: 'text-grip', title: t('Drag to move'), dataset: { drag: node.id } },
    icon('hand', 12),
  );
  sh.body.append(area, grip);
  let current = node;
  const save = debounce(() => {
    const c = JSON.parse(JSON.stringify(getNode(node.id).content));
    c.text._0.text = area.value;
    patchNode(node.id, { content: c }, { silent: true });
  }, 300);
  area.addEventListener('input', save);
  area.addEventListener('keydown', (e) => e.stopPropagation());
  const paint = () => {
    const tx = inner(current);
    Object.assign(area.style, {
      fontSize: `${tx.fontSize}px`,
      fontWeight: tx.fontWeight === 'bold' ? 700 : tx.fontWeight === 'medium' ? 500 : 400,
      color: tx.color,
      textAlign: tx.alignment,
      fontFamily:
        tx.fontFamily === 'mono'
          ? 'Cascadia Mono, monospace'
          : tx.fontFamily === 'serif'
            ? 'Georgia, serif'
            : 'inherit',
    });
  };
  return {
    el: sh.root,
    mount() {
      area.value = inner(current).text;
      paint();
    },
    update(n) {
      current = n;
      paint();
    },
    focus() {
      area.focus();
    },
    destroy() {
      save.flush();
    },
  };
}

// ---------------------------------------------------------- shapes & strokes
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const dash = (style, w) => (style === 'dashed' ? `${w * 4} ${w * 3}` : style === 'dotted' ? `${w} ${w * 2}` : 'none');

function shapeView(node, ctx) {
  const sh = shell(node, 'shape', { connectable: false, headless: true });
  sh.body.dataset.drag = node.id;
  sh.body.classList.add('shape-body');
  const svg = svgEl('svg', { class: 'shape-svg', preserveAspectRatio: 'none', viewBox: '0 0 100 100' });
  const label = el('div', { class: 'shape-label', contentEditable: 'true', spellcheck: false });
  sh.body.append(svg, label);
  let current = node;
  label.addEventListener('keydown', (e) => e.stopPropagation());
  label.addEventListener('mousedown', (e) => e.stopPropagation());
  label.addEventListener(
    'input',
    debounce(() => {
      const c = JSON.parse(JSON.stringify(getNode(node.id).content));
      c.shape._0.text = label.innerText;
      patchNode(node.id, { content: c }, { silent: true });
    }, 300),
  );
  const paint = () => {
    const s = inner(current);
    const stroke = colorOf(s.strokeColor);
    const fill = s.fillStyle === 'none' ? 'none' : colorOf(s.fillColor);
    svg.replaceChildren();
    const common = {
      stroke,
      'stroke-width': s.strokeWidth,
      'stroke-dasharray': dash(s.strokeStyle, s.strokeWidth),
      fill,
      'fill-opacity': s.fillStyle === 'none' ? 0 : 0.22,
      'vector-effect': 'non-scaling-stroke',
    };
    const w = s.strokeWidth / 2;
    if (s.shapeType === 'ellipse') svg.append(svgEl('ellipse', { cx: 50, cy: 50, rx: 50 - w, ry: 50 - w, ...common }));
    else if (s.shapeType === 'diamond')
      svg.append(svgEl('polygon', { points: `50,${w} ${100 - w},50 50,${100 - w} ${w},50`, ...common }));
    else svg.append(svgEl('rect', { x: w, y: w, width: 100 - 2 * w, height: 100 - 2 * w, rx: 3, ...common }));
    if (label.innerText !== s.text) label.innerText = s.text || '';
    label.style.fontSize = `${s.fontSize || 16}px`;
    sh.root.style.transform = s.rotation ? `rotate(${s.rotation}rad)` : '';
  };
  return {
    el: sh.root,
    mount() {
      paint();
    },
    update(n) {
      current = n;
      paint();
    },
    destroy() {},
  };
}

function strokeView(node) {
  const sh = shell(node, 'stroke', { connectable: false, headless: true });
  sh.body.dataset.drag = node.id;
  sh.body.classList.add('shape-body');
  const svg = svgEl('svg', { class: 'shape-svg', preserveAspectRatio: 'none', viewBox: '0 0 100 100' });
  sh.body.append(svg);
  let current = node;
  const pt = (p) => [(Array.isArray(p) ? p[0] : p.x) * 100, (Array.isArray(p) ? p[1] : p.y) * 100];
  const paint = () => {
    const s = inner(current);
    const color = colorOf(s.strokeColor);
    svg.replaceChildren();
    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: `ah-${node.id}`,
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.append(marker);
    const [x1, y1] = pt(s.startPoint);
    const [x2, y2] = pt(s.endPoint);
    let d = `M${x1},${y1} L${x2},${y2}`;
    if (s.strokeType === 'arrow' && s.controlPoint) {
      const [cx, cy] = pt(s.controlPoint);
      d = `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`;
    }
    const p = svgEl('path', {
      d,
      fill: 'none',
      stroke: color,
      'stroke-width': s.strokeWidth,
      'stroke-linecap': 'round',
      'stroke-dasharray': dash(s.strokeStyle, s.strokeWidth),
      'vector-effect': 'non-scaling-stroke',
    });
    if (s.strokeType === 'arrow') p.setAttribute('marker-end', `url(#ah-${node.id})`);
    svg.append(defs, p);
  };
  return {
    el: sh.root,
    mount() {
      paint();
    },
    update(n) {
      current = n;
      paint();
    },
    destroy() {},
  };
}

// ------------------------------------------------------------------------- band
// A list of terminals on the left, the shown terminal on the right. Members are real terminal views embedded here.
function bandView(node, ctx) {
  const sh = shell(node, 'band', { connectable: true });
  const list = el('div', { class: 'band-list' });
  const pane = el('div', { class: 'band-pane' });
  const grip = el('div', { class: 'band-grip', title: t('Drag to resize the list') });
  const addBtn = btn('plus', t('New terminal in this band'), () => op('addNewMember'));
  sh.head.prepend(icon('users', 14));
  sh.head.append(addBtn, closeBtn(node, ctx));
  sh.body.append(el('div', { class: 'band-body' }, list, grip, pane));
  let current = node;
  let embedded = null;
  let embeddedId = null;
  const dots = new Map();
  const status = new Map();

  const data = () => inner(current);
  const shownId = () => {
    const d = data();
    return d.shownMemberId && d.memberNodeIds.includes(d.shownMemberId) ? d.shownMemberId : d.memberNodeIds[0] || null;
  };
  const termName = (id) => {
    const n = getNode(id);
    return n ? inner(n).name || t('Terminal') : '?';
  };

  async function op(name, args = {}) {
    flush();
    const r = await api.bandOp(S.wsId, name, { bandId: node.id, ...args });
    if (r.doc) setDoc(S.wsId, r.doc);
    if (!r.ok) toast(r.error);
    return r;
  }

  function paintList() {
    const d = data();
    list.style.width = `${d.listWidth || 190}px`;
    sh.titleEl.textContent = d.hasCustomName ? d.name : `${d.name} · ${termName(shownId())}`;
    dots.clear();
    list.replaceChildren(
      ...d.memberNodeIds.map((id) => {
        const dot = el('span', { class: `status-dot${status.get(id) === 'running' ? ' running' : ''}` });
        dots.set(id, dot);
        const row = el(
          'button',
          {
            class: `band-row${id === shownId() ? ' on' : ''}`,
            type: 'button',
            draggable: true,
            onclick: () => op('setShown', { id }),
            oncontextmenu: (e) => {
              e.preventDefault();
              ctx.memberMenu && ctx.memberMenu(e, node.id, id);
            },
          },
          dot,
          el('span', { class: 'band-name' }, termName(id)),
        );
        row.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('application/x-omaestri-member', id);
        });
        row.addEventListener('dragover', (e) => {
          if ([...e.dataTransfer.types].includes('application/x-omaestri-member')) e.preventDefault();
        });
        row.addEventListener('drop', (e) => {
          const m = e.dataTransfer.getData('application/x-omaestri-member');
          if (m && m !== id) {
            e.preventDefault();
            op('moveMember', { id: m, beforeId: id });
          }
        });
        return row;
      }),
    );
  }

  function mountShown() {
    const id = shownId();
    if (embeddedId === id && embedded) {
      embedded.update(getNode(id));
      return;
    }
    if (embedded) {
      embedded.destroy();
      embedded = null;
    }
    embeddedId = id;
    pane.replaceChildren();
    if (!id || !getNode(id)) return;
    embedded = terminalView(getNode(id), { remove: () => {}, edit: (x) => ctx.edit(x) });
    embedded.sig = JSON.stringify(getNode(id).content);
    pane.append(embedded.el.querySelector('.node-body'));
    embedded.mount();
  }

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX,
      w0 = data().listWidth || 190;
    const move = (ev) => {
      list.style.width = `${Math.max(120, Math.min(360, w0 + (ev.clientX - x0) / S.view.zoom))}px`;
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      op('setListWidth', { width: parseFloat(list.style.width) });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  return {
    el: sh.root,
    mount() {
      paintList();
      mountShown();
    },
    update(n) {
      current = n;
      paintList();
      mountShown();
    },
    // events for hidden members are routed here by canvas.viewOf()
    memberView(id) {
      if (!data().memberNodeIds.includes(id)) return null;
      return {
        data(d) {
          if (id === embeddedId && embedded) embedded.data(d);
        },
        status(s) {
          status.set(id, s);
          const dot = dots.get(id);
          if (dot) dot.classList.toggle('running', s === 'running');
          if (id === embeddedId && embedded) embedded.status(s);
        },
        exit() {
          if (id === embeddedId && embedded) embedded.exit();
        },
        restart() {
          return id === embeddedId && embedded ? embedded.restart() : undefined;
        },
        prompter: () => (id === embeddedId && embedded ? embedded.prompter() : null),
        update() {},
      };
    },
    shown: () => embedded,
    shownId,
    restart() {
      return embedded && embedded.restart();
    },
    focus() {
      embedded && embedded.focus();
    },
    destroy() {
      embedded && embedded.destroy();
    },
  };
}

// ------------------------------------------------------------ note stack (fichário)
// A tab rail on top of the front page; the page itself is a regular note view embedded in the stack.
function stackView(node, ctx) {
  const sh = shell(node, 'stack note', { connectable: true });
  const rail = el('div', { class: 'stack-tabs' });
  const pageBox = el('div', { class: 'stack-page' });
  sh.head.prepend(icon('notebook-tabs', 14));
  sh.head.append(
    btn('plus', t('New page'), () => op('addPage')),
    closeBtn(node, ctx),
  );
  sh.body.append(rail, pageBox);
  let current = node;
  let embedded = null;
  let embeddedId = null;

  const data = () => inner(current);
  const frontId = () => {
    const d = data();
    return d.frontNoteId && d.memberNodeIds.includes(d.frontNoteId) ? d.frontNoteId : d.memberNodeIds[0] || null;
  };
  const pageName = (id) => {
    const n = getNode(id);
    return n ? (inner(n).fileName || '').replace(/\.md$/i, '') : '?';
  };

  async function op(name, args = {}) {
    flush();
    const r = await api.stackOp(S.wsId, name, { stackId: node.id, ...args });
    if (r.doc) setDoc(S.wsId, r.doc);
    if (!r.ok) toast(r.error);
    return r;
  }

  function paintRail() {
    const d = data();
    sh.titleEl.textContent = d.hasCustomName ? d.name : `${d.name} · ${pageName(frontId())}`;
    rail.replaceChildren(
      ...d.memberNodeIds.map((id) => {
        const b = el(
          'button',
          {
            class: `stack-tab${id === frontId() ? ' on' : ''}`,
            type: 'button',
            draggable: true,
            title: pageName(id),
            onclick: () => op('setFront', { noteId: id }),
            oncontextmenu: (e) => {
              e.preventDefault();
              ctx.pageMenu && ctx.pageMenu(e, node.id, id);
            },
          },
          pageName(id),
        );
        b.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('application/x-omaestri-page', id);
        });
        b.addEventListener('dragover', (e) => {
          if ([...e.dataTransfer.types].includes('application/x-omaestri-page')) e.preventDefault();
        });
        b.addEventListener('drop', (e) => {
          const moved = e.dataTransfer.getData('application/x-omaestri-page');
          if (moved && moved !== id) {
            e.preventDefault();
            op('moveMember', { noteId: moved, beforeId: id });
          }
        });
        return b;
      }),
    );
  }

  function mountFront() {
    const fid = frontId();
    if (embeddedId === fid && embedded) {
      embedded.update(getNode(fid));
      copyColor();
      return;
    }
    if (embedded) {
      embedded.destroy();
      embedded = null;
    }
    embeddedId = fid;
    pageBox.replaceChildren();
    if (!fid || !getNode(fid)) return;
    embedded = noteView(getNode(fid), { remove: () => {}, edit: () => {} });
    embedded.sig = JSON.stringify(getNode(fid).content);
    pageBox.append(embedded.el.querySelector('.node-body'));
    embedded.mount();
    copyColor();
  }
  const copyColor = () => {
    if (embedded) sh.root.style.setProperty('--note', embedded.el.style.getPropertyValue('--note'));
  };

  return {
    el: sh.root,
    mount() {
      paintRail();
      mountFront();
    },
    update(n) {
      current = n;
      paintRail();
      mountFront();
    },
    front: () => embedded,
    external() {
      embedded && embedded.external && embedded.external();
    },
    focus() {
      embedded && embedded.focus && embedded.focus();
    },
    destroy() {
      embedded && embedded.destroy();
    },
  };
}

function freehandView(node) {
  const sh = shell(node, 'freehand', { connectable: false, headless: true });
  sh.body.dataset.drag = node.id;
  sh.body.classList.add('shape-body');
  const svg = svgEl('svg', { class: 'shape-svg', preserveAspectRatio: 'none', viewBox: '0 0 100 100' });
  sh.body.append(svg);
  let current = node;
  const toXY = (p) => [(Array.isArray(p) ? p[0] : p.x) * 100, (Array.isArray(p) ? p[1] : p.y) * 100];
  const paint = () => {
    const f = inner(current);
    svg.replaceChildren();
    const pts = (f.points || []).map(toXY);
    if (pts.length < 2) return;
    // quadratic smoothing through midpoints keeps hand-drawn lines soft
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++)
      d += ` Q${pts[i][0]},${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2},${(pts[i][1] + pts[i + 1][1]) / 2}`;
    d += ` L${pts[pts.length - 1][0]},${pts[pts.length - 1][1]}`;
    svg.append(
      svgEl('path', {
        d,
        fill: 'none',
        stroke: colorOf(f.strokeColor),
        'stroke-width': f.strokeWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-opacity': f.opacity ?? 1,
        'vector-effect': 'non-scaling-stroke',
      }),
    );
    sh.root.style.transform = f.rotation ? `rotate(${f.rotation}rad)` : '';
  };
  return {
    el: sh.root,
    mount() {
      paint();
    },
    update(n) {
      current = n;
      paint();
    },
    destroy() {},
  };
}

// Cross-floor connector: one per floor for a connection between terminals on different floors.
function connectorView(node, ctx) {
  const sh = shell(node, 'connector', { connectable: false, headless: true });
  let current = node;
  const label = el('span', { class: 'cf-label' });
  const go = el(
    'button',
    {
      class: 'cf-go',
      type: 'button',
      onclick: (e) => {
        e.stopPropagation();
        const d = inner(current);
        ctx.jump(d.peerTerminalId, d.peerFloorId);
      },
    },
    icon('arrow-right-left', 14),
    label,
  );
  const cut = btn('unlink', t('Disconnect'), () => ctx.disconnectCross(inner(current).connectionId));
  sh.body.append(go, cut);
  const paint = () => {
    const d = inner(current);
    label.textContent = `${d.peerFloorName} · ${d.peerName}`;
    go.title = t('Go to {name} on {floor}', { name: d.peerName, floor: d.peerFloorName });
  };
  return {
    el: sh.root,
    mount() {
      paint();
    },
    update(n) {
      current = n;
      paint();
    },
    destroy() {},
  };
}

// Unknown nodes from Maestri files: shown as inert placeholders but preserved on save.
function placeholderView(node) {
  const sh = shell(node, 'placeholder', { connectable: false });
  sh.titleEl.textContent = t('{kind} (not editable on Windows yet)', { kind: kindOf(node) });
  return { el: sh.root, mount() {}, update() {}, destroy() {} };
}

export function createNodeView(node, ctx) {
  switch (kindOf(node)) {
    case 'terminal':
      return terminalView(node, ctx);
    case 'note':
      return noteView(node, ctx);
    case 'fileTree':
      return fileTreeView(node, ctx);
    case 'portal':
      return portalView(node, ctx);
    case 'text':
      return textView(node, ctx);
    case 'shape':
      return shapeView(node, ctx);
    case 'stroke':
      return strokeView(node, ctx);
    case 'freehand':
      return freehandView(node, ctx);
    case 'noteStack':
      return stackView(node, ctx);
    case 'band':
      return bandView(node, ctx);
    case 'connector':
      return connectorView(node, ctx);
    default:
      return placeholderView(node);
  }
}
export { rectOf };
