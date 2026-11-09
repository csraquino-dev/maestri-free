// Modal dialogs: new terminal, edit node, workspace, floors, routines, preferences.
import { el, toast, WORKSPACE_COLORS, kindOf } from './util.js';
import { S, api, patchNode, setDoc, flush } from './store.js';
import { THEME_IDS } from './themes.js';
import { icon } from './icons.js';
import { t, setLang, getLang } from './i18n.js';
import { NAMED_COLORS, colorOf } from './nodes.js';

const root = document.getElementById('modal-root');

export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => {
    bg.remove();
    window.removeEventListener('keydown', esc, true);
    onClose && onClose();
  };
  const esc = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const bg = el(
    'div',
    { class: 'modal-bg', onmousedown: (e) => e.target === bg && close() },
    el(
      'div',
      { class: `modal${wide ? ' wide' : ''}` },
      el(
        'div',
        { class: 'modal-head' },
        el('h3', {}, title),
        el('button', { class: 'btn-x', onclick: close, title: t('Close') }, icon('x', 16)),
      ),
      body,
    ),
  );
  root.append(bg);
  window.addEventListener('keydown', esc, true);
  return close;
}

const field = (label, input, hint) =>
  el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('small', {}, hint) : null);
const text = (value = '', ph = '') => el('input', { type: 'text', value, placeholder: ph, spellcheck: false });
const dirPicker = (input) =>
  el(
    'div',
    { class: 'row' },
    Object.assign(input, { style: { flex: 1 } }),
    el(
      'button',
      {
        class: 'btn-ghost',
        type: 'button',
        onclick: async () => {
          const d = await api.pickDir();
          if (d) input.value = d;
        },
      },
      icon('folder-open', 14),
      t('Browse…'),
    ),
  );
const ghost = (label, fn, ic) => el('button', { class: 'btn-ghost', onclick: fn }, ic ? icon(ic, 14) : null, label);
const primary = (label, fn, ic) => el('button', { class: 'btn-primary', onclick: fn }, ic ? icon(ic, 14) : null, label);
const danger = (label, fn, ic) => el('button', { class: 'btn-danger', onclick: fn }, ic ? icon(ic, 14) : null, label);
const select = (options, value, onchange) =>
  el(
    'select',
    { onchange: (e) => onchange && onchange(e.target.value) },
    options.map(([v, l]) => el('option', { value: v, selected: v === value }, l)),
  );
const note = (msg, kind = '') => el('p', { class: `note ${kind}` }, msg);
const toggle = (checked, onchange) =>
  el(
    'label',
    { class: 'switch' },
    el('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }),
    el('span', { class: 'slider' }),
  );

// ------------------------------------------------------------------ new terminal
export async function newTerminalDialog(onCreate) {
  const presets = S.prefs.agentPresets.filter((p) => p.isActive);
  let sel = presets[0];
  let env = 'local';
  const [shells, distros] = await Promise.all([api.listShells(), api.listWslDistros()]);
  const grid = el('div', { class: 'presets' });
  const name = text(sel ? sel.name : 'Shell');
  const cmd = text(sel ? sel.command : '', t('optional command to launch'));
  const cwd = text(
    S.floorId
      ? (S.doc.payload.floors.find((f) => f.id === S.floorId) || {}).worktreePath || ''
      : S.doc.payload.workingDirectory || '',
    t('working directory'),
  );
  const role = select([['', t('— none —')], ...S.prefs.rolePresets.map((r) => [r.id, r.name])], '');
  const manager = el('input', { type: 'checkbox' });
  const shellSel = select(
    shells.map((s) => [s.path, s.label]),
    S.prefs.defaultShell || 'powershell.exe',
  );
  const distroSel = select(
    distros.map((d) => [d, d]),
    distros[0] || '',
  );
  const sshHost = text('', 'servidor.exemplo.com');
  const sshUser = text('', t('user (optional)'));
  const sshPort = el('input', { type: 'number', value: 22, min: 1, max: 65535 });
  const dockerImage = text('node:22', 'node:22');
  const dockerShell = text('/bin/bash', '/bin/bash');
  const dockerMount = el('input', { type: 'checkbox', checked: true });
  const dockerNoNet = el('input', { type: 'checkbox' });
  const dockerResult = el('p', { class: 'note' });
  const envBox = el('div');
  const seg = el('div', { class: 'seg' });

  const paintPresets = () =>
    grid.replaceChildren(
      ...presets.map((p) =>
        el(
          'div',
          {
            class: `preset${p === sel ? ' sel' : ''}`,
            onclick: () => {
              sel = p;
              name.value = p.name;
              cmd.value = p.command;
              paintPresets();
            },
          },
          el('i', { style: { background: p.color } }),
          p.name,
        ),
      ),
    );
  const paintEnv = () => {
    seg.replaceChildren(
      ...[
        ['local', t('Local'), 'terminal'],
        ['wsl', 'WSL', 'container'],
        ['ssh', 'SSH', 'server'],
        ['docker', 'Docker', 'container'],
      ].map(([id, label, ic]) =>
        el(
          'button',
          {
            class: id === env ? 'on' : '',
            onclick: () => {
              env = id;
              paintEnv();
            },
          },
          icon(ic, 14),
          label,
        ),
      ),
    );
    envBox.replaceChildren();
    if (env === 'local') envBox.append(field(t('Shell'), shellSel));
    if (env === 'wsl')
      envBox.append(
        distros.length
          ? field(t('WSL distribution'), distroSel)
          : note(t('No WSL distribution found. Install one with "wsl --install".'), 'warn'),
      );
    if (env === 'docker')
      envBox.append(
        el(
          'div',
          { class: 'row' },
          el('div', { class: 'grow' }, field(t('Docker image'), dockerImage)),
          field(t('Shell in the container'), dockerShell),
        ),
        el('label', { class: 'row check' }, dockerMount, t('Mount the working directory at /workspace')),
        el('label', { class: 'row check' }, dockerNoNet, t('No network access (--network none)')),
        el(
          'div',
          { class: 'row' },
          ghost(
            t('Test Docker'),
            async () => {
              dockerResult.className = 'note';
              dockerResult.textContent = t('Testing…');
              const r = await api.dockerTest({ image: dockerImage.value.trim() || undefined });
              dockerResult.className = `note ${r.ok ? '' : 'warn'}`;
              dockerResult.textContent = r.ok
                ? t('Docker {v} is running. Image {i}: {s}.', {
                    v: r.version,
                    i: r.image,
                    s: r.imagePresent ? t('already downloaded') : t('will be downloaded on first use'),
                  })
                : r.error;
            },
            'container',
          ),
          dockerResult,
        ),
        note(
          t(
            'The container is removed when the terminal closes. The omaestri command is not available inside Docker terminals: its server only listens on this computer.',
          ),
        ),
      );
    if (env === 'ssh')
      envBox.append(
        el(
          'div',
          { class: 'row' },
          el('div', { class: 'grow' }, field(t('Host'), sshHost)),
          field(t('User'), sshUser),
          field(t('Port'), sshPort),
        ),
        note(
          t(
            'SSH uses your ssh.exe and keys. A reverse tunnel exposes the omaestri server to the remote shell (127.0.0.1:port); the remote host still needs its own omaestri client.',
          ),
        ),
      );
  };
  paintPresets();
  paintEnv();

  const submit = () => {
    const o = {
      presetId: sel && sel.id,
      name: name.value.trim() || 'Shell',
      command: cmd.value.trim(),
      workingDirectory: cwd.value.trim(),
      roleId: role.value || null,
      isManager: manager.checked,
    };
    if (env === 'local') o.shellPath = shellSel.value;
    else if (env === 'docker') {
      o.remote = {
        kind: 'docker',
        image: dockerImage.value.trim() || 'node:22',
        shell: dockerShell.value.trim() || '/bin/bash',
        mount: dockerMount.checked,
        network: dockerNoNet.checked ? 'none' : 'bridge',
      };
      o.shellPath = 'docker.exe';
    } else if (env === 'wsl') {
      if (!distroSel.value) return toast(t('Pick a WSL distribution'));
      o.remote = { kind: 'wsl', distro: distroSel.value };
      o.shellPath = 'wsl.exe';
    } else {
      if (!sshHost.value.trim()) return toast(t('Host is required'));
      o.remote = {
        kind: 'ssh',
        host: sshHost.value.trim(),
        user: sshUser.value.trim(),
        port: Number(sshPort.value) || 22,
      };
      o.shellPath = 'ssh.exe';
    }
    close();
    onCreate(o);
  };
  const close = modal(
    t('New terminal'),
    el(
      'div',
      {},
      grid,
      seg,
      envBox,
      field(t('Name'), name),
      field(t('Command (runs inside the shell)'), cmd),
      field(t('Working directory'), dirPicker(cwd)),
      field(t('Role'), role),
      el(
        'label',
        { class: 'row check' },
        manager,
        icon('crown', 14),
        t('Maestro mode — this agent can recruit, connect and dismiss other agents'),
      ),
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        primary(t('Create'), submit, 'plus'),
      ),
    ),
  );
  setTimeout(() => name.focus(), 0);
}

