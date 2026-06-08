<div align="center">

<img src="./assets/hero.png" alt="pi-taskflow — orquestração DAG declarativa para subagentes Pi: stateful, retomável, com isolamento de contexto" width="900">

<p>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=B692FF&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/dm/pi-taskflow?style=flat-square&color=6E8BFF&label=downloads" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-43D9AD?style=flat-square" alt="MIT license"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/runtime%20deps-0-43D9AD?style=flat-square" alt="zero runtime dependencies"></a>
  <a href="https://github.com/heggria/pi-taskflow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heggria/pi-taskflow/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/tests-394-6E8BFF?style=flat-square" alt="394 tests"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/dogfooded-%E2%9C%93-43D9AD?style=flat-square" alt="dogfooded"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi%20coding%20agent-B692FF?style=flat-square" alt="for the Pi coding agent"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <b>Português</b>
</p>

<p><strong>Orquestração DAG declarativa para <a href="https://pi.dev">subagentes do Pi</a>.</strong><br/>
Distribuir (fan out) ·  Gatear ·  Retomar ·  Salvar como comando — resultados intermediários ficam fora do seu contexto.</p>

```bash
pi install npm:pi-taskflow
```

</div>

---

**Subagentes são fire-and-forget. Taskflows (fluxos de tarefas) disparam, distribuem, pausam, gateiam, retomam e se salvam como um comando.**

Você já conhece os atalhos `task` / `tasks` / `chain` da ferramenta interna de subagentes. O `pi-taskflow` usa a **mesma** sintaxe abreviada — então suas delegações existentes instantaneamente se tornam **rastreáveis, retomáveis e salváveis como um comando de uma palavra `/tf:<name>`**. Quando você superar a sintaxe abreviada, a DSL completa oferece um DAG real: distribuição dinâmica (fan-out) sobre dezenas de itens, roteamento condicional, gates de qualidade, aprovações humanas, repetições (retry) e um teto de gastos rígido.

E o tempo todo, **apenas a fase final chega à sua conversa.** Cada transcrição intermediária permanece no runtime (ambiente de execução), nunca na sua janela de contexto.

## Por que isto existe

Aqui está o obstáculo que você enfrenta com subagentes puros: você descreve um plano de várias etapas em prosa, o modelo o rederiva toda vez que executa, as transcrições intermediárias inundam seu contexto, e no momento em que uma chamada de modelo falha você recomeça do zero. Não há reutilização, nem recuperação, nem estrutura.

O `pi-taskflow` move o plano **para fora do prompt e para dentro de uma definição declarativa.** O runtime é dono do DAG, dos loops, das repetições e do estado intermediário. Você declara um pipeline (fluxo) uma vez e o executa cem vezes — pelo nome.

<div align="center">
<img src="./assets/context-isolation.png" alt="Com subagentes puros, cada transcrição inunda seu contexto; com pi-taskflow, as transcrições ficam no runtime e apenas o resultado final retorna" width="900">
</div>

> Quando um trabalho precisa de doze etapas com distribuição ramificada e um gate de revisão, você quer orquestração — não prompts de sorte.

| | subagent (interno) | **pi-taskflow** |
|---|---|---|
| **Quem dirige** | o modelo, passo a passo | o runtime, a partir de uma definição |
| **Topologia** | cadeia / paralelo plano | **DAG com concorrência em camadas + roteamento** |
| **Resultados intermediários** | na sua janela de contexto | **no runtime — não no seu contexto** |
| **Escala** | um punhado de tarefas | **distribuição dinâmica `map` sobre dezenas de itens** |
| **Reutilizável** | re-descrito toda vez | **salvo como `/tf:<name>`** |
| **Retomável** | ✗ | **✓ entre sessões — fases em cache pulam automaticamente** |
| **Gates de qualidade** | ✗ | **fases `gate` que param em `VERDICT: BLOCK`** |
| **Roteamento condicional** | ✗ | **guardas `when` + junções OR `join: any`** |
| **Tolerância a falhas** | ✗ | **`retry` por fase + repetição automática em erros transitórios** |
| **Humano no loop** | ✗ | **fases `approval` (aprovar / rejeitar / editar)** |
| **Controle de custos** | ✗ | **`budget` global (limites em USD / tokens)** |
| **Composição** | ✗ | **fases `flow` executam subfluxos salvos** |
| **Progresso ao vivo** | opaco durante a execução | **renderização DAG ao vivo com tempo + custo** |
| **Ergonomia** | JSON inline a cada vez | **atalho (`task`/`tasks`/`chain`) *ou* DSL** |

Ele não substitui a ferramenta de subagente. Ele dá aos seus subagentes um DAG, uma memória e um nome.

## Comparado a outras extensões Pi

O ecossistema Pi agora tem **20+ extensões de delegação, workflow e orquestração** — cada uma excelente no que faz. Aqui está um mapa honesto de onde o `pi-taskflow` se situa (verificado contra o lançamento npm mais recente de cada pacote, junho de 2026). Para a análise completa — todos os pacotes, pontos fortes *e* fracos — veja [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md). Para o panorama mais amplo, fora do Pi (LangGraph, Temporal, CrewAI, Mastra…), veja [`COMPETITORS.md`](./COMPETITORS.md).

