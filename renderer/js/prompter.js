// Prompter: a composer docked under (or floating over) a terminal. Enter sends the prompt to the agent,
// "@" mentions files / connected nodes / floors / workspaces / routines, "/" (or the bookmark button) opens the
// saved prompts, big pastes collapse into a chip, drafts are kept per terminal.
import { el, toast, debounce } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api, emit } from './store.js';
import { rankSavedPrompts, savedPromptRows } from './prompt-rank.js';
// dialogs.js is imported lazily: it depends on nodes.js, which imports this module
const openPromptDialog = async (...a) => (await import('./dialogs.js')).savedPromptDialog(...a);

const PLACEMENTS = ['off', 'overlay', 'below'];
const PASTE_LINES = 6,
  PASTE_CHARS = 800;
const drafts = new Map(); // terminalId -> text
const fileCache = new Map(); // terminalId -> { files, truncated }

// ---- shared state (one prompter at a time, like Maestri)
const stored = () => {
  try {
    return localStorage.getItem('prompterPlacement');
  } catch {
    return null;
  }
};
S.prompter = { terminalId: null, placement: PLACEMENTS.includes(stored()) ? stored() : 'overlay' };
export const placementLabel = (p) =>
  p === 'off' ? t('Show prompter') : p === 'overlay' ? t('Dock prompter below') : t('Hide prompter');
export function cyclePrompter(terminalId) {
  const cur = S.prompter.terminalId === terminalId ? S.prompter.placement : 'off';
  const next = PLACEMENTS[(PLACEMENTS.indexOf(cur) + 1) % PLACEMENTS.length];
  setPrompter(terminalId, next);
}
export function setPrompter(terminalId, placement) {
  S.prompter = { terminalId: placement === 'off' ? null : terminalId, placement };
  if (placement !== 'off') {
    try {
      localStorage.setItem('prompterPlacement', placement);
    } catch {
      /* storage unavailable */
    }
  }
  emit('prompter');
}

// ---- helpers
const pastedLabel = (text, n) => {
  const lines = text.split(/\r?\n/).length;
  return `⟦${t('Pasted text {n}', { n })} · ${lines > 1 ? t('{c} lines', { c: lines }) : t('{c} characters', { c: text.length })}⟧`;
};