// ------------------------------------------------------------------- edit node
const COLOR_OPTIONS = Object.keys(NAMED_COLORS);
const colorSelect = (value, onchange) =>
  select(COLOR_OPTIONS.map((c) => [c, t(c)]).concat(/^#/.test(value) ? [[value, value]] : []), value, onchange);

export function editNodeDialog(node, onRemove) {
  const kind = kindOf(node);
  const c = JSON.parse(JSON.stringify(node.content));
  const body = el('div');
  let apply = () => {};
  if (kind === 'terminal') {
    const tc = c.terminal._0;
    const name = text(tc.name);
    const cmd = text(tc.command);
    const cwd = text(tc.workingDirectory);
    const shellPath = text(tc.shellPath, 'powershell.exe');
    const color = el('input', { type: 'color', value: /^#/.test(tc.color) ? tc.color : '#0a84ff' });
    const theme = select([['', t('Follow global')], ...THEME_IDS.map((x) => [x, x])], tc.themeId || '');
    const fsz = el('input', { type: 'number', min: 8, max: 32, value: tc.fontSize || '', placeholder: t('global') });
    const role = select(
      [['', t('— none —')], ...S.prefs.rolePresets.map((r) => [r.id, r.name])],
      tc.assignedRoleId || '',
    );
    const mgr = el('input', { type: 'checkbox', checked: !!tc.isManager });
    body.append(
      field(t('Name'), name),
      field(t('Command'), cmd),
      field(t('Working directory'), dirPicker(cwd)),
      tc.remote ? null : field(t('Shell'), shellPath),
      el(
        'div',
        { class: 'row' },
        field(t('Color'), color),
        field(t('Theme'), theme),
        field(t('Font size'), fsz),
        field(t('Role'), role),
      ),
      el('label', { class: 'row check' }, mgr, icon('crown', 14), t('Maestro mode')),
      note(t('Command, directory, shell and role changes apply the next time the terminal is restarted.')),
    );
    apply = () => {
      Object.assign(tc, {
        name: name.value.trim() || tc.name,
        command: cmd.value.trim(),
        workingDirectory: cwd.value.trim(),
        shellPath: shellPath.value.trim() || tc.shellPath || 'powershell.exe',
        color: color.value,
        themeId: theme.value || null,
        fontSize: fsz.value ? Number(fsz.value) : null,
        assignedRoleId: role.value || null,
        isManager: mgr.checked,
      });
    };
  } else if (kind === 'portal') {
    const pc = c.portal._0;
    const name = text(pc.name);
    const scope = select(
      [
        ['isolated', t('Isolated')],
        ['shared', t('Shared')],
      ],
      pc.storageScope,
    );
    body.append(
      field(t('Name'), name),
      field(t('Storage'), scope),
      note(t('Storage scope applies the next time the portal is created.')),
    );
    apply = () => {
      pc.name = name.value.trim() || pc.name;
      pc.storageScope = scope.value;
    };
  } else if (kind === 'fileTree') {
    const fc = c.fileTree._0;
    const name = text(fc.name);
    const rootP = text(fc.rootPath);
    body.append(field(t('Name'), name), field(t('Folder'), dirPicker(rootP)));
    apply = () => {
      fc.name = name.value.trim() || fc.name;
      fc.rootPath = rootP.value.trim() || fc.rootPath;
    };
  } else if (kind === 'shape' || kind === 'stroke') {
    const s = kind === 'shape' ? c.shape._0 : c.stroke._0;
    const stroke = colorSelect(typeof s.strokeColor === 'string' ? s.strokeColor : 'blue');
    const width = el('input', { type: 'number', min: 1, max: 20, value: s.strokeWidth });
    const style = select(
      [
        ['solid', t('Solid')],
        ['dashed', t('Dashed')],
        ['dotted', t('Dotted')],
      ],
      s.strokeStyle,
    );
    body.append(
      el(
        'div',
        { class: 'row' },
        field(t('Line color'), stroke),
        field(t('Thickness'), width),
        field(t('Style'), style),
      ),
    );
    let fill, fillStyle, type, fs;
    if (kind === 'shape') {
      fill = colorSelect(s.fillColor);
      fillStyle = select(
        [
          ['none', t('No fill')],
          ['solid', t('Solid')],
        ],
        s.fillStyle === 'none' ? 'none' : 'solid',
      );
      type = select(
        [
          ['rect', t('Rectangle')],
          ['ellipse', t('Ellipse')],
          ['diamond', t('Diamond')],
        ],
        s.shapeType,
      );
      fs = el('input', { type: 'number', min: 8, max: 72, value: s.fontSize });
      body.append(
        el(
          'div',
          { class: 'row' },
          field(t('Fill color'), fill),
          field(t('Fill'), fillStyle),
          field(t('Shape'), type),
          field(t('Font size'), fs),
        ),
      );
    } else {
      type = select(
        [
          ['line', t('Line')],
          ['arrow', t('Arrow')],
        ],
        s.strokeType,
      );
      body.append(field(t('Type'), type));
    }
    apply = () => {
      s.strokeColor = stroke.value;
      s.strokeWidth = Number(width.value) || 2;
      s.strokeStyle = style.value;
      if (kind === 'shape') {
        s.fillColor = fill.value;
        s.fillStyle = fillStyle.value;
        s.shapeType = type.value;
        s.fontSize = Number(fs.value) || 16;
      } else {
        s.strokeType = type.value;
        s.controlPoint = type.value === 'arrow' ? s.controlPoint || [0.5, 0.5] : null;
      }
    };
  } else {
    body.append(el('p', {}, t('Nothing to edit.')));
  }
  const close = modal(
    t('Edit {kind}', { kind: t(kind) }),
    el(
      'div',
      {},
      body,
      el(
        'div',
        { class: 'actions' },
        danger(
          t('Delete'),
          () => {
            close();
            onRemove([node.id]);
          },
          'trash-2',
        ),
        el('span', { class: 'grow' }),
        ghost(t('Cancel'), () => close()),
        primary(
          t('Save'),
          () => {
            apply();
            patchNode(node.id, { content: c });
            close();
          },
          'check',
        ),
      ),
    ),
  );
}

export function promptName(title, initial, onOk) {
  const input = text(initial || '', t('Name'));
  const ok = () => {
    const v = input.value.trim();
    if (!v) return toast(t('Name is required'));
    close();
    onOk(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok();
  });
  const close = modal(
    title,
    el(
      'div',
      {},
      field(t('Name'), input),
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        primary(t('Save'), ok, 'check'),
      ),
    ),
  );
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

// ------------------------------------------------------------- saved prompts
// target: {kind:'new', text, workspaceId} | {kind:'edit', prompt}
export function savedPromptDialog(target, onDone) {
  const orig = target.kind === 'edit' ? target.prompt : null;
  const name = text(orig ? orig.name.replaceAll('-', ' ') : '', t('e.g. code review'));
  const desc = text(orig ? orig.description : '', t('Short description (optional)'));
  const body = el('textarea', { value: orig ? orig.text : target.text || '', placeholder: t('The prompt text') });
  const wsName = (S.workspaces.find((w) => w.id === S.wsId) || {}).name || '';
  const owner = orig ? orig.workspaceId : target.workspaceId;
  const scope = select(
    [
      ['', t('All workspaces')],
      [S.wsId, t('Only “{n}”', { n: wsName })],
    ],
    owner ? S.wsId : '',
  );
  const err = el('p', { class: 'note warn', hidden: true });
  const save = async () => {
    if (!name.value.trim() || !body.value.trim()) {
      err.hidden = false;
      err.textContent = t('Name and text are required.');
      return;
    }
    const r = await api.promptsSave({
      id: orig ? orig.id : null,
      name: name.value.trim(),
      description: desc.value.trim(),
      text: body.value,
      workspaceId: scope.value || null,
    });
    if (!r.ok) {
      err.hidden = false;
      err.textContent = r.code === 'emptyText' ? t('Name and text are required.') : r.error;
      return;
    }
    close();
    toast(t('Prompt saved'));
    onDone && onDone(r.prompt);
  };
  const close = modal(
    orig ? t('Edit saved prompt') : t('New saved prompt'),
    el(
      'div',
      {},
      field(t('Name'), name),
      field(t('Description'), desc),
      field(t('Text'), body),
      field(t('Available in'), scope),
      err,
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        primary(t('Save'), save, 'check'),
      ),
    ),
  );
  setTimeout(() => name.focus(), 0);
}

// -------------------------------------------------------------- pull requests (gh)
export async function pullRequestsDialog(root) {
  const host = el('div', { class: 'pr-panel' });
  let state = 'open';
  const rows = el('div', { class: 'routines', style: { maxHeight: '44vh' } });
  const CHK = { success: ['check', 'ok'], failure: ['x', 'bad'], pending: ['clock', 'wait'], none: ['minus', ''] };
  async function load() {
    rows.replaceChildren(el('p', { class: 'empty' }, t('Loading…')));
    const r = await api.prList(root, state);
    if (!r.ok) {
      rows.replaceChildren(el('p', { class: 'note warn' }, r.error));
      return;
    }
    rows.replaceChildren(
      ...(r.value.length
        ? r.value.map((p) =>
            el(
              'div',
              { class: 'routine slim' },
              el(
                'span',
                { class: `pr-chk ${CHK[p.checks][1]}`, title: t('Checks: {s}', { s: p.checks }) },
                icon(CHK[p.checks][0], 14),
              ),
              el(
                'div',
                { class: 'grow' },
                el('div', { class: 'r-title' }, `#${p.number} ${p.title}${p.draft ? ' · ' + t('draft') : ''}`),
                el('div', { class: 'r-sub' }, `${p.head} → ${p.base} · ${p.author || ''} · ${p.state}`),
              ),
              el(
                'button',
                { class: 'btn-ghost sm', onclick: () => api.openExternal(p.url) },
                icon('external-link', 12),
                t('Open'),
              ),
            ),
          )
        : [el('p', { class: 'empty' }, t('No pull requests.'))]),
    );
  }
  const tabs = el(
    'div',
    { class: 'tabs' },
    ...[
      ['open', t('Open')],
      ['merged', t('Merged')],
      ['closed', t('Closed')],
      ['all', t('All')],
    ].map(([id, l]) =>
      el(
        'button',
        {
          class: `tab${state === id ? ' on' : ''}`,
          onclick: (e) => {
            state = id;
            tabs.querySelectorAll('.tab').forEach((b) => b.classList.remove('on'));
            e.currentTarget.classList.add('on');
            load();
          },
        },
        l,
      ),
    ),
  );
  const title = text('', t('Title of the new pull request'));
  const base = text('', t('base branch (default: repository default)'));
  const body = el('textarea', { class: 'git-msg', rows: 3, placeholder: t('Description') });
  const draft = el('input', { type: 'checkbox' });
  host.append(
    tabs,
    rows,
    el('h4', {}, t('New pull request from the current branch')),
    title,
    base,
    body,
    el('label', { class: 'row check' }, draft, t('Draft')),
    el(
      'div',
      { class: 'actions' },
      primary(
        t('Create pull request'),
        async () => {
          const r = await api.prCreate(root, {
            title: title.value,
            body: body.value,
            base: base.value.trim() || undefined,
            draft: draft.checked,
          });
          if (!r.ok) return toast(r.error, 7000);
          toast(t('Pull request created.'));
          title.value = '';
          body.value = '';
          api.openExternal(r.value.url);
          load();
        },
        'git-pull-request',
      ),
    ),
  );
  modal(t('Pull requests'), host, { wide: true });
  load();
}

// ------------------------------------------------------------------ git changes
export async function gitDialog(root, onChanged) {
  const call = async (op, ...a) => {
    const r = await api.git(op, root, ...a);
    if (!r.ok) {
      toast(r.error, 7000);
      throw new Error(r.error);
    }
    return r.value;
  };
  const host = el('div', { class: 'git-panel' });
  let st = null;
  let current = null; // { path, staged }
  let tab = 'changes';
  const msg = el('textarea', { class: 'git-msg', placeholder: t('Commit message'), rows: 3 });
  const diffBox = el('pre', { class: 'git-diff' }, t('Select a file to see its changes.'));
  const COL = {
    M: t('modified'),
    A: t('added'),
    D: t('deleted'),
    R: t('renamed'),
    C: t('copied'),
    U: t('conflict'),
    '?': t('new'),
  };
  const badge = (f, staged) => {
    const c = staged ? f.index : f.untracked ? '?' : f.worktree;
    return el('span', { class: `git git-${c === '?' ? 'A' : c}`, title: COL[c] || c }, c === '?' ? 'U' : c);
  };

  async function showDiff(f, staged) {
    current = { path: f.path, staged };
    try {
      const d = await call('diff', f.path, staged);
      diffBox.replaceChildren(
        ...(d
          ? d
              .split('\n')
              .map((l) =>
                el(
                  'div',
                  {
                    class:
                      l.startsWith('+') && !l.startsWith('+++')
                        ? 'add'
                        : l.startsWith('-') && !l.startsWith('---')
                          ? 'del'
                          : l.startsWith('@@')
                            ? 'hunk'
                            : '',
                  },
                  l || ' ',
                ),
              )
          : [t('No textual changes.')]),
      );
    } catch {
      /* toast already shown */
    }
    paintLists();
  }

  const fileRow = (f, staged) =>
    el(
      'div',
      { class: `git-file${current && current.path === f.path && current.staged === staged ? ' on' : ''}` },
      el('input', {
        type: 'checkbox',
        checked: staged,
        title: staged ? t('Unstage') : t('Stage'),
        onchange: async () => {
          await call(staged ? 'unstage' : 'stage', [f.path]);
          await refresh();
        },
      }),
      badge(f, staged),
      el('span', { class: 'git-path', title: f.path, onclick: () => showDiff(f, staged) }, f.path),
      staged
        ? null
        : el(
            'button',
            {
              class: 'btn-x',
              title: f.untracked ? t('Delete file') : t('Discard changes'),
              onclick: async () => {
                if (confirm(t('Discard changes to “{p}”? This cannot be undone.', { p: f.path }))) {
                  await call('discard', [f.path]);
                  await refresh();
                }
              },
            },
            icon('undo-2', 14),
          ),
    );

  const listsBox = el('div', { class: 'git-lists' });
  function paintLists() {
    if (!st) return;
    const staged = st.files.filter((f) => f.staged);
    const changes = st.files.filter((f) => !f.staged || f.worktree);
    listsBox.replaceChildren(
      el(
        'div',
        { class: 'git-sec' },
        t('Staged ({n})', { n: staged.length }),
        staged.length
          ? el(
              'button',
              {
                class: 'btn-ghost sm',
                onclick: async () => {
                  await call(
                    'unstage',
                    staged.map((f) => f.path),
                  );
                  await refresh();
                },
              },
              t('Unstage all'),
            )
          : null,
      ),
      ...staged.map((f) => fileRow(f, true)),
      el(
        'div',
        { class: 'git-sec' },
        t('Changes ({n})', { n: changes.length }),
        changes.length
          ? el(
              'button',
              {
                class: 'btn-ghost sm',
                onclick: async () => {
                  await call(
                    'stage',
                    changes.map((f) => f.path),
                  );
                  await refresh();
                },
              },
              t('Stage all'),
            )
          : null,
      ),
      ...changes.map((f) => fileRow(f, false)),
      !st.files.length ? el('p', { class: 'empty' }, icon('check', 24), t('Working tree clean.')) : null,
    );
  }

  async function refresh() {
    st = await call('status');
    if (!st.isRepo) {
      host.replaceChildren(el('p', { class: 'note warn' }, t('This folder is not a git repository.')));
      return;
    }
    draw();
    onChanged && onChanged();
  }

  async function draw() {
    const branches = await call('branches').catch(() => []);
    const sel = el(
      'select',
      {
        onchange: async (e) => {
          try {
            await call('checkout', e.target.value);
            await refresh();
          } catch {
            await refresh();
          }
        },
      },
      branches.map((b) => el('option', { value: b.name, selected: b.current }, b.name)),
    );
    const newBranch = ghost(
      t('New branch…'),
      () =>
        promptNameLazy(t('New branch'), '', async (name) => {
          try {
            await call('checkout', name, { create: true });
            await refresh();
          } catch {
            /* shown */
          }
        }),
      'git-branch',
    );
    const stashBtn = ghost(
      t('Stash'),
      async () => {
        try {
          await call('stashPush', '');
          toast(t('Changes stashed'));
          await refresh();
        } catch {
          /* shown */
        }
      },
      'download',
    );
    const popBtn = ghost(
      t('Pop stash'),
      async () => {
        const l = await call('stashes');
        if (!l.length) return toast(t('No stashes.'));
        try {
          await call('stashPop', l[0].ref);
          toast(t('Stash applied'));
          await refresh();
        } catch {
          await refresh();
        }
      },
      'upload',
    );
    const tabs = el(
      'div',
      { class: 'tabs' },
      ...[
        ['changes', t('Changes')],
        ['history', t('History')],
      ].map(([id, l]) =>
        el(
          'button',
          {
            class: `tab${tab === id ? ' on' : ''}`,
            onclick: () => {
              tab = id;
              draw();
            },
          },
          l,
        ),
      ),
    );
    const head = el(
      'div',
      { class: 'git-head' },
      icon('git-branch', 16),
      sel,
      el('span', { class: 'git-sync' }, `${st.ahead ? `↑${st.ahead} ` : ''}${st.behind ? `↓${st.behind}` : ''}`),
      el('span', { class: 'grow' }),
      newBranch,
      stashBtn,
      popBtn,
    );
    if (tab === 'history') {
      const log = await call('log', 60);
      host.replaceChildren(
        head,
        tabs,
        el(
          'div',
          { class: 'routines', style: { maxHeight: '48vh' } },
          ...(log.length
            ? log.map((c) =>
                el(
                  'div',
                  { class: 'routine slim' },
                  icon('git-branch', 14),
                  el(
                    'div',
                    { class: 'grow' },
                    el('div', { class: 'r-title' }, c.subject),
                    el('div', { class: 'r-sub' }, `${c.hash} · ${c.author} · ${c.when}`),
                  ),
                ),
              )
            : [el('p', { class: 'empty' }, t('No commits yet.'))]),
        ),
      );
      return;
    }
    const commitBtn = primary(
      t('Commit'),
      async () => {
        try {
          const h = await call('commit', msg.value);
          msg.value = '';
          toast(t('Committed {h}', { h }));
          await refresh();
        } catch {
          /* shown */
        }
      },
      'check',
    );
    commitBtn.disabled = !st.files.some((f) => f.staged);
    paintLists();
    host.replaceChildren(
      head,
      tabs,
      el('div', { class: 'git-cols' }, el('div', { class: 'git-left' }, listsBox, msg, commitBtn), diffBox),
    );
  }

  modal(t('Git changes'), host, { wide: true });
  refresh();
}
const promptNameLazy = (...a) => promptName(...a);

// -------------------------------------------------------------------- partituras
export async function savePartituraDialog(ids) {
  const r = await api.partituraCapture(S.wsId, ids, { name: '' });
  if (!r.ok) return toast(r.error);
  const edits = {};
  const name = text('', t('e.g. Review team'));
  const desc = text('', t('Short description (optional)'));
  const wsName = (S.workspaces.find((w) => w.id === S.wsId) || {}).name || '';
  const scope = select(
    [
      ['', t('All workspaces')],
      ['ws', t('Only “{n}”', { n: wsName })],
    ],
    '',
  );
  const p = r.partitura;
  const cmds = r.commands.map((c) => {
    const input = text(c.command, t('no command'));
    input.oninput = () => {
      edits[c.nodeId] = input.value;
    };
    return el(
      'div',
      { class: 'list-row' },
      icon('terminal', 16),
      el('span', { style: { width: '130px' } }, c.name),
      input,
    );
  });
  const nodes = p.payload.nodes.length;
  const err = el('p', { class: 'note warn', hidden: true });
  const save = async () => {
    if (!name.value.trim()) {
      err.hidden = false;
      err.textContent = t('Name is required');
      return;
    }
    p.name = name.value.trim();
    p.description = desc.value.trim();
    const s = await api.partituraSave(p, scope.value ? S.wsId : null, edits);
    if (!s.ok) {
      err.hidden = false;
      err.textContent = s.error;
      return;
    }
    close();
    toast(t('Partitura saved'));
  };
  const close = modal(
    t('Save as partitura'),
    el(
      'div',
      {},
      el(
        'p',
        { class: 'note' },
        t('A partitura saves this selection ({n} nodes) so you can place the same team again in any workspace.', {
          n: nodes,
        }),
      ),
      field(t('Name'), name),
      field(t('Description'), desc),
      field(t('Available in'), scope),
      cmds.length ? el('div', {}, el('h4', {}, t('Commands the terminals will run')), ...cmds) : null,
      err,
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        primary(t('Save'), save, 'check'),
      ),
    ),
    { wide: true },
  );
  setTimeout(() => name.focus(), 0);
}

export async function partituraPaletteDialog(onPlaced) {
  const q = text('', t('Search partituras…'));
  const body = el('div', { class: 'routines' });
  async function draw() {
    const all = await api.partituraList(S.wsId);
    const needle = q.value.trim().toLowerCase();
    const rows = all.filter(
      (p) => !needle || p.name.toLowerCase().includes(needle) || (p.description || '').toLowerCase().includes(needle),
    );
    body.replaceChildren(
      ...(rows.length
        ? rows.map((p) =>
            el(
              'div',
              { class: 'routine' },
              icon('layout-grid', 18),
              el(
                'div',
                { class: 'grow' },
                el('div', { class: 'r-title' }, p.name),
                el(
                  'div',
                  { class: 'r-sub' },
                  `${t('{t} terminal(s) · {n} note(s)', { t: p.terminals, n: p.notes })}${p.workspaceId ? ` · ${t('This workspace only')}` : ''}${p.description ? ` · ${p.description}` : ''}`,
                ),
              ),
              primary(
                t('Place'),
                async () => {
                  close();
                  await onPlaced(p.id);
                },
                'plus',
              ),
              ghost(
                '',
                async () => {
                  const r = await api.partituraExport(p.id, S.wsId);
                  if (r.file) toast(t('Exported to {f}', { f: r.file }));
                },
                'download',
              ),
              ghost(
                '',
                async () => {
                  if (confirm(t('Delete partitura “{n}”?', { n: p.name }))) {
                    await api.partituraRemove(p.id, S.wsId);
                    draw();
                  }
                },
                'trash-2',
              ),
            ),
          )
        : [
            el(
              'p',
              { class: 'empty' },
              icon('layout-grid', 28),
              t('No partituras yet. Select nodes and choose “Save as partitura”.'),
            ),
          ]),
    );
  }
  q.addEventListener('input', draw);
  const close = modal(
    t('Partituras'),
    el(
      'div',
      {},
      q,
      body,
      el(
        'div',
        { class: 'actions' },
        ghost(
          t('Import…'),
          async () => {
            const r = await api.partituraImport(S.wsId, false);
            if (r.ok && !r.canceled) {
              toast(t('Partitura imported'));
              draw();
            } else if (!r.ok) toast(r.error);
          },
          'upload',
        ),
        el('span', { class: 'grow' }),
        ghost(t('Close'), () => close()),
      ),
    ),
    { wide: true },
  );
  draw();
  setTimeout(() => q.focus(), 0);
}

export function bandDeleteDialog(band, onChoice) {
  const d = band.content.band._0;
  const close = modal(
    t('Delete band'),
    el(
      'div',
      {},
      el(
        'p',
        {},
        t('The band “{n}” has {c} terminals. What should happen to them?', { n: d.name, c: d.memberNodeIds.length }),
      ),
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        el('span', { class: 'grow' }),
        ghost(
          t('Keep terminals on the canvas'),
          () => {
            close();
            onChoice(true);
          },
          'users',
        ),
        danger(
          t('Close band and terminals'),
          () => {
            close();
            onChoice(false);
          },
          'trash-2',
        ),
      ),
    ),
  );
}

export function stackDeleteDialog(stack, onChoice) {
  const d = stack.content.noteStack._0;
  const close = modal(
    t('Delete stack'),
    el(
      'div',
      {},
      el(
        'p',
        {},
        t('The stack “{n}” has {c} pages. What should happen to them?', { n: d.name, c: d.memberNodeIds.length }),
      ),
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        el('span', { class: 'grow' }),
        ghost(
          t('Keep notes on the canvas'),
          () => {
            close();
            onChoice(true);
          },
          'notebook-tabs',
        ),
        danger(
          t('Delete stack and notes'),
          () => {
            close();
            onChoice(false);
          },
          'trash-2',
        ),
      ),
    ),
  );
}

