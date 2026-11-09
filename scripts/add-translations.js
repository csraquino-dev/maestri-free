// Merge new translations into renderer/js/pt-br.js.  Usage: node scripts/add-translations.js <file.json> "<section title>"
// <file.json> is a flat { "English source": "Português" } object. Existing keys are never overwritten.
const fs = require('fs');
const path = require('path');

const [jsonFile, title = 'novos textos'] = process.argv.slice(2);
const add = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const target = path.join(__dirname, '..', 'renderer', 'js', 'pt-br.js');
let src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const have = new Set();
for (const m of src.matchAll(/\[`((?:[^`\\]|\\.)*)`,/g)) have.add(m[1]);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const lines = Object.entries(add)
  .filter(([k]) => !have.has(k))
  .map(([k, v]) => `  [\`${esc(k)}\`, \`${esc(v)}\`],`);
if (!lines.length) {
  console.log('nothing new');
  process.exit(0);
}
src = src.replace(/\n\]\);\s*$/, `\n\n  // ---- ${title}\n${lines.join('\n')}\n]);\n`);
fs.writeFileSync(target, src);
console.log(`added ${lines.length} translations`);
