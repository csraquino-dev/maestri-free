# Paridade com o Maestri 0.30.4 — situação atual

Mapa feito com o REA (`rea extract-artifact` + leitura estática do bundle do renderer e dos 494 canais IPC).
✅ feito e testado · ◐ parcial · ❌ não implementado (motivo na última coluna).

| Área do Maestri | Situação | Observação |
| --- | --- | --- |
| Canvas, nós (terminal, nota, portal, árvore, texto), conexões, minimapa, zoom | ✅ | |
| Cordas com física (Verlet, dormir/acordar, desvio de nós, 3 estilos) | ✅ | `rope-sim.js`, 9 testes |
| Barra de vidro flutuante + barra contextual por tipo de nó + contador de conexões | ✅ | |
| Barra lateral: busca, fixados, grupos, pastas, arrastar-e-soltar, largura, andares, atividade | ✅ | `sidebar-layout.js`, 7 testes |
| Paleta de comandos (Ctrl+K): ações, navegação, "enviar prompt a um terminal" | ✅ | ranking testado |
| Prompter: compositor sob/sobre o terminal, `@` menções, `/` prompts salvos, colagem em bloco, rascunhos | ✅ | |
| Prompts salvos (arquivos .md global / por espaço, ranking, desfazer exclusão) | ✅ | |
| Desenho: caneta, marca-texto, linha, seta, retângulo/elipse/losango, cor/espessura/padrão/preenchimento | ✅ | sem reconhecimento de formas (`drawing:recognize`) |
| Andares (git worktree, hooks, aterrissar) | ✅ | sem "revisão de PR" nem snapshots do overview |
| Rotinas (agenda, histórico, CLI) | ✅ | |
| Backups, exportar/importar/duplicar espaço de trabalho, undo/redo | ✅ | |
| Terminais locais/WSL/SSH, temas, scrollback | ✅ | sem sandboxes Docker/tmux; ciclo de vida do PTY endurecido (sem o aviso `conpty.cc remove_pty_baton`), 5 testes |
| Portal + `omaestri portal …` | ✅ | sem modo "design" (`portalDesign`) |
| Árvore de arquivos + painel de alterações do git (status, diff, stage/unstage, descartar, commit, branches, stash, histórico) | ✅ | `git-ops.js`, 9 testes; escritas serializadas por repositório (sem `index.lock`) |
| Pilhas de notas (fichario) e bandas (grupos de nós) | ✅ | `stacks.js`, `bands.js`, 13 testes |
| Braçadeiras (cable ties), visão geral dos andares e cordas entre andares | ✅ | `cable-ties.js`, `cross-floor.js`, `overview.js` |
| Modo chat (7 conversas por cor, `omaestri say`/`recall`, anexos, busca) | ✅ | `chat.js`; protocolo igual ao da skill maestri-chat |
| Desenho inteligente (reconhecimento de formas) e modo design do portal | ✅ | `shape-recognizer.js`, `portal-design.js` |
| Sandbox Docker e pull requests (via `gh`) | ✅ | exigem Docker / GitHub CLI instalados; sem `omaestri` dentro do contêiner |
| Partituras (modelos de layout reutilizáveis: salvar seleção, biblioteca, colocar) | ✅ | `partituras.js` |
| Contas de agentes, uso/limites dos agentes | ❌ | dependem de serviços do Maestri |
| Controle do computador (`computerUse`), dispositivos (`device`), pareamento remoto (`remote`) | ❌ | recursos nativos/serviços do Maestri |
| Licença, atualizações automáticas, janela sem moldura | ❌ | não se aplicam a este port |

Para o que depende de contas, licença ou serviços do Maestri não há como ser "igual" sem esses serviços; o restante é
trabalho de engenharia (cada linha ❌ acima é uma entrega própria).