// --------------------------------------------------------------------- workspace
export function workspaceDialog(entry, onSave, onDelete) {
  const name = text(entry ? entry.name : '', t('Workspace name'));
  const dir = text(entry ? entry.workingDirectory : '', t('Working directory'));
  let color = entry ? entry.color : 'blue';
  const swatches = el('div', { class: 'row', style: { flexWrap: 'wrap' } });
  const paint = () =>
    swatches.replaceChildren(
      ...Object.entries(WORKSPACE_COLORS).map(([k, v]) =>
        el('span', {
          title: t(k),
          onclick: () => {
            color = k;
            paint();
          },
          class: `swatch${k === color ? ' on' : ''}`,
          style: { background: v },
        }),
      ),
    );
  paint();
  const close = modal(
    entry ? t('Edit workspace') : t('New workspace'),
    el(
      'div',
      {},
      field(t('Name'), name),
      field(t('Working directory'), dirPicker(dir)),
      field(t('Color'), swatches),
      el(
        'div',
        { class: 'actions' },
        entry && onDelete
          ? danger(
              t('Delete'),
              () => {
                if (
                  confirm(
                    t('Delete workspace "{name}" and all its notes? This cannot be undone.', { name: entry.name }),
                  )
                ) {
                  close();
                  onDelete();
                }
              },
              'trash-2',
            )
          : null,
        el('span', { class: 'grow' }),
        ghost(t('Cancel'), () => close()),
        primary(
          entry ? t('Save') : t('Create'),
          () => {
            if (!name.value.trim()) return toast(t('Name is required'));
            close();
            onSave({ name: name.value.trim(), workingDirectory: dir.value.trim() || S.env.homedir, color });
          },
          'check',
        ),
      ),
    ),
  );
  setTimeout(() => name.focus(), 0);
}