| Extensão | Modelo | DSL customizada | DAG | Distribuição dinâmica | Retomada entre sessões | Gate de qualidade | Aprovação humana | Salvar como comando | Zero deps |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **pi-taskflow** | **fluxos de tarefas declarativos multifase** | **✓** | **✓** | **✓ `map`** | **✓ hash de fase** | **✓** | **✓** | **✓ `/tf:<name>`** | **✓** |
| [`@pi-agents/orchid`](https://www.npmjs.com/package/@pi-agents/orchid) | pipeline opinativo de 9 fases + loop Ralph | fixo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ (2) |
| [`pi-crew`](https://www.npmjs.com/package/pi-crew) | equipes por papel + git worktrees + async | parcial | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✕ (7) |
| [`ultimate-pi`](https://www.npmjs.com/package/ultimate-pi) | arnês governado plan→execute→review | contratos YAML | ✓ (tempo de plano) | ✕ | ✓ | ✓ (3 níveis) | ✓ | ✓ | ✕ (16) |
| [`@zhushanwen/pi-workflow`](https://www.npmjs.com/package/@zhushanwen/pi-workflow) | scripts JS (`agent`/`parallel`/`pipeline`) | sim (JS) | ✕ (linear) | ✓ | ✓ | ✕ | ✕ | ✓ (cache de chamada) | ✓ |
| [`@fiale-plus/pi-rogue-orchestration`](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | loop de timer + resolução de meta | ✕ | ✕ | ✕ | ✓ | ✓ (verificação de meta) | ✕ | ✕ | ✓ |
| [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | delegação única / paralela / em cadeia | ✕ | ✕ | estático | – | ✕ | esclarecer | fluxos nomeados | ✕ (3) |
| [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents) | subagentes estilo Claude-Code + worktrees | ✕ | ✕ | ✕ | ✓ (por id) | ✕ | por agente | ✕ | ✕ (1) |
| [`pi-pipeline`](https://www.npmjs.com/package/pi-pipeline) | fixo SPEC→PLAN→TASKS→VERIFY | ✕ | fixo | ✕ | planejamento de sessão | ✓ | esclarecer | ✕ | ✕ (2) |
| [`pi-agent-flow`](https://www.npmjs.com/package/pi-agent-flow) | `fork` paralelo one-shot de especialistas | sim | ✕ | ✕ | – | ✕ | ✕ | – | ✕ (2) |

*(Fatia representativa dos 20+ — veja [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md) para todos eles, além de `@0xkobold/pi-orchestration`, `@melihmucuk/pi-crew`, `@mediadatafusion/pi-workflow-suite`, `gentle-pi`, `@dreki-gg/pi-subagent`, e mais.)*

**Como escolher:**

- **`@pi-agents/orchid`** é o orquestrador mais completo em recursos do ecossistema (DAG + worktrees + loop Ralph + caixa de correio de agente) — mas sua DSL é um pipeline *fixo* de 9 fases, carrega dependências de runtime + jiti, e está em beta. Recorra ao `pi-taskflow` quando quiser **definir seu próprio grafo** (não adotar um opinativo) com **zero dependências** e uma instalação de um comando.
- **`pi-crew` / `ultimate-pi`** são mais pesados — isolamento com worktree, equipes assíncronas duráveis, governança multinível. Se você quer leve, declarativo e zero dependência, este é o projeto.
- **`@zhushanwen/pi-workflow`** é o mais próximo em espírito e também zero-dep, mas você cria fluxos como **scripts JavaScript**. A **DSL JSON declarativa** do `pi-taskflow` é mais segura e auditável, e sua **retomada por hash de entrada em nível de fase** é mais granular que a deduplicação por cache de chamada.
- **`@fiale-plus/pi-rogue-orchestration`** tem um verdadeiro **loop-até-concluir** (um recurso que o `pi-taskflow` ainda não tem). Se seu trabalho é "continue até a meta ser atingida", vale a pena conferir; o `pi-taskflow` é para pipelines *estruturados e ramificados*.
- **`pi-subagents` / `@gotgenes/pi-subagents`** são as escolhas maduras para delegação ad-hoc "use o revisor neste diff" e trabalhos em segundo plano. O `pi-taskflow` é para quando essas delegações precisam se tornar um *pipeline repetível e retomável*.
- **`pi-pipeline` / `pi-agent-flow`** entregam fluxos *opinativos e fixos*. O `pi-taskflow` entrega uma *tela em branco*: você (ou o modelo) declara o grafo que se adequa ao trabalho.

> A verdade em uma linha: **`pi-taskflow` é a única extensão Pi que oferece um pipeline de subagentes declarativo, retomável e em formato DAG que você salva como um comando de uma palavra — com zero dependências de runtime e isolamento de contexto por design.** As lacunas conhecidas que serão fechadas em breve: loop-até-concluir, isolamento com worktree e execuções em segundo plano não bloqueantes (veja [`STRATEGY.md`](./STRATEGY.md)).

## Início em 30 segundos

**1. Instale** — um comando:

```bash
pi install npm:pi-taskflow
```

> **Opcional:** execute `/tf init` uma vez para mapear os papéis de modelo dos 18 agentes internos
> (`fast`, `strong`, `thinker`, …) para seus próprios modelos — um seletor interativo.
> Pule esta etapa e os agentes usarão o modelo padrão do Pi. Veja [Papéis de modelo](#papéis-de-modelo).

**2. Execute** — basta pedir ao modelo em uma sessão Pi:

> *Execute uma cadeia: primeiro explore o fluxo de autenticação, depois resuma as descobertas.*

O modelo chama a ferramenta `taskflow` automaticamente. Você vê progresso ao vivo, tempo por etapa, custo de tokens e um registro de execução salvo — **mesmo esforço que a ferramenta interna, agora rastreável e retomável.**

**3. Salve** — diga *"salve isso"* e você terá `/tf:<name>` para sempre.

É isso. Você pode estar executando seu primeiro fluxo antes de seu café esfriar — sem escrever uma única definição de fase.

### A sintaxe abreviada (mesma forma da ferramenta interna)

```jsonc
// Único — um agente, um trabalho
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// Paralelo — dispare vários de uma vez, saídas mescladas
{ "tasks": [
  { "task": "Audit auth in src/api",             "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }

// Cadeia — sequencial; cada etapa vê a saída anterior
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

`agent` é opcional (padrão: primeiro agente descoberto). Adicione um `name` para rotular a execução e desbloquear o salvamento como comando.

## Veja em execução

Isto não é uma simulação. **Isto é a saída real do terminal** — o fluxo `self-improve` que escreve e verifica seus próprios conjuntos de testes, interceptado em pleno voo por um gate de qualidade:

```
⊗ taskflow self-improve  6/7 · blocked · $0.095
    ✓ discover            agent   deepseek-v4-flash  10t ↑38k ↓6.7k $0.011
  ┌ ✓ write-runner-tests  agent   claude-sonnet-4-6  10t ↑13 ↓6.6k $0.020
  ├ ✓ write-store-tests   agent   claude-sonnet-4-6  10t ↑11 ↓10k $0.018
  ├ ✓ write-agents-tests  agent   claude-sonnet-4-6  10t ↑28 ↓13k $0.030
  └ ✓ fix-stability       agent   claude-sonnet-4-6  10t ↑13 ↓3.9k $0.012
    ✓ verify              gate    BLOCK 3 type errors in test files  deepseek-v4-flash
    ⊘ report              reduce  skipped · Gate blocked  ↳ fix-stability
```

**O layout *é* o DAG.** Nenhum painel, nenhum log para grep — você lê a barra de progresso e entende todo o pipeline:

- **Cabeçalho** — `⊗` = bloqueado (um gate o interrompeu); `6/7` fases processadas; custo agregado `$0.095`.
- **Ícones de status** — `✓` concluído · `◐` executando · `✗` falhou · `⊘` pulado · `○` pendente.
- **Trilho `┌ ├ └`** — fases na mesma camada do DAG, executando concorrentemente. As quatro tarefas `write-*`/`fix-stability` se distribuem a partir de `discover`. Uma calha vazia = uma camada de fase única.
- **`↳`** — uma dependência longa que pula camadas. `report` depende de `verify` adjacente *e* de `fix-stability` duas camadas atrás, então apenas essa aresta de salto é anotada.
- **Gate** — `verify` emitiu `VERDICT: BLOCK`, então o runtime pulou `report` e encerrou a execução como `blocked`, exibindo o motivo inline.
- **Detalhe** — por fase: modelo, contagens de token (`↑`entrada `↓`saída), custo, tempo. Fases de distribuição também mostram progresso de subtarefas (`3/15 2✗ 8▸`).

## Torne-se declarativo

A sintaxe abreviada é sua rampa de entrada. A DSL é onde o `pi-taskflow` mostra seu valor — distribuição dinâmica, roteamento estruturado e gates de qualidade.

### Distribuir e reduzir

```jsonc
{
  "name": "summarize-files",
  "description": "Discover files, summarize each, produce one report",
  "args": { "dir": { "default": "." } },
  "concurrency": 8,
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "List source files under {args.dir} (non-recursive).\nOutput ONLY a JSON array [{\"file\":\"\"}]. No prose.",
      "output": "json" },
    { "id": "summarize", "type": "map",
      "over": "{steps.discover.json}", "as": "item", "agent": "scout",
      "task": "Read {item.file} and give a one-sentence summary.",
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["summarize"], "agent": "writer",
      "task": "Combine into a short overview:\n{steps.summarize.output}",
      "dependsOn": ["summarize"], "final": true }
  ]
}
```

1. **`discover`** lista cada arquivo e emite um array JSON.
2. **`summarize`** é um `map` — ele distribui um subagente por arquivo, limitado a 8 concorrentes, com `{item.file}` vinculado a cada caminho.
3. **`report`** é um `reduce` — ele mescla cada resumo em uma visão geral limpa.

Os resumos intermediários nunca entram no seu contexto. O runtime os possui; você recebe o relatório. **Salve uma vez → `/tf:summarize-files dir=src` para sempre.**

### Roteie, gateie, repita, aprove e limite os gastos

```jsonc
{
  "name": "triage-and-fix",
  "budget": { "maxUSD": 1.5 },
  "phases": [
    { "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
      "task": "Classify the bug. Output ONLY {\"severity\":\"high\"} or {\"severity\":\"low\"}." },
    { "id": "deep",  "when": "{steps.triage.json.severity} == high", "dependsOn": ["triage"],
      "agent": "executor-code", "task": "Root-cause and patch it.",
      "retry": { "max": 2, "backoffMs": 500 } },
    { "id": "quick", "when": "{steps.triage.json.severity} == low",  "dependsOn": ["triage"],
      "agent": "executor-fast", "task": "Apply the quick fix." },
    { "id": "approve", "type": "approval", "join": "any", "dependsOn": ["deep", "quick"],
      "task": "Review the fix before it ships." },
    { "id": "ship", "type": "agent", "dependsOn": ["approve"],
      "task": "Open a PR with the change.", "final": true }
  ]
}
```

- **`when`** roteia para `deep` *ou* `quick` a partir do JSON de triagem — o outro ramo é pulado.
- **`join: "any"`** permite que `approve` dispare no momento em que qualquer ramo que executou for concluído (uma junção OR).
- **`retry`** reexecuta um patch instável com backoff; **`budget`** interrompe toda a execução se ficar muito cara.
- **`approval`** pausa para um humano (aprovar / rejeitar / editar) antes do `ship` final.

Sem scripts. Sem `eval`. Apenas dados que o runtime executa — seguro o suficiente para executar definições geradas por LLM diretamente.

## Tipos de fase

| tipo | o que faz | campos obrigatórios |
|------|-----------|---------------------|
| `agent` | um subagente executa uma única tarefa | `task` |
| `parallel` | executa `branches[]` concorrentemente | `branches` (array de `{task, agent?}`) |
| `map` | **distribui** sobre um array — um subagente por item, `{item}` vinculado | `over`, `task` |
| `gate` | etapa de qualidade/revisão que pode **interromper o fluxo** | `task` |
| `reduce` | agrega saídas de fases `from[]` em uma | `from`, `task` |
| `approval` | pausa **humano no loop** — aprovar / rejeitar / editar | — |
| `flow` | executa um **subfluxo salvo** como uma fase (composição) | `use` |
| `loop` | **itera uma tarefa até concluir** — reexecuta um corpo até uma condição, convergência ou limite | `task`, `until` |
| `tournament` | **N variantes competem**, um juiz escolhe a melhor (ou agrega) | `task` \| `branches` |

### Campos comuns de fase

Toda fase precisa de um `id` único e um `type` (padrão: `agent`). Além dos campos específicos de cada tipo:

| Campo | Significado |
|---|---|
| `agent` | Agente a executar (padrão: primeiro agente descoberto) |
| `dependsOn` | IDs de fase que esta fase aguarda — constrói o DAG |
| `join` | `"all"` (padrão) aguarda todas as dependências; `"any"` é uma junção OR |
| `when` | Guarda condicional — pula a menos que a expressão seja verdadeira |
| `retry` | `{ max, backoffMs?, factor? }` — repete um subagente com falha |
| `output` | `"text"` (padrão) ou `"json"` (expõe `{steps.ID.json}`) |
| `model` / `thinking` / `tools` | Sobrescritas por fase para o subagente |
| `cwd` | Diretório de trabalho para o subagente |
| `concurrency` | Limite de distribuição para `map` / `parallel` (sobrescreve o padrão do fluxo) |
| `final` | Marca a fase portadora do resultado (senão a última fase vence) |
| `optional` | Uma falha aqui **não** aborta a execução |
| `use` / `with` | (`flow`) nome do subfluxo salvo + seus argumentos |
| `cache` | `{ scope, ttl?, fingerprint? }` — memoização entre execuções (veja abaixo) |

Chaves em nível de fluxo: `name`, `description`, `args`, `concurrency` (padrão 8), `agentScope` e `budget: { maxUSD?, maxTokens? }`.

### Fluxo de controle e confiabilidade

- **`when`** — pula uma fase a menos que uma expressão seja verdadeira. Suporta `{refs}`, `== != < > <= >=`, `&& || !`, parênteses e strings/números entre aspas. Combine com `join: "any"` na fase de mesclagem para roteamento if/else real. Erros de análise **falham abertamente**.
- **`join: "any"`** — uma junção OR: a fase executa assim que *uma* dependência é concluída (padrão `"all"` aguarda todas).
- **`retry`** — `{ "max": 2, "backoffMs": 500, "factor": 2 }` repete um subagente com falha com backoff fixo ou exponencial; o uso é somado e a contagem de tentativas aparece como `↻N` na TUI. Erros transitórios do provedor (limite de taxa / 5xx / timeout) **repetem automaticamente mesmo sem uma política explícita**; erros graves não.
- **`approval`** — pausa para um humano (Aprovar / Rejeitar / Editar). Rejeitar interrompe o fluxo; Editar injeta a nota digitada como saída da fase para etapas posteriores. Execuções não interativas aprovam automaticamente.
- **`flow`** — `{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }` executa um fluxo salvo como uma fase (recursão é detectada e rejeitada).

### Loop-até-concluir (`loop`)

Alguns trabalhos são inerentemente iterativos — refinar um rascunho até um revisor ficar satisfeito, repetir-e-melhorar até os testes passarem, convergir para uma resposta. Uma fase `loop` reexecuta um corpo de tarefa até que uma condição de parada seja atendida:

```jsonc
{
  "id": "refine",
  "type": "loop",
  "task": "Improve this draft (iteration {loop.iteration}). Previous attempt:\n{loop.lastOutput}\n\nReturn JSON {\"draft\":\"…\",\"done\":true|false}.",
  "until": "{steps.refine.json.done} == true",   // a própria saída da iteração é exposta aqui
  "output": "json",
  "maxIterations": 6,        // padrão 10, limite duro 100 — o loop SEMPRE termina
  "convergence": true        // padrão: para cedo se a saída de uma iteração for idêntica à anterior
}
```

- **Variáveis locais do corpo** — a tarefa pode ler `{loop.iteration}` (baseado em 1), `{loop.lastOutput}` (a saída da iteração anterior) e `{loop.maxIterations}` para construir sobre seu próprio trabalho anterior; todas as três também estão disponíveis para a condição `until`.
- **`until`** — avaliada após cada iteração com a saída da iteração exposta como `{steps.<thisId>.output}` / `.json`. Mesmos operadores que `when`. O loop para no momento em que se torna verdadeiro.
- **Sempre termina.** Quatro paradas independentes: `until` verdadeiro, **convergência** (um ponto fixo — saída idêntica à iteração anterior), **`maxIterations`** (limite duro de 100) ou uma **iteração com falha** (a fase falha com a saída parcial preservada). Um `until` malformado **para** o loop em vez de girar para sempre (fail-safe) e exibe um aviso na fase.
- A TUI mostra `↻N` com o motivo da parada (`done` / `converged` / `max` / `failed`); o uso é somado entre iterações. Assim como `gate`/`approval`, `loop` é **excluído do cache `cross-run`** (cada execução deve iterar do zero).

### Torneio (`tournament`)

Para trabalhos de final aberto, o melhor resultado geralmente vem de gerar vários candidatos e selecionar o mais forte — melhor-de-N com um juiz, em uma fase declarativa:

```jsonc
{
  "id": "headline",
  "type": "tournament",
  "task": "Write a punchy headline for this launch post.",
  "variants": 4,                    // gera 4 competidores da MESMA tarefa (padrão 3, max 20)
  "judge": "Pick the headline with the strongest hook and clearest promise.",
  "judgeAgent": "reviewer",          // opcional; padrão é o agente da fase
  "mode": "best"                     // "best" (padrão) | "aggregate"
}
```

- **Competidores** — ou `variants: N` cópias de uma mesma `task` (a diversidade vem do não-determinismo do modelo), ou `branches: [{task, agent?}, …]` distintas quando você quer confrontar *abordagens diferentes*.
- **Juiz** — após a distribuição, um agente juiz vê cada variante (numerada) mais sua rubrica `judge` e escolhe um vencedor via uma linha `WINNER: <n>` ou `{"winner": n}`. Um veredito ilegível **falha abertamente** para a variante 1; um juiz com falha também cai em fallback — o trabalho nunca é perdido.
- **`mode`** — `best` retorna a variante vencedora **verbatim**; `aggregate` retorna a resposta **sintetizada** do juiz combinando as partes mais fortes.
- **Curto-circuitos:** se apenas um competidor sobreviver, ele vence sem chamada de juiz; se todos falharem, a fase falha. A TUI mostra `⚑ N→#k`; o uso soma variantes + juiz. Assim como `gate`, é **excluído do cache `cross-run`**.
- **`budget`** — um teto global `{maxUSD, maxTokens}`; uma vez excedido, fases pendentes pulam e a distribuição em voo para de gerar, encerrando a execução como `blocked`.
- **Watchdog ocioso** — um subagente que fica em silêncio por 5 minutos é tratado como travado e morto (SIGTERM → SIGKILL), então um filho pendurado nunca pode congelar o fluxo inteiro.

### Memoização entre execuções (`cache`)

Toda fase já é endereçada por conteúdo: dentro da **retomada** de uma única execução, uma fase cujas entradas resolvidas não mudaram é pulada. `cache` estende essa reutilização **entre execuções independentes** — se qualquer execução anterior computou uma fase com um hash de entrada idêntico, seu resultado é reutilizado por **$0.00**.

```jsonc
{
  "id": "analyze-auth",
  "task": "Summarize how the auth module works.",
  "context": ["src/auth/**/*.ts"],
  "cache": {
    "scope": "cross-run",                 // "run-only" (padrão) | "cross-run" | "off"
    "ttl": "6h",                          // idade máxima opcional antes de um hit ser tratado como miss
    "fingerprint": ["git:HEAD", "glob:src/auth/**/*.ts"]  // dobra o estado do mundo na chave
  }
}
```

- **`scope`** — `"run-only"` (padrão) é exatamente o comportamento histórico (retomada apenas dentro da execução). `"cross-run"` opta a fase pelo armazenamento persistente. `"off"` desabilita completamente a reutilização (mesmo dentro de uma execução), para depuração.
- **Atualidade é o jogo inteiro.** A chave de cache já inclui o prompt, os itens `over` e quaisquer arquivos `context` (pré-lidos na tarefa). `fingerprint` dobra *entradas implícitas* na chave para que "o mundo mudou" se torne um cache miss: `git:HEAD`, `glob:<pat>` (tamanho+mtime), `glob!:<pat>` (hash de conteúdo), `file:<path>`, `env:<NAME>`. `ttl` (`30m`/`6h`/`7d`) é um backstop de tempo.
- **Limite honesto:** um subagente que lê um arquivo que não declarou em `context`/`fingerprint` ainda pode servir um hit `cross-run` obsoleto. É por isso que o padrão é `run-only` e por que fases `gate`/`approval` são **proibidas** de `cross-run` (elas devem produzir um resultado fresco a cada execução). Opte apenas por fases cuja saída é uma função das entradas declaradas.
- Cache reside em `.pi/taskflows/cache/` (gitignorado). Limpe com `action: "cache-clear"`. Raciocínio completo: [`docs/rfc-cross-run-memoization.md`](./docs/rfc-cross-run-memoization.md).

### Fases de gate (controle de qualidade)

Um `gate` executa um agente para revisar a saída upstream e pode **bloquear o resto do fluxo de trabalho.** Termine a tarefa do gate pedindo um veredito que o runtime possa ler:

- uma linha final `VERDICT: PASS` ou `VERDICT: BLOCK` (também aceita `OK`, `FAIL`, `STOP`, `REJECT`, `HALT` — a última ocorrência vence), ou
- JSON como `{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block", "reason": "..."}`.

Em **BLOCK**, fases downstream pulam e a execução termina como `blocked` com o motivo exibido. **Saída ambígua falha abertamente** (tratada como PASS) — um gate nunca interrompe seu fluxo acidentalmente.

```
Review the audit below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

## Interpolação e expressões

| placeholder | resolve para |
|---|---|
| `{args.X}` | argumento de invocação |
| `{steps.ID.output}` | saída de texto de uma fase anterior |
| `{steps.ID.json}` | saída anterior analisada como JSON (ou `{steps.ID.json.field}`) |
| `{item}` / `{item.field}` | item atual dentro de uma fase `map` |
| `{previous.output}` | saída da fase imediatamente upstream |

Gramática de condição (para `when`): `== != < > <= >=`, `&& || !`, parênteses, strings/números entre aspas e qualquer referência `{...}` — ex.: `"when": "{steps.triage.json.route} == deep && {args.force} != true"`.

> Referenciar `{steps.X}` que não está declarado em `dependsOn` é um **erro de validação grave** — o runtime detecta o bug de pipeline mais comum antes que um único agente execute.

## Comandos

Fluxos salvos se tornam atalhos de CLI. Todos os comandos rodam na sessão Pi:

| Comando | O que faz |
|---|---|
| `/tf list` | Lista todos os fluxos salvos |
| `/tf run <name> [args]` | Executa um fluxo salvo (ex.: `/tf run summarize-files dir=src`) |
| `/tf show <name>` | Imprime a definição de um fluxo |
| `/tf runs` | Navega pelo histórico recente de execuções (TUI interativa) |
| `/tf resume <runId>` | Continua uma execução pausada/com falha — fases em cache pulam automaticamente |
| `/tf init` | **Mapeia interativamente papéis de modelo** para seus modelos habilitados (escreve em `~/.pi/agent/settings.json`) |
| `/tf:<name> [args]` | Atalho — executa o fluxo em um toque |

Ações da ferramenta (usadas pelo modelo): `run` (`define` inline ou `name` salvo), `save`, `resume`, `list`, `init`.

## Retomada entre sessões

Uma execução de taskflow não está vinculada à sua sessão. Cada fase concluída é escrita em disco, então uma execução que falha (ou que você interrompe) pode ser continuada depois com `/tf resume <runId>` — **fases em cache pulam automaticamente** e apenas o trabalho restante gasta tokens.

<div align="center">
<img src="./assets/resume.png" alt="Uma execução falha no meio da sessão 1; na sessão 2, /tf resume pula as fases em cache e reexecuta apenas a fase com falha e o que vem depois" width="900">
</div>

A retomada é indexada pelo hash de entrada de cada fase — se uma saída upstream mudou, as fases dependentes reexecutam; se nada mudou, elas são reutilizadas. Nenhuma outra extensão Pi concorrente faz isso entre sessões.

## Armazenamento

```
.pi/taskflows/<name>.json          # definições com escopo de projeto (commite para compartilhar)
~/.pi/agent/taskflows/<name>.json  # definições com escopo de usuário
.pi/taskflows/runs/<runId>.json    # estado da execução para retomada (gitignore disto)
```

> Commite `.pi/taskflows/` e todo seu time compartilha os pipelines — sem sincronização de configuração, sem documento de integração. O estado da execução é escrito atomicamente e protegido por um bloqueio de arquivo zero-dependência, então execuções concorrentes nunca corrompem o índice.

Escopo de descoberta de agente (via `agentScope` na definição do fluxo):

| valor | descobre agentes de |
|---|---|
| `"user"` (padrão) | `~/.pi/agent/agents/*.md` |
| `"project"` | `.pi/agents/*.md` (sobe na árvore) |
| `"both"` | usuário + projeto; projeto vence em colisão de nome |

## Agentes

O Taskflow vem com **18 agentes internos** — cada um um arquivo `.md` com um prompt de sistema ajustado, nível de thinking e conjunto de ferramentas. Você pode referenciá-los pelo `name` em qualquer fase ou atalho, logo após a instalação. Nenhuma configuração necessária.

### Lista de agentes internos

| Agente | Papel | Thinking | Papel padrão |
|---|---|---:|---|
| `executor` | Implementar mudanças de código planejadas | high | `{{fast}}` |
| `executor-fast` | Correções triviais (≤2 arquivos, ≤50 linhas) | off | `{{fast}}` |
| `executor-code` | Implementação complexa de múltiplos arquivos | high | `{{strong}}` |
| `executor-ui` | Mudanças de frontend / estilo / visuais | high | `{{vision}}` |
| `scout` | Reconhecimento rápido de base de código & mapeamento de arquivos | off | `{{fast}}` |
| `planner` | Criação de plano de implementação | high | `{{strong}}` |
| `analyst` | Análise de requisitos, detecção de ambiguidade | high | `{{thinker}}` |
| `critic` | Autodúvida inline durante raciocínio | xhigh | `{{thinker}}` |
| `reviewer` | Revisão geral de código / arquitetura | high | `{{strong}}` |
| `risk-reviewer` | Risco de backend / infra / DB / API | high | `{{reasoner}}` |
| `security-reviewer` | Vulnerabilidades de segurança, auth/crypto | xhigh | `{{reasoner}}` |
| `plan-arbiter` | Gate de qualidade de plano (tarefas complexas) | high | `{{arbiter}}` |
| `final-arbiter` | Desempate quando críticos discordam | xhigh | `{{arbiter}}` |
| `test-engineer` | Projetar e implementar testes | high | `{{fast}}` |
| `doc-writer` | Criação de documentação | off | `{{fast}}` |
| `recover` | Recuperação de sessão após compactação | low | `{{fast}}` |
| `verifier` | Executar testes, validar resultados | off | `{{fast}}` |
| `visual-explorer` | Análise de metadados de design Figma | high | `{{vision}}` |

Agentes são em camadas: **interno → usuário (`~/.pi/agent/agents/`) → projeto (`.pi/agents/`)**. Um agente de usuário ou projeto com o mesmo `name` sobrescreve o interno — então você pode personalizar qualquer agente sem tocar no pacote.

### Papéis de modelo

O campo `model` de cada agente interno usa um **placeholder de papel** (ex.: `{{fast}}`) em vez de uma string de provedor fixa. Isso desacopla *intenção* de *implementação* — você mapeia papéis para modelos uma vez, e todo agente se adapta.

| Papel | Intenção | Modelo típico |
|---|---|---|
| `{{fast}}` | Barato e rápido — alto volume, baixo risco | DeepSeek V4 Flash |
| `{{strong}}` | Equilibrado — planejamento, revisão, complexidade moderada | MiMo v2.5 Pro |
| `{{thinker}}` | Análise profunda — requisitos, crítica | DeepSeek V4 Pro |
| `{{arbiter}}` | Julgamento final — desempate, gates de qualidade de plano | Qwen 3.7 Max |
| `{{vision}}` | Multimodal — trabalho de UI, leitura de design | MiniMax M3 |
| `{{reasoner}}` | Raciocínio cauteloso — segurança, risco | GLM 5.1 |

Sem configuração, os agentes recorrem ao modelo padrão do Pi. Para mapear papéis para modelos reais, execute a configuração interativa:

```bash
/tf init
```

`/tf init` começa com um **menu de ação**. Usuários de primeira viagem veem um atalho de 2 opções ("Usar padrões recomendados" / "Configurar cada papel"). Usuários recorrentes veem o menu completo de 5 opções:

```
? O que você quer fazer com os papéis de modelo?
  ❯ Usar padrões recomendados
    Configurar cada papel
    Editar um papel
    Mostrar papéis atuais
    Cancelar
```

O seletor mostra **nomes de exibição** dos modelos com flags de capacidade e marcadores de atual/recomendado:

```
? Modelo para 'vision' — Multimodal (executor-ui, visual-explorer)
  Atual: openrouter/anthropic/claude-sonnet-4-6
  Recomendado: minimax/MiniMax-M3
  ───────────────
  ❯ MiniMax M3 (minimax/MiniMax-M3) · image ✓ · reasoning ✓ · (recomendado)
    Claude Sonnet 4.6 (openrouter/anthropic/...) · image ✓ · reasoning ✓ · (atual)
    GPT-5 (openrouter/openai/gpt-5) · image ✓
    DeepSeek V4 Flash (openrouter/deepseek/v4-flash)
    ───────────────
    Custom (digite o seu próprio)
    Manter atual
    Voltar ao menu de ação
```

Antes de salvar, uma **tela de pré-visualização** mostra o diff de suas alterações:

```
? Revisar alterações:
  fast       openrouter/deepseek/deepseek-v4-flash   (inalterado)
  strong     openrouter/xiaomi/mimo-v2.5-pro         (inalterado)
  thinker    openrouter/qwen/qwen3.7-max             (alterado ← era: openrouter/deepseek/v4-pro)
  arbiter    openrouter/qwen/qwen3.7-max             (inalterado)
  vision     minimax/MiniMax-M3                      (inalterado)
  reasoner   z-ai/glm-5.1                            (inalterado)
  ───────────────
  ❯ Salvar estas alterações
    Editar um papel
    Cancelar
```

Suas escolhas são escritas em `~/.pi/agent/settings.json`:

```json
{
  "modelRoles": {
    "fast":     "openrouter/deepseek/deepseek-v4-flash",
    "strong":   "openrouter/xiaomi/mimo-v2.5-pro",
    "thinker":  "openrouter/deepseek/deepseek-v4-pro",
    "arbiter":  "openrouter/qwen/qwen3.7-max",
    "vision":   "minimax/MiniMax-M3",
    "reasoner": "z-ai/glm-5.1"
  }
}
```

Edite os valores manualmente a qualquer momento, ou apenas reexecute `/tf init`. Você também pode sobrescrever agentes individuais via `subagents.agentOverrides` no mesmo arquivo:

```json
{
  "modelRoles": { ... },
  "subagents": {
    "agentOverrides": {
      "executor": { "model": "anthropic/claude-sonnet-4-20250514" },
      "reviewer": { "thinking": "xhigh" }
    }
  }
}
```

### Caminho da ferramenta (`action="init"`)

O modelo também pode configurar papéis via a ferramenta `taskflow`:

| Modo | Comportamento |
|---|---|
| `mode: "show"` (padrão) | Relatório somente leitura dos `modelRoles` atuais. Nunca sobrescreve. |
| `mode: "apply-defaults"` + `force: true` | Escreve `RECOMMENDED_DEFAULTS` em `settings.json`, preservando chaves obsoletas. |
| `mode: "interactive"` | Inicia o menu de ação completo + fluxo do seletor (requer uma sessão de UI). |

> **Nota de depreciação v0.0.13:** Se `mode` for omitido, a ferramenta recai ao comportamento v0.0.12 quando `modelRoles` estiver vazio (autoescreve padrões) com um aviso `console.warn` de depreciação. Se `modelRoles` já existir, comporta-se como `mode: "show"`. Esta ponte será removida na v0.0.14.

### Agentes personalizados

Coloque um arquivo `.md` em `~/.pi/agent/agents/` (nível de usuário) ou `.pi/agents/` (nível de projeto, comite-o) para adicionar o seu próprio:

```markdown
---
name: my-linter

description: Run ESLint and report violations

tools: read, bash

model: "{{fast}}"

thinking: off
---

You are a linting agent. Run `npx eslint --format json` on the
provided files. Report violations grouped by file. No fixes.
```

Em seguida, referencie-o em qualquer fase: `{ "agent": "my-linter", "task": "Lint src/" }`.

## Exemplos

Definições prontas para leitura em [`examples/`](./examples):

| Arquivo | Demonstra |
|---|---|
| [`summarize-files.json`](./examples/summarize-files.json) | discover → `map` distribuição → `reduce` |
| [`conditional-research.json`](./examples/conditional-research.json) | Roteamento `when` + `join: any` + `gate` + `budget` |
| [`guarded-refactor.json`](./examples/guarded-refactor.json) | `approval` (humano no loop) + `retry` + `gate` |

Copie um para `.pi/taskflows/<name>.json` (ou `~/.pi/agent/taskflows/`) e ele se registra como `/tf:<name>` — ou apenas aponte o modelo para ele.

## O que há dentro

<div align="center">

**0 dependências de runtime** · **394 testes** · **10 tipos de fase** · **retomada entre sessões** · **memoização entre execuções** · **~4.9k LOC de runtime**

</div>

- **Zero dependências de runtime.** Sem campo `dependencies` — o runtime é construído inteiramente em módulos internos do Node (`fs` / `path` / `os` / `child_process` / `crypto`). O bloqueio de arquivo é `fs.openSync("wx")`, não uma biblioteca de terceiros.
- **371 testes em 14 suítes** cobrindo concorrência, bloqueio atômico de arquivo (regressões de corrida com 8 processos), endurecimento contra path-traversal, retomada entre sessões, atualidade de cache entre execuções (isolamento de chave fluxo/thinking/ferramentas, invalidação de fingerprint, expurgo TTL/LRU), vereditos de gate, limites de budget, repetição/backoff, fluxos de approval, terminação de loop, julgamento de tournament, composição de subfluxo, isolamento de callback, watchdog ocioso, configuração de init de papéis de modelo e parseModelFromLabel com regressão de nome de modelo entre parênteses — além de um teste end-to-end ao vivo que gera subagentes reais e um dogfood de cache entre execuções.
- **Endurecido por design.** Defesa contra path-traversal (léxico + `realpath`), validação de runId, sanitização de HTML/erros, escritas atômicas, roubo de bloqueio obsoleto via `rename` e um watchdog ocioso que mata subagentes travados.
- **Dogfooded.** Cada novo recurso tem que sobreviver ao próprio fluxo `self-improve` do projeto antes de ser lançado.

## 🍽️ Comemos da nossa própria comida

Cada recurso do `pi-taskflow` é lançado **através do próprio `pi-taskflow`.**

Nosso fluxo `self-improve` é um DAG de 10 fases — ele audita a base de código, corrige defeitos, verifica correção, gateia na qualidade e exibe o relatório — tudo declarativamente. Ele é salvo como `/tf:self-improve` e executado antes de cada lançamento. Nenhum outro orquestrador de agente no ecossistema Pi se constrói com ele mesmo.

| Campanha | Escala | Fases | Resultado |
|----------|-------|--------|---------|
| [Dogfood v0.0.8](./docs/dogfooding-v0.0.8-report.md) | Auditoria completa da base → triagem → correção → verificação | 10 fases, 234 testes | 13 correções, todas aprovadas |
| [Autoauditoria v0.0.6](./docs/self-audit-report.md) | inventário → auditoria de mapa → gate → approval → correção map → reduce | 9 fases | 11 defeitos críticos corrigidos |
| [Dogfood de cache entre execuções](./docs/rfc-cross-run-memoization.md) | Runtime real + armazenamento em disco | Harness de teste dedicado | Correção de cache sob fingerprints adversariais |
| [Revisão cruzada adversarial](./docs/brainstorm-adversarial-review-report.md) | Revisão adversarial multiagente | `tournament` + `gate` | Correção de chave de cache P0 enviada |
| [Revisão de redesign do init](./docs/issue-necessity-review-report.md) | Auditoria de necessidade → verificações paralelas → veredito | 7 fases | Plano completo de redesign validado |

> **Meta:** usamos a distribuição `map` do `pi-taskflow`, vereditos `gate`, `approval` humano no loop, `tournament` melhor-de-N, `loop` até-concluir e cache `cross-run` — para construir o próprio `pi-taskflow`.

## Status e limites

**v0.0.13** — loop-até-concluir (fase `loop`: iterar até uma condição, convergência ou limite), torneio (melhor-de-N com juiz), memoização entre execuções (cache endereçado por conteúdo com fingerprints git/arquivo/glob/env e TTL), `/tf init` interativo com seletores de modelo cientes de papel + pré-visualização de diff + escrita de mesclagem atômica, 18 agentes internos com 6 papéis de modelo. Camada completa de fluxo de controle e confiabilidade (guardas `when`, `join: any`, `retry`/backoff, `approval`, composição `flow`, limites `budget`, watchdog ocioso) sobre a DSL + runtime DAG (`agent`/`parallel`/`map`/`gate`/`reduce`). Fluxos inline e salvos, retomada entre sessões, progresso ao vivo e contexto isolado. Uma execução roda como uma única chamada de ferramenta em streaming.

Fronteiras conhecidas (rastreadas, limitadas — sem surpresas no meio do fluxo):

- **Sem execução em segundo plano destacada.** Uma execução precisa da sessão Pi aberta. Execução em segundo plano verdadeira (e gatilhos de evento/cron sobre ela) está no roadmap.
- **Sem `output: "file"`.** Saídas são apenas texto/JSON — escreva arquivos via a chamada de ferramenta `write` de um agente.
- **`map` requer um array JSON.** O campo `over` deve resolver para um array `{steps.ID.json}`. Envolva uma lista de texto em uma fase `output: "json"` de agente único primeiro.
- **O DAG deve ser acíclico.** Ciclos são rejeitados na validação.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test            # testes unitários — sem rede, sem spawn de processos
npm run test:e2e    # end-to-end real (gera subagentes ao vivo; precisa de acesso a modelo)
```

O runtime reside em `extensions/`, testes em `test/`, exemplos executáveis em `examples/` e a justificativa de design completa em [`DESIGN.md`](./DESIGN.md).

## Contribuindo

Contribuições são bem-vindas — este é um projeto jovem e em rápida evolução. Abra uma issue ou PR no [GitHub](https://github.com/heggria/pi-taskflow). Boas primeiras contribuições: novos fluxos de exemplo, ideias de tipos de fase e polimento da TUI.

## Licença

MIT
