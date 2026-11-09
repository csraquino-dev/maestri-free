// Lists every translatable key used by the renderer and reports the ones missing in pt-br.js.
// Usage: node scripts/check-i18n.js [--list]
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer');
const files = [
  path.join(dir, 'index.html'),
  ...fs
    .readdirSync(path.join(dir, 'js'))
    .filter((f) => f.endsWith('.js') && !['pt-br.js', 'icons.js'].includes(f))
    .map((f) => path.join(dir, 'js', f)),
];
const keys = new Set();
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n');

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]));
  for (const m of src.matchAll(/data-i18n(?:-title|-ph)?="([^"]+)"/g)) keys.add(m[1]);
}
// dynamic keys passed through t(variable)
const extra = [
  'blue',
  'red',
  'green',
  'orange',
  'purple',
  'pink',
  'cyan',
  'yellow',
  'gray',
  'black',
  'white',
  'rainbow',
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sent to terminal',
  'Terminal not running',
  'Reminder shown',
  'Skipped (terminal busy)',
  'Skipped by script',
  'Missed (app was closed)',
  'terminal',
  'note',
  'portal',
  'fileTree',
  'text',
  'shape',
  'stroke',
  'freehand',
  'unknown',
  'Select',
  'Add terminal / agent',
  'Add note',
  'Attach a file as a note',
  'Add file tree',
  'Add portal (browser)',
  'Add text',
  'Shapes and lines',
];
extra.forEach((k) => keys.add(k));

const { PT } = (() => {
  const src =
    fs.readFileSync(path.join(dir, 'js', 'pt-br.js'), 'utf8').replace('export const PT', 'const PT') +
    '\nmodule.exports={PT};';
  const m = { exports: {} };
  new Function('module', src)(m);
  return m.exports;
})();

if (process.argv.includes('--list')) {
  console.log([...keys].sort().join('\n'));
  process.exit(0);
}
const missing = [...keys].filter((k) => !(k in PT)).sort();
const unused = Object.keys(PT).filter((k) => !keys.has(k));
console.log(
  `keys: ${keys.size}, translated: ${keys.size - missing.length}, missing: ${missing.length}, unused entries: ${unused.length}`,
);
if (missing.length) console.log('MISSING:\n' + missing.map((k) => '  ' + JSON.stringify(k)).join('\n'));
if (unused.length && process.argv.includes('--unused'))
  console.log('UNUSED:\n' + unused.map((k) => '  ' + JSON.stringify(k)).join('\n'));
process.exit(missing.length ? 1 : 0);
