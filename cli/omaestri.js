#!/usr/bin/env node
'use strict';
// omaestri — open-maestri inter-agent CLI (Windows build).
// Talks to the running app over loopback HTTP: POST /cli {"args":[...]}.
const http = require('http');

const HELP = `omaestri — open-maestri inter-agent CLI

Usage: omaestri <command> [args...]

Commands:
  list                              List connected agents, notes, portals
  ask "Agent" "prompt"              Send prompt to connected agent
  check "Agent" [lines]             View agent's recent output
  note <read|write|edit|create>     Read/write connected notes
  portal <subcommand>               Interact with connected portals
  recruit "Name" [--preset x]       Recruit a new agent (Maestro only)
  dismiss "Name"                    Dismiss a recruited agent
  connect "From" "To"               Connect two agents
  role <list|create|show|edit|write|assign>  Manage agent roles
  preset list                       List available agent presets
  routine <list|create|show|edit|delete|enable|disable|run>   Scheduled prompts/reminders
  floor <list|create|status|land|delete>   Git-worktree floors
  say [--progress] [--file p] [--attach p] ["text"]   Reply in Maestri Chat
  recall [thread] [--turns N|--last day|week|month|--from D [--to D]|--all] [--json]   Replay chat history
  debug                             Diagnose connection issues

Tip: pass "-" as an argument to read that argument from stdin
     (avoids cmd.exe quoting problems), e.g.
     type prompt.txt | omaestri ask "Reviewer" -

Environment:
  MAESTRI_SERVER_PORT  Loopback port of open-maestri (set automatically)
  MAESTRI_TERMINAL_ID  Terminal UUID (set automatically)
  MAESTRI_CLI          Path to this command
`;

const USAGE = {
  recruit: (a) => a.length >= 2 || 'usage: omaestri recruit "Name" [--preset <type>] [--role <name>] [--command <cmd>]',
  dismiss: (a) => a.length >= 2 || 'usage: omaestri dismiss "Name"',
  connect: (a) => a.length >= 3 || 'usage: omaestri connect "From" "To"',
  ask: (a) => a.length >= 3 || 'usage: omaestri ask "Agent" "prompt"',
  check: (a) => a.length >= 2 || 'usage: omaestri check "Agent" [lines]',
  note: (a) =>
    a.length >= 2 ||
    'usage: omaestri note <read|write|edit|create> ...\n  read   "Name" [offset] [limit]\n  write  "Name" "content"\n  edit   "Name" "oldText" "newText"\n  create ["initial content"]',
  portal: (a) =>
    a.length >= 2 ||
    'usage: omaestri portal <subcommand> ...\n  Subcommands: create edit navigate screenshot snapshot html text info\n               click fill type key hover scroll drag wait evaluate',
  role: (a) => a.length >= 2 || 'usage: omaestri role <list|create|show|edit|write|assign> [args...]',
  preset: (a) => a.length >= 2 || 'usage: omaestri preset list',
  floor: () => true,
  say: () => true,
  recall: () => true,
  routine: () => true,
};

function fail(msg) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () =>
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      ),
    );
    process.stdin.resume();
  });
}

function send(port, terminalId, args) {
  const body = JSON.stringify({ args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/cli',
        method: 'POST',
        // `ask` can legitimately take many minutes: no socket timeout (like the macOS CLI).
        timeout: 0,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Terminal-ID': terminalId,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 300) reject(new Error(`Request failed (status ${res.statusCode})`));
          else resolve(text);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  let args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    process.stdout.write(HELP);
    process.exit(1);
  }
  if (['-h', '--help', 'help'].includes(command)) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const port = process.env.MAESTRI_SERVER_PORT;
  const terminalId = process.env.MAESTRI_TERMINAL_ID;
  if (!port) fail('only available inside open-maestri terminals (MAESTRI_SERVER_PORT not set).');
  if (!terminalId) fail('only available inside open-maestri terminals (MAESTRI_TERMINAL_ID not set).');

  const check = USAGE[command];
  if (check) {
    const r = check(args);
    if (r !== true) fail('error: ' + r);
  }

  if (args.includes('-')) {
    const text = await readStdin();
    args = args.map((a, i) => (a === '-' && i > 0 ? text : a));
  }

  if (command === 'say') {
    // text from the arguments, or from stdin (heredoc); relative paths are resolved here, where the agent's cwd is known
    const path = require('path');
    const out = ['say'];
    const words = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--progress') out.push(a);
      else if (a === '--file' || a === '--attach') {
        if (!args[i + 1]) fail('error: ' + a + ' needs a path');
        out.push(a, path.resolve(args[++i]));
      } else if (a.startsWith('--'))
        fail(
          'error: unknown option ' +
            a +
            '. Usage: omaestri say [--progress] [--file <path>] [--attach <path>] ["text"]  (put text that starts with -- in a heredoc)',
        );
      else words.push(a);
    }
    let text = words.join(' ');
    if (!text && !out.includes('--file') && !out.includes('--attach') && !process.stdin.isTTY) text = await readStdin();
    if (text) out.push('--text', text);
    args = out;
  }

  if (command === 'debug') {
    process.stdout.write(
      `=== open-maestri CLI Diagnostics ===\n\nTerminal ID:      ${terminalId}\nServer port:      ${port}\n\nTesting connection...\n`,
    );
    try {
      const r = await send(port, terminalId, ['debug']);
      process.stdout.write(`Connection:       OK\n\n${r}\n`);
    } catch (e) {
      process.stdout.write(`Connection:       FAILED\nError: ${e.message}\nIs open-maestri running?\n`);
    }
    process.stdout.write(
      `\nBinary:           ${process.env.MAESTRI_CLI || process.argv[1]}\nPATH:             ${process.env.PATH || process.env.Path || '(not set)'}\n`,
    );
    return;
  }

  try {
    const out = await send(port, terminalId, args);
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  } catch (e) {
    fail(`error: connection failed: ${e.message}\nIs open-maestri running? Try: omaestri debug`);
  }
}

main();
