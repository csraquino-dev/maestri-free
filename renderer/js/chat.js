// Chat mode for a terminal node: a conversation with the agent running in it, in seven colour-named threads.
// Messages go to the terminal under a "Maestri Chat" header; the agent answers with `omaestri say` (see main/chat.js).
import { el, toast } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api } from './store.js';

export const THREADS = [
  ['blue', '#0a84ff'],
  ['purple', '#bf5af2'],
  ['pink', '#ff375f'],
  ['red', '#ff453a'],
  ['orange', '#ff9f0a'],
  ['yellow', '#ffd60a'],
  ['green', '#30d158'],
];
const THREAD_NAME = {
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
};
export const threadLabel = (id) => t(THREAD_NAME[id]);

const timeOf = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function renderMarkdown(text, into) {
  into.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
  into.querySelectorAll('a[href]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal(a.href);
    }),
  );
}

// opts: { node, name: () => string, onUnread: (n) => void }
export function createChatView({ node, name, onUnread = () => {} }) {
  let state = {
    threads: Object.fromEntries(THREADS.map(([id]) => [id, []])),
    pending: null,
    unread: {},
    lastThread: 'blue',
  };
  let thread = 'blue';
  let files = [];
  let off = null;
  const imgCache = new Map();

  const dots = el('div', { class: 'chat-threads' });
  const searchBox = el('input', {
    class: 'chat-search',
    type: 'search',
    placeholder: t('Search this conversation…'),
    spellcheck: false,
  });
  const results = el('div', { class: 'chat-results', hidden: true });
  const clearBtn = el('button', { class: 'btn', type: 'button', title: t('Clear this thread') }, icon('trash-2', 14));
  const head = el('div', { class: 'chat-head' }, dots, el('span', { class: 'grow' }), searchBox, clearBtn);
  const list = el('div', { class: 'chat-msgs' });
  const typing = el(
    'div',
    { class: 'chat-typing', hidden: true },
    el('span', { class: 'dots' }, el('i'), el('i'), el('i')),
    el('span', {}, t('The agent is working…')),
  );
  const chips = el('div', { class: 'chat-files' });
  const input = el('textarea', {
    class: 'chat-input',
    rows: 1,
    placeholder: t('Message the agent…'),
    spellcheck: false,
  });
  const attachBtn = el('button', { class: 'btn', type: 'button', title: t('Attach a file') }, icon('paperclip', 15));
  const sendBtn = el('button', { class: 'chat-send', type: 'button', title: t('Send (Enter)') }, icon('arrow-up', 16));
  const composer = el('div', { class: 'chat-composer' }, attachBtn, input, sendBtn);
  const root = el('div', { class: 'chat', hidden: true }, head, results, list, typing, chips, composer);

  const colorOf = (id) => THREADS.find(([x]) => x === id)[1];

  function paintDots() {
    dots.replaceChildren(
      ...THREADS.map(([id, color]) => {
        const n = state.unread[id] || 0;
        const b = el(
          'button',
          {
            class: `thread-dot${id === thread ? ' on' : ''}`,
            type: 'button',
            title: `${threadLabel(id)}${n ? ` · ${n}` : ''}`,
            style: { '--c': color },
            onclick: () => setThread(id),
          },
          n && id !== thread ? el('b', {}, String(n)) : null,
        );
        return b;
      }),
    );
    onUnread(
      THREADS.reduce((sum, [id]) => sum + (id === thread && root.hidden === false ? 0 : state.unread[id] || 0), 0),
    );
  }

  function attachmentEl(a) {
    if (a.image) {
      const img = el('img', { class: 'chat-img', alt: a.name });
      const hold = imgCache.get(a.id);
      if (hold) img.src = hold;
      else
        api.chatAttachment(S.wsId, node.id, a.id).then((r) => {
          if (r && r.dataUrl) {
            imgCache.set(a.id, r.dataUrl);
            img.src = r.dataUrl;
          }
        });
      img.addEventListener('click', () =>
        api.chatAttachment(S.wsId, node.id, a.id).then((r) => r && api.openPath(r.path)),
      );
      return img;
    }
    return el(
      'button',
      {
        class: 'chat-file',
        type: 'button',
        title: a.name,
        onclick: () => api.chatAttachment(S.wsId, node.id, a.id).then((r) => r && api.openPath(r.path)),
      },
      icon('file', 14),
      a.name,
    );
  }

  function bubble(m) {
    const b = el('div', {
      class: `bubble ${m.role}${m.kind === 'progress' ? ' progress' : ''}`,
      dataset: { id: m.id },
    });
    if (m.text) {
      const body = el('div', { class: 'bubble-text' });
      renderMarkdown(m.text, body);
      b.append(body);
    }
    for (const a of m.attachments || []) b.append(attachmentEl(a));
    b.append(el('span', { class: 'bubble-time' }, timeOf(m.at)));
    return b;
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  function paint(scroll = true) {
    list.replaceChildren(
      ...(state.threads[thread].length
        ? state.threads[thread].map(bubble)
        : [
            el(
              'p',
              { class: 'empty chat-empty' },
              icon('message-circle', 24),
              t('No messages yet. Write to {name} below.', { name: name() }),
            ),
          ]),
    );
    typing.hidden = state.pending !== thread;
    root.style.setProperty('--c', colorOf(thread));
    if (scroll) list.scrollTop = list.scrollHeight;
  }

  async function setThread(id) {
    thread = id;
    const s = await api.chatMarkRead(S.wsId, node.id, id);
    state = { ...state, ...s, threads: state.threads };
    paintDots();
    paint();
  }

  async function load() {
    state = await api.chatRead(S.wsId, node.id);
    thread = state.pending || state.lastThread || thread;
    paintDots();
    paint();
  }

  function paintFiles() {
    chips.replaceChildren(
      ...files.map((f, i) =>
        el(
          'span',
          { class: 'chat-chip' },
          icon('paperclip', 12),
          f.split(/[\\/]/).pop(),
          el(
            'button',
            {
              type: 'button',
              onclick: () => {
                files.splice(i, 1);
                paintFiles();
              },
            },
            icon('x', 12),
          ),
        ),
      ),
    );
  }

  async function send() {
    const text = input.value.trim();
    if (!text && !files.length) return;
    sendBtn.disabled = true;
    try {
      const r = await api.chatSend(S.wsId, node.id, thread, text, files);
      if (!r.ok) {
        toast(
          r.reason === 'notRunning'
            ? t('The terminal is not running. Restart it to chat.')
            : r.error || t('Could not send.'),
          4500,
        );
        return;
      }
      input.value = '';
      files = [];
      paintFiles();
      autosize();
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  attachBtn.addEventListener('click', async () => {
    const f = await api.pickFile();
    if (f) {
      files.push(f);
      paintFiles();
    }
  });
  clearBtn.addEventListener('click', async () => {
    if (!confirm(t('Clear the {thread} thread? This cannot be undone.', { thread: threadLabel(thread) }))) return;
    state = {
      ...state,
      ...(await api.chatClear(S.wsId, node.id, thread)),
      threads: { ...state.threads, [thread]: [] },
    };
    paintDots();
    paint();
  });

  let searchSeq = 0;
  searchBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      searchBox.value = '';
      results.hidden = true;
    }
  });
  searchBox.addEventListener('input', async () => {
    const seq = ++searchSeq;
    const q = searchBox.value.trim();
    if (!q) {
      results.hidden = true;
      return;
    }
    const hits = await api.chatSearch(S.wsId, node.id, q);
    if (seq !== searchSeq) return;
    results.replaceChildren(
      ...(hits.length
        ? hits
            .slice(-8)
            .reverse()
            .map((h) =>
              el(
                'button',
                {
                  class: 'chat-hit',
                  type: 'button',
                  onclick: async () => {
                    results.hidden = true;
                    await setThread(h.thread);
                    const target = list.querySelector(`[data-id="${h.id}"]`);
                    if (target) {
                      target.scrollIntoView({ block: 'center' });
                      target.classList.add('flash');
                      setTimeout(() => target.classList.remove('flash'), 1400);
                    }
                  },
                },
                el('i', { class: 'dot', style: { background: colorOf(h.thread) } }),
                el('span', {}, h.text.replace(/\s+/g, ' ').slice(0, 90)),
              ),
            )
        : [el('p', { class: 'empty' }, t('Nothing found.'))]),
    );
    results.hidden = false;
  });

  function onMessage(wsId, tid, th, msg, summary) {
    if (tid !== node.id || wsId !== S.wsId) return;
    if (msg === null) {
      state.threads[th] = [];
    } else {
      const stick = th === thread && nearBottom();
      state.threads[th] = [...state.threads[th], msg];
      if (th === thread && !root.hidden) {
        list.querySelector('.chat-empty')?.remove();
        list.append(bubble(msg));
        if (stick || msg.role === 'user') list.scrollTop = list.scrollHeight;
      }
    }
    state = { ...state, ...summary, threads: state.threads };
    if (th === thread && !root.hidden && msg && msg.role === 'agent')
      api.chatMarkRead(S.wsId, node.id, th).then((s) => {
        state = { ...state, ...s, threads: state.threads };
        paintDots();
      });
    typing.hidden = state.pending !== thread;
    if (msg && msg.role === 'user' && th !== thread && !root.hidden) setThread(th);
    paintDots();
  }

  return {
    el: root,
    async show() {
      root.hidden = false;
      await load();
      await api.chatMarkRead(S.wsId, node.id, thread).then((s) => {
        state = { ...state, ...s, threads: state.threads };
        paintDots();
      });
      input.focus();
    },
    hide() {
      root.hidden = true;
      paintDots();
    },
    isOpen: () => !root.hidden,
    focus() {
      input.focus();
    },
    subscribe() {
      if (!off) off = api.on.chatMessage(onMessage);
      api.chatRead(S.wsId, node.id).then((s) => {
        state = { ...state, ...s, threads: s.threads };
        paintDots();
      });
    },
    destroy() {
      off && off();
      off = null;
    },
  };
}
