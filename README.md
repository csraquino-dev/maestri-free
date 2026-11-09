# maestri-free

> Projeto não oficial, sem vínculo com o Maestri nem com a Maestri Labs. "Maestri" é marca dos seus donos. Este repositório é um port para Windows do [open-maestri](https://github.com/pedrotecinf/open-maestri) (GPL-3.0), escrito de forma independente a partir de análise estática de comportamento; não contém código nem imagens do aplicativo original.

## open-maestri para Windows

Port para Windows do [open-maestri](https://github.com/pedrotecinf/open-maestri) (macOS): um canvas onde terminais,
agentes de IA, notas, árvores de arquivos e navegadores embutidos são nós conectáveis, e os agentes conversam entre si
pela CLI `omaestri`.

Feito com Electron + ConPTY (`node-pty`) + xterm.js. Interface em **português (Brasil)** (inglês opcional em
*Preferências → Geral*), ícones [Lucide](https://lucide.dev) (ISC). Licença **GPL-3.0-ou-posterior**, como o original.

## Executar

```powershell
npm install
node node_modules\electron\install.js   # baixa o binário do Electron (o npm bloqueia scripts de instalação)
npm start                                # ou dê dois cliques em Open-Maestri.cmd
```

Gerar o app: `npm run pack` (pasta `dist\win-unpacked\open-maestri.exe`) ou `npm run dist` (instalador NSIS + portátil).
Builds sem assinatura mostram o SmartScreen na primeira execução.

## Testes

```powershell
npm test            # backend (shells ConPTY reais, servidor HTTP, CLI) + rotinas, andares com git real, backups, undo, física das cordas, barra lateral, prompter, paleta e importar/exportar
npm run selftest    # sobe a UI de verdade: PT-BR, ícones, andares, rotinas, portal, desfazer + capturas de tela
npm run i18n        # confere que todo texto da interface tem tradução
```

## Recursos

| Recurso | Situação |
| --- | --- |
| Canvas infinito: pan, zoom, minimapa, seleção múltipla, arrastar, redimensionar, ordem Z | ✅ |
| Terminais (PTY, xterm-256color), presets (Claude Code, Codex, Gemini CLI, OpenCode, Shell), scrollback restaurado, temas | ✅ PowerShell, pwsh, cmd, Git Bash |
| **Terminais WSL e SSH** (túnel reverso para o servidor do omaestri) | ✅ novo |
| Notas Markdown (bruto/formatado, colar imagem, cadeias de notas, importar `.md`/`.txt`) | ✅ |
| Árvore de arquivos com status/branch do git e **painel de alterações** (diff, stage, commit, branches, stash, histórico) | ✅ novo |
| **Pilhas de notas**, **bandas** e **partituras** (salvar a seleção e recolocar depois) | ✅ novo |
| Portal (navegador embutido) + `omaestri portal …` | ✅ |
| Conexões em corda: terminal↔terminal/nota/portal, nota↔nota, portal↔portal | ✅ |
| CLI `omaestri`: `list ask check note portal recruit dismiss connect role preset` | ✅ |
| Modo Maestro, papéis, presets, injeção de skills em `~/.claude/skills` etc. | ✅ |
| **Andares (Floors)**: git worktree isolado por andar, canvas próprio, hooks setup/run/teardown, aterrissar (merge `--no-ff`) com pré-visualização, `omaestri floor …` | ✅ novo |
| **Rotinas**: prompt/comando agendado para um terminal ou lembrete (uma vez, intervalo, diário, semanal; fim por contagem/data; histórico), `omaestri routine …` | ✅ novo |
| **Backups**: automático a cada hora (24 mantidos), manual, exportar/importar/restaurar | ✅ novo |
| **Desfazer / refazer** (Ctrl+Z / Ctrl+Y) para estrutura e layout | ✅ novo |
| **Formas e linhas** (retângulo, elipse, losango, linha, seta) | ✅ novo |
| Workspaces, formato `~/.open-maestri` e `workspace.json` schema 2 compatível com a versão macOS | ✅ |
| **Barra lateral do Maestri** (busca, fixados, grupos, pastas, arrastar-e-soltar, largura ajustável, andares e atividade por espaço) | ✅ novo |
| **Paleta de comandos** (Ctrl+K) com ações, navegação e envio de prompt | ✅ novo |
| **Prompter** (compositor sob/sobre o terminal, `@` menções, `/` prompts salvos, Ctrl+Shift+P) e **prompts salvos** | ✅ novo |
| **Desenho** (caneta, marca-texto, linha, seta, formas; cor, espessura, padrão, preenchimento) | ✅ novo |
| Duplicar / exportar / importar espaço de trabalho | ✅ novo |
| **Barra de vidro flutuante** (ferramentas + barra contextual por tipo de nó, contador de conexões, pulso nos botões) | ✅ novo — `docs/barra-flutuante-e-cordas.md` |
| **Cordas com física** (Verlet de 21 pontos, balançam ao mover nós, dormem quando assentam, desviam dos nós) | ✅ novo |
| Aviso de notificação quando um agente em segundo plano termina | ✅ |
| **Visão geral dos andares** (Ctrl+Shift+), cordas entre andares, **braçadeiras** (Alt+arrastar), **modo chat** (Ctrl+J), desenho inteligente, modo design do portal, terminais Docker, pull requests | ✅ novo |
| Contas/uso de agentes, controle de computador, pareamento remoto | ❌ dependem de serviços do Maestri — ver `docs/paridade.md` |

## Diferenças em relação ao macOS

* **Transporte do IPC**: no macOS há socket unix + TCP; no Windows só TCP em loopback (`MAESTRI_SERVER_PORT`). O servidor escuta em `127.0.0.1` e recusa pares que não sejam loopback.
* **Aspas**: o `cmd.exe` deforma `& % ^` nos argumentos. Para esses textos use `-` e entregue por stdin: `type prompt.txt | omaestri ask "Revisor" -`. PowerShell e Git Bash citam normalmente.
* A saída da CLI `omaestri` **não é traduzida** de propósito: os agentes e as skills dependem do texto em inglês.
* `omaestri` é `omaestri.cmd` (mais um atalho POSIX para o Git Bash) e roda no Node embutido do app; não precisa de Node no sistema.
* SSH: o host remoto ainda precisa de um cliente `omaestri` próprio (o túnel reverso só expõe o servidor local).
* A seleção de texto no terminal pode ficar deslocada quando o zoom do canvas não é 100% (xterm.js sob transformação CSS).
* `ask` espera o agente ficar ocioso (2 s sem saída) ou `OMAESTRI_ASK_TIMEOUT_MS` (padrão 20 min).

## Estrutura

```
main/        Processo principal do Electron + backend sem Electron (core, handlers, servidor, terminais, portais, floors, routines, backups)
renderer/    UI do canvas (módulos JS puros), i18n (pt-br.js), ícones gerados (icons.js)
cli/         omaestri.js, omaestri.cmd, omaestri (sh)
assets/      Skills dos agentes (extraídas do SkillInjector do app macOS)
build/       Ícone do app (icon.svg → icon.png / icon.ico via `npm run icons`)
docs/        Análise do Maestri feita com o REA
tests/       Testes e2e do backend e das novas funções; fixture do portal
```