// ------------------------------------------------------------------------ floors
export async function floorCreateDialog(onCreated) {
  const info = await api.floorInfo(S.wsId);
  const body = el('div');
  if (!info.isRepo) {
    body.append(
      note(t('The workspace folder is not a git repository, so floors (git worktrees) are unavailable.'), 'warn'),
      el('p', {}, el('code', {}, info.dir)),
      note(t('Run "git init" and make a first commit in that folder, then try again.')),
      el(
        'div',
        { class: 'actions' },
        primary(t('OK'), () => close()),
      ),
    );
    const close = modal(t('New floor'), body);
    return;
  }
  const name = text('', t('e.g. login-refactor'));
  const branch = text('', 'floor/…');
  const existing = el('input', { type: 'checkbox' });
  const branchSel = select(
    info.branches.map((b) => [b, b]),
    info.branches[0],
  );
  const branchBox = el('div');
  const paintBranch = () => {
    branchBox.replaceChildren(
      existing.checked
        ? field(t('Existing branch'), branchSel)
        : field(t('New branch name (optional)'), branch, t('Created from {branch}', { branch: info.branch })),
    );
  };
  existing.onchange = paintBranch;
  paintBranch();
  const setup = el('input', { type: 'checkbox' });
  const submit = async () => {
    if (!name.value.trim()) return toast(t('Name is required'));
    flush();
    const btn = ok;
    btn.disabled = true;
    const r = await api.floorCreate(S.wsId, {
      name: name.value.trim(),
      branch: existing.checked ? branchSel.value : branch.value.trim() || undefined,
      existingBranch: existing.checked,
      runSetup: setup.checked,
    });
    btn.disabled = false;
    if (!r.ok) return toast(r.error, 6000);
    close();
    setDoc(S.wsId, r.doc);
    onCreated(r.floor);
    toast(t('Floor "{name}" created', { name: r.floor.name }));
  };
  const ok = primary(t('Create floor'), submit, 'layers');
  body.append(
    note(
      t(
        'A floor is an isolated copy of your repository (git worktree) with its own canvas. Agents on a floor cannot disturb your main branch.',
      ),
    ),
    field(t('Floor name'), name),
    el('label', { class: 'row check' }, existing, t('Use an existing branch')),
    branchBox,
    el('label', { class: 'row check' }, setup, t('Run setup hooks after creating')),
    el(
      'div',
      { class: 'actions' },
      ghost(t('Cancel'), () => close()),
      ok,
    ),
  );
  const close = modal(t('New floor'), body);
  setTimeout(() => name.focus(), 0);
}