export function createComposer(node, terminalName) {
  const id = node.id;
  const root = el('div', { class: 'prompter' });
  const area = el('textarea', {
    class: 'pr-input',
    rows: 1,
    spellcheck: false,
    placeholder: t('Prompt for {name}… (@ mention, / saved prompts)', { name: terminalName() }),
  });
  const sendBtn = el(
    'button',
    { class: 'pr-send', type: 'button', title: t('Send (Enter)'), disabled: true },
    icon('arrow-up', 16),
  );
  const promptsBtn = el(
    'button',
    { class: 'pr-tool', type: 'button', title: t('Saved prompts') },
    icon('bookmark', 16),
  );
  const mentionBtn = el('button', { class: 'pr-tool', type: 'button', title: t('Mention (@)') }, icon('at-sign', 16));
  const hint = el('span', { class: 'pr-hint' }, t('Enter sends · Shift+Enter new line'));
  const warn = el('div', { class: 'pr-warn', hidden: true });
  const menuHost = el('div', { class: 'pr-menu-host' });
  root.append(
    menuHost,
    warn,
    el('div', { class: 'pr-box' }, area, el('div', { class: 'pr-bar' }, promptsBtn, mentionBtn, hint, sendBtn)),
  );

  const pastes = new Map(); // token -> text
  let pasteCount = 0;
  let menu = null; // { kind:'mention'|'prompt', items, index, query, start, optionsFor }
  let targets = null;
  let sending = false;
  let prompts = [];

  const autosize = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 190)}px`;
  };
  const saveDraft = debounce(() => drafts.set(id, area.value), 150);
  const refreshSend = () => {
    sendBtn.disabled = sending || !area.value.trim();
  };

  async function loadTargets() {
    if (!targets) targets = (await api.prompterTargets(S.wsId, id)) || {};
    // the file index can take a moment on big folders: never make the menu wait for it
    if (!fileCache.has(id)) {
      fileCache.set(id, { files: [], loading: true });
      api
        .prompterFileIndex(S.wsId, id)
        .then((idx) => {
          fileCache.set(id, idx);
          if (menu && menu.kind === 'mention') buildMenu();
        })
        .catch(() => fileCache.set(id, { files: [] }));
    }
  }
  async function loadPrompts() {
    prompts = await api.promptsVisible(S.wsId);
  }

  // ---------------------------------------------------------------- menus
  function closeMenu() {
    menu = null;
    menuHost.replaceChildren();
  }
  function paintMenu() {
    if (!menu) return;
    const rows = menu.rows;
    menuHost.replaceChildren(
      el(
        'div',
        { class: 'pr-menu glass' },
        ...(rows.length
          ? rows.map((r, i) =>
              r.header
                ? el('div', { class: 'pr-sec' }, r.header)
                : el(
                    'button',
                    {
                      class: `pr-opt${i === menu.index ? ' on' : ''}`,
                      type: 'button',
                      onmousedown: (e) => {
                        e.preventDefault();
                        commit(i);
                      },
                      onmouseenter: () => {
                        menu.index = i;
                        paintMenu();
                      },
                      oncontextmenu: (e) => {
                        if (menu.kind === 'prompt' && r.kind === 'prompt') {
                          e.preventDefault();
                          menu.optionsFor = r.prompt;
                          buildMenu();
                        }
                      },
                    },
                    icon(r.ic || 'file-text', 14),
                    el('span', { class: 'pr-lab' }, r.label),
                    r.sub ? el('span', { class: 'pr-sub' }, r.sub) : null,
                  ),
            )
          : [el('div', { class: 'pr-empty' }, t('No results'))]),
      ),
    );
    const on = menuHost.querySelector('.pr-opt.on');
    on && on.scrollIntoView({ block: 'nearest' });
  }

  function mentionRows(query) {
    const q = query.toLowerCase();
    const has = (s) => !q || String(s).toLowerCase().includes(q);
    const rows = [];
    const sec = (title, items) => {
      if (items.length) rows.push({ header: title }, ...items);
    };
    const T = targets || {};
    sec(t('Connected'), [
      ...(T.agents || [])
        .filter((a) => has(a.name))
        .map((a) => ({ ic: 'terminal', label: a.name, insert: `@${a.name}` })),
      ...(T.notes || [])
        .filter((n) => has(n.name))
        .map((n) => ({ ic: 'sticky-note', label: n.name, sub: t('note'), insert: `${n.name} (${n.path})` })),
      ...(T.portals || [])
        .filter((p) => has(p.name))
        .map((p) => ({
          ic: 'globe',
          label: p.name,
          sub: p.url || '',
          insert: `${p.name}${p.url ? ` (${p.url})` : ''}`,
        })),
    ]);
    const idx = fileCache.get(id) || { files: [] };
    sec(
      t('Files'),
      idx.files
        .filter((f) => has(f))
        .sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q) || a.length - b.length)
        .slice(0, 8)
        .map((f) => ({ ic: 'file-text', label: f.split('/').pop(), sub: f, insert: f })),
    );
    sec(
      t('Floors'),
      (T.floors || [])
        .filter((f) => has(f.name))
        .map((f) => ({ ic: 'layers', label: f.id ? f.name : t('Ground'), insert: f.id ? f.name : t('Ground') })),
    );
    sec(
      t('Workspaces'),
      (T.workspaces || [])
        .filter((w) => has(w.name))
        .map((w) => ({ ic: 'layout-grid', label: w.name, insert: w.name })),
    );
    sec(
      t('Routines'),
      (T.routines || [])
        .filter((r) => has(r.name))
        .map((r) => ({ ic: 'calendar-clock', label: r.name, insert: r.name })),
    );
    return rows;
  }

  function promptRows() {
    const matches = rankSavedPrompts(prompts, menu.query);
    const base = savedPromptRows(matches, menu.query, menu.optionsFor);
    return base.map((r) => {
      if (r.kind === 'create') return { kind: 'create', ic: 'plus', label: t('New saved prompt…') };
      if (r.kind === 'edit')
        return { kind: 'edit', prompt: r.prompt, ic: 'pencil', label: t('Edit “{n}”', { n: r.prompt.name }) };
      if (r.kind === 'delete')
        return { kind: 'delete', prompt: r.prompt, ic: 'trash-2', label: t('Delete “{n}”', { n: r.prompt.name }) };
      return {
        kind: 'prompt',
        prompt: r.prompt,
        ic: 'bookmark',
        label: r.prompt.name.replaceAll('-', ' '),
        sub: r.prompt.description || r.prompt.text.slice(0, 60),
      };
    });
  }

  function buildMenu() {
    if (!menu) return;
    menu.rows = menu.kind === 'mention' ? mentionRows(menu.query) : promptRows();
    const sel = menu.rows.findIndex(
      (r) => !r.header && (menu.kind === 'mention' || r.kind === 'prompt' || menu.optionsFor),
    );
    if (menu.index < 0 || !menu.rows[menu.index] || menu.rows[menu.index].header) menu.index = sel < 0 ? 0 : sel;
    paintMenu();
  }

  async function openMenu(kind, start, query = '') {
    if (kind === 'mention') await loadTargets();
    else await loadPrompts();
    menu = { kind, start, query, index: -1, rows: [], optionsFor: null };
    buildMenu();
  }

  function replaceRange(from, to, text) {
    area.setRangeText(text, from, to, 'end');
    area.dispatchEvent(new Event('input'));
    area.focus();
  }

  async function commit(i) {
    const r = menu && menu.rows[i];
    if (!r || r.header) return;
    if (menu.kind === 'mention') {
      const end = area.selectionStart;
      replaceRange(menu.start, end, `${r.insert} `);
      closeMenu();
      return;
    }
    if (r.kind === 'create') {
      const end = area.selectionStart;
      const draft = area.value.slice(menu.start + 1, end);
      closeMenu();
      replaceRange(menu.start, end, '');
      openPromptDialog({ kind: 'new', text: draft, workspaceId: S.wsId }, async () => {
        await loadPrompts();
      });
      return;
    }
    if (r.kind === 'edit') {
      const p = r.prompt;
      closeMenu();
      openPromptDialog({ kind: 'edit', prompt: p }, loadPrompts);
      return;
    }
    if (r.kind === 'delete') {
      await api.promptsDelete(r.prompt.id);
      await loadPrompts();
      toast(t('Prompt deleted'), 4000);
      closeMenu();
      return;
    }
    if (r.kind === 'prompt') {
      const end = area.selectionStart;
      replaceRange(menu.start, end, r.prompt.text);
      closeMenu();
    }
  }

  // detect "@query" at the caret, or "/query" at the very start
  function maybeMenu() {
    const pos = area.selectionStart;
    const before = area.value.slice(0, pos);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      const start = pos - m[1].length - 1;
      if (menu && menu.kind === 'mention') {
        menu.query = m[1];
        menu.start = start;
        menu.index = -1;
        buildMenu();
      } else openMenu('mention', start, m[1]);
      return;
    }
    const sl = /^\/([^\s]*)$/.exec(before);
    if (sl) {
      if (menu && menu.kind === 'prompt') {
        menu.query = sl[1];
        menu.start = 0;
        menu.index = -1;
        buildMenu();
      } else openMenu('prompt', 0, sl[1]);
      return;
    }
    if (menu) closeMenu();
  }

  // ------------------------------------------------------------------ events
  area.addEventListener('input', () => {
    autosize();
    refreshSend();
    saveDraft();
    maybeMenu();
  });
  area.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep canvas shortcuts out of the composer
    if (menu) {
      const sel = menu.rows.map((r, i) => (r.header ? -1 : i)).filter((i) => i >= 0);
      const at = sel.indexOf(menu.index);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        menu.index = sel[(at + 1) % sel.length];
        paintMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        menu.index = sel[(at - 1 + sel.length) % sel.length];
        paintMenu();
        return;
      }
      if (e.key === 'ArrowRight' && menu.kind === 'prompt' && menu.rows[menu.index]?.kind === 'prompt') {
        e.preventDefault();
        menu.optionsFor = menu.rows[menu.index].prompt;
        buildMenu();
        return;
      }
      if (e.key === 'ArrowLeft' && menu.optionsFor) {
        e.preventDefault();
        menu.optionsFor = null;
        buildMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commit(menu.index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setPrompter(null, 'off');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  area.addEventListener('paste', (e) => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    if (text.split(/\r?\n/).length >= PASTE_LINES || text.length >= PASTE_CHARS) {
      e.preventDefault();
      const token = pastedLabel(text, ++pasteCount);
      pastes.set(token, text);
      area.setRangeText(token + ' ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    }
  });
  area.addEventListener('blur', () =>
    setTimeout(() => {
      if (!root.contains(document.activeElement)) closeMenu();
    }, 120),
  );
  promptsBtn.addEventListener('click', () => {
    area.focus();
    if (menu && menu.kind === 'prompt') return closeMenu();
    const pos = area.selectionStart;
    if (!area.value.trim()) {
      area.value = '/';
      area.setSelectionRange(1, 1);
    }
    openMenu(
      'prompt',
      area.value.startsWith('/') ? 0 : pos,
      area.value.startsWith('/') ? area.value.slice(1, area.selectionStart) : '',
    );
  });
  mentionBtn.addEventListener('click', () => {
    area.focus();
    const pos = area.selectionStart;
    area.setRangeText('@', pos, pos, 'end');
    area.dispatchEvent(new Event('input'));
  });
  sendBtn.addEventListener('click', () => send());
  // files dropped on the composer insert their path
  root.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      root.classList.add('drop');
    }
  });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', (e) => {
    root.classList.remove('drop');
    const paths = [...(e.dataTransfer?.files || [])].map((f) => window.maestri.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    e.preventDefault();
    e.stopPropagation();
    area.setRangeText(
      paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ') + ' ',
      area.selectionStart,
      area.selectionEnd,
      'end',
    );
    area.dispatchEvent(new Event('input'));
  });

  async function send() {
    if (sending) return;
    let text = area.value;
    for (const [token, full] of pastes) text = text.replace(token, full);
    if (!text.trim()) return;
    sending = true;
    refreshSend();
    const r = await api.prompterDeliver(id, text);
    sending = false;
    if (!r.ok) {
      warn.hidden = false;
      warn.textContent =
        r.reason === 'notRunning'
          ? t('This terminal is not running. Restart it to send prompts.')
          : t('Nothing to send.');
      refreshSend();
      return;
    }
    warn.hidden = true;
    area.value = '';
    pastes.clear();
    drafts.delete(id);
    autosize();
    refreshSend();
    closeMenu();
    area.focus();
  }

  return {
    el: root,
    focus: () => area.focus(),
    refreshName: () => {
      area.placeholder = t('Prompt for {name}… (@ mention, / saved prompts)', { name: terminalName() });
    },
    mount() {
      area.value = drafts.get(id) || '';
      autosize();
      refreshSend();
      fileCache.delete(id);
      targets = null;
    },
    destroy() {
      drafts.set(id, area.value);
      closeMenu();
    },
    // test hooks
    _send: send,
    _area: area,
  };
}
