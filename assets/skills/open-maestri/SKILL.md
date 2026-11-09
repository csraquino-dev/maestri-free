---
name: open-maestri
description: Send messages to connected AI agents on the open-maestri canvas and get their responses. Also read and write connected sticky notes. Use when the user's intent is to collaborate with another agent on the canvas. Look for actions like 'ask [name] to...', 'tell [name] to...', 'check on [name]', or 'create/update a note'.
user-invocable: false
---

# open-maestri Inter-Agent Communication

You're running inside open-maestri, a spatial workspace with other coding agents and sticky notes nearby.
Connected agents can exchange prompts and responses through the `omaestri` CLI.
Connected notes can be read and written through the `omaestri` CLI.

## Commands

- `omaestri list`
  list connected agents, notes, and portals

- `omaestri ask "Agent Name" "your prompt"`
  send a prompt to a connected agent and get the response

- `omaestri check "Agent Name" [lines]`
  read the agent's current terminal output on demand (default 20 lines)

- `omaestri note create ["content"]`
  create a new note on the canvas and link it to this terminal

- `omaestri note read "Note Name"`
  read the full note with line numbers

- `omaestri note read "Note Name" 10 20`
  read 20 lines starting from line 10

- `omaestri note write "Note Name" "content"`
  replace a note's content entirely

- `omaestri note edit "Note Name" "old text" "new text"`
  replace a substring within a note

The `omaestri` CLI is pre-installed and available on PATH inside open-maestri terminals.
If `omaestri` is not found on PATH, call it through the `MAESTRI_CLI` environment variable (PowerShell: `& $env:MAESTRI_CLI list`, cmd: `%MAESTRI_CLI% list`, Git Bash: `"$MAESTRI_CLI" list`).

On Windows, quoting in cmd.exe can mangle prompts containing `&`, `%` or `^`. For long or special-character text, pipe it through stdin using `-` as the argument: `type prompt.txt | omaestri ask "Agent" -`.

Always run `omaestri list` first to get the exact agent and note names.

The response from `ask` returns as soon as the other agent finishes. Scale the Bash tool timeout to the estimated completion time:

- **60000ms** (1 min) — quick questions, status checks, simple lookups
- **300000ms** (5 min) — delegating a small, focused task (a single file change, a quick refactor)
- **600000ms** (10 min) — code reviews, multi-step tasks, larger delegations
- **1200000ms** (20 min) — debugging sessions, complex investigations, multi-file refactors

If the timeout expires before the agent responds, do NOT re-send the prompt. Run `omaestri check "Agent Name"` to see their progress, then wait again with an appropriate timeout. Never interrupt an agent that is still working, and do not edit files that the other agent is actively modifying — wait for them to finish first.

Use `check` to read what an agent is currently showing without sending a prompt — useful to check if a previous request completed or to see its current state.

Run `omaestri debug` to diagnose connection or setup issues.

## Connected Notes

Use `omaestri note create` to create a new note on the canvas — it appears linked to your terminal and is automatically connected. Optional initial content can be provided.

Notes support line-range reads: `omaestri note read "Note Name" <offset> <limit>` where offset is the starting line number and limit is how many lines to return.

Use `omaestri note write` to replace the entire note content. Use `omaestri note edit` for surgical in-place replacements.