function hookOutput(results) {
  if (!results.length) return el('p', { class: 'note' }, t('No commands to run.'));
  return el(
    'div',
    { class: 'hook-out' },
    results.map((r) =>
      el(
        'div',
        { class: r.code === 0 ? 'ok' : 'bad' },
        el('b', {}, `${r.code === 0 ? '✓' : '✗'} ${r.command}`),
        el('pre', {}, (r.output || '').trim() || t('(no output)')),
      ),
    ),
  );
}

export function floorEditDialog(floor) {
  const name = text(floor.name);
  const lines = (a) => (a || []).join('\n');
  const setup = el('textarea', { value: lines(floor.hooks.setup), placeholder: 'npm install' });
  const run = el('textarea', { value: lines(floor.hooks.run), placeholder: 'npm run dev' });
  const tear = el('textarea', { value: lines(floor.hooks.teardown), placeholder: 'npm run clean' });
  const auto = el('input', { type: 'checkbox', checked: !!floor.hooks.autoRunSetup });
  const out = el('div');
  const parse = (ta) =>
    ta.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const save = async () => {
    const r = await api.floorUpdate(S.wsId, floor.id, {
      name: name.value.trim(),
      hooks: { setup: parse(setup), run: parse(run), teardown: parse(tear), autoRunSetup: auto.checked },
    });
    if (r.ok) setDoc(S.wsId, r.doc);
    else toast(r.error);
    return r.ok;
  };
  const runPhase = (phase) => async () => {
    if (!(await save())) return;
    out.replaceChildren(el('p', { class: 'note' }, t('Running…')));
    const r = await api.floorRunHooks(S.wsId, floor.id, phase);
    out.replaceChildren(r.ok ? hookOutput(r.results) : note(r.error, 'warn'));
  };
  const close = modal(
    t('Floor settings'),
    el(
      'div',
      {},
      field(t('Name'), name),
      el('div', { class: 'field' }, el('label', {}, t('Branch')), el('code', {}, floor.branchName)),
      el('div', { class: 'field' }, el('label', {}, t('Folder')), el('code', {}, floor.worktreePath)),
      el('h4', {}, t('Hooks (one command per line, run in the floor folder)')),
      field(t('Setup'), setup),
      field(t('Run'), run),
      field(t('Teardown (before deleting)'), tear),
      el('label', { class: 'row check' }, auto, t('Run setup automatically when the floor is created')),
      el(
        'div',
        { class: 'row' },
        ghost(t('Run setup'), runPhase('setup'), 'play'),
        ghost(t('Run'), runPhase('run'), 'play'),
        ghost(t('Run teardown'), runPhase('teardown'), 'play'),
      ),
      out,
      el(
        'div',
        { class: 'actions' },
        ghost(t('Open folder'), () => api.openPath(floor.worktreePath), 'folder-open'),
        el('span', { class: 'grow' }),
        ghost(t('Cancel'), () => close()),
        primary(
          t('Save'),
          async () => {
            if (await save()) close();
          },
          'check',
        ),
      ),
    ),
    { wide: true },
  );
}

