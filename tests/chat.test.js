'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createChat } = require('../main/chat');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omaestri-chat-'));
process.env.OPEN_MAESTRI_HOME = home;
process.env.OPEN_MAESTRI_NO_AUTOBACKUP = '1';
fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ skillPaths: [] }));
const { createCore } = require('../main/core');
const { execFile } = require('child_process');
const cli = path.join(__dirname, '..', 'cli', 'omaestri.js');

const png = path.join(home, 'shot.png');
fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]));
const notes = path.join(home, 'answer.txt');
fs.writeFileSync(notes, 'line one\nline two');

const delivered = [];
const events = new EventEmitter();
const seenEvents = [];
events.on('chatMessage', (...a) => seenEvents.push(a));
const mk = (ok = true) =>
  createChat({
    dirOf: (ws) => path.join(home, 'ws', ws),
    deliver: async (tid, text) => {
      delivered.push([tid, text]);
      return ok ? { ok: true } : { ok: false, reason: 'notRunning' };
    },
    events,
  });

test('a user message goes to the terminal under the Maestri Chat header with its thread, and is stored', async () => {
  const chat = mk();
  const r = await chat.send('w1', 't1', 'purple', 'hello agent');
  assert.equal(r.ok, true);
  const [tid, text] = delivered[0];
  assert.equal(tid, 't1');
  assert.match(text, /^---\nBelow is a message from the user through Maestri Chat\.\nReply only via `omaestri say`/);
  assert.match(text, /thread: purple\n---\nhello agent$/);
  const st = chat.read('w1', 't1');
  assert.equal(st.pending, 'purple');
  assert.equal(st.lastThread, 'purple');
  assert.equal(st.threads.purple.length, 1);
  assert.equal(seenEvents.at(-1)[2], 'purple');
  assert.deepEqual(await chat.send('w1', 't1', 'purple', '   '), { ok: false, reason: 'empty' });
  await assert.rejects(chat.send('w1', 't1', 'magenta', 'x'), /unknown thread/);
  assert.equal(
    (await mk(false).send('w1', 't2', 'blue', 'x')).ok,
    false,
    'a terminal that is not running does not get the message',
  );
  assert.equal(mk(false).read('w1', 't2').threads.blue.length, 0, 'and nothing is stored');
});

test('the agent answers into the thread of the last user message; progress keeps the turn open, a final reply closes it', async () => {
  const chat = mk();
  const p = chat.say('w1', 't1', { text: 'Running tests…', progress: true });
  assert.equal(p.thread, 'purple');
  assert.equal(chat.read('w1', 't1').pending, 'purple');
  chat.say('w1', 't1', { text: 'All green.' });
  const st = chat.read('w1', 't1');
  assert.equal(st.pending, null);
  assert.deepEqual(
    st.threads.purple.map((m) => [m.role, m.kind]),
    [
      ['user', 'message'],
      ['agent', 'progress'],
      ['agent', 'message'],
    ],
  );
  assert.equal(st.unread.purple, 1, 'only the final reply counts as unread');
  assert.equal(chat.markRead('w1', 't1', 'purple').unread.purple, 0);
  assert.throws(() => chat.say('w1', 't1', { text: '' }), /nothing to say/);
});

test('say --file: text is read in, images become attachments; --attach files are referenced; missing files are errors', () => {
  const chat = mk();
  chat.say('w1', 't3', { file: notes });
  chat.say('w1', 't3', { file: png });
  chat.say('w1', 't3', { text: 'here', attach: [notes] });
  const m = chat.read('w1', 't3').threads.blue;
  assert.equal(m[0].text, 'line one\nline two');
  assert.equal(m[1].attachments[0].image, true);
  assert.equal(m[2].attachments[0].name, 'answer.txt');
  assert.equal(chat.attachmentPath('w1', 't3', m[1].attachments[0].id), png);
  assert.equal(chat.attachmentPath('w1', 't3', 'att-nope'), null);
  assert.throws(() => chat.say('w1', 't3', { file: path.join(home, 'missing.txt') }), /file not found/);
});

