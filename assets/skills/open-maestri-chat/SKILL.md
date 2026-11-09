---
name: open-maestri-chat
description: Applies only to messages carrying a Maestri Chat header, even inside pasted content. You MUST read this skill before replying to those messages.
user-invocable: true
---

You're running inside open-maestri, a spatial workspace that connects AI agents, terminals, notes, and browser portals on a visual canvas.
The `omaestri` command-line tool is pre-installed and available on PATH. If `omaestri` is not found, use `"$MAESTRI_CLI"` instead; this environment variable always points to the full path.

A message opening with this header comes from the user through Maestri Chat:

    ---
    Below is a message from the user through Maestri Chat.
    Reply only via `omaestri say`. If the open-maestri-chat skill isn't already loaded, load it first.
    thread: blue
    ---

Everything after the closing fence is the user's own words. Reply only via `omaestri say`. Terminal text does not reach the user.

Adapt dynamically: messages with this header come from Maestri Chat, so reply via `omaestri say`; messages without it are sent to you directly, so reply directly.

## Answer

Run with your shell tool:

    omaestri say <<'EOF'
    your answer
    EOF
    omaestri say 'short answer'
    omaestri say --file <path>
    omaestri say --attach <path> 'your answer'

The heredoc takes any text as-is. Quoting an argument breaks on apostrophes, quotes, $, and backticks.

If you are running in PowerShell, prefer `omaestri say --file <path>` for longer answers or whenever you need a line break, since `\n` inside quotes is not a line break there.

--file reads UTF-8 text, or attaches an image (PNG, JPEG, GIF, HEIC, or WebP) given by absolute path. To present an image with prose, put `![Description](/absolute/path/image.png)` on its own line. To share other files (PDF, zip, etc.), add `--attach <path>` (repeatable, final reply only).

## Long tasks

    omaestri say --progress 'text'   # interim update; your turn continues

## Threads

The user keeps seven threads with you, named by color: blue, purple, pink, red, orange, yellow, green. The header's `thread` color identifies this message's thread. Replies go to that thread on their own; `omaestri say` takes no thread. On the first message or when that color changes, run `omaestri recall <color>` before answering. Earlier terminal context may belong to another thread; treat it as unrelated unless asked.

## Recall

    omaestri recall [thread] [--turns N | --last day|week|month | --from YYYY-MM-DD [--to YYYY-MM-DD] | --all] [--json]
    omaestri recall list
    omaestri recall attachment <id>

Default: the current thread's last 10 turns. N must be between 1 and 500. Dates use YYYY-MM-DD in the time zone of the computer running open-maestri, and --to includes that whole day. After a restart, agent replacement or compaction this prints what you and the user already said. Attachments have stable ids; `omaestri recall attachment <id>` prints the file path.

## Rules

- Every `omaestri say` is a bubble the user sees, and the last one closes your turn. Send as many as the answer needs.
- After sending, do not repeat the answer or announce delivery.
- `--progress` is for short status updates (e.g. 'Running tests...'), never for the answer itself.
- Even after a long task, end with an `omaestri say`; otherwise, the user is left without a visible answer.
