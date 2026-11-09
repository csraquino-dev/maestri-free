// Portal design mode: point at an element of the page shown in a portal (or drag a region), add an instruction, and send
// the element's details + a screenshot to the agents connected to the portal.
import { el, toast } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, api } from './store.js';

// ---- code that runs INSIDE the page (stringified into webview.executeJavaScript; each must be self-contained)
function pagePick(x, y, r) {
  const cssPath = (node) => {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + CSS.escape(cur.id);
        parts.unshift(part);
        break;
      }
      const cls = [...cur.classList]
        .slice(0, 2)
        .map((c) => '.' + CSS.escape(c))
        .join('');
      part += cls;
      const same = cur.parentElement ? [...cur.parentElement.children].filter((s) => s.tagName === cur.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const describe = (node, full) => {
    const b = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const d = {
      tag: node.tagName.toLowerCase(),
      selector: cssPath(node),
      rect: { x: b.left, y: b.top, w: b.width, h: b.height },
      text: (node.innerText || node.value || '').trim().slice(0, 200),
    };
    if (full) {
      d.html = node.outerHTML.slice(0, 1500);
      d.styles = {
        color: cs.color,
        background: cs.backgroundColor,
        font: `${cs.fontSize} ${cs.fontFamily.split(',')[0]} ${cs.fontWeight}`,
        display: cs.display,
        position: cs.position,
        margin: cs.margin,
        padding: cs.padding,
        border: cs.border,
      };
    }
    return d;
  };
  if (!r) {
    const node = document.elementFromPoint(x, y);
    return node ? { element: describe(node, true), others: [] } : null;
  }
  const area = (q) => Math.max(0, q.w) * Math.max(0, q.h);
  const scored = [];
  for (const node of document.body.querySelectorAll('*')) {
    const b = node.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    const ix = Math.max(0, Math.min(b.right, r.x + r.w) - Math.max(b.left, r.x));
    const iy = Math.max(0, Math.min(b.bottom, r.y + r.h) - Math.max(b.top, r.y));
    const inter = ix * iy;
    if (!inter) continue;
    const union = area({ w: b.width, h: b.height }) + area(r) - inter;
    scored.push({ node, iou: inter / union });
  }
  scored.sort((a, b) => b.iou - a.iou);
  if (!scored.length) return null;
  return { element: describe(scored[0].node, true), others: scored.slice(1, 6).map((s) => describe(s.node, false)) };
}

const call = (fn, ...args) =>
  `(${fn.toString()})(${args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',')})`;
export const pickScript = (x, y) => call(pagePick, x, y, null);
export const regionScript = (rect) => call(pagePick, 0, 0, rect);

// ---- overlay + panel over the webview
export function attachDesign({ body, wv, node, designBtn }) {
  let active = false;
  let picked = null; // { element, others }
  const overlay = el('div', { class: 'design-overlay', hidden: true });
  const hover = el('div', { class: 'design-box hover', hidden: true });
  const sel = el('div', { class: 'design-box sel', hidden: true });
  const hint = el(
    'div',
    { class: 'design-hint' },
    icon('scan-search', 14),
    t('Click an element, or drag to select a region.'),
  );
  overlay.append(hover, sel, hint);
  const instruction = el('textarea', {
    class: 'design-text',
    rows: 2,
    placeholder: t('What should the agent do with this? (optional)'),
    spellcheck: false,
  });
  const label = el('div', { class: 'design-sel' });
  const sendBtn = el('button', { class: 'btn-primary', type: 'button' }, icon('send', 14), t('Send to agents'));
  const copyBtn = el('button', { class: 'btn-ghost', type: 'button' }, icon('copy', 14), t('Copy prompt'));
  const cancelBtn = el('button', { class: 'btn-ghost', type: 'button' }, t('Cancel'));
  const panel = el(
    'div',
    { class: 'design-panel', hidden: true },
    label,
    instruction,
    el('div', { class: 'row' }, sendBtn, copyBtn, el('span', { class: 'grow' }), cancelBtn),
  );
  body.style.position = 'relative';
  body.append(overlay, panel);

  const place = () => {
    Object.assign(overlay.style, {
      left: `${wv.offsetLeft}px`,
      top: `${wv.offsetTop}px`,
      width: `${wv.offsetWidth}px`,
      height: `${wv.offsetHeight}px`,
    });
  };
  const box = (b, r) => {
    Object.assign(b.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    b.hidden = false;
  };
  const run = async (script) => {
    try {
      return await wv.executeJavaScript(script);
    } catch {
      return null;
    }
  };

  function setSelection(result) {
    picked = result;
    if (!result) {
      sel.hidden = true;
      panel.hidden = true;
      return;
    }
    box(sel, result.element.rect);
    label.replaceChildren(
      el('b', {}, result.element.selector),
      result.element.text ? el('span', { class: 'design-snip' }, ` — ${result.element.text.slice(0, 80)}`) : null,
    );
    panel.hidden = false;
    instruction.focus();
  }

  function toggle(on = !active) {
    active = on;
    place();
    overlay.hidden = !active;
    designBtn.classList.toggle('on', active);
    if (!active) {
      hover.hidden = true;
      setSelection(null);
    }
  }

  let last = 0,
    down = null;
  overlay.addEventListener('mousemove', async (e) => {
    e.stopPropagation();
    if (down) {
      const r = {
        x: Math.min(down.x, e.offsetX),
        y: Math.min(down.y, e.offsetY),
        w: Math.abs(e.offsetX - down.x),
        h: Math.abs(e.offsetY - down.y),
      };
      box(hover, r);
      return;
    }
    const now = performance.now();
    if (now - last < 70) return;
    last = now;
    const res = await run(pickScript(e.offsetX, e.offsetY));
    if (res && !down) box(hover, res.element.rect);
    else if (!down) hover.hidden = true;
  });
  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    down = { x: e.offsetX, y: e.offsetY };
  });
  overlay.addEventListener('mouseup', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const d = down;
    down = null;
    if (!d) return;
    const r = {
      x: Math.min(d.x, e.offsetX),
      y: Math.min(d.y, e.offsetY),
      w: Math.abs(e.offsetX - d.x),
      h: Math.abs(e.offsetY - d.y),
    };
    const res = r.w < 6 && r.h < 6 ? await run(pickScript(d.x, d.y)) : await run(regionScript(r));
    hover.hidden = true;
    if (res) setSelection(res);
    else toast(t('Nothing found there.'));
  });
  overlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  window.addEventListener(
    'keydown',
    (e) => {
      if (active && e.key === 'Escape') {
        e.stopPropagation();
        toggle(false);
      }
    },
    true,
  );
  new ResizeObserver(() => active && place()).observe(body);

  const payload = async (withShot) => {
    let png = null;
    if (withShot) {
      try {
        png = (await wv.capturePage()).toDataURL();
      } catch {
        png = null;
      }
    }
    return {
      url: wv.getURL(),
      title: wv.getTitle(),
      element: picked.element,
      others: picked.others,
      instruction: instruction.value,
      png,
    };
  };
  sendBtn.addEventListener('click', async () => {
    if (!picked) return;
    sendBtn.disabled = true;
    try {
      const r = await api.portalDesignSend(S.wsId, node.id, await payload(true), { copyOnly: false });
      if (r.ok) {
        toast(t('Sent to {n} agent(s).', { n: r.sentTo }));
        instruction.value = '';
        toggle(false);
      } else
        toast(
          r.connected ? t('The connected terminal is not running.') : t('Connect a terminal to this portal first.'),
          4500,
        );
    } finally {
      sendBtn.disabled = false;
    }
  });
  copyBtn.addEventListener('click', async () => {
    if (!picked) return;
    const r = await api.portalDesignSend(S.wsId, node.id, await payload(true), { copyOnly: true });
    try {
      await navigator.clipboard.writeText(r.prompt);
      toast(t('Prompt copied.'));
    } catch {
      toast(t('Could not copy.'));
    }
  });
  cancelBtn.addEventListener('click', () => setSelection(null));
  return { toggle, isActive: () => active };
}