export async function landDialog(floor, onLanded) {
  const body = el('div', {}, note(t('Loading…')));
  const close = modal(t('Land floor "{name}"', { name: floor.name }), body, { wide: true });
  const r = await api.floorLandPreview(S.wsId, floor.id);
  if (!r.ok) {
    body.replaceChildren(note(r.error, 'warn'), el('div', { class: 'actions' }, primary(t('OK'), close)));
    return;
  }
  const p = r.preview;
  const removeAfter = el('input', { type: 'checkbox', checked: true });
  const delBranch = el('input', { type: 'checkbox' });
  const problems = [];
  if (p.dirtyFiles) problems.push(t('The floor has {n} uncommitted file(s). Commit them first.', { n: p.dirtyFiles }));
  if (p.targetDirty) problems.push(t('The target branch "{b}" has uncommitted changes.', { b: p.target }));
  if (!p.commits.length) problems.push(t('Nothing to land: the floor has no new commits.'));
  const go = primary(
    t('Land (merge) onto {b}', { b: p.target }),
    async () => {
      go.disabled = true;
      const res = await api.floorLand(S.wsId, floor.id, {
        removeAfter: removeAfter.checked,
        deleteBranch: removeAfter.checked && delBranch.checked,
      });
      if (!res.ok) {
        go.disabled = false;
        return toast(res.error, 8000);
      }
      close();
      setDoc(S.wsId, res.doc);
      onLanded(res.result);
      toast(t('Landed {n} commit(s) onto {b}', { n: res.result.commits, b: res.result.target }));
    },
    'git-merge',
  );
  go.disabled = problems.length > 0;
  body.replaceChildren(
    el('p', {}, t('Merges branch {from} into {to} with a merge commit.', { from: floor.branchName, to: p.target })),
    ...problems.map((x) => note(x, 'warn')),
    el('h4', {}, t('Commits ({n})', { n: p.commits.length })),
    el('pre', { class: 'code' }, p.commits.join('\n') || '—'),
    el('h4', {}, t('Changes')),
    el('pre', { class: 'code' }, p.diffStat || '—'),
    el('label', { class: 'row check' }, removeAfter, t('Remove the floor after landing')),
    el('label', { class: 'row check' }, delBranch, t('Also delete the floor branch')),
    el(
      'div',
      { class: 'actions' },
      ghost(t('Cancel'), () => close()),
      go,
    ),
  );
}

// ---------------------------------------------------------------------- routines
const WEEKDAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const OUTCOME = {
  sentToTerminal: 'Sent to terminal',
  terminalNotRunning: 'Terminal not running',
  reminder: 'Reminder shown',
  skippedWhileBusy: 'Skipped (terminal busy)',
  skippedByScript: 'Skipped by script',
  missedWhileClosed: 'Missed (app was closed)',
};

export function describeSchedule(s) {
  const hh = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (s.kind === 'once') return t('once on {d}', { d: new Date(s.at).toLocaleString() });
  if (s.kind === 'interval') {
    const x = s.seconds;
    return t('every {v}', { v: x % 3600 === 0 ? `${x / 3600} h` : x % 60 === 0 ? `${x / 60} min` : `${x} s` });
  }
  if (s.kind === 'daily') return t('daily at {h}', { h: hh(s.hour, s.minute) });
  return t('{days} at {h}', { days: s.weekdays.map((d) => t(WEEKDAY_KEYS[d])).join(', '), h: hh(s.hour, s.minute) });
}

export async function routinesDialog() {
  let tab = 'list';
  const body = el('div');
  const tabs = el('div', { class: 'tabs' });
  const terminals = () => S.doc.payload.nodes.filter((n) => n.content.terminal);
  const termName = (id) => {
    const n = S.doc.payload.nodes.find((x) => x.id === id);
    return n ? n.content.terminal._0.name : t('(removed terminal)');
  };

  async function draw() {
    tabs.replaceChildren(
      ...[
        ['list', t('Routines')],
        ['history', t('History')],
      ].map(([id, l]) =>
        el(
          'button',
          {
            class: `tab${tab === id ? ' on' : ''}`,
            onclick: () => {
              tab = id;
              draw();
            },
          },
          l,
        ),
      ),
    );
    const data = await api.routineList(S.wsId);
    body.replaceChildren(tab === 'list' ? listPage(data) : historyPage(data));
  }

  function listPage(data) {
    const rows = data.routines.map((r) =>
      el(
        'div',
        { class: 'routine' },
        toggle(r.enabled, async (on) => {
          const x = await api.routineSetEnabled(r.id, on);
          if (!x.ok) toast(x.error);
          draw();
        }),
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'r-title' }, r.name),
          el(
            'div',
            { class: 'r-sub' },
            `${describeSchedule(r.schedule)} · ${r.terminalId ? `→ ${termName(r.terminalId)}` : t('Reminder')}${r.nextRunAt && r.enabled ? ` · ${t('next {d}', { d: new Date(r.nextRunAt).toLocaleString() })}` : ''} · ${t('{n} run(s)', { n: r.runCount })}`,
          ),
          r.command ? el('div', { class: 'r-cmd' }, r.command) : null,
        ),
        el(
          'button',
          {
            class: 'btn-ghost',
            title: t('Run now'),
            onclick: async () => {
              const x = await api.routineRunNow(r.id);
              toast(x.ok ? t(OUTCOME[x.result.outcome] || x.result.outcome) : x.error);
              draw();
            },
          },
          icon('play', 14),
        ),
        el('button', { class: 'btn-ghost', title: t('Edit'), onclick: () => editor(r) }, icon('pencil', 14)),
        el(
          'button',
          {
            class: 'btn-ghost',
            title: t('Delete'),
            onclick: async () => {
              if (confirm(t('Delete routine "{name}"?', { name: r.name }))) {
                await api.routineRemove(r.id);
                draw();
              }
            },
          },
          icon('trash-2', 14),
        ),
      ),
    );
    return el(
      'div',
      {},
      note(
        t(
          'Routines send a prompt or command to a terminal on a schedule, or just remind you. Missed runs while the app is closed are skipped.',
        ),
      ),
      rows.length
        ? el('div', { class: 'routines' }, rows)
        : el('p', { class: 'empty' }, icon('calendar-clock', 28), t('No routines yet.')),
      el(
        'div',
        { class: 'actions' },
        primary(t('New routine'), () => editor(null), 'plus'),
      ),
    );
  }

  function historyPage(data) {
    return el(
      'div',
      {},
      data.history.length
        ? el(
            'div',
            { class: 'routines' },
            data.history.map((h) =>
              el(
                'div',
                { class: 'routine slim' },
                icon(h.outcome === 'sentToTerminal' || h.outcome === 'reminder' ? 'check' : 'circle-alert', 16),
                el(
                  'div',
                  { class: 'grow' },
                  el('div', { class: 'r-title' }, h.routineName),
                  el(
                    'div',
                    { class: 'r-sub' },
                    `${new Date(h.at).toLocaleString()} · ${t(OUTCOME[h.outcome] || h.outcome)}${h.detail ? ` · ${h.detail}` : ''}`,
                  ),
                ),
              ),
            ),
          )
        : el('p', { class: 'empty' }, icon('history', 28), t('No runs yet.')),
      el(
        'div',
        { class: 'actions' },
        ghost(
          t('Clear history'),
          async () => {
            await api.routineClearHistory();
            draw();
          },
          'trash-2',
        ),
      ),
    );
  }

  function editor(r) {
    const name = text(r ? r.name : '', t('e.g. Morning status'));
    const target = select(
      [['', t('Reminder (notification only)')], ...terminals().map((n) => [n.id, n.content.terminal._0.name])],
      r ? r.terminalId || '' : (terminals()[0] || {}).id || '',
    );
    const cmd = el('textarea', { value: r ? r.command : '', placeholder: t('Prompt or command to send') });
    const s0 = r ? r.schedule : { kind: 'interval', seconds: 1800 };
    const kind = select(
      [
        ['interval', t('Every…')],
        ['daily', t('Daily')],
        ['weekly', t('Weekly')],
        ['once', t('Once')],
      ],
      s0.kind,
      () => paintSched(),
    );
    const sched = el('div');
    const mins = el('input', {
      type: 'number',
      min: 1,
      value: s0.kind === 'interval' ? Math.max(1, Math.round(s0.seconds / 60)) : 30,
    });
    const unit = select(
      [
        ['m', t('minutes')],
        ['h', t('hours')],
      ],
      s0.kind === 'interval' && s0.seconds % 3600 === 0 ? 'h' : 'm',
    );
    if (s0.kind === 'interval' && s0.seconds % 3600 === 0) mins.value = s0.seconds / 3600;
    const time = el('input', {
      type: 'time',
      value:
        s0.kind === 'daily' || s0.kind === 'weekly'
          ? `${String(s0.hour).padStart(2, '0')}:${String(s0.minute).padStart(2, '0')}`
          : '09:00',
    });
    const days = new Set(s0.kind === 'weekly' ? s0.weekdays : [1, 2, 3, 4, 5]);
    const dayBox = el('div', { class: 'days' });
    const paintDays = () =>
      dayBox.replaceChildren(
        ...WEEKDAY_KEYS.map((d, i) =>
          el(
            'button',
            {
              type: 'button',
              class: days.has(i) ? 'on' : '',
              onclick: () => {
                days.has(i) ? days.delete(i) : days.add(i);
                paintDays();
              },
            },
            t(d),
          ),
        ),
      );
    const local = (d) => {
      const x = new Date(d);
      x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
      return x.toISOString().slice(0, 16);
    };
    const once = el('input', {
      type: 'datetime-local',
      value: s0.kind === 'once' ? local(s0.at) : local(Date.now() + 3600e3),
    });
    const paintSched = () => {
      sched.replaceChildren();
      if (kind.value === 'interval')
        sched.append(el('div', { class: 'row' }, field(t('Every'), mins), field(' ', unit)));
      if (kind.value === 'daily') sched.append(field(t('Time'), time));
      if (kind.value === 'weekly') {
        paintDays();
        sched.append(field(t('Days'), dayBox), field(t('Time'), time));
      }
      if (kind.value === 'once') sched.append(field(t('Date and time'), once));
    };
    paintSched();
    const e0 = r ? r.endRepeat : { kind: 'never' };
    const endKind = select(
      [
        ['never', t('Never')],
        ['afterCount', t('After N runs')],
        ['onDate', t('On a date')],
      ],
      e0.kind,
      () => paintEnd(),
    );
    const endBox = el('div');
    const count = el('input', { type: 'number', min: 1, value: e0.kind === 'afterCount' ? e0.count : 5 });
    const until = el('input', {
      type: 'datetime-local',
      value: e0.kind === 'onDate' ? local(e0.date) : local(Date.now() + 7 * 864e5),
    });
    const paintEnd = () => {
      endBox.replaceChildren();
      if (endKind.value === 'afterCount') endBox.append(field(t('Runs'), count));
      if (endKind.value === 'onDate') endBox.append(field(t('Until'), until));
    };
    paintEnd();
    const save = async () => {
      let schedule;
      if (kind.value === 'interval')
        schedule = {
          kind: 'interval',
          seconds: Math.max(1, Number(mins.value) || 1) * (unit.value === 'h' ? 3600 : 60),
        };
      else if (kind.value === 'once') schedule = { kind: 'once', at: new Date(once.value).toISOString() };
      else {
        const [h, m] = time.value.split(':').map(Number);
        schedule =
          kind.value === 'daily'
            ? { kind: 'daily', hour: h, minute: m }
            : { kind: 'weekly', weekdays: [...days].sort(), hour: h, minute: m };
      }
      const endRepeat =
        endKind.value === 'afterCount'
          ? { kind: 'afterCount', count: Math.max(1, Number(count.value) || 1) }
          : endKind.value === 'onDate'
            ? { kind: 'onDate', date: new Date(until.value).toISOString() }
            : { kind: 'never' };
      const payload = {
        name: name.value.trim(),
        terminalId: target.value || null,
        command: cmd.value,
        schedule,
        endRepeat,
      };
      if (!payload.name) return toast(t('Name is required'));
      if (payload.terminalId && !payload.command.trim()) return toast(t('A routine needs a command.'));
      const res = r
        ? await api.routineUpdate(r.id, payload)
        : await api.routineCreate({ ...payload, workspaceId: S.wsId });
      if (!res.ok) return toast(res.error, 6000);
      draw();
    };
    body.replaceChildren(
      field(t('Name'), name),
      field(t('Send to'), target),
      field(t('Prompt / command'), cmd),
      field(t('Repeat'), kind),
      sched,
      field(t('Stop repeating'), endKind),
      endBox,
      el(
        'div',
        { class: 'actions' },
        ghost(t('Back'), () => draw(), 'arrow-left'),
        primary(t('Save'), save, 'check'),
      ),
    );
  }

  modal(t('Routines'), el('div', {}, tabs, body), { wide: true });
  draw();
}

