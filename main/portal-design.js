'use strict';
// Portal design mode, main-process half: turn the element/region the user picked on a page (plus an instruction and
// a screenshot) into a prompt for the agents connected to that portal.
const fs = require('fs');
const path = require('path');

const clip = (s, n) => {
  s = String(s == null ? '' : s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function connectedTerminalIds(doc, portalId) {
  const out = [];
  for (const c of doc.payload.portalConnections || [])
    if (c.portalNodeId === portalId && !out.includes(c.terminalId)) out.push(c.terminalId);
  return out;
}

const rectText = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}` : '');

function buildPrompt({ url, title, element, others = [], instruction, screenshot }) {
  const L = [];
  L.push('[Portal design]');
  L.push(`Page: ${title ? `${clip(title, 120)} — ` : ''}${clip(url, 300)}`);
  if (element) {
    L.push(`Selected element: ${clip(element.selector, 300)}  (${rectText(element.rect)})`);
    if (element.text) L.push(`Text: ${clip(element.text.replace(/\s+/g, ' '), 200)}`);
    if (element.styles)
      L.push(
        `Styles: ${Object.entries(element.styles)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${clip(v, 60)}`)
          .join('; ')}`,
      );
    if (element.html) L.push(`HTML: ${clip(element.html.replace(/\s+/g, ' '), 900)}`);
  }
  if (others.length)
    L.push(
      `Nearby candidates: ${others
        .slice(0, 5)
        .map((o) => clip(o.selector, 120))
        .join(' | ')}`,
    );
  if (screenshot) L.push(`Screenshot: ${screenshot}`);
  L.push(`Request: ${instruction && instruction.trim() ? instruction.trim() : '(look at the selected element)'}`);
  return L.join('\n');
}

function saveScreenshot(dir, pngBase64) {
  if (!pngBase64) return null;
  const data = Buffer.from(String(pngBase64).replace(/^data:image\/png;base64,/, ''), 'base64');
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return null; // not a PNG
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `portal-design-${Date.now()}.png`);
  fs.writeFileSync(file, data);
  return file;
}

// payload: { url, title, element, others, instruction, png }   opts: { copyOnly }
async function send({ doc, portalId, payload, deliver, screenshotsDir, copyOnly = false }) {
  const shot = saveScreenshot(screenshotsDir, payload.png);
  const prompt = buildPrompt({ ...payload, screenshot: shot });
  if (copyOnly) return { ok: true, prompt, screenshot: shot, sentTo: 0 };
  const targets = connectedTerminalIds(doc, portalId);
  let sent = 0;
  for (const tid of targets) {
    const r = await deliver(tid, prompt);
    if (r && r.ok) sent++;
  }
  return { ok: sent > 0, prompt, screenshot: shot, sentTo: sent, connected: targets.length };
}

module.exports = { connectedTerminalIds, buildPrompt, saveScreenshot, send };
