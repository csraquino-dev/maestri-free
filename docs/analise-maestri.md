# Análise do Maestri 0.30.4 (Windows) com o REA

Alvo: `C:\Users\conta\AppData\Local\Programs\Maestri` (instalação do próprio usuário). Análise **estática**: nada foi
executado. Foi usada só para descobrir *quais recursos existem* e o *comportamento observável* (formatos, semântica de
comandos e mensagens), para que o open-maestri-win cubra a mesma superfície. Nenhum código do Maestri foi copiado.

## Método

1. `rea inspect-artifact` / `rea extract-artifact resources\app.asar` — o Maestri é um app **Electron** (React 19, Jotai,
   xterm.js, node-pty, i18next, lucide-react) com uma CLI nativa em Swift (`resources\cli\maestri.exe`, não analisada).
2. `rea analyze-javascript-application` (bundles `out/main/index.js` e `out/preload/index.js`) → grafo de aplicação e
   **494 canais IPC** literais. Canais dinâmicos não são resolvidos pelo REA (limitação declarada por ele).
3. Leitura dos trechos de texto/ajuda dos bundles para a semântica das rotinas (`--every/--daily/--weekly/--once`,
   `--count/--until`, resultados `sentToTerminal`, `terminalNotRunning`, `reminder`, `skippedWhileBusy`, …) e dos andares
   (`git worktree add [-b]`, landing, hooks).

## Superfície encontrada (canais IPC por área) × situação no open-maestri-win

| Área (nº de canais) | O que é | Situação |
| --- | --- | --- |
| workspace (36), node (7), connection (15), appState, sidebarLayout | espaços de trabalho, nós, conexões | ✅ (undo/redo incluído) |
| terminal (30), agent (13) | PTY, shells, WSL, sandboxes | ✅ shells/WSL/SSH · ❌ sandboxes Docker/tmux |
| **floor (29), floorHooks (13)**, floorSnapshot | andares = worktrees, hooks, landing | ✅ criar/excluir/aterrissar/hooks/status |
| **routine (11)** | rotinas agendadas + histórico | ✅ |
| **data (16)** | backups, exportar/importar, armazenamento | ✅ (sem mover o local de armazenamento) |
| note (14), portal (8), fileTree (35) | notas, navegador, arquivos + git | ✅ notas/portal · ◐ árvore (somente leitura, sem commit/stash/diff UI) |
| drawing (6), shape/stroke | desenhos | ◐ formas e linhas · ❌ mão livre/reconhecimento |
| noteStack (16), band (13), group (4), cableTie (4) | pilhas de notas, bandas, grupos, braçadeiras | ❌ |
| partitura (10), savedPrompts (9), prompter (7), palette | layouts/prompts salvos | ❌ |
| chat (28), computerUse (8), device (6), portalDesign (4) | chat com agentes, controle do computador | ❌ |
| accounts (27), agentUsage (7), gitHosts (5), pullRequests (36), license (7) | contas, uso, PRs, licença | ❌ (fora do escopo) |
| remote (18), updates (4), windowControls, app (19) | pareamento remoto, atualização automática | ❌ (app/janela ✅) |

Legenda: ✅ feito · ◐ parcial · ❌ não implementado.

## O que foi implementado a partir da análise

* **Rotinas** — mesmo modelo de agenda (`once | interval | daily | weekly`, fim `never | afterCount | onDate`), mesmas flags e mensagens de erro da CLI, resultados e histórico; execuções perdidas com o app fechado são ignoradas.
* **Andares** — `git worktree add -b`, remoção com `--force`, landing com checagem de sujeira e `merge --no-ff`, hooks, canvas por andar (campo `floorId` nos nós; o `workspace.json` continua com `floors` compatível com o original).
* **Backups, undo/redo, WSL/SSH, formas/linhas** — equivalentes funcionais dos canais `data:*`, `workspace:undo/redo`, `agent:listWslDistros` e `drawing/shape`.

## Limites desta análise

* Apenas JavaScript do processo principal e do preload foi analisado; o renderer (React) e a CLI Swift não.
* Evidência estática: "canal existe" não prova como o comportamento se dá em tempo de execução.