// ------------------------------------------------------------------ preferences
export function preferencesDialog(afterSave) {
  const p = JSON.parse(JSON.stringify(S.prefs));
  let tab = 'general';
  const body = el('div');
  const tabs = el('div', { class: 'tabs' });
  const TABS = [
    ['general', t('General'), 'settings'],
    ['agents', t('Agents'), 'bot'],
    ['prompts', t('Prompts'), 'bookmark'],
    ['roles', t('Roles'), 'crown'],
    ['skills', t('Skills'), 'sparkles'],
    ['data', t('Data'), 'database'],
    ['about', t('About'), 'circle-alert'],
  ];
  const draw = () => {
    tabs.replaceChildren(
      ...TABS.map(([id, label, ic]) =>
        el(
          'button',
          {
            class: `tab${id === tab ? ' on' : ''}`,
            onclick: () => {
              tab = id;
              draw();
            },
          },
          icon(ic, 14),
          label,
        ),
      ),
    );
    const page = PAGES[tab]();
    body.replaceChildren(page);
  };

  const PAGES = {
    general() {
      const lang = select(
        [
          ['pt-BR', 'Português (Brasil)'],
          ['en', 'English'],
        ],
        p.language === 'en' ? 'en' : 'pt-BR',
        (v) => (p.language = v),
      );
      const theme = select(
        THEME_IDS.map((x) => [x, x]),
        p.terminalTheme,
        (v) => (p.terminalTheme = v),
      );
      const font = text(p.terminalFontFamily);
      font.oninput = () => (p.terminalFontFamily = font.value);
      const size = el('input', {
        type: 'number',
        min: 8,
        max: 32,
        value: p.terminalFontSize,
        oninput: () => (p.terminalFontSize = Number(size.value) || 13),
      });
      const shell = text(p.defaultShell || 'powershell.exe');
      shell.oninput = () => (p.defaultShell = shell.value.trim() || 'powershell.exe');
      const bg = select(
        [
          ['dotGrid', t('Dot grid')],
          ['solid', t('Solid')],
        ],
        p.canvasBackground,
        (v) => (p.canvasBackground = v),
      );
      const ide = select(
        [
          ['cursor', 'Cursor'],
          ['vscode', 'VS Code'],
          ['windsurf', 'Windsurf'],
        ],
        p.preferredIDE,
        (v) => (p.preferredIDE = v),
      );
      const auto = el('input', {
        type: 'number',
        min: 5,
        max: 600,
        value: p.autosaveIntervalSeconds,
        oninput: () => (p.autosaveIntervalSeconds = Number(auto.value) || 30),
      });
      return el(
        'div',
        {},
        field(t('Language'), lang),
        field(t('Terminal theme'), theme),
        field(t('Terminal font family'), font),
        el(
          'div',
          { class: 'row' },
          field(t('Font size'), size),
          field(t('Autosave (seconds, restart to apply)'), auto),
        ),
        field(t('Default shell'), shell, 'powershell.exe, pwsh.exe, cmd.exe, bash.exe…'),
        el('div', { class: 'row' }, field(t('Canvas background'), bg), field(t('Preferred IDE'), ide)),
        field(
          t('Connection style'),
          select(
            [
              ['avoidNodes', t('Ropes avoid nodes')],
              ['behindNodes', t('Ropes pass behind nodes')],
              ['circuit', t('Circuit (right angles)')],
            ],
            p.ropeRouting || 'avoidNodes',
            (v) => (p.ropeRouting = v),
          ),
          t('Ropes are simulated like real cables and swing when you move a node.'),
        ),
      );
    },
    agents() {
      const wrap = el('div');
      const draw2 = () => {
        wrap.replaceChildren(
          el('p', { class: 'note' }, t('Agent presets appear in the New terminal dialog.')),
          ...p.agentPresets.map((a, i) =>
            el(
              'div',
              { class: 'list-row' },
              toggle(a.isActive, (v) => (a.isActive = v)),
              Object.assign(text(a.name), { oninput: (e) => (a.name = e.target.value), style: { width: '140px' } }),
              Object.assign(text(a.command, t('command')), {
                oninput: (e) => (a.command = e.target.value),
                style: { flex: 1 },
              }),
              el('input', {
                type: 'color',
                value: /^#/.test(a.color) ? a.color : '#8e8e93',
                oninput: (e) => (a.color = e.target.value),
              }),
              a.isBuiltIn
                ? el('span', { class: 'badge' }, t('built-in'))
                : el(
                    'button',
                    {
                      class: 'btn-ghost',
                      onclick: () => {
                        p.agentPresets.splice(i, 1);
                        draw2();
                      },
                    },
                    icon('trash-2', 14),
                  ),
            ),
          ),
          ghost(
            t('Add preset'),
            () => {
              p.agentPresets.push({
                id: crypto.randomUUID().toUpperCase(),
                name: t('Custom'),
                command: '',
                icon: 'terminal',
                agentType: 'generic_shell',
                color: '#8e8e93',
                isActive: true,
                isBuiltIn: false,
              });
              draw2();
            },
            'plus',
          ),
        );
      };
      draw2();
      return wrap;
    },
    prompts() {
      const wrap = el('div');
      const draw2 = async () => {
        const list = await api.promptsAll();
        wrap.replaceChildren(
          el(
            'p',
            { class: 'note' },
            t(
              'Saved prompts appear in the prompter (type / or use the bookmark). They are plain Markdown files you can also edit by hand.',
            ),
          ),
          list.length
            ? el(
                'div',
                { class: 'routines' },
                list.map((p) =>
                  el(
                    'div',
                    { class: 'routine slim' },
                    icon('bookmark', 16),
                    el(
                      'div',
                      { class: 'grow' },
                      el('div', { class: 'r-title' }, p.name.replaceAll('-', ' ')),
                      el(
                        'div',
                        { class: 'r-sub' },
                        `${p.workspaceId ? t('This workspace only') : t('All workspaces')}${p.description ? ` · ${p.description}` : ''}`,
                      ),
                    ),
                    ghost('', () => savedPromptDialog({ kind: 'edit', prompt: p }, draw2), 'pencil'),
                    ghost(
                      '',
                      async () => {
                        await api.promptsDelete(p.id);
                        toast(t('Prompt deleted'), 6000);
                        draw2();
                      },
                      'trash-2',
                    ),
                  ),
                ),
              )
            : el('p', { class: 'empty' }, icon('bookmark', 28), t('No saved prompts yet.')),
          el(
            'div',
            { class: 'actions' },
            ghost(
              t('Undo delete'),
              async () => {
                await api.promptsUndoDelete();
                draw2();
              },
              'undo-2',
            ),
            primary(
              t('New saved prompt'),
              () => savedPromptDialog({ kind: 'new', text: '', workspaceId: null }, draw2),
              'plus',
            ),
          ),
        );
      };
      draw2();
      return wrap;
    },
    roles() {
      const wrap = el('div');
      const draw2 = () => {
        wrap.replaceChildren(
          ...p.rolePresets.map((r, i) =>
            el(
              'div',
              { class: 'field' },
              el(
                'div',
                { class: 'row' },
                Object.assign(text(r.name), { oninput: (e) => (r.name = e.target.value), style: { flex: 1 } }),
                el(
                  'button',
                  {
                    class: 'btn-ghost',
                    onclick: () => {
                      p.rolePresets.splice(i, 1);
                      draw2();
                    },
                  },
                  icon('trash-2', 14),
                ),
              ),
              Object.assign(el('textarea', { value: r.prompt, placeholder: t('Role instructions') }), {
                oninput: (e) => (r.prompt = e.target.value),
              }),
            ),
          ),
          ghost(
            t('Add role'),
            () => {
              p.rolePresets.push({
                id: crypto.randomUUID().toUpperCase(),
                name: t('New role'),
                prompt: '',
                color: '#007AFF',
                icon: 'person.fill',
              });
              draw2();
            },
            'plus',
          ),
          p.rolePresets.length
            ? null
            : el(
                'p',
                { class: 'note' },
                t('Roles inject instructions (CLAUDE.md / AGENTS.md) into a recruited agent.'),
              ),
        );
      };
      draw2();
      return wrap;
    },
    skills() {
      const wrap = el('div');
      const draw2 = () => {
        wrap.replaceChildren(
          el(
            'p',
            { class: 'note' },
            t(
              'The open-maestri skills (agent instructions for the omaestri CLI) are installed into every active folder below when the app starts.',
            ),
          ),
          ...p.skillPaths.map((s, i) =>
            el(
              'div',
              { class: 'list-row' },
              toggle(s.isActive, (v) => (s.isActive = v)),
              el('span', { style: { width: '120px' } }, s.name),
              Object.assign(text(s.path), { oninput: (e) => (s.path = e.target.value), style: { flex: 1 } }),
              s.isBuiltIn
                ? null
                : el(
                    'button',
                    {
                      class: 'btn-ghost',
                      onclick: () => {
                        p.skillPaths.splice(i, 1);
                        draw2();
                      },
                    },
                    icon('trash-2', 14),
                  ),
            ),
          ),
          ghost(
            t('Add skills folder'),
            () => {
              p.skillPaths.push({
                id: crypto.randomUUID().toUpperCase(),
                name: t('Custom'),
                path: '~/.custom/skills',
                icon: 'doc.text',
                isActive: true,
                isBuiltIn: false,
              });
              draw2();
            },
            'plus',
          ),
        );
      };
      draw2();
      return wrap;
    },
    data() {
      const wrap = el('div');
      const draw2 = async () => {
        const list = await api.backupList();
        wrap.replaceChildren(
          el(
            'p',
            { class: 'note' },
            t(
              'A backup contains every workspace (layout and notes), your preferences and routines. An automatic backup is made every hour; the last 24 are kept.',
            ),
          ),
          el(
            'div',
            { class: 'row wrap' },
            primary(
              t('Back up now'),
              async () => {
                const r = await api.backupNow();
                toast(r.ok ? t('Backup created') : r.error);
                draw2();
              },
              'save',
            ),
            ghost(
              t('Export…'),
              async () => {
                const r = await api.backupExport();
                if (r.ok && !r.canceled) toast(t('Exported to {f}', { f: r.file }));
              },
              'download',
            ),
            ghost(
              t('Import…'),
              async () => {
                const r = await api.backupImport();
                if (r.ok && !r.canceled) {
                  await afterImport(r);
                  toast(t('Imported {n} workspace(s)', { n: r.workspaces }));
                } else if (!r.ok) toast(r.error);
              },
              'upload',
            ),
            ghost(t('Open folder'), () => api.backupReveal(), 'folder-open'),
          ),
          el('p', { class: 'note' }, t('Data folder: {p}', { p: S.env.home })),
          el('h4', {}, t('Saved backups')),
          list.length
            ? el(
                'div',
                { class: 'routines' },
                list.map((b) =>
                  el(
                    'div',
                    { class: 'routine slim' },
                    icon('hard-drive', 16),
                    el(
                      'div',
                      { class: 'grow' },
                      el('div', { class: 'r-title' }, b.name),
                      el(
                        'div',
                        { class: 'r-sub' },
                        `${new Date(b.mtime).toLocaleString()} · ${(b.size / 1024).toFixed(0)} KB`,
                      ),
                    ),
                    ghost(
                      t('Restore'),
                      async () => {
                        if (!confirm(t('Restore this backup? Workspaces with the same id will be overwritten.')))
                          return;
                        const r = await api.backupRestore(b.file);
                        if (r.ok) {
                          await afterImport(r);
                          toast(t('Backup restored'));
                        } else toast(r.error);
                      },
                      'history',
                    ),
                  ),
                ),
              )
            : el('p', { class: 'empty' }, icon('database', 28), t('No backups yet.')),
        );
      };
      draw2();
      return wrap;
    },
    about() {
      return el(
        'div',
        {},
        el('p', {}, t('open-maestri for Windows — multi-agent orchestration canvas.')),
        el('p', { class: 'note' }, t('Data folder: {p}', { p: S.env.home })),
        el('p', { class: 'note' }, t('Inter-agent server: 127.0.0.1:{port} (loopback only)', { port: S.env.port })),
        el(
          'p',
          { class: 'note' },
          t('Licensed GPL-3.0-or-later. A port of github.com/pedrotecinf/open-maestri. Icons: Lucide (ISC).'),
        ),
      );
    },
  };

  async function afterImport(r) {
    close();
    const { S: st } = await import('./store.js');
    st.workspaces = r.workspaces;
    document.dispatchEvent(new CustomEvent('workspaces-imported', { detail: r }));
  }

  draw();
  const close = modal(
    t('Preferences'),
    el(
      'div',
      {},
      tabs,
      body,
      el(
        'div',
        { class: 'actions' },
        ghost(t('Cancel'), () => close()),
        primary(
          t('Save'),
          async () => {
            await api.setPrefs(p);
            S.prefs = p;
            setLang(p.language);
            close();
            toast(t('Preferences saved'));
            afterSave && afterSave();
          },
          'check',
        ),
      ),
    ),
    { wide: true },
  );
}

export { getLang, colorOf };
