// One-off helper: extracts the three agent skills embedded in the macOS app's
// SkillInjector.swift into assets/skills/<name>/SKILL.md (GPL-3.0, same as upstream).
const fs = require('fs'),
  path = require('path');
const src = fs.readFileSync(process.argv[2], 'utf8').split('\r\n').join('\n');
const re = /private static let (\w+) = """\n([\s\S]*?)\n    """/g;
let m,
  n = 0;
while ((m = re.exec(src))) {
  let body =
    m[2]
      .split('\n')
      .map((l) => (l.startsWith('    ') ? l.slice(4) : l))
      .join('\n') + '\n';
  const name = /^name: (.+)$/m.exec(body)[1].trim();
  body = body.replace(
    /If `omaestri` is not found on PATH \(e\.g\., custom shell setups that reset PATH\), use `"\$MAESTRI_CLI"` instead — this environment variable always points to the full binary path\./,
    'If `omaestri` is not found on PATH, call it through the `MAESTRI_CLI` environment variable (PowerShell: `& $env:MAESTRI_CLI list`, cmd: `%MAESTRI_CLI% list`, Git Bash: `"$MAESTRI_CLI" list`).\n\nOn Windows, quoting in cmd.exe can mangle prompts containing `&`, `%` or `^`. For long or special-character text, pipe it through stdin using `-` as the argument: `type prompt.txt | omaestri ask "Agent" -`.',
  );
  const dir = path.join('assets', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  console.log('wrote', dir, body.length);
  n++;
}
if (n !== 3) {
  console.error('expected 3 skills, got', n);
  process.exit(1);
}
