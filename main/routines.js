'use strict';
// Routines: scheduled prompts/commands sent to a terminal (or a reminder notification).
// Schedule kinds mirror Maestri: once | interval | daily | weekly, with an end-repeat rule.
const path = require('path');
const { EventEmitter } = require('events');
const persistence = require('./persistence');

const file = () => path.join(persistence.paths.root, 'routines.json');
const HISTORY_MAX = 300;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ----------------------------------------------------------------- parsing
function parseDuration(s) {
  s = String(s).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60);
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0,
    used = 0,
    m;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2]];
    used += m[0].length;
  }
  return total > 0 && used === s.replace(/\s+/g, '').length ? total : null;
}
const parseTime = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  return m && +m[1] < 24 && +m[2] < 60 ? { hour: +m[1], minute: +m[2] } : null;
};
function parseWeekly(s) {
  const [days, time] = String(s).split('@');
  const t = parseTime(time || '');
  const set = new Set();
  for (const d of String(days).toLowerCase().split(',')) {
    const i = WEEKDAYS.findIndex((w) => d.trim().startsWith(w));
    if (i < 0) return null;
    set.add(i);
  }
  return t && set.size ? { weekdays: [...set].sort(), ...t } : null;
}
function parseDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d) ? null : d;
}

// Next fire time (ms) strictly after `from`, or null.
function nextRun(r, from) {
  const s = r.schedule;
  if (!s) return null;
  if (s.kind === 'once') {
    const at = Date.parse(s.at);
    return at > from ? at : null;
  }
  if (s.kind === 'interval') {
    const base = r.lastRunAt ? Date.parse(r.lastRunAt) : Date.parse(r.createdAt);
    return Math.max(from + 1000, base + s.seconds * 1000);
  }
  const cand = (day) => {
    const d = new Date(day);
    d.setHours(s.hour, s.minute, 0, 0);
    return d.getTime();
  };
  const start = new Date(from);
  for (let i = 0; i < 8; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const t = cand(d);
    if (t <= from) continue;
    if (s.kind === 'daily' || (s.kind === 'weekly' && s.weekdays.includes(d.getDay()))) return t;
  }
  return null;
}

function validateSchedule(s) {
  if (!s || !['once', 'interval', 'daily', 'weekly'].includes(s.kind)) return 'invalid schedule';
  if (s.kind === 'interval' && !(s.seconds >= 1)) return 'interval must be at least 1 second';
  if ((s.kind === 'daily' || s.kind === 'weekly') && !(s.hour >= 0 && s.hour < 24 && s.minute >= 0 && s.minute < 60))
    return 'invalid time';
  if (s.kind === 'weekly' && !(Array.isArray(s.weekdays) && s.weekdays.length)) return 'pick at least one weekday';
  if (s.kind === 'once' && isNaN(Date.parse(s.at))) return 'invalid date';
  return null;
}

function describeSchedule(s) {
  const hh = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (s.kind === 'once') return `once at ${new Date(s.at).toLocaleString()}`;
  if (s.kind === 'interval') {
    const x = s.seconds;
    return `every ${x % 3600 === 0 ? x / 3600 + 'h' : x % 60 === 0 ? x / 60 + 'm' : x + 's'}`;
  }
  if (s.kind === 'daily') return `daily at ${hh(s.hour, s.minute)}`;
  return `${s.weekdays.map((d) => WEEKDAYS[d]).join(',')} at ${hh(s.hour, s.minute)}`;
}

// -------------------------------------------------------------------- store
class Routines extends EventEmitter {
  constructor({ workspaces, terminals, prefs }) {
    super();
    this.workspaces = workspaces;
    this.terminals = terminals;
    this.prefs = prefs;
    const stored = persistence.readJSON(file(), {});
    this.items = Array.isArray(stored.routines) ? stored.routines : [];
    this.history = Array.isArray(stored.history) ? stored.history : [];
    this.timer = null;
  }

  save() {
    persistence.writeJSON(file(), {
      schemaVersion: 1,
      routines: this.items,
      history: this.history.slice(-HISTORY_MAX),
    });
    this.emit('changed');
  }

  list(wsId) {
    return this.items.filter((r) => !wsId || r.workspaceId === wsId);
  }
  get(ref, wsId) {
    const q = String(ref).toLowerCase();
    const l = this.list(wsId);
    return (
      l.find((r) => r.id === ref) ||
      l.find((r) => r.name.toLowerCase() === q) ||
      l.find((r) => r.name.toLowerCase().includes(q))
    );
  }

  create(input) {
    const err = validateSchedule(input.schedule);
    if (err) throw new Error(err);
    if (!input.name || !String(input.name).trim()) throw new Error('a routine needs a name');
    if (input.terminalId && !input.command) throw new Error('a routine needs a command');
    if (this.list(input.workspaceId).some((r) => r.name.toLowerCase() === String(input.name).trim().toLowerCase()))
      throw new Error(`a routine named "${input.name}" already exists`);
    const r = {
      id: persistence.uuid(),
      name: String(input.name).trim(),
      workspaceId: input.workspaceId,
      terminalId: input.terminalId || null, // null => reminder
      command: input.command || '',
      schedule: input.schedule,
      endRepeat: input.endRepeat || { kind: 'never' },
      enabled: input.enabled !== false,
      runCount: 0,
      createdAt: persistence.now(),
      lastRunAt: null,
      nextRunAt: null,
    };
    this._arm(r);
    this.items.push(r);
    this.save();
    return r;
  }

