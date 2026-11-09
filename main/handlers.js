'use strict';
// omaestri CLI command handlers. Output strings intentionally match open-maestri
// (macOS) so existing Maestri skills / agent prompts keep working.
const fs = require('fs');
const path = require('path');
const persistence = require('./persistence');
const { frameRect } = require('./workspaces');

const ASK_TIMEOUT_MS = Number(process.env.OMAESTRI_ASK_TIMEOUT_MS) || 20 * 60 * 1000;

function createHandlers({ workspaces, terminals, portals, ui, routines, floors, chat }) {
  const R = require('./routines');
  const lc = (s) => String(s || '').toLowerCase();

  // ------------------------------------------------------------- resolving
  function callerContext(tid) {
    if (!tid) return null;
    const wsId = workspaces.workspaceOfNode(tid);
    if (!wsId) return null;
    const doc = workspaces.getDoc(wsId);
    const node = workspaces.terminalNode(doc, tid);
    if (!node) return null;
    return { wsId, doc, node, tc: node.content.terminal._0 };
  }

  const termName = (node) => node.content.terminal._0.name || node.content.terminal._0.command || 'Shell';

  function matchTerminal(doc, ids, query) {
    const q = lc(query);
    return ids
      .map((id) => workspaces.terminalNode(doc, id))
      .filter(Boolean)
      .find((n) => {
        const tc = n.content.terminal._0;
        return (
          lc(tc.name).includes(q) ||
          lc(tc.command).includes(q) ||
          n.id.toLowerCase().startsWith(q.slice(0, 8)) ||
          lc(tc.name) === q
        );
      });
  }

  function ensureSession(ctx, node) {
    return terminals.ensure(node, ctx.wsId, ui.prefs());
  }

  // ------------------------------------------------------------------ list
  function list(args, tid) {
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const sections = [`You:\n  - name: "${termName(ctx.node)}"`];
    const conns = workspaces.connectionsOf(ctx.doc, tid);
    const agents = conns.agents
      .map((id) => workspaces.terminalNode(ctx.doc, id))
      .filter(Boolean)
      .map((n) => {
        const role = n.content.terminal._0.assignedRoleId ? roleNameOf(n.content.terminal._0.assignedRoleId) : null;
        return `  - name: "${termName(n)}"${role ? ` - role: ${role}` : ''}`;
      });
    const notes = conns.notes
      .map((id) => workspaces.findNode(ctx.doc, id))
      .filter(Boolean)
      .map((n) => `  - name: "${workspaces.noteNameOf(n)}"`);
    const portalLines = conns.portals
      .map((id) => workspaces.findNode(ctx.doc, id))
      .filter(Boolean)
      .map((n) => {
        const pc = n.content.portal._0;
        const live = portals.info(n.id);
        const url = (live && live.url) || pc.currentURL;
        return `  - name: "${pc.name}"${url ? ` - url: ${url}` : ''}`;
      });
    if (!agents.length && !notes.length && !portalLines.length) return sections.join('\n\n') + '\n\nNo connections.';
    if (agents.length) sections.push('Connected agents:\n' + agents.join('\n'));
    if (portalLines.length)
      sections.push('Connected portals (use `omaestri portal snapshot`):\n' + portalLines.join('\n'));
    if (notes.length) sections.push('Connected notes (use `omaestri note read/write/edit`):\n' + notes.join('\n'));
    return sections.join('\n\n');
  }

  function roleNameOf(roleId) {
    const r = ui.prefs().rolePresets.find((x) => x.id === roleId);
    return r ? r.name : null;
  }

  // ------------------------------------------------------------------- ask
  const shellPromptRe = /(%|\$|>|❯|#)\s*$/;

  async function ask(args, tid) {
    if (args.length < 3) return 'error: usage: omaestri ask "TargetAgent" "prompt"';
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const conns = workspaces.connectionsOf(ctx.doc, tid);
    const target = matchTerminal(ctx.doc, conns.agents, args[1]);
    if (!target) return `error: agent '${args[1]}' not found. Use 'omaestri list' to see connected agents.`;
    const session = ensureSession(ctx, target);

    const conn = ctx.doc.payload.connections.find(
      (c) =>
        (c.terminalIdA === tid && c.terminalIdB === target.id) ||
        (c.terminalIdA === target.id && c.terminalIdB === tid),
    );
    if (conn) ui.connectionStatus(ctx.wsId, conn.id, 'communicating');
    session.markActiveTask();

    const prompt = args[2];
    const text = prompt.endsWith('\r') ? prompt : prompt.replace(/[\r\n]+$/, '') + '\r';
    const isShell = session.agentType === 'generic_shell';
    const baseline = session.screenText().split('\n').length;
    // Bracketed paste keeps multi-line prompts intact in agent TUIs.
    if (!isShell && /\n/.test(prompt)) {
      session.write('\x1b[200~' + prompt.replace(/[\r\n]+$/, '') + '\x1b[201~');
      await new Promise((r) => setTimeout(r, 150));
      session.write('\r');
    } else {
      session.write(text);
    }

    const result = isShell ? await waitForPrompt(session, baseline) : await waitForIdle(session);
    if (conn) ui.connectionStatus(ctx.wsId, conn.id, 'idle');
    return result || '(no output)';
  }

  function waitForIdle(session) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(grace);
        session.off('idle', onIdle);
        resolve(session.screenText());
      };
      const onIdle = () => finish();
      // give the agent a moment to start working before listening for idle
      const grace = setTimeout(() => session.on('idle', onIdle), 500);
      const timer = setTimeout(finish, ASK_TIMEOUT_MS);
    });
  }

  function waitForPrompt(session, baseline) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        resolve(session.screenText());
      };
      // Poll: shell output often arrives before any listener could be attached.
      const poll = setInterval(() => {
        const lines = session.screenText().split('\n');
        if (lines.length <= baseline + 1) return;
        const last = (lines[lines.length - 1] || '').trim();
        if (shellPromptRe.test(last)) finish();
      }, 100);
      const timer = setTimeout(finish, Math.min(ASK_TIMEOUT_MS, 5 * 60 * 1000));
    });
  }

  // ----------------------------------------------------------------- check
  function check(args, tid) {
    if (args.length < 2) return 'error: usage: omaestri check "TargetAgent" [lines]';
    const lines = args[2] ? parseInt(args[2], 10) || 20 : 20;
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const conns = workspaces.connectionsOf(ctx.doc, tid);
    const target = matchTerminal(ctx.doc, conns.agents, args[1]);
    if (!target) return `error: agent '${args[1]}' not found in connections`;
    const out = ensureSession(ctx, target).recentOutput(lines);
    return out.trim() ? out : '(no recent output)';
  }

  // ------------------------------------------------------------------ note
  function resolveNote(ctx, name) {
    const conns = workspaces.connectionsOf(ctx.doc, ctx.node.id);
    const q = lc(name);
    const nodes = conns.notes.map((id) => workspaces.findNode(ctx.doc, id)).filter(Boolean);
    const node =
      nodes.find((n) => lc(workspaces.noteNameOf(n)) === q) ||
      nodes.find((n) => lc(workspaces.noteNameOf(n)).includes(q));
    return node ? { node, file: workspaces.notePath(ctx.doc, node) } : null;
  }

  function noteCmd(args, tid) {
    if (args.length < 2) return 'error: usage: omaestri note <read|write|edit|create> ...';
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const sub = args[1];
    try {
      if (sub === 'create') {
        const content = args[2] || '';
        const name = `Note-${persistence.uuid().slice(0, 8)}`;
        const node = workspaces.addNote(ctx.doc, { name, content, anchorId: tid });
        workspaces.connect(ctx.doc, tid, node.id);
        workspaces.changed(ctx.wsId);
        return name;
      }
      if (!['read', 'write', 'edit'].includes(sub))
        return `error: unknown note subcommand '${sub}'. Valid: read|write|edit|create`;
      if (args.length < 3) return `error: usage: omaestri note ${sub} "NoteName"`;
      const note = resolveNote(ctx, args[2]);
      if (!note) return `error: note '${args[2]}' not found in connections`;
      if (sub === 'read') {
        const text = fs.existsSync(note.file) ? fs.readFileSync(note.file, 'utf8') : '';
        const all = text.split('\n');
        const offset = args[3] ? Math.max(1, parseInt(args[3], 10) || 1) : 1;
        const limit = args[4] ? parseInt(args[4], 10) || all.length : all.length;
        const width = String(Math.min(all.length, offset - 1 + limit)).length;
        return all
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => `${String(offset + i).padStart(width, ' ')}\t${l}`)
          .join('\n');
      }
      if (sub === 'write') {
        if (args.length < 4) return 'error: usage: omaestri note write "NoteName" "content"';
        persistence.writeFileAtomic(note.file, args[3]);
        ui.noteChanged(note.node.id);
        return 'OK';
      }
      if (args.length < 5) return 'error: usage: omaestri note edit "NoteName" "oldText" "newText"';
      const cur = fs.readFileSync(note.file, 'utf8');
      const idx = cur.indexOf(args[3]);
      if (idx < 0) return 'error: text not found in note';
      persistence.writeFileAtomic(note.file, cur.slice(0, idx) + args[4] + cur.slice(idx + args[3].length));
      ui.noteChanged(note.node.id);
      return 'OK';
    } catch (err) {
      return `error: ${err.message}`;
    }
  }

  // --------------------------------------------------------------- maestro
  function requireManager(ctx) {
    return ctx && ctx.tc.isManager;
  }

  function findPreset(prefs, ident) {
    const q = lc(ident);
    return prefs.agentPresets.find((p) => p.agentType === ident || lc(p.name) === q || p.command === ident);
  }

  function recruit(args, tid) {
    if (args.length < 2)
      return 'error: usage: omaestri recruit "Name" [--preset <agentType>] [--role <roleName>] [--command <cmd>]';
    const ctx = callerContext(tid);
    if (!ctx) return 'error: recruit can only be called from a Maestro terminal';
    if (!requireManager(ctx))
      return 'error: this terminal is not in Maestro mode. Enable Maestro mode when creating the terminal.';
    const name = args[1];
    let presetId = 'generic_shell';
    let roleName = null;
    let customCmd = null;
    for (let i = 2; i < args.length;) {
      if (args[i] === '--preset' && args[i + 1]) {
        presetId = args[i + 1];
        i += 2;
      } else if (args[i] === '--role' && args[i + 1]) {
        roleName = args[i + 1];
        i += 2;
      } else if (args[i] === '--command' && args[i + 1]) {
        customCmd = args[i + 1];
        i += 2;
      } else i += 1;
    }
    const prefs = ui.prefs();
    const preset = findPreset(prefs, presetId) || {
      name,
      command: customCmd || presetId,
      agentType: 'generic_shell',
      color: '#8E8E93',
    };
    const command = customCmd || preset.command;
    const role = roleName ? prefs.rolePresets.find((r) => lc(r.name) === lc(roleName)) : null;
    if (roleName && !role) return `error: role '${roleName}' not found`;

    const node = workspaces.addTerminal(
      ctx.doc,
      {
        name,
        agentType: preset.agentType,
        command,
        workingDirectory: ctx.tc.workingDirectory,
        color: preset.color,
        roleId: role && role.id,
      },
      tid,
    );
    workspaces.connect(ctx.doc, tid, node.id);
    if (role) injectRole(role, ctx.tc.workingDirectory);
    workspaces.changed(ctx.wsId);
    terminals.ensure(node, ctx.wsId, prefs, { roleName: role && role.name });
    return `Recruited '${name}' with preset '${preset.name}'${role ? ` and role '${role.name}'` : ''}`;
  }

  function dismiss(args, tid) {
    if (args.length < 2) return 'error: usage: omaestri dismiss "Name"';
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const conns = workspaces.connectionsOf(ctx.doc, tid);
    const q = lc(args[1]);
    const target = conns.agents
      .map((id) => workspaces.terminalNode(ctx.doc, id))
      .filter(Boolean)
      .find((n) => {
        const tc = n.content.terminal._0;
        return lc(tc.name).includes(q) || lc(tc.command).includes(q) || n.id.toLowerCase().startsWith(q.slice(0, 8));
      });
    if (!target) return `error: agent '${args[1]}' not found among connected agents`;
    terminals.remove(target.id);
    workspaces.removeNode(ctx.doc, target.id);
    workspaces.changed(ctx.wsId);
    return `Dismissed '${args[1]}'`;
  }

  function connect(args, tid) {
    if (args.length < 3) return 'error: usage: omaestri connect "From" "To"';
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const all = ctx.doc.payload.nodes.filter((n) => n.content.terminal).map((n) => n.id);
    const a = matchTerminal(ctx.doc, all, args[1]);
    if (!a) return `error: '${args[1]}' not found`;
    const b = matchTerminal(ctx.doc, all, args[2]);
    if (!b) return `error: '${args[2]}' not found`;
    workspaces.connect(ctx.doc, a.id, b.id);
    workspaces.changed(ctx.wsId);
    return `Connected '${args[1]}' ↔ '${args[2]}'`;
  }

  function injectRole(role, workingDirectory) {
    const base = workingDirectory
      ? path.join(workingDirectory, '.open-maestri', 'roles')
      : path.join(persistence.paths.root, 'roles');
    const dir = path.join(base, role.id);
    const body = `<your_assigned_role>\n${role.prompt}\n</your_assigned_role>\n\n<working_directory>\nIMPORTANT: You were started in this directory to receive the above role assignment. The actual project you should be working on is located at:\n${workingDirectory}\n</working_directory>`;
    try {
      persistence.ensureDir(dir);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), body);
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), body);
      persistence.writeJSON(path.join(dir, 'role.json'), {
        color: role.color,
        icon: role.icon,
        id: role.id,
        name: role.name,
        prompt: role.prompt,
        schemaVersion: 1,
      });
    } catch {
      /* working directory may be read-only */
    }
    return dir;
  }

  function role(args, tid) {
    if (args.length < 2) return 'error: usage: omaestri role <list|create|show|edit|write|assign> [args...]';
    const prefs = ui.prefs();
    const find = (n) => prefs.rolePresets.find((r) => lc(r.name) === lc(n));
    switch (args[1]) {
      case 'list':
        if (!prefs.rolePresets.length)
          return 'No roles defined. Create one: omaestri role create "RoleName" "Role instructions"';
        return prefs.rolePresets.map((r) => `  - ${r.name}: ${r.prompt.slice(0, 60)}...`).join('\n');
      case 'create': {
        if (args.length < 4) return 'error: usage: omaestri role create "RoleName" "Role instructions"';
        prefs.rolePresets.push({
          id: persistence.uuid(),
          name: args[2],
          prompt: args[3],
          color: '#007AFF',
          icon: 'person.fill',
        });
        ui.savePrefs(prefs);
        return `Role '${args[2]}' created`;
      }
      case 'show': {
        if (args.length < 3) return 'error: usage: omaestri role show "RoleName"';
        const r = find(args[2]);
        return r ? `Name: ${r.name}\nPrompt: ${r.prompt}` : `error: role '${args[2]}' not found`;
      }
      case 'edit':
      case 'write': {
        if (args.length < 4) return `error: usage: omaestri role ${args[1]} "RoleName" --prompt "..."`;
        const r = find(args[2]);
        if (!r) return `error: role '${args[2]}' not found`;
        for (let i = 3; i < args.length;) {
          if (args[i] === '--prompt' && args[i + 1]) {
            r.prompt = args[i + 1];
            i += 2;
          } else i += 1;
        }
        ui.savePrefs(prefs);
        return `Role '${args[2]}' updated`;
      }
      case 'assign': {
        if (args.length < 4) return 'error: usage: omaestri role assign "AgentName" "RoleName" (use --none to clear)';
        const ctx = callerContext(tid);
        if (!ctx) return 'error: missing terminal ID';
        const all = ctx.doc.payload.nodes.filter((n) => n.content.terminal).map((n) => n.id);
        const agent = matchTerminal(ctx.doc, all, args[2]);
        if (!agent) return `error: agent '${args[2]}' not found`;
        const tc = agent.content.terminal._0;
        if (args[3] === '--none') {
          tc.assignedRoleId = null;
          workspaces.changed(ctx.wsId);
          return `Role cleared for '${args[2]}' (takes effect on next restart)`;
        }
        const r = find(args[3]);
        if (!r) return `error: role '${args[3]}' not found`;
        tc.assignedRoleId = r.id;
        injectRole(r, tc.workingDirectory);
        workspaces.changed(ctx.wsId);
        return `Role '${args[3]}' assigned to '${args[2]}' (takes effect on next restart)`;
      }
      default:
        return `error: unknown role subcommand '${args[1]}'. Valid: list|create|show|edit|write|assign`;
    }
  }

  function preset(args) {
    if (args.length < 2) return 'error: usage: omaestri preset <list>';
    if (args[1] !== 'list') return `error: unknown preset subcommand '${args[1]}'. Valid: list`;
    return ui
      .prefs()
      .agentPresets.filter((p) => p.isActive)
      .map((p) => `  - ${p.agentType}: ${p.name} (${p.command})`)
      .join('\n');
  }

  function debug(args, tid) {
    return `open-maestri inter-agent server debug:\n  Server port: ${ui.port()}\n  Terminal ID: ${tid || '(none)'}\n  Commands: list ask check note portal recruit dismiss connect role preset routine floor debug`;
  }

  // --------------------------------------------------------------- routines
  function flags(args, from) {
    const f = {};
    const pos = [];
    for (let i = from; i < args.length; i++) {
      if (args[i].startsWith('--')) {
        const k = args[i].slice(2);
        if (['reminder', 'remove', 'delete-branch', 'existing', 'disabled'].includes(k)) f[k] = true;
        else f[k] = args[++i];
      } else pos.push(args[i]);
    }
    return { f, pos };
  }

  function scheduleFromFlags(f) {
    const given = ['every', 'daily', 'weekly', 'once'].filter((k) => f[k] !== undefined);
    if (given.length > 1) return { error: 'Specify only one schedule: --every, --daily, --weekly, or --once.' };
    if (!given.length) return { empty: true };
    if (f.every !== undefined) {
      const s = R.parseDuration(f.every);
      return s
        ? { schedule: { kind: 'interval', seconds: s } }
        : { error: `Invalid --every "${f.every}". Use e.g. 45s, 30m, 2h, 1h30m (a bare number means minutes).` };
    }
    if (f.daily !== undefined) {
      const t = R.parseTime(f.daily);
      return t
        ? { schedule: { kind: 'daily', ...t } }
        : { error: `Invalid --daily "${f.daily}". Use 24h HH:mm, e.g. 09:00.` };
    }
    if (f.weekly !== undefined) {
      const w = R.parseWeekly(f.weekly);
      return w
        ? { schedule: { kind: 'weekly', ...w } }
        : { error: `Invalid --weekly "${f.weekly}". Use days@HH:mm, e.g. mon,wed,fri@09:00.` };
    }
    const d = R.parseDateTime(f.once);
    return d
      ? { schedule: { kind: 'once', at: d.toISOString() } }
      : { error: `Invalid --once "${f.once}". Use "yyyy-MM-dd HH:mm", e.g. "2026-06-20 15:00".` };
  }

  function endFromFlags(f) {
    if (f.count !== undefined && f.until !== undefined) return { error: 'Specify only one of --count or --until.' };
    if (f.count !== undefined) {
      const n = parseInt(f.count, 10);
      return n >= 1 ? { value: { kind: 'afterCount', count: n } } : { error: '--count must be at least 1.' };
    }
    if (f.until !== undefined) {
      const d = R.parseDateTime(f.until) || (isNaN(Date.parse(f.until)) ? null : new Date(f.until));
      return d ? { value: { kind: 'onDate', date: d.toISOString() } } : { error: `Invalid --until "${f.until}".` };
    }
    return {};
  }

  const fmtRoutine = (r) =>
    `${r.enabled ? '*' : '-'} ${r.name} | ${R.describeSchedule(r.schedule)} | ${r.terminalId ? 'terminal' : 'reminder'}${r.nextRunAt && r.enabled ? ` | next ${new Date(r.nextRunAt).toLocaleString()}` : ''} | runs: ${r.runCount}`;

  async function routineCmd(args, tid) {
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const sub = args[1];
    const wsId = ctx.wsId;
    if (!sub || sub === 'list') {
      const l = routines.list(wsId);
      return l.length
        ? l.map(fmtRoutine).join('\n')
        : 'No routines. Create one: omaestri routine create "Name" --command "..." --every 30m';
    }
    const { f, pos } = flags(args, 2);
    const allTerminals = () => ctx.doc.payload.nodes.filter((n) => n.content.terminal).map((n) => n.id);
    if (sub === 'create') {
      const name = f.name || pos[0];
      if (!name)
        return 'error: usage: omaestri routine create "Name" --command "..." (--every 30m | --daily 09:00 | --weekly mon,wed@09:00 | --once "2026-06-20 15:00") [--terminal "Name" | --reminder] [--count N | --until DATE]';
      const reminder = f.reminder === true;
      if (!reminder && !f.command) return 'A routine needs a command. Pass --command "...".';
      const sc = scheduleFromFlags(f);
      if (sc.empty) return 'A routine needs a schedule. Pass one of --every, --daily, --weekly, --once.';
      if (sc.error) return sc.error;
      const en = endFromFlags(f);
      if (en.error) return en.error;
      if (reminder && f.terminal) return 'Pass either --terminal or --reminder, not both.';
      let terminalId = null;
      if (!reminder) {
        if (f.terminal) {
          const t = matchTerminal(ctx.doc, allTerminals(), f.terminal);
          if (!t) return `No terminal named "${f.terminal}" in this workspace. Run omaestri list.`;
          terminalId = t.id;
        } else terminalId = tid;
      }
      try {
        const r = routines.create({
          name,
          workspaceId: wsId,
          terminalId,
          command: f.command || '',
          schedule: sc.schedule,
          endRepeat: en.value,
          enabled: !f.disabled,
        });
        return `Created routine "${r.name}": ${R.describeSchedule(r.schedule)}${r.nextRunAt ? ` (next ${new Date(r.nextRunAt).toLocaleString()})` : ''}`;
      } catch (e) {
        return `error: ${e.message}`;
      }
    }
    if (!pos[0]) return `error: usage: omaestri routine ${sub} "Name"`;
    const target = routines.get(pos[0], wsId);
    if (!target) return `error: routine '${pos[0]}' not found`;
    try {
      switch (sub) {
        case 'show':
          return `${fmtRoutine(target)}\ncommand: ${target.command || '(reminder)'}\nend: ${JSON.stringify(target.endRepeat)}\nlast run: ${target.lastRunAt || 'never'}`;
        case 'delete':
          routines.remove(target.id);
          return `Deleted routine "${target.name}"`;
        case 'enable':
          routines.setEnabled(target.id, true);
          return `Enabled "${target.name}"`;
        case 'disable':
          routines.setEnabled(target.id, false);
          return `Disabled "${target.name}"`;
        case 'run': {
          const r = await routines.runNow(target.id);
          return `Ran "${target.name}": ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`;
        }
        case 'edit': {
          const upd = {};
          if (f.command !== undefined) upd.command = f.command;
          if (f.name !== undefined) upd.name = f.name;
          const sc = scheduleFromFlags(f);
          if (sc.error) return sc.error;
          if (sc.schedule) upd.schedule = sc.schedule;
          const en = endFromFlags(f);
          if (en.error) return en.error;
          if (en.value) upd.endRepeat = en.value;
          if (f.reminder) upd.terminalId = null;
          if (f.terminal) {
            const t = matchTerminal(ctx.doc, allTerminals(), f.terminal);
            if (!t) return `No terminal named "${f.terminal}" in this workspace.`;
            upd.terminalId = t.id;
          }
          routines.update(target.id, upd);
          return `Updated "${target.name}"`;
        }
        default:
          return `error: unknown routine subcommand '${sub}'. Valid: list|show|create|edit|delete|enable|disable|run`;
      }
    } catch (e) {
      return `error: ${e.message}`;
    }
  }

  // ----------------------------------------------------------------- floors
  async function floorCmd(args, tid) {
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    const sub = args[1] || 'list';
    const { f, pos } = flags(args, 2);
    const wsId = ctx.wsId;
    try {
      if (sub === 'list') {
        const fl = ctx.doc.payload.floors;
        const count = (id) => ctx.doc.payload.nodes.filter((n) => (n.floorId || null) === id).length;
        return [
          'Ground: ' + count(null) + ' nodes',
          ...fl.map((x) => `${x.name} | branch ${x.branchName} | ${count(x.id)} nodes | ${x.worktreePath}`),
        ].join('\n');
      }
      if (sub === 'create') {
        if (!pos[0]) return 'error: usage: omaestri floor create "Name" [--branch BRANCH] [--existing]';
        const r = await floors.create(wsId, {
          name: pos[0],
          branch: f.branch,
          existingBranch: f.existing === true,
          runSetup: false,
        });
        workspaces.changed(wsId);
        return `Created floor "${r.floor.name}" on branch ${r.floor.branchName} at ${r.floor.worktreePath}`;
      }
      if (!pos[0] && sub !== 'status') return `error: usage: omaestri floor ${sub} "Name"`;
      if (sub === 'status') {
        const names = pos[0] ? [pos[0]] : ctx.doc.payload.floors.map((x) => x.name);
        if (!names.length) return 'No floors.';
        const lines = [];
        for (const n of names) {
          const s = await floors.status(wsId, n);
          lines.push(
            `${s.floor.name}: ${s.ahead} ahead, ${s.behind} behind ${s.target}, ${s.dirtyFiles} uncommitted file(s)`,
          );
        }
        return lines.join('\n');
      }
      if (sub === 'delete') {
        const r = await floors.remove(wsId, pos[0], { deleteBranch: f['delete-branch'] === true });
        workspaces.changed(wsId);
        return `Deleted floor "${r.floor.name}"${r.warnings.length ? `\nwarnings: ${r.warnings.join('; ')}` : ''}`;
      }
      if (sub === 'land') {
        const r = await floors.land(wsId, pos[0], {
          removeAfter: f.remove === true,
          deleteBranch: f['delete-branch'] === true,
        });
        workspaces.changed(wsId);
        return `Landed "${r.landed}" onto ${r.target} (${r.commits} commit(s))${r.removed ? ' and removed the floor' : ''}`;
      }
      return `error: unknown floor subcommand '${sub}'. Valid: list|create|status|land|delete`;
    } catch (e) {
      return `error: ${e.message}`;
    }
  }

  // ------------------------------------------------------------- chat (say / recall)
  function chatCmd(args, tid) {
    const ctx = callerContext(tid);
    if (!ctx) return 'error: missing terminal ID';
    if (!chat) return 'error: chat is not available';
    const cmd = args[0];
    try {
      if (cmd === 'say') {
        const o = { text: '', progress: false, file: null, attach: [] };
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a === '--text') o.text = args[++i] || '';
          else if (a === '--progress') o.progress = true;
          else if (a === '--file') o.file = args[++i];
          else if (a === '--attach') o.attach.push(args[++i]);
          else if (a.startsWith('--'))
            return `error: unknown option '${a}'. Usage: omaestri say [--progress] [--file <path>] [--attach <path>] ["text"]`;
          else o.text = o.text ? o.text + ' ' + a : a;
        }
        chat.say(ctx.wsId, tid, o);
        return o.progress ? 'progress sent' : 'sent';
      }
      // recall
      const sub = args[1];
      if (sub === 'list') return chat.list(ctx.wsId, tid);
      if (sub === 'attachment') {
        const p = chat.attachmentPath(ctx.wsId, tid, args[2]);
        return p || `error: attachment '${args[2] || ''}' not found`;
      }
      const o = {};
      let thread = null;
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '--turns') o.turns = Number(args[++i]);
        else if (a === '--last') o.last = args[++i];
        else if (a === '--from') o.from = args[++i];
        else if (a === '--to') o.to = args[++i];
        else if (a === '--all') o.all = true;
        else if (a === '--json') o.json = true;
        else if (a.startsWith('--')) return `error: unknown option '${a}'`;
        else thread = a;
      }
      if (o.last && !['day', 'week', 'month'].includes(o.last)) return 'error: --last must be day, week or month';
      for (const k of ['from', 'to'])
        if (o[k] && !/^\d{4}-\d{2}-\d{2}$/.test(o[k])) return `error: --${k} needs a date like 2026-01-31`;
      return chat.recall(ctx.wsId, tid, thread, o);
    } catch (e) {
      return `error: ${e.message}`;
    }
  }

  // ---------------------------------------------------------------- router
  async function route(args, tid) {
    const command = args[0];
    if (!command) return 'error: empty command';
    try {
      switch (command) {
        case 'list':
          return list(args, tid);
        case 'ask':
          return await ask(args, tid);
        case 'check':
          return check(args, tid);
        case 'note':
          return noteCmd(args, tid);
        case 'portal': {
          const ctx = callerContext(tid);
          if (!ctx) return 'error: missing terminal ID';
          return await portals.handle(args, ctx);
        }
        case 'recruit':
          return recruit(args, tid);
        case 'dismiss':
          return dismiss(args, tid);
        case 'connect':
          return connect(args, tid);
        case 'role':
          return role(args, tid);
        case 'preset':
          return preset(args);
        case 'routine':
          return await routineCmd(args, tid);
        case 'floor':
          return await floorCmd(args, tid);
        case 'say':
        case 'recall':
          return chatCmd(args, tid);
        case 'debug':
          return debug(args, tid);
        default:
          return `error: unknown command '${command}'. Try 'omaestri list' for available commands.`;
      }
    } catch (err) {
      return `error: ${err && err.message ? err.message : err}`;
    }
  }

  return { route, injectRole, frameRect };
}

module.exports = { createHandlers };
