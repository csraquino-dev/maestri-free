---
name: open-maestri-manager
description: Create new connected agent terminals on the open-maestri canvas and assign them roles. Use when the user asks to assemble a team, delegate parallel work, or spin up additional agents or terminals to help, or to invoke Maestro Mode.
user-invocable: false
---

# open-maestri Team Orchestration

The commands below spawn new agent terminals on the canvas, assign them roles, and wire them together.
Recruits are auto-connected to your terminal — once a recruit exists you can `omaestri ask "Name" "..."` to delegate work and `omaestri check "Name"` to read their output.

## Reuse before recruiting

**Before calling `omaestri recruit`, always run `omaestri list` first.**
If a connected teammate already has a fitting role, delegate to them with `omaestri ask "Name" "..."` — do NOT spin up a new recruit for the same role.

Only recruit when:
- `omaestri list` shows nobody whose role covers the task, AND
- the work genuinely needs a new persona (e.g. a reviewer-only voice when your existing teammate is the implementer).

If an existing recruit's role is close but wrong, prefer `omaestri role edit` over recruiting a duplicate.

## Commands

### `omaestri recruit "Name" [--preset "Claude Code"] [--role "Reviewer"] [--command "claude"]`

Spawn a new agent terminal on the canvas with the given name.

- `--preset` — use a configured agent preset by name or type (e.g. `claude_code`, `codex`, `generic_shell`). Run `omaestri preset list` to see available presets.
- `--role` — assign a role preset by name. The role's instructions are injected as system context. Run `omaestri role list` to see available roles.
- `--command` — override the launch command directly (e.g. `claude --resume`).

```
omaestri recruit "Reviewer" --preset "Claude Code" --role "Code Reviewer"
omaestri recruit "Tester" --command "claude" --role "QA Engineer"
omaestri recruit "Shell" --preset "generic_shell"
```

After recruiting, the new terminal is auto-connected. Delegate immediately:
```
omaestri ask "Reviewer" "Please review the changes in src/Auth.swift"
```

### `omaestri dismiss "Name"`

Stop and remove a recruited agent terminal from the canvas. Disconnects it and terminates its process.

```
omaestri dismiss "Reviewer"
```

### `omaestri connect "From" "To"`

Manually wire two existing terminals together so they can communicate via `omaestri ask`.

```
omaestri connect "Reviewer" "Tester"
```

### `omaestri role list`

List all configured role presets with their instructions preview.

### `omaestri role create "RoleName" "Role instructions"`

Create a new role preset saved to preferences.

```
omaestri role create "Code Reviewer" "You are a meticulous code reviewer. Focus on correctness, security, and readability. Always cite the specific line or pattern you are commenting on."
```

### `omaestri role show "RoleName"`

Show the full details (name and prompt) of a role.

```
omaestri role show "Code Reviewer"
```

### `omaestri role edit "RoleName" --prompt "new instructions"`

Update an existing role's instructions. `write` is an alias for `edit`.

```
omaestri role edit "Code Reviewer" --prompt "You are a strict code reviewer focused on security vulnerabilities and performance."
omaestri role write "Code Reviewer" --prompt "Updated instructions here."
```

### `omaestri role assign "AgentName" "RoleName"`

Assign a role to an existing agent (takes effect on next restart). Use `--none` to clear the role.

```
omaestri role assign "Reviewer" "Code Reviewer"
omaestri role assign "Reviewer" --none
```

### `omaestri preset list`

List all configured agent presets (Claude Code, Codex, generic shell, custom presets). Run this before `omaestri recruit --preset "..."` to confirm the preset name exists.

## Workflow

1. Run `omaestri list` — check if you already have teammates who can do the job.
2. Run `omaestri preset list` and `omaestri role list` — find the right preset and role.
3. `omaestri recruit "Name" --preset "..." --role "..."` — spawn the agent.
4. Wait a moment for the terminal to start (the agent needs to initialize).
5. `omaestri ask "Name" "task description"` — delegate the work with an appropriate Bash timeout.
6. `omaestri check "Name"` — monitor progress without interrupting.
7. `omaestri dismiss "Name"` — clean up when the task is done.
