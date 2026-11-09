# Barra flutuante e animação das cordas (do Maestri, via REA)

Fonte: `rea extract-artifact` do `app.asar` do Maestri 0.30.4 e leitura estática do bundle do renderer
(`out/renderer/assets/index-*.js`, que preserva os nomes das funções). Nada foi executado; o código do
open-maestri-win é uma reimplementação própria do **comportamento** observado (constantes, regras e layout).

## Barra de vidro flutuante

| Peça no Maestri | O que faz | No open-maestri-win |
| --- | --- | --- |
| `MainToolbar` (`GlassToolbar`) | pílula de vidro no topo, centralizada, só com ícones de 32 px: selecionar · terminal · nota · anexo · árvore de arquivos · portal · texto · desenho | `chrome.js` → `#main-pill` (8 ferramentas) |
| ferramenta "armada" | clicar na ferramenta e depois no canvas posiciona o nó ali; Esc cancela | `app.js` `pickTool` / `placeAt` |
| `ContextualToolbar` | segunda pílula **abaixo** da principal, aparece ao selecionar um nó, com mola (`y -24→0`, `scale .9→1`, bounce 0,4, `visualDuration` 0,3 s); sai em 150 ms | `chrome.js` `updateContext` (Web Animations) |
| `TerminalToolbar` | Editar · | Conectar + contador de conexões · | Reiniciar · | Excluir | idem (chat e "prompter" não implementados) |
| barras de Nota / Portal / Árvore / Texto | nota: fonte −/+, negrito, itálico, código, título, tarefa, lista, bloco de código, bruto/formatado, cor, conectar, excluir · portal: recarregar, conectar, mostrar/ocultar barra, editar, fechar · árvore: revelar, trocar pasta, excluir · texto: peso, família, tamanho | idem |
| `ConnectionsBadge` | bolinha com o nº de conexões; popover lista os nós ligados (clique foca) e permite desconectar um/todos | `chrome.js` `badge()` |
| `GlassButton` | 32×32 redondo, hover `foreground/10`, ativo com ícone na cor primária, **pulso** ao clicar `scale [1, 1.22, 0.97, 1]` em 0,38 s | `.gbtn` + `@keyframes gpulse` |
| estilo `glass` | `rgba(--glass-bg-rgb, .6)` + realce interno `0.5px`, sombras `0 .5px 1.5px` e `0 6px 20px`; no chrome do canvas, degradê `.96 → .42` | `glass-theme.css` (mesmos tokens claro/escuro) |
| modo conectar | botão Conectar arma o modo; corda de pré-visualização tracejada na cor de destaque (2,4 px) com ponto `r=3` na ponta; clique em outro nó conecta | `canvas.js` `beginConnect` |

## Física da corda

Cada conexão é uma cadeia de Verlet de **21 pontos** (20 segmentos) presa às **bordas mais próximas** dos dois nós
(par de pontos médios de aresta mais perto entre si).

| Constante | Valor |
| --- | --- |
| passo fixo / máx. de sub-passos por quadro | 1/60 s / 4 |
| gravidade (y) / amortecimento | 1600 / 0,965 |
| folga do comprimento de repouso | 1,05 × distância entre os pinos (mín. 40 px no total) |
| iterações de restrição por passo | 8 |
| desvio de nós (`avoidNodes`, padrão) | margem 20 px, zona de canto 30 px, mistura 0,4 |
| dorme quando | movimento total < 0,5 após 0,5 s de graça, ou após 10 s |
| acorda quando | um pino muda, ou um nó arrastado fica a ≤ 80 px da corda |
| forma estática inicial | parábola com flecha = max(12% do vão, 20 px) |
| desenho | caminho Bézier suave (Catmull-Rom), tracejado `8 6`, 2 px, ponta redonda; 2,5 px na cor de destaque enquanto agentes conversam; contínuo ao destacar |

Modos de roteamento (preferência `ropeRouting`): `avoidNodes` (padrão), `behindNodes` (sem desvio) e `circuit`
(ângulos retos com cantos de 10 px). A forma em repouso é salva no `workspace.json` (`ropePoints`, 21 pontos) e
restaurada sem "reanimar". Com "reduzir movimento" do sistema ligado a corda vai direto à forma final.

Código: `renderer/js/rope-sim.js` (física pura, testada em `tests/rope-sim.test.js`) e `renderer/js/ropes.js` (DOM).

## O que ainda difere do Maestri

* Não há modo de chat com o agente nem o "prompter" (editor de prompt acoplado ao terminal).
* Barra de desenho completa (cores, espessura, caneta livre) e seleção de desenhos.
* Laço de "cable ties" (braçadeiras que agrupam cordas), bandas e pilhas de notas.
* O Maestri tem barra superior/laterais próprias (sidebar com seções, indicador de andares, pílula de zoom com passo
  configurável); aqui a barra lateral e a de andares seguem o desenho próprio do port.
