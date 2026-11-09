// Renders build/icon.svg into build/icon.png (512) and build/icon.ico (16..256, PNG-compressed).
// Run with Electron so no extra image library is needed:  npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'build');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 520,
    height: 520,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const render = async (size) => {
    const html = `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.setContentSize(size, size);
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
  };
  const png512 = await render(512);
  fs.writeFileSync(path.join(root, 'icon.png'), png512);
  const pngs = [];
  for (const s of SIZES) pngs.push({ s, data: await render(s) });

  // ICO container with PNG payloads (supported since Windows Vista)
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const dir = Buffer.alloc(16 * pngs.length);
  pngs.forEach((p, i) => {
    dir.writeUInt8(p.s >= 256 ? 0 : p.s, i * 16);
    dir.writeUInt8(p.s >= 256 ? 0 : p.s, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(p.data.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    offset += p.data.length;
  });
  fs.writeFileSync(path.join(root, 'icon.ico'), Buffer.concat([head, dir, ...pngs.map((p) => p.data)]));
  console.log('icon.png', png512.length, 'bytes; icon.ico sizes', SIZES.join(','));
  app.quit();
});