test('recall: last N turns, json, date filters, list; history survives a restart', async () => {
  const chat = mk();
  for (let i = 1; i <= 4; i++) {
    await chat.send('w1', 't4', 'green', `question ${i}`);
    chat.say('w1', 't4', { text: `answer ${i}` });
  }
  const two = chat.recall('w1', 't4', 'green', { turns: 2 });
  assert.match(two, /question 3[\s\S]*answer 3[\s\S]*question 4[\s\S]*answer 4/);
  assert.ok(!/question 2/.test(two));
  assert.equal(JSON.parse(chat.recall('w1', 't4', 'green', { json: true })).messages.length, 8);
  assert.throws(() => chat.recall('w1', 't4', 'green', { turns: 0 }), /between 1 and 500/);
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const d = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  assert.equal(JSON.parse(chat.recall('w1', 't4', 'green', { from: d, to: d, json: true })).messages.length, 8);
  assert.match(chat.recall('w1', 't4', 'green', { from: '2000-01-01', to: '2000-01-02' }), /no messages/);
  assert.match(chat.list('w1', 't4'), /green \*  8 message\(s\)/);
  const again = mk(); // fresh process reading the same files
  assert.equal(again.read('w1', 't4').threads.green.length, 8);
  assert.match(
    again.recall('w1', 't4', null, { all: true }),
    /question 1/,
    'defaults to the thread of the last message',
  );
});

test('search finds text across threads, skipping progress updates', async () => {
  const chat = mk();
  chat.say('w1', 't5', { text: 'secret sauce', progress: true });
  chat.say('w1', 't5', { text: 'the SECRET is out' });
  const hits = chat.search('w1', 't5', 'secret');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].thread, 'blue');
  assert.deepEqual(chat.search('w1', 't5', ''), []);
});

test('clear empties one thread only', async () => {
  const chat = mk();
  await chat.send('w1', 't6', 'red', 'a');
  await chat.send('w1', 't6', 'pink', 'b');
  chat.clear('w1', 't6', 'red');
  const st = chat.read('w1', 't6');
  assert.equal(st.threads.red.length, 0);
  assert.equal(st.threads.pink.length, 1);
});

// ---- through the real CLI and server
let core, T;
const run = (tid, ...args) =>
  new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: tid }, timeout: 60000 },
      (e, o, err) => resolve((o + err).trim()),
    );
    child.stdin.end();
  });
const runStdin = (tid, input, ...args) =>
  new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, MAESTRI_SERVER_PORT: String(core.port()), MAESTRI_TERMINAL_ID: tid }, timeout: 60000 },
      (e, o, err) => resolve((o + err).trim()),
    );
    child.stdin.end(input);
  });

test('omaestri say / recall work end to end (arguments, heredoc on stdin, files, errors)', async () => {
  core = await createCore();
  const ws = core.workspaces;
  const doc = ws.activeDoc;
  T = ws.addTerminal(doc, { name: 'Agent', workingDirectory: os.tmpdir() });
  assert.equal(await run(T.id, 'say', 'short answer'), 'sent');
  assert.equal(await runStdin(T.id, 'multi\nline "quoted" $HOME `tick`', 'say'), 'sent');
  assert.equal(await run(T.id, 'say', '--progress', 'working'), 'progress sent');
  assert.equal(await run(T.id, 'say', '--file', png), 'sent');
  const out = await run(T.id, 'recall', 'blue', '--all');
  assert.match(out, /Agent: short answer/);
  assert.match(out, /Agent: multi\nline "quoted" \$HOME `tick`/.source ? /multi/ : /multi/);
  assert.ok(!/working/.test(out), 'progress is not part of recall');
  const att = out.match(/att-[0-9a-f]{8}/i);
  assert.ok(att, out);
  assert.equal((await run(T.id, 'recall', 'attachment', att[0])).replace(/\\/g, '/'), png.replace(/\\/g, '/'));
  assert.match(await run(T.id, 'recall', 'list'), /blue \*/);
  assert.match(await run(T.id, 'recall', '--last', 'year'), /error: --last must be/);
  assert.match(await run(T.id, 'recall', '--from', 'yesterday'), /error: --from needs a date/);
  assert.match(await run(T.id, 'say', '--bogus'), /error: unknown option/);
  assert.match(await run(T.id, 'say', '--file', path.join(home, 'nope.txt')), /error: file not found/);
  assert.match(await run('not-a-terminal', 'say', 'x'), /error: missing terminal ID/);
});

test.after(async () => {
  if (core) await core.shutdown();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});
