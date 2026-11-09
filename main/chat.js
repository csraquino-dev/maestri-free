'use strict';
// Chat mode: talk to the agent in a terminal as a conversation instead of typing into its TUI.
// - The user's messages are delivered to the terminal under a short "Maestri Chat" header naming the thread.
// - The agent answers with `omaestri say` (bubbles; --progress for interim updates; --file / --attach for files).
// - Seven threads per terminal, named by colour; `omaestri recall` replays history after a restart or compaction.
// Stored per terminal in <workspace>/chat/<terminalId>.json.
const fs = require('fs');
const path = require('path');
const { uuid } = require('./persistence');

const THREADS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green'];
const MAX_PER_THREAD = 2000;
const MAX_TEXT = 100000;
const MAX_FILE = 25 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic']);
const DAY = 86400000;

const HEADER = (thread) => `---
Below is a message from the user through Maestri Chat.
Reply only via \`omaestri say\`. If the open-maestri-chat skill isn't already loaded, load it first.
thread: ${thread}
---`;

function emptyState() {
  return {
    lastThread: 'blue',
    pending: null,
    seen: {},
    threads: Object.fromEntries(THREADS.map((t) => [t, []])),
    attachments: {},
  };
}

function createChat({ dirOf, deliver, events }) {
  const cache = new Map();
  const fileOf = (wsId, tid) => path.join(dirOf(wsId), 'chat', `${tid}.json`);

  function load(wsId, tid) {
    const key = `${wsId}/${tid}`;
    if (cache.has(key)) return cache.get(key);
    let st = emptyState();
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(wsId, tid), 'utf8'));
      st = { ...st, ...raw, threads: { ...st.threads, ...(raw.threads || {}) } };
    } catch {
      /* first use */
    }
    cache.set(key, st);
    return st;
  }
  function save(wsId, tid) {
    const st = load(wsId, tid);
    const f = fileOf(wsId, tid);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(st));
    } catch {
      /* read-only home: the in-memory chat still works */
    }
  }
  const checkThread = (t) => {
    if (!THREADS.includes(t)) throw new Error(`unknown thread '${t}'. Threads: ${THREADS.join(', ')}`);
    return t;
  };
  const unreadOf = (st, thread) =>
    st.threads[thread].slice(st.seen[thread] || 0).filter((m) => m.role === 'agent' && m.kind !== 'progress').length;
  const summary = (st) => ({
    lastThread: st.lastThread,
    pending: st.pending,
    unread: Object.fromEntries(THREADS.map((t) => [t, unreadOf(st, t)])),
    counts: Object.fromEntries(THREADS.map((t) => [t, st.threads[t].length])),
  });

  function push(wsId, tid, thread, msg) {
    const st = load(wsId, tid);
    const list = st.threads[thread];
    list.push(msg);
    if (list.length > MAX_PER_THREAD) {
      const cut = list.length - MAX_PER_THREAD;
      list.splice(0, cut);
      st.seen[thread] = Math.max(0, (st.seen[thread] || 0) - cut);
    }
    save(wsId, tid);
    events && events.emit('chatMessage', wsId, tid, thread, msg, summary(st));
    return msg;
  }

  function addAttachment(st, file) {
    const abs = path.resolve(file);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`not a file: ${file}`);
    if (stat.size > MAX_FILE) throw new Error(`file too large (max 25 MB): ${file}`);
    const ext = path.extname(abs).toLowerCase();
    const id = `att-${uuid().slice(0, 8)}`;
    st.attachments[id] = { id, name: path.basename(abs), path: abs, size: stat.size, image: IMAGE_EXT.has(ext) };
    return st.attachments[id];
  }

  // ---- user side
  async function send(wsId, tid, thread, text, files = []) {
    checkThread(thread);
    text = String(text || '').trim();
    if (!text && !files.length) return { ok: false, reason: 'empty' };
    if (text.length > MAX_TEXT) return { ok: false, reason: 'tooLong' };
    const st = load(wsId, tid);
    const atts = files.map((f) => addAttachment(st, f));
    const body = [text, ...atts.map((a) => `Attachment: ${a.path}`)].filter(Boolean).join('\n');
    const r = await deliver(tid, `${HEADER(thread)}\n${body}`);
    if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'notRunning' };
    st.lastThread = thread;
    st.pending = thread;
    st.seen[thread] = st.threads[thread].length + 1;
    const msg = push(wsId, tid, thread, {
      id: uuid(),
      role: 'user',
      kind: 'message',
      text,
      attachments: atts,
      at: new Date().toISOString(),
    });
    return { ok: true, message: msg };
  }

  // ---- agent side (omaestri say)
  function say(wsId, tid, { text = '', progress = false, file = null, attach = [] } = {}) {
    const st = load(wsId, tid);
    const thread = st.lastThread;
    const atts = [];
    if (file) {
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${file}`);
      if (IMAGE_EXT.has(path.extname(abs).toLowerCase())) atts.push(addAttachment(st, abs));
      else {
        if (fs.statSync(abs).size > MAX_FILE) throw new Error('file too large (max 25 MB)');
        text = [text, fs.readFileSync(abs, 'utf8')].filter(Boolean).join('\n');
      }
    }
    for (const f of attach) {
      if (!fs.existsSync(path.resolve(f))) throw new Error(`file not found: ${f}`);
      atts.push(addAttachment(st, f));
    }
    text = String(text).trim();
    if (!text && !atts.length) throw new Error('nothing to say');
    if (text.length > MAX_TEXT) throw new Error('message too long');
    if (!progress) st.pending = null;
    const msg = push(wsId, tid, thread, {
      id: uuid(),
      role: 'agent',
      kind: progress ? 'progress' : 'message',
      text,
      attachments: atts,
      at: new Date().toISOString(),
    });
    return { thread, message: msg };
  }

  function read(wsId, tid) {
    const st = load(wsId, tid);
    return { ...summary(st), threads: st.threads };
  }

  function markRead(wsId, tid, thread) {
    checkThread(thread);
    const st = load(wsId, tid);
    st.seen[thread] = st.threads[thread].length;
    save(wsId, tid);
    return summary(st);
  }

  function clear(wsId, tid, thread) {
    checkThread(thread);
    const st = load(wsId, tid);
    st.threads[thread] = [];
    st.seen[thread] = 0;
    if (st.pending === thread) st.pending = null;
    save(wsId, tid);
    events && events.emit('chatMessage', wsId, tid, thread, null, summary(st));
    return summary(st);
  }

  // ---- recall
  const stamp = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const dayStart = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };

  function recall(wsId, tid, thread, opts = {}) {
    const st = load(wsId, tid);
    thread = checkThread(thread || st.lastThread);
    let msgs = st.threads[thread].filter((m) => m.kind !== 'progress');
    if (opts.from || opts.to || opts.last) {
      let from = -Infinity,
        to = Infinity;
      if (opts.last) from = Date.now() - ({ day: DAY, week: 7 * DAY, month: 30 * DAY }[opts.last] || 0);
      if (opts.from) from = dayStart(opts.from);
      if (opts.to) to = dayStart(opts.to) + DAY;
      msgs = msgs.filter((m) => {
        const t = Date.parse(m.at);
        return t >= from && t < to;
      });
    } else if (!opts.all) {
      // a "turn" is a user message and everything the agent answered to it
      const turns = [];
      for (const m of msgs) {
        if (m.role === 'user' || !turns.length) turns.push([m]);
        else turns[turns.length - 1].push(m);
      }
      const n = opts.turns === undefined ? 10 : opts.turns;
      if (!(n >= 1 && n <= 500)) throw new Error('--turns must be between 1 and 500');
      msgs = turns.slice(-n).flat();
    }
    if (opts.json)
      return JSON.stringify(
        { thread, messages: msgs.map((m) => ({ ...m, attachments: m.attachments.map((a) => a.id) })) },
        null,
        1,
      );
    if (!msgs.length) return `(no messages in thread ${thread})`;
    return [
      `thread: ${thread}`,
      ...msgs.map(
        (m) =>
          `[${stamp(m.at)}] ${m.role === 'user' ? 'User' : 'Agent'}: ${m.text}${m.attachments.length ? `  (attachments: ${m.attachments.map((a) => `${a.id}=${a.name}`).join(', ')})` : ''}`,
      ),
    ].join('\n');
  }

  function list(wsId, tid) {
    const st = load(wsId, tid);
    return THREADS.map((t) => {
      const l = st.threads[t];
      return `${t}${t === st.lastThread ? ' *' : ''}  ${l.length} message(s)${l.length ? `  last ${stamp(l[l.length - 1].at)}` : ''}`;
    }).join('\n');
  }

  function attachmentPath(wsId, tid, id) {
    const a = load(wsId, tid).attachments[id];
    return a && fs.existsSync(a.path) ? a.path : null;
  }

  // ---- search the whole conversation
  function search(wsId, tid, query, thread) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return [];
    const st = load(wsId, tid);
    const out = [];
    for (const t of thread ? [checkThread(thread)] : THREADS)
      st.threads[t].forEach((m, i) => {
        if (m.kind !== 'progress' && m.text.toLowerCase().includes(q))
          out.push({ thread: t, index: i, id: m.id, role: m.role, text: m.text, at: m.at });
      });
    return out.slice(-200);
  }

  return { THREADS, send, say, read, markRead, clear, recall, list, attachmentPath, search, HEADER };
}

module.exports = { createChat, THREADS };