  update(id, fields) {
    const r = this.items.find((x) => x.id === id);
    if (!r) throw new Error('routine not found');
    for (const k of ['name', 'terminalId', 'command', 'schedule', 'endRepeat', 'enabled'])
      if (k in fields) r[k] = fields[k];
    const err = validateSchedule(r.schedule);
    if (err) throw new Error(err);
    if ('schedule' in fields) {
      r.runCount = 0;
      r.lastRunAt = null;
    }
    this._arm(r);
    this.save();
    return r;
  }

  remove(id) {
    this.items = this.items.filter((r) => r.id !== id);
    this.save();
  }
  setEnabled(id, on) {
    return this.update(id, { enabled: !!on });
  }
  clearHistory() {
    this.history = [];
    this.save();
  }
  removeForWorkspace(wsId) {
    this.items = this.items.filter((r) => r.workspaceId !== wsId);
    this.save();
  }

  _arm(r) {
    const n = r.enabled ? nextRun(r, Date.now()) : null;
    r.nextRunAt = n ? new Date(n).toISOString() : null;
    if (r.enabled && !n && r.schedule.kind === 'once') r.enabled = false;
  }

  _finish(r, outcome, detail) {
    this.history.push({
      id: persistence.uuid(),
      routineId: r.id,
      routineName: r.name,
      workspaceId: r.workspaceId,
      at: persistence.now(),
      outcome,
      detail: detail || '',
    });
    if (this.history.length > HISTORY_MAX * 2) this.history = this.history.slice(-HISTORY_MAX);
  }

  async runNow(id, { manual = true } = {}) {
    const r = this.items.find((x) => x.id === id);
    if (!r) throw new Error('routine not found');
    let outcome = 'sentToTerminal';
    let detail = '';
    if (!r.terminalId) {
      outcome = 'reminder';
      detail = r.command || r.name;
      this.emit('notify', { title: r.name, body: r.command || r.name });
    } else {
      const wsId = this.workspaces.workspaceOfNode(r.terminalId);
      const doc = wsId && this.workspaces.getDoc(wsId);
      const node = doc && this.workspaces.terminalNode(doc, r.terminalId);
      if (!node) {
        outcome = 'terminalNotRunning';
        detail = 'terminal no longer exists';
      } else {
        let s = this.terminals.get(node.id);
        if (!s || !s.alive) {
          s = this.terminals.ensure(node, wsId, this.prefs());
          await new Promise((res) => setTimeout(res, 1800));
        }
        if (!s.alive) {
          outcome = 'terminalNotRunning';
          detail = 'terminal is not running';
        } else if (s.status === 'running' && !manual) {
          outcome = 'skippedWhileBusy';
          detail = 'terminal was busy';
        } else {
          s.markActiveTask();
          const text = r.command.replace(/[\r\n]+$/, '');
          if (/\n/.test(text)) {
            s.write(`\x1b[200~${text}\x1b[201~`);
            await new Promise((res) => setTimeout(res, 150));
            s.write('\r');
          } else s.write(text + '\r');
        }
      }
    }
    if (outcome === 'sentToTerminal' || outcome === 'reminder') {
      r.runCount += 1;
      r.lastRunAt = persistence.now();
    }
    // end-repeat rules
    const e = r.endRepeat || { kind: 'never' };
    if (r.schedule.kind === 'once' && (outcome === 'sentToTerminal' || outcome === 'reminder')) r.enabled = false;
    if (e.kind === 'afterCount' && r.runCount >= e.count) r.enabled = false;
    if (e.kind === 'onDate' && Date.now() >= Date.parse(e.date)) r.enabled = false;
    if (!manual && (outcome === 'skippedWhileBusy' || outcome === 'terminalNotRunning'))
      r.lastRunAt = persistence.now(); // retry on the next slot
    this._arm(r);
    this._finish(r, manual ? `${outcome}` : outcome, detail);
    this.save();
    return { outcome, detail };
  }

  start() {
    // missed slots while the app was closed are skipped, not replayed
    for (const r of this.items) {
      if (!r.enabled) continue;
      if (r.nextRunAt && Date.parse(r.nextRunAt) < Date.now() - 60000) {
        if (r.schedule.kind !== 'once') this._finish(r, 'missedWhileClosed', '');
        r.lastRunAt = r.schedule.kind === 'interval' ? persistence.now() : r.lastRunAt;
        this._arm(r);
      }
    }
    this.save();
    this.timer = setInterval(() => this.tick(), 10000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const now = Date.now();
    for (const r of [...this.items]) {
      if (r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= now) {
        try {
          await this.runNow(r.id, { manual: false });
        } catch (err) {
          console.error('routine failed', r.name, err);
        }
      }
    }
  }
}

module.exports = {
  Routines,
  parseDuration,
  parseTime,
  parseWeekly,
  parseDateTime,
  nextRun,
  validateSchedule,
  describeSchedule,
};
