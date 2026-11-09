// Command palette (Ctrl+K): actions, navigation (workspaces / floors / terminals / notes / portals)
// and a guided flow "send a prompt to a terminal" (pick target → compose → Enter).
import { el, kindOf, inner, toast } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api } from './store.js';
import { rankItems, capNavigation, highlight } from './palette-rank.js';

let open = null;

export function isPaletteOpen() {
  return !!open;
}
export function closePalette() {
  if (open) {
    open.close();
  }
}

// H = { run(actionId), goWorkspace(id), goFloor(id|null), focusNode(id) }
export function openPalette(H, { flow = null } = {}) {
  if (open) return closePalette();
  const previous = document.activeElement;
  const root = document.getElementById('modal-root');
  const input = el('input', {
    class: 'pal-input',
    type: 'text',
    spellcheck: false,
    autocomplete: 'off',
    placeholder: t('Type a command or search…'),
  });
  const list = el('div', { class: 'pal-list', role: 'listbox' });
  const foot = el('div', { class: 'pal-foot' });
  const compose = el('textarea', {
    class: 'pal-compose',
    rows: 3,
    placeholder: t('Prompt to send (Enter sends, Shift+Enter new line)'),
    hidden: true,
  });
  const crumb = el('div', { class: 'pal-crumb', hidden: true });
  const card = el(
    'div',
    { class: 'pal glass', role: 'dialog' },
    el('div', { class: 'pal-search' }, icon('search', 16), input),
    crumb,
    list,
    compose,
    foot,
  );
  const bg = el('div', { class: 'modal-bg pal-bg', onmousedown: (e) => e.target === bg && close() }, card);

  let items = [];
  let results = [];
  let index = 0;
  let step = flow || { kind: 'commands' };
  let chosen = null;

  const nodesOfKind = (pred) => S.doc.payload.nodes.filter(pred);
  const floorTag = (n) => {
    const f = n.floorId && S.doc.payload.floors.find((x) => x.id === n.floorId);
    return f ? f.name : t('Ground');
  };

  function commands() {
    const A = (id, title, ic, kw = []) => ({
      id: `a:${id}`,
      group: 'actions',
      title,
      icon: ic,
      keywords: kw,
      action: id,
    });
    const out = [
      A('terminal', t('New terminal'), 'terminal', ['agent', 'shell', 'claude', 'codex']),
      A('note', t('New note'), 'sticky-note'),
      A('fileTree', t('New file tree'), 'folder-tree'),
      A('portal', t('New portal'), 'globe', ['browser', 'web']),
      A('text', t('New text label'), 'type'),
      A('workspace', t('New workspace'), 'plus'),
      A('chat', t('Toggle chat on the terminal'), 'message-square', ['conversation', 'say', 'talk']),
      A('pullRequests', t('Pull requests'), 'git-pull-request', ['pr', 'github', 'gh']),
      A('overview', t('Floor overview'), 'layout-grid', ['floors', 'andares', 'connect']),
      A('git', t('Open git changes'), 'git-branch', ['commit', 'stage', 'diff', 'branch']),
      A('partituras', t('Open partituras…'), 'layout-grid', ['template', 'team', 'layout']),
      A('savePartitura', t('Save selection as partitura…'), 'save', ['template']),
      A('importWorkspace', t('Import workspace…'), 'upload', ['open', 'file']),
      A('floor', t('New floor'), 'layers', ['git', 'worktree', 'branch']),
      A('group', t('New sidebar group'), 'folder'),
      A('routines', t('Open routines'), 'calendar-clock', ['schedule', 'cron']),
      A('prefs', t('Open preferences'), 'settings', ['settings', 'config']),
      A('prompter', t('Toggle prompter'), 'panel-bottom', ['compose', 'prompt']),
      A('fit', t('Fit everything'), 'maximize-2', ['zoom']),
      A('undo', t('Undo'), 'undo-2'),
      A('redo', t('Redo'), 'redo-2'),
      A('backup', t('Back up now'), 'save', ['export', 'data']),
      A('ide', t('Open folder in IDE'), 'code-xml'),
      {
        id: 'flow:send',
        group: 'actions',
        title: t('Send prompt to a terminal…'),
        icon: 'arrow-up',
        keywords: ['ask', 'message', 'agent'],
        flow: 'send',
        boost: 5,
      },
    ];
    for (const w of S.workspaces)
      out.push({
        id: `w:${w.id}`,
        group: 'navigation',
        title: w.name,
        sub: t('Workspace'),
        icon: 'layout-grid',
        go: () => H.goWorkspace(w.id),
        boost: w.id === S.wsId ? -50 : 0,
      });
    for (const f of S.doc.payload.floors)
      out.push({
        id: `f:${f.id}`,
        group: 'navigation',
        title: f.name,
        sub: t('Floor · {b}', { b: f.branchName }),
        icon: 'git-branch',
        go: () => H.goFloor(f.id),
      });
    if (S.doc.payload.floors.length)
      out.push({
        id: 'f:ground',
        group: 'navigation',
        title: t('Ground'),
        sub: t('Floor'),
        icon: 'house',
        go: () => H.goFloor(null),
      });
    for (const n of S.doc.payload.nodes) {
      const k = kindOf(n);
      if (!['terminal', 'note', 'portal'].includes(k)) continue;
      const i = inner(n);
      const name = i.name || (i.fileName || '').replace(/\.md$/i, '');
      out.push({
        id: `n:${n.id}`,
        group: 'navigation',
        title: name,
        sub: `${t(k)} · ${floorTag(n)}`,
        icon: k === 'terminal' ? 'terminal' : k === 'note' ? 'sticky-note' : 'globe',
        go: () => H.focusNode(n.id, n.floorId || null),
      });
    }
    return out;
  }

  function targets() {
    return nodesOfKind((n) => n.content.terminal).map((n) => ({
      id: n.id,
      title: n.content.terminal._0.name,
      sub: floorTag(n),
      icon: 'terminal',
      node: n,
    }));
  }

  function refresh() {
    const q = input.value;
    if (step.kind === 'commands') {
      items = items.length ? items : commands();
      results = capNavigation(rankItems(items, q));
    } else if (step.kind === 'pickTarget') {
      items = items.length ? items : targets();
      results = rankItems(items, q);
    }
    index = 0;
    paint();
  }

  function paint() {
    list.replaceChildren();
    crumb.hidden = step.kind === 'commands';
    compose.hidden = step.kind !== 'compose';
    list.hidden = step.kind === 'compose';
    if (step.kind === 'pickTarget') crumb.replaceChildren(icon('arrow-up', 13), t('Send prompt to a terminal…'));
    if (step.kind === 'compose')
      crumb.replaceChildren(icon('terminal', 13), t('Prompt for {name}', { name: chosen.title }));
    if (step.kind !== 'compose') {
      if (!results.length)
        list.append(
          el(
            'div',
            { class: 'pal-empty' },
            step.kind === 'pickTarget' && !items.length ? t('This workspace has no terminals.') : t('No results'),
          ),
        );
      let lastGroup = null;
      results.forEach((r, i) => {
        const it = r.item;
        if (step.kind === 'commands' && it.group !== lastGroup) {
          lastGroup = it.group;
          list.append(el('div', { class: 'pal-sec' }, it.group === 'actions' ? t('Actions') : t('Go to')));
        }
        const label = el(
          'span',
          { class: 'pal-title' },
          ...highlight(it.title, r.titleOffsets).map((p) => (p.hit ? el('b', {}, p.text) : p.text)),
        );
        list.append(
          el(
            'button',
            {
              class: `pal-row${i === index ? ' on' : ''}`,
              type: 'button',
              role: 'option',
              onmouseenter: () => {
                index = i;
                paintSel();
              },
              onmousedown: (e) => {
                e.preventDefault();
                choose(i);
              },
            },
            icon(it.icon || 'circle', 16),
            label,
            it.sub ? el('span', { class: 'pal-sub' }, it.sub) : null,
          ),
        );
      });
    }
    foot.replaceChildren(
      el(
        'span',
        {},
        step.kind === 'compose' ? t('Enter sends · Esc goes back') : t('↑↓ navigate · Enter run · Esc close'),
      ),
    );
    paintSel();
  }
  function paintSel() {
    [...list.querySelectorAll('.pal-row')].forEach((n, i) => n.classList.toggle('on', i === index));
    const on = list.querySelector('.pal-row.on');
    on && on.scrollIntoView({ block: 'nearest' });
  }

  async function choose(i) {
    const r = results[i];
    if (!r) return;
    const it = r.item;
    if (step.kind === 'commands') {
      if (it.flow === 'send') {
        step = { kind: 'pickTarget' };
        items = [];
        input.value = '';
        input.placeholder = t('Choose a terminal…');
        refresh();
        return;
      }
      close();
      if (it.go) it.go();
      else H.run(it.action);
    } else if (step.kind === 'pickTarget') {
      chosen = it;
      step = { kind: 'compose' };
      paint();
      compose.focus();
    }
  }

  async function send() {
    const text = compose.value;
    if (!text.trim()) return;
    const r = await api.prompterDeliver(chosen.id, text);
    if (!r.ok) {
      toast(
        r.reason === 'notRunning'
          ? t('This terminal is not running. Restart it to send prompts.')
          : t('Nothing to send.'),
      );
      return;
    }
    close();
    toast(t('Prompt sent to {name}', { name: chosen.title }));
  }

  function back() {
    if (step.kind === 'compose') {
      step = { kind: 'pickTarget' };
      paint();
      input.focus();
      return;
    }
    if (step.kind === 'pickTarget') {
      step = { kind: 'commands' };
      items = [];
      input.value = '';
      input.placeholder = t('Type a command or search…');
      refresh();
      return;
    }
    close();
  }

  const keys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    if (step.kind === 'compose') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = Math.min(results.length - 1, index + 1);
      paintSel();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = Math.max(0, index - 1);
      paintSel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(index);
    }
  };
  card.addEventListener('keydown', (e) => {
    e.stopPropagation();
    keys(e);
  });
  input.addEventListener('input', refresh);

  function close() {
    bg.remove();
    open = null;
    if (previous && previous.isConnected && previous.focus) previous.focus();
  }
  open = { close };
  root.append(bg);
  if (step.kind === 'pickTarget') input.placeholder = t('Choose a terminal…');
  refresh();
  input.focus();
}
