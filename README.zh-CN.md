<div align="center">

<img src="./assets/hero.png" alt="taskflow — 面向编码智能体子代理的声明式、可验证的任务节点图：有状态、可恢复、上下文隔离" width="900">

<p>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=B692FF&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/dm/pi-taskflow?style=flat-square&color=6E8BFF&label=downloads" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-43D9AD?style=flat-square" alt="MIT license"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/runtime%20deps-0-43D9AD?style=flat-square" alt="zero runtime dependencies"></a>
  <a href="https://github.com/heggria/taskflow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heggria/taskflow/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/tests-872-6E8BFF?style=flat-square" alt="872 tests"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/dogfooded-%E2%9C%93-43D9AD?style=flat-square" alt="dogfooded"></a>
  <a href="#run-it-on-your-agent"><img src="https://img.shields.io/badge/runs%20on-Pi%20%2B%20Codex-B692FF?style=flat-square" alt="runs on Pi and Codex"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="./docs/i18n/README.hi.md">हिन्दी</a> ·
  <a href="./docs/i18n/README.es.md">Español</a> ·
  <a href="./docs/i18n/README.ar.md">العربية</a>
  <!-- 其余翻译版本文档创建后可添加链接:
  · <a href="./docs/i18n/README.bn.md">বাংলা</a>
  · <a href="./docs/i18n/README.pt.md">Português</a>
  · <a href="./docs/i18n/README.ru.md">Русский</a>
  -->
</p>

<p><strong>面向编码智能体子代理（subagent）的声明式、可验证的「任务图」。</strong><br/>
不是你要去「写脚本」的 workflow——而是你去「声明」的一张 DAG。并发分发（fan out）· 门控（gate）· 恢复（resume）· 保存为命令——中间结果始终远离你的上下文窗口（context window）。<br/>
可运行于 <a href="https://pi.dev">Pi</a> 编码智能体与 <a href="https://github.com/openai/codex">OpenAI Codex</a>。</p>

```bash
# Pi
pi install npm:pi-taskflow

# Codex
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow
```

</div>

---

**`workflow` 是在「流动」，而 `taskflow` 是一张「图」。** 其他编排框架让模型去「写脚本」——命令式的代码逐步流动，而那张图藏在控制流里。`taskflow` 恰恰相反：你把工作**声明**为一张由离散、具名的**任务（task）节点**、通过 `dependsOn` 边连接而成的图——而运行时会在花掉一个 token 之前，*先验证这张图。*

你已经熟悉内置子代理（subagent）工具的 `task` / `tasks` / `chain` 了。`taskflow` 使用**完全相同的简写语法**——所以你现有的委托立刻就能变成**可追踪、可恢复、可保存为一条 `/tf:<name>` 命令**的流程。当你超越简写语法时，完整的 DSL 为你提供真正的 DAG：针对数十个项目的动态并发分发、条件路由、质量门控、人工审批、重试，以及硬性费用上限。

而且自始至终，**只有最终阶段（final phase）才会进入你的对话。** 每一个中间转录都留在运行时中，永远不会进入你的上下文窗口。

## 为什么叫 “taskflow” 而不是 “workflow”？

名字就是立论。在工程语境里，**task（任务）**是一个*离散、被声明出来的工作单元*——是任务图的节点（构建系统、调度器、编译器都把这种 `task` 连成 DAG）。而 **work（工作）**息息相反，是*流动的、无界的*——那种连续的、命令式的「干活」过程。

这个区别，恰恰就是 Pi 生态里的设计分水岭：

<div align="center">
<img src="./assets/task-vs-work.png" alt="work 是一段流动的命令式脚本，它的图藏在控制流里、运行前无法验证；taskflow 是一张由离散任务节点构成的声明式图，在花掉任何 token 之前就被静态验证" width="900">
</div>

- 一个 **`workflow`**（那种动态的、code-mode 的形态）是模型在写一段**「流动」的命令式脚本**：`await agent(...)`、一个 `if`、一个 `for`、又一个 `await`。很有表达力——它是图灵完备的——但那张图只在*代码跑起来的时候*才存在。你看不到它、diff 不了它，也无法在付费之前证明它会终止。
- 一个 **`taskflow`** 把计划**从代码中移出、放进一张由 `task` 节点构成的声明式图里。** 因为这张图是*数据*，运行时就能做到命令式脚本从结构上做不到的事：在任何子代理被启动之前就**静态验证它**（无环、无死端、不超预算、无悬空引用）、**渲染它**（实时进度*本身就是*那张 DAG）、**逐阶段恢复它**，以及把它**保存为一条命令**。

> **我们有意为之的取舍：**我们放弃了任意代码的极致表达力，换来了命令式脚本永远无法拥有的东西——一张**可验证、可观测、可重放、且能安全交给 LLM 生成**的图。当一个任务需要十二个步骤、带分支并发分发和一道审查门控时，你要的是一张能*检查*的图——而不是一段你只能*祈祷*它跑对的脚本。

## 为什么需要这个

这就是你在使用原生子代理时遇到的瓶颈：你用文字描述一个多步骤计划，模型每次都要重新推导，中间转录物塞满你的上下文，一旦某次模型调用失败你就得从头开始。没有复用，没有恢复，没有结构——也没有任何办法在烧掉 token 之前*检查*这个计划。

`taskflow` 把计划**从提示词中移出，放入一张由任务节点构成的声明式图里。** 运行时（runtime）拥有 DAG、循环、重试和中间状态的所有权。你声明一次流水线，就能按名字运行上百次。因为这个计划是数据——不是文字，也不是代码——所以它可以被**验证、可视化、重放**。

<div align="center">
<img src="./assets/context-isolation.png" alt="使用原生子代理时每个转录物都涌入你的上下文；使用 taskflow 时转录物留在运行时，只有最终结果返回" width="900">
</div>

> 十二个步骤、分支并发分发、一道审查门控、一个费用上限——这就是一张图，你想要*看到并检查*它，而不是每次运行都重新提示一遍。

| | 子代理（内置） | **taskflow** |
|---|---|---|
| **谁在驱动** | 模型，逐轮驱动 | 运行时，依据定义驱动 |
| **拓扑结构** | 链式 / 平面并行 | **带分层并发 + 路由的 DAG** |
| **中间结果** | 在你的上下文窗口中 | **在运行时中——不在你的上下文里** |
| **规模** | 少量任务 | **动态 `map` 并发分发，覆盖数十个项目** |
| **可复用** | 每次重新描述 | **保存为 `/tf:<name>`** |
| **可恢复** | ✗ | **✓ 跨会话（cross-session）——已缓存的阶段自动跳过** |
| **质量门控** | ✗ | **`gate` 阶段，在 `VERDICT: BLOCK` 时停止** |
| **条件路由** | ✗ | **`when` 守卫 + `join: any` 或连接（OR-join）** |
| **容错** | ✗ | **逐阶段 `retry` + 瞬态错误自动重试** |
| **人机协作** | ✗ | **`approval` 阶段（批准 / 拒绝 / 编辑）** |
| **成本控制** | ✗ | **全运行 `budget`（USD / 代币上限）** |
| **组合** | ✗ | **`flow` 阶段运行已保存的子流程** |
| **实时进度** | 运行时不可见 | **实时 DAG 渲染，附带耗时和成本** |
| **易用性** | 每次内联 JSON | **简写语法（`task`/`tasks`/`chain`）*或* DSL** |

它没有取代子代理工具。它给你的子代理赋予了一张**图**、一份记忆和一个名字。

## 声明式图 vs 命令式脚本

精神上最接近 `taskflow` 的，是那种**动态 / code-mode 的 workflow**——模型写一段 JavaScript 编排脚本。它强大、且确实很有表达力。但它位于某个根本轴的*另一极*：**表达力 vs 可验证性。**

| | 动态 `workflow`（code-mode） | **`taskflow`**（声明式图） |
|---|---|---|
| **计划是什么** | 模型书写并运行的命令式 JS | **运行时执行的声明式 JSON 数据** |
| **那张图** | 隐式——藏在 `if`/`for`/`await` 控制流里 | **显式——`phases[]` + `dependsOn` 边，一等对象** |
| **运行前验证** | ✗ 图灵完备；无法证明会终止 | **✓ 静态检查：无环、无死端、不超预算、无悬空引用** |
| **看到它** | ✗ 图只在代码跑起来时存在 | **✓ 实时进度渲染*本身就是* DAG** |
| **恢复** | 粗粒度（调用缓存去重） | **✓ 逐阶段输入哈希恢复，跨会话** |
| **能否安全交给 LLM 生成** | 有风险——它是可执行代码 | **✓ 它只是数据——无 `eval`、无任意执行** |
| **表达力上限** | **更高**——任意控制流 | 受 DSL 限制（但 `map`/`when`/`loop`/`gate` 覆盖了大多数任务） |

我们有意选了**可验证**的那一边。你放弃的表达力是真实的；但你换回的——一张能检查、能看、能重放、能安全交给模型书写的计划——才是把一次性提示变成持久编排的关键。

## 与其他 Pi 扩展的对比

Pi 生态现在有 **20 多个委托、工作流和编排扩展**——每个在各自领域都很出色。以下是一份诚实的定位图（已对照每个包截至 2026 年 6 月的最新 npm 发布版核实）。完整的对比——每个包的优缺点——请参见 [`PI-ECOSYSTEM.md`](./docs/internal/PI-ECOSYSTEM.md)。更广泛的非 Pi 生态对比（LangGraph、Temporal、CrewAI、Mastra……）请参见 [`COMPETITORS.md`](./docs/internal/COMPETITORS.md)。

| 扩展 | 模型 | 自定义 DSL | DAG | 动态并发分发 | 跨会话恢复 | 质量门控 | 人工审批 | 保存为命令 | 零依赖 |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **taskflow** | **声明式多阶段 taskflow** | **✓** | **✓** | **✓ `map`** | **✓ phase-hash** | **✓** | **✓** | **✓ `/tf:<name>`** | **✓** |
| [`@pi-agents/orchid`](https://www.npmjs.com/package/@pi-agents/orchid) | 固定 9 阶段流水线 + Ralph 循环 | 固定 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ (2) |
| [`pi-crew`](https://www.npmjs.com/package/pi-crew) | 角色团队 + git worktree + 异步 | 部分 | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✕ (7) |
| [`ultimate-pi`](https://www.npmjs.com/package/ultimate-pi) | 受管制的 plan→execute→review 框架 | YAML 合约 | ✓（规划时） | ✕ | ✓ | ✓（3 级） | ✓ | ✓ | ✕ (16) |
| [`@zhushanwen/pi-workflow`](https://www.npmjs.com/package/@zhushanwen/pi-workflow) | JS 脚本（`agent`/`parallel`/`pipeline`） | 是（JS） | ✕（线性） | ✓ | ✓ | ✕ | ✕ | ✓（调用缓存） | ✓ |
| [`@fiale-plus/pi-rogue-orchestration`](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | 定时器循环 + 目标解析 | ✕ | ✕ | ✕ | ✓ | ✓（目标检查） | ✕ | ✕ | ✓ |
| [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | 单/并行/链式委托 | ✕ | ✕ | 静态 | – | ✕ | clarify | 命名工作流 | ✕ (3) |
| [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents) | Claude-Code 风格子代理 + worktree | ✕ | ✕ | ✕ | ✓（按 id） | ✕ | 逐代理 | ✕ | ✕ (1) |
| [`pi-pipeline`](https://www.npmjs.com/package/pi-pipeline) | 固定 SPEC→PLAN→TASKS→VERIFY | ✕ | 固定 | ✕ | 会话内规划 | ✓ | clarify | ✕ | ✕ (2) |
| [`pi-agent-flow`](https://www.npmjs.com/package/pi-agent-flow) | 一次性并行专业 `fork` | 是 | ✕ | ✕ | – | ✕ | ✕ | – | ✕ (2) |

*（20 多个扩展的代表性切片——完整列表及 `@0xkobold/pi-orchestration`、`@melihmucuk/pi-crew`、`@mediadatafusion/pi-workflow-suite`、`gentle-pi`、`@dreki-gg/pi-subagent` 等请参见 [`PI-ECOSYSTEM.md`](./docs/internal/PI-ECOSYSTEM.md)。）*

**如何选择：**

- **`@pi-agents/orchid`** 是生态中功能最完整的编排器（DAG + worktree + Ralph 循环 + 代理邮箱）——但其 DSL 是*固定*的 9 阶段流水线，携带运行时依赖 + jiti，且处于 beta 阶段。当你想**定义自己的图结构**（而非采用别人的固定观点），并且追求**零依赖**和一条命令安装时，选 `taskflow`。
- **`pi-crew` / `ultimate-pi`** 更重——worktree 隔离、持久的异步团队、多层治理。如果你想要轻量、声明式、零依赖，那就选本项目。
- **`@zhushanwen/pi-workflow`** 精神上最为接近，也是零依赖，但它站在上述分水岭的**命令式**那一边：你要以模型书写并运行的 **JavaScript 脚本**来编写工作流。`taskflow` 的**声明式 JSON DAG** 是可验证的那一边——可静态检查、可可视化、可安全交给 LLM 生成，且恢复粒度精细到阶段级别而非调用缓存去重。
- **`@fiale-plus/pi-rogue-orchestration`** 拥有真正的**循环至完成**（`taskflow` 尚不具备的功能）。如果你的任务是"一直做直到目标达成"，它值得一看；而 `taskflow` 适用于*结构化、分支式的*流水线。
- **`pi-subagents` / `@gotgenes/pi-subagents`** 是即席"用 reviewer 审查这个 diff"委托和后台作业的成熟选择。`taskflow` 则适用于当这些委托需要变成*可重复、可恢复的流水线*时。
- **`pi-pipeline` / `pi-agent-flow`** 提供的是*固定观点、固定结构*的流程。`taskflow` 提供的是*一张空白画布*：你（或模型）声明适合任务的图结构。

> 诚实的一句话总结：**`taskflow` 是唯一一个给你一张*声明式、可验证、可恢复*的任务节点 DAG 的 Pi 扩展——保存为一条单词命令，零运行时依赖，且从设计上就上下文隔离。** code-mode 的 workflow 让模型去*写脚本*跳动工作，`taskflow` 则让它*声明一张运行时能在执行前证明其正确的图。*

## 30 秒快速开始

### 在 Pi 上

**1. 安装**——一条命令：

```bash
pi install npm:pi-taskflow
```

> **可选：** 运行 `/tf init` 一次，将 18 个内置代理的模型角色（model role）
>（`fast`、`strong`、`thinker`……）映射到你已启用的模型——交互式选择器。
> 跳过此步骤则代理使用 Pi 的默认模型。参见[模型角色](#模型角色)。

**2. 运行**——直接在 Pi 会话中告诉模型：

> *运行一个链式任务：先探索认证流程，然后总结发现。*

模型会自动调用 `taskflow` 工具。你会看到实时进度、每步耗时、代币成本和已保存的运行记录——**与内置工具同样省力，现在可追踪且可恢复。**

**3. 保存**——说一句 *"save it"*，你就永远拥有了 `/tf:<name>`。

就这么简单。你可以在咖啡凉下来之前运行第一个工作流——无需编写任何阶段定义。

<a id="run-it-on-your-agent"></a>
### 在 Codex 上

taskflow 以 Codex **插件（plugin）** 的形式发布——安装一次，`taskflow_*` MCP 工具与一个路由 skill 便会自动生效，无需手动 `mcp add`，也无需改配置：

```bash
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow
```

插件通过 `npx`（`codex-taskflow`）声明其 MCP server，按需拉起，全局无需再装任何东西。随后只要让 Codex 执行多阶段或扇出任务，它就会调用这些工具。参见 [Codex 指南](./docs/codex-mcp.md)。

### 简写语法（与内置工具相同的格式）

```jsonc
// 单一任务——一个代理，一个任务
{ "task": "Summarize the architecture of src/", "agent": "explorer" }

// 并行——同时触发多个任务，输出合并
{ "tasks": [
  { "task": "Audit auth in src/api",             "agent": "analyst" },
  { "task": "Audit input validation in src/api", "agent": "analyst" }
] }

// 链式——顺序执行；每个步骤可以看到前一个步骤的输出
{ "chain": [
  { "task": "List the public API of src/lib", "agent": "scout" },
  { "task": "Write docs for:\n{previous.output}", "agent": "writer" }
] }
```

`agent` 是可选的（默认使用第一个发现的代理）。添加 `name` 来标记运行并解锁将其保存为命令的功能。

## 看看它如何运行

这不是模拟图。**这是真实运行的 stdout**——`self-improve` 流程会编写并验证自己的测试套件，被质量门控在中途捕获：

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

**布局本身就是 DAG。** 没有仪表盘，没有需要 grep 的日志——你看一眼进度条就了解了整个流水线：

- **头部（header）**——`⊗` = 被阻塞（门控将其停止）；`6/7` 个阶段已处理；累计成本 `$0.095`。
- **状态图标**——`✓` 完成 · `◐` 运行中 · `✗` 失败 · `⊘` 已跳过 · `○` 等待中。
- **轨道线 `┌ ├ └`**——同一 DAG 层中的阶段，并发运行。四个 `write-*`/`fix-stability` 任务从 `discover` 并发分发出去。空白侧边线 = 单阶段层。
- **`↳`**——跨层长距离依赖。`report` 依赖于相邻的 `verify` *以及*两层级之前的 `fix-stability`，因此只标注了这条跳过边。
- **门控（gate）**——`verify` 发出了 `VERDICT: BLOCK`，因此运行时跳过了 `report`，以 `blocked` 状态结束运行，并将原因内联展示。
- **详情**——每阶段：模型、代币数量（`↑` 输入 `↓` 输出）、成本、耗时。并发分发阶段还显示子任务进度（`3/15 2✗ 8▸`）。

## 走向声明式

简写语法是你的入口。DSL 才是 `taskflow` 的真正价值所在——动态并发分发、结构化路由和质量门控。

### 并发分发与归约

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

1. **`discover`** 列出每个文件并输出一个 JSON 数组。
2. **`summarize`** 是一个 `map`——它为每个文件并发分发一个子代理，最多 8 个并发，`{item.file}` 绑定到每个文件路径。
3. **`report`** 是一个 `reduce`——它将所有摘要合并为一个干净的概述。

中间的摘要永远不会进入你的上下文。运行时拥有它们；你获得报告。**保存一次 → 永久可用 `/tf:summarize-files dir=src`。**

### 路由、门控、重试、审批与费用上限

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

- **`when`** 根据分诊 JSON 的结果路由到 `deep` *或* `quick`——另一个分支被跳过。
- **`join: "any"`** 让 `approve` 在任意一个分支运行完成时立即触发（或连接 OR-join）。
- **`retry`** 以回退策略重试不稳定的补丁；**`budget`** 在成本过高时停止整个运行。
- **`approval`** 暂停等待人工操作（批准 / 拒绝 / 编辑），然后才进入最终的 `ship`。

无需脚本。无需 `eval`。运行时执行的是纯粹的数据——可以安全地直接运行 LLM 生成的定义。

## 阶段类型

| 类型 | 功能 | 必填字段 |
|------|--------------|-----------------|
| `agent` | 一个子代理运行单个任务 | `task` |
| `parallel` | 并发运行 `branches[]` | `branches`（`{task, agent?}` 数组） |
| `map` | **并发分发**到一个数组——每个项目一个子代理，`{item}` 绑定 | `over`、`task` |
| `gate` | 质量/审查步骤，可以**暂停流程** | `task` |
| `reduce` | 将 `from[]` 阶段的输出聚合为一个 | `from`、`task` |
| `approval` | **人机协作**暂停——批准 / 拒绝 / 编辑 | — |
| `flow` | 将一个**已保存的子流程**作为阶段运行（组合） | `use` |
| `loop` | **迭代一个任务直到完成**——重复运行主体直到条件满足、收敛或达到上限 | `task`、`until` |
| `tournament` | **N 个变体竞争**，评判者选择最佳（或聚合） | `task` \| `branches` |

### 通用阶段字段

每个阶段需要唯一的 `id` 和 `type`（默认为 `agent`）。除各类型特有字段外：

| 字段 | 含义 |
|---|---|
| `agent` | 要运行的代理（默认为第一个发现的代理） |
| `dependsOn` | 本阶段等待的阶段 id——构建 DAG |
| `join` | `"all"`（默认）等待所有依赖；`"any"` 为或连接 |
| `when` | 条件守卫——表达式为真时才执行，否则跳过 |
| `retry` | `{ max, backoffMs?, factor? }`——重试失败的子代理 |
| `output` | `"text"`（默认）或 `"json"`（暴露 `{steps.ID.json}`） |
| `model` / `thinking` / `tools` | 子代理的逐阶段覆盖设置 |
| `cwd` | 子代理的工作目录 |
| `concurrency` | `map` / `parallel` 的并发分发上限（覆盖流程默认值） |
| `final` | 标记为结果承载阶段（否则最后一个阶段胜出） |
| `optional` | 此处失败**不会**中止运行 |
| `use` / `with` | （`flow`）已保存的子流程名称及其参数 |
| `cache` | `{ scope, ttl?, fingerprint? }`——跨运行记忆化（见下文） |

流程级键：`name`、`description`、`args`、`concurrency`（默认 8）、`agentScope` 和 `budget: { maxUSD?, maxTokens? }`。

### 控制流与可靠性

- **`when`**——除非表达式为真，否则跳过阶段。支持 `{refs}`、`== != < > <= >=`、`&& || !`、括号以及带引号的字符串/数字。配合合并阶段的 `join: "any"` 实现真正的 if/else 路由。解析错误**开放失败（fail open）**。
- **`join: "any"`**——或连接：阶段在*一个*依赖完成后立即运行（默认 `"all"` 等待所有依赖）。
- **`retry`**——`{ "max": 2, "backoffMs": 500, "factor": 2 }` 以固定或指数回退策略重试失败的子代理；使用量累加，尝试次数以 `↻N` 形式在 TUI 中显示。瞬态提供商错误（速率限制 / 5xx / 超时）**即使没有显式策略也会自动重试**；硬错误不会。
- **`approval`**——暂停等待人工操作（批准 / 拒绝 / 编辑）。拒绝会中止流程；编辑会将输入内容作为阶段输出注入下游步骤。非交互式运行自动批准。
- **`flow`**——`{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }` 将保存的流程作为阶段运行（循环递归会被检测并拒绝）。

### 循环至完成（`loop`）

有些工作天生就是迭代式的——修改草稿直到评审满意、重试并改进直到测试通过、收敛到最终答案。一个 `loop` 阶段会反复运行一个任务体，直到停止条件成立：

```jsonc
{
  "id": "refine",
  "type": "loop",
  "task": "Improve this draft (iteration {loop.iteration}). Previous attempt:\n{loop.lastOutput}\n\nReturn JSON {\"draft\":\"…\",\"done\":true|false}.",
  "until": "{steps.refine.json.done} == true",   // 迭代自身的输出在这里暴露
  "output": "json",
  "maxIterations": 6,        // 默认 10，硬上限 100——循环一定会终止
  "convergence": true        // 默认：如果某次迭代的输出与前一次完全一致则提前停止
}
```

- **主体局部变量**——任务可以读取 `{loop.iteration}`（从 1 开始）、`{loop.lastOutput}`（前一次迭代的输出）和 `{loop.maxIterations}`，以基于自身之前的输出继续构建；这三个变量对 `until` 条件同样可用。
- **`until`**——每次迭代后评估，迭代输出以 `{steps.<thisId>.output}` / `.json` 暴露。运算符与 `when` 相同。一旦表达式为真，循环立即停止。
- **总是会终止。** 四种独立停止方式：`until` 为真、**收敛**（不动点——输出与前一次迭代完全一致）、**`maxIterations`**（硬上限 100）、或**迭代失败**（阶段失败，部分输出保留）。格式错误的 `until` 会**停止**循环而非永远旋转（故障安全），并在阶段上显示警告。
- TUI 中显示 `↻N` 及停止原因（`done` / `converged` / `max` / `failed`）；使用量跨迭代累加。与 `gate`/`approval` 一样，`loop` **被排除在 `cross-run` 缓存之外**（每次运行必须从头迭代）。

### 锦标赛（`tournament`）

对于开放式工作，最佳结果往往来自生成多个候选并由评判者挑选最强的一个——best-of-N 带评判者，一个声明式阶段搞定：

```jsonc
{
  "id": "headline",
  "type": "tournament",
  "task": "Write a punchy headline for this launch post.",
  "variants": 4,                    // 生成 4 个相同任务的竞争者（默认 3，最多 20）
  "judge": "Pick the headline with the strongest hook and clearest promise.",
  "judgeAgent": "reviewer",          // 可选；默认使用阶段指定的 agent
  "mode": "best"                     // "best"（默认）| "aggregate"
}
```

- **竞争者**——要么 `variants: N` 生成同一 `task` 的 N 份拷贝（多样性来自模型的不确定性），要么使用不同的 `branches: [{task, agent?}, …]` 当你想让*不同方法*相互竞争时。
- **评判者**——并发分发完成后，一个评判代理看到所有变体（编号排列）及你的 `judge` 评分标准，通过 `WINNER: <n>` 行或 `{"winner": n}` 选择胜者。无法解读的判定**开放失败**为变体 1；评判失败也会回退——工作成果不会丢失。
- **`mode`**——`best` **逐字返回**胜出的变体；`aggregate` 返回评判者**综合**各部分精华的答案。
- **短路：**如果只有一个竞争者存活，它直接获胜无需评判调用；如果全部失败，阶段失败。TUI 显示 `⚑ N→#k`；使用量累加变体 + 评判者。与 `gate` 一样，**被排除在 `cross-run` 缓存之外**。
- **`budget`**——整个运行的 `{maxUSD, maxTokens}` 上限；一旦超过，等待中的阶段跳过，正在运行的并发分发停止派发新任务，运行以 `blocked` 状态结束。
- **空闲看门狗（idle watchdog）**——子代理静默 5 分钟会被视为卡死并被终止（SIGTERM → SIGKILL），因此一个挂起的子进程永远无法冻结整个流程。

### 跨运行记忆化（`cache`）

每个阶段本身已经是内容寻址的：在单次运行的**恢复**中，已解析输入未变的阶段会被跳过。`cache` 将这个复用扩展到**独立的运行之间**——如果任何之前的运行计算过相同输入哈希的阶段，其结果被复用，花费**$0.00**。

```jsonc
{
  "id": "analyze-auth",
  "task": "Summarize how the auth module works.",
  "context": ["src/auth/**/*.ts"],
  "cache": {
    "scope": "cross-run",                 // "run-only"（默认）| "cross-run" | "off"
    "ttl": "6h",                          // 可选最长寿命，命中超过此时间视为未命中
    "fingerprint": ["git:HEAD", "glob:src/auth/**/*.ts"]  // 将世界状态折叠到键中
  }
}
```

- **`scope`**——`"run-only"`（默认）即历史行为（仅运行内恢复）。`"cross-run"` 将阶段选择加入持久化存储。`"off"` 完全禁用复用（甚至运行内），用于调试。
- **新鲜度是关键。** 缓存键已包含提示词、`over` 项目和任何 `context` 文件（预读到任务中）。`fingerprint` 将*隐式*输入折叠到键中，使得"世界变了"成为缓存未命中：`git:HEAD`、`glob:<pat>`（大小+修改时间）、`glob!:<pat>`（内容哈希）、`file:<path>`、`env:<NAME>`。`ttl`（`30m`/`6h`/`7d`）是时间安全网。
- **诚实的限制：**一个子代理读取了未在 `context`/`fingerprint` 中声明的文件，仍可能返回过时的 `cross-run` 命中。这就是为什么默认值是 `run-only`，以及为什么 `gate`/`approval` 阶段**禁止**使用 `cross-run`（它们必须在每次运行中产生新鲜的结果）。只对输出是声明输入函数的那类阶段选择加入。
- 缓存位于 `.pi/taskflows/cache/`（被 gitignore 忽略）。使用 `action: "cache-clear"` 清除。完整理由参见 [`docs/rfc-cross-run-memoization.md`](./docs/internal/rfc-cross-run-memoization.md)。

### 门控阶段（质量控制）

一个 `gate` 阶段运行一个代理来审查上游输出，并可以**阻止工作流的其余部分。** 通过以下方式结束门控任务，让运行时能够读取判决：

- 末尾行 `VERDICT: PASS` 或 `VERDICT: BLOCK`（也接受 `OK`、`FAIL`、`STOP`、`REJECT`、`HALT`——按最后一次出现为准），或
- JSON 格式如 `{"continue": false, "reason": "missing auth checks"}` / `{"verdict": "block", "reason": "..."}`。

**BLOCK** 时，下游阶段被跳过，运行以 `blocked` 状态结束，原因内联展示。**模糊的输出开放失败（视为 PASS）**——门控永远不会意外中止你的流程。

```
Review the audit below. If any endpoint is missing auth, end with
"VERDICT: BLOCK" and a one-line reason; otherwise end with "VERDICT: PASS".

{steps.audit.output}
```

## 插值与表达式

| 占位符 | 解析为 |
|---|---|
| `{args.X}` | 调用参数 |
| `{steps.ID.output}` | 之前阶段的文本输出 |
| `{steps.ID.json}` | 之前输出解析为 JSON（或 `{steps.ID.json.field}`） |
| `{item}` / `{item.field}` | `map` 阶段中的当前项目 |
| `{previous.output}` | 紧邻的上游阶段的输出 |

条件语法（用于 `when`）：`== != < > <= >=`、`&& || !`、括号、带引号的字符串/数字，以及任何 `{...}` 引用——例如：`"when": "{steps.triage.json.route} == deep && {args.force} != true"`。

> 引用未在 `dependsOn` 中声明的 `{steps.X}` 是**硬性验证错误**——运行时在第一个代理运行之前就能捕获这个最常见的流水线 bug。

## 命令

保存的流程变成 CLI 快捷方式。所有命令在 Pi 会话中运行：

| 命令 | 功能 |
|---|---|
| `/tf list` | 列出所有已保存的流程 |
| `/tf run <name> [args]` | 运行已保存的流程（例如 `/tf run summarize-files dir=src`） |
| `/tf show <name>` | 打印流程的定义 |
| `/tf runs` | 浏览近期运行历史（交互式 TUI） |
| `/tf resume <runId>` | 继续一个暂停/失败的运行——已缓存的阶段自动跳过 |
| `/tf init` | **交互式映射模型角色**到你的已启用模型（写入 `~/.pi/agent/settings.json`） |
| `/tf:<name> [args]` | 快捷方式——一键运行流程 |

工具动作（由模型使用）：`run`（内联 `define` 或已保存的 `name`）、`save`、`resume`、`list`、`init`。

## 跨会话恢复

taskflow 运行与你的会话无关。每个已完成的阶段都写入磁盘，因此失败（或你中止）的运行可以通过 `/tf resume <runId>` 后续继续——**已缓存的阶段自动跳过**，只有剩余的工作会消耗代币。

<div align="center">
<img src="./assets/resume.png" alt="一个运行在会话 1 中途失败；在会话 2 中 /tf resume 跳过已缓存的阶段，只重新运行失败的阶段及其后续内容" width="900">
</div>

恢复以每个阶段的输入哈希为键——如果上游输出发生了变化，依赖的阶段会重新运行；如果没有变化，则复用结果。没有其他 Pi 扩展能做到跨会话的这一点。

## 存储

```
.pi/taskflows/<name>.json          # 项目级定义（提交以共享）
~/.pi/agent/taskflows/<name>.json  # 用户级定义
.pi/taskflows/runs/<runId>.json    # 运行状态以供恢复（gitignore 此项）
```

> 提交 `.pi/taskflows/`，你的整个团队共享流水线——无需配置同步，无需新手指南。运行状态通过原子写入写入，并由零依赖的文件锁保护，因此并发运行永远不会损坏索引。

代理发现范围（通过流程定义中的 `agentScope`）：

| 值 | 发现代理的来源 |
|---|---|
| `"user"`（默认） | `~/.pi/agent/agents/*.md` |
| `"project"` | `.pi/agents/*.md`（向上遍历目录树） |
| `"both"` | 用户 + 项目；名称冲突时项目覆盖 |

## 代理

Taskflow 自带 **18 个内置代理**——每个代理是一个 `.md` 文件，包含调优的系统提示词、推理级别和工具集。安装后你可以在任何阶段或简写语法中通过 `name` 引用它们。无需任何设置。

### 内置代理列表

| 代理 | 角色 | 推理级别 | 默认角色 |
|---|---|---|---:|---|
| `executor` | 执行规划的代码变更 | high | `{{fast}}` |
| `executor-fast` | 简单修复（≤2 文件，≤50 行） | off | `{{fast}}` |
| `executor-code` | 复杂多文件实现 | high | `{{strong}}` |
| `executor-ui` | 前端 / 样式 / 视觉变更 | high | `{{vision}}` |
| `scout` | 快速代码库侦查与文件映射 | off | `{{fast}}` |
| `planner` | 实现计划创建 | high | `{{strong}}` |
| `analyst` | 需求分析，歧义检测 | high | `{{thinker}}` |
| `critic` | 推理过程中的内联自我质疑 | xhigh | `{{thinker}}` |
| `reviewer` | 通用代码 / 架构审查 | high | `{{strong}}` |
| `risk-reviewer` | 后端 / 基础设施 / 数据库 / API 风险 | high | `{{reasoner}}` |
| `security-reviewer` | 安全漏洞，认证/加密 | xhigh | `{{reasoner}}` |
| `plan-arbiter` | 计划质量门控（复杂任务） | high | `{{arbiter}}` |
| `final-arbiter` | 评判者意见冲突时的裁决者 | xhigh | `{{arbiter}}` |
| `test-engineer` | 设计并实现测试 | high | `{{fast}}` |
| `doc-writer` | 文档撰写 | off | `{{fast}}` |
| `recover` | 压缩后的会话恢复 | low | `{{fast}}` |
| `verifier` | 运行测试，验证结果 | off | `{{fast}}` |
| `visual-explorer` | Figma 设计元数据分析 | high | `{{vision}}` |

代理是分层的：**内置 → 用户（`~/.pi/agent/agents/`）→ 项目（`.pi/agents/`）**。同名用户或项目代理覆盖内置代理——因此你可以自定义任何代理而无需修改包本身。

### 模型角色

每个内置代理的 `model` 字段使用**角色占位符**（例如 `{{fast}}`）而不是硬编码的提供商字符串。这样将*意图*与*实现*解耦——你只需将角色映射到模型一次，所有代理就会自适应。

| 角色 | 意图 | 典型模型 |
|---|---|---|
| `{{fast}}` | 便宜快捷——高容量、低风险 | DeepSeek V4 Flash |
| `{{strong}}` | 平衡——规划、审查、中等复杂度 | MiMo v2.5 Pro |
| `{{thinker}}` | 深度分析——需求、批判 | DeepSeek V4 Pro |
| `{{arbiter}}` | 最终判断——裁决、计划质量门控 | Qwen 3.7 Max |
| `{{vision}}` | 多模态——UI 工作、设计解读 | MiniMax M3 |
| `{{reasoner}}` | 谨慎推理——安全、风险 | GLM 5.1 |

不配置时，代理回退使用 Pi 的默认模型。要将角色映射到真实模型，运行交互式设置：

```bash
/tf init
```

`/tf init` 从一个**行动菜单**开始。首次用户会看到一个 2 选项快捷方式（"使用推荐默认值" / "配置每个角色"）。回访用户会看到完整的 5 选项菜单：

```
? What do you want to do with model roles?
  ❯ Use recommended defaults
    Configure each role
    Edit one role
    Show current roles
    Cancel
```

选择器显示模型**显示名称**，附带能力标记和当前/推荐标记：

```
? Model for 'vision' — Multimodal (executor-ui, visual-explorer)
  Current: openrouter/anthropic/claude-sonnet-4-6
  Recommended: minimax/MiniMax-M3
  ───────────────
  ❯ MiniMax M3 (minimax/MiniMax-M3) · image ✓ · reasoning ✓ · (recommended)
    Claude Sonnet 4.6 (openrouter/anthropic/...) · image ✓ · reasoning ✓ · (current)
    GPT-5 (openrouter/openai/gpt-5) · image ✓
    DeepSeek V4 Flash (openrouter/deepseek/v4-flash)
    ───────────────
    Custom (type your own)
    Keep current
    Back to action menu
```

保存之前，一个**预览屏幕**会显示你的变更差异：

```
? Review changes:
  fast       openrouter/deepseek/deepseek-v4-flash   (unchanged)
  strong     openrouter/xiaomi/mimo-v2.5-pro         (unchanged)
  thinker    openrouter/qwen/qwen3.7-max             (changed ← was: openrouter/deepseek/v4-pro)
  arbiter    openrouter/qwen/qwen3.7-max             (unchanged)
  vision     minimax/MiniMax-M3                      (unchanged)
  reasoner   z-ai/glm-5.1                            (unchanged)
  ───────────────
  ❯ Save these changes
    Edit a role
    Cancel
```

你的选择会被写入 `~/.pi/agent/settings.json`：

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

随时手动编辑这些值，或重新运行 `/tf init`。

若需自定义特定代理的模型或 thinking 而不修改 `modelRoles`，可在 `~/.pi/agent/agents/<name>.md` 创建代理文件，在 YAML frontmatter 中覆盖。

### 工具路径（`action="init"`）

模型也可以通过 `taskflow` 工具配置角色：

| 模式 | 行为 |
|---|---|
| `mode: "show"`（默认） | 只读报告当前 `modelRoles`。从不覆盖。 |
| `mode: "apply-defaults"` + `force: true` | 将 `RECOMMENDED_DEFAULTS` 写入 `settings.json`，保留旧键。 |
| `mode: "interactive"` | 启动完整的行动菜单 + 选择器流程（需要 UI 会话）。 |



### 自定义代理

将 `.md` 文件放入 `~/.pi/agent/agents/`（用户级）或 `.pi/agents/`（项目级，可提交）来添加你自己的代理：

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

然后在任何阶段中引用它：`{ "agent": "my-linter", "task": "Lint src/" }`。

## 示例

[`examples/`](./examples) 中已准备好可直接阅读的定义：

| 文件 | 演示内容 |
|---|---|
| [`summarize-files.json`](./examples/summarize-files.json) | discover → `map` 并发分发 → `reduce` |
| [`conditional-research.json`](./examples/conditional-research.json) | `when` 路由 + `join: any` + `gate` + `budget` |
| [`guarded-refactor.json`](./examples/guarded-refactor.json) | `approval`（人机协作）+ `retry` + `gate` |

将其中一份复制到 `.pi/taskflows/<name>.json`（或 `~/.pi/agent/taskflows/`），它就会注册为 `/tf:<name>`——或者直接让模型指向它。

## 内部构成

<div align="center">

**0 个运行时依赖** · **872 个测试** · **9 种阶段类型** · **共享上下文树** · **跨会话恢复** · **跨运行记忆化** · **逐项 map 缓存** · **增量重算** · **后台（detached）执行** · **`compile` Mermaid 渲染** · **~9k LOC 运行时**

</div>

- **零运行时依赖。** 没有 `dependencies` 字段——运行时完全基于 Node 内置模块（`fs` / `path` / `os` / `child_process` / `crypto`）。文件锁是 `fs.openSync("wx")`，不是第三方库。
- **872 个测试分布在 51 个测试文件中**，涵盖并发、原子文件锁定（8 进程竞争回归测试）、路径穿越防御、跨会话恢复、跨运行缓存新鲜度（流程/推理/工具键隔离、指纹失效、TTL/LRU 淘汰）、逐项 map 缓存、增量重算、FlowIR 编译接缝、门控判决、预算上限、重试/回退、审批流程、循环终止、锦标赛评判、子流程组合、共享上下文树、工作区隔离、后台执行、回调隔离、空闲看门狗、模型角色 init 配置，以及 `compile` Mermaid 渲染器。
- **经过强化的设计。** 路径穿越防御（词法 + `realpath`）、runId 验证、HTML/错误净化、原子写入、通过 `rename` 实现的过期锁窃取，以及杀死卡死子代理的空闲看门狗。
- **自产自用（dogfooded）。** 每个新功能必须在发布前通过项目自身的 `self-improve` taskflow 的考验。

## 🍽️ 我们吃自己的狗粮

`taskflow` 中的每个功能都是**通过 `taskflow` 自身**发布的。

我们的 `self-improve` 流程是一个 10 阶段 DAG——它审计代码库、修补缺陷、验证正确性、进行质量门控并展示报告——全部以声明式完成。它被保存为 `/tf:self-improve`，并在每次发布之前运行。Pi 生态中没有其他代理编排器用自身来构建自己。

| 活动 | 规模 | 阶段数 | 结果 |
|----------|-------|--------|---------|
| [v0.0.8 dogfood](./docs/internal/dogfooding-v0.0.8-report.md) | 全代码库审计 → 分类 → 修复 → 验证 | 10 阶段，234 个测试 | 13 个修复，全部通过 |
| [v0.0.6 自审计](./docs/internal/self-audit-report.md) | 盘点 → 映射审计 → 门控 → 审批 → 映射修复 → 归约 | 9 阶段 | 修复 11 个关键缺陷 |
| [跨运行缓存 dogfood](./docs/internal/rfc-cross-run-memoization.md) | 真实运行时 + 磁盘存储 | 专用测试框架 | 在对抗性指纹下验证缓存正确性 |
| [对抗性交叉审查](./docs/internal/brainstorm-adversarial-review-report.md) | 多代理对抗性审查 | `tournament` + `gate` | 修复 P0 缓存键问题并发布 |
| [Init 重设计审查](./docs/internal/issue-necessity-review-report.md) | 必要性审计 → 并行检查 → 判决 | 7 阶段 | 完整重设计方案已验证 |
| [第 2 轮对抗性审计](./docs/internal/dogfooding-report.md) | 逐阶段 DAG 执行——12 个发现覆盖 runner/runtime/interpolate/verify | 14 阶段 | 已修复 10 项，0 退化 |
| [第 3 轮对抗性审计](./docs/internal/dogfooding-report.md) | 集成层 + 跨模块——10 个发现覆盖 index/agents/cache/render/runs-view | 9 阶段 | 已修复 10 项，0 退化 |

> **元点评：** 我们使用了 `taskflow` 的 `map` 并发分发、`gate` 判决、`approval` 人机协作、`tournament` best-of-N、`loop` 循环至完成和 `cross-run` 缓存——来构建 `taskflow`。

## 状态与边界

**v0.1.1**——修复 issue #3：后台（detached）运行与前台运行现在都能真正执行阶段了（monorepo 拆分后丢失的子代理 runner 注入已补回，另有 detached-runner 模块解析修复与崩溃不再静默卡住的守卫）。详见 [CHANGELOG](./CHANGELOG.md)。本版本基线：**多宿主 monorepo**——引擎拆分为宿主无关的 `taskflow-core`，加上 `taskflow`（Pi 适配器）与 `codex-taskflow`（Codex 运行器 + MCP 服务器）两个适配器。**共享上下文树**：可选开启（`shareContext` / `contextSharing`）的黑板 + 监督工具（`ctx_read`/`ctx_write` 水平复用、`ctx_report`/`ctx_spawn` 垂直监督）。**工作区隔离**：阶段的 `cwd` 接受保留关键字 `temp`/`dedicated`/`worktree`，运行时分配隔离目录（或一条一次性分支上的 git worktree）并在阶段结束后拆除。**后台（detached）执行**：运行可脱离 Pi 会话后台执行。早期功能：循环至完成（`loop`）、锦标赛（best-of-N 带评判者）、跨运行记忆化（基于 git/文件/glob/环境指纹和 TTL 的内容寻址缓存）、交互式 `/tf init`、18 个内置代理及模型角色。完整的控制流与可靠性层（`when` 守卫、`join: any`、`retry`/回退、`approval`、`flow` 组合、`budget` 上限、`eval` 机器门控、空闲看门狗）构建在 DSL + DAG 运行时（`agent`/`parallel`/`map`/`gate`/`reduce`）之上。支持内联 + 已保存流程、跨会话恢复、实时进度和上下文隔离。一次运行作为一个流式工具调用执行。

已知边界（已追踪、有限定——不会在流程中途出现意外）：

- **共享上下文需显式开启。** 除非阶段设置 `shareContext`（或流程设置 `contextSharing`），子代理不共享任何内容。黑板为每次运行独立、基于文件、大小受限，并随运行清理。派生嵌套上限为 `MAX_DYNAMIC_NESTING`（5）。
- **工作区隔离是 fail-open 的。** `cwd: "worktree"` 要求基底 cwd 是一个 git 工作树；否则降级为 `temp` 目录（带警告）。保留关键字仅在作者编写的流程中生效。
- **无 `output: "file"`。** 输出只能是文本/JSON——通过代理的 `write` 工具调用写入文件。
- **`map` 需要一个 JSON 数组。** `over` 字段必须解析为 `{steps.ID.json}` 数组。先用一个单代理 `output: "json"` 阶段包装文本列表。
- **DAG 必须是无环的。** 循环会在验证时被拒绝。
- **跨运行缓存不包含 `gate`、`approval`、`loop` 和 `tournament`。** 这些阶段每次运行必须产生新结果。
- **审批在后台模式下自动拒绝。** 这是一项安全不变量——审批门控绝不会被静默绕过。

## 开发

`taskflow` 是一个 npm-workspaces monorepo，包含三个发布包：

| 包 | 角色 |
|----|------|
| [`taskflow-core`](./packages/taskflow-core) | 宿主无关的编排引擎（零宿主 SDK 依赖；仅 `typebox`） |
| [`pi-taskflow`](./packages/pi-taskflow) | Pi 扩展适配器——`taskflow` 工具 + `/tf` 命令（即 `pi install npm:pi-taskflow` 安装的内容） |
| [`codex-taskflow`](./packages/codex-taskflow) | Codex 子代理运行器 + 零依赖 MCP 服务器（[指南](./docs/codex-mcp.md)） |

```bash
npm install
npm run typecheck     # 跨所有包做 tsc --noEmit（无需构建）
npm test              # 单元测试——无网络，无进程派生
npm run test:core     # 仅引擎测试（另有 test:pi、test:codex）
npm run build         # 为三个包生成 dist/*.js + .d.ts
npm run test:e2e-codex      # codex executor 端到端（需 `codex` + 模型访问权限）
npm run test:e2e-codex-mcp  # codex MCP 服务器端到端
```

Pi 的端到端套件会派生真实 `pi` 子代理，直接运行（使用 `.mts` 扩展名，单元测试 glob 会跳过），例如：

```bash
node --conditions=development --experimental-strip-types packages/pi-taskflow/test/e2e.mts
```

引擎代码位于 `packages/taskflow-core/src/`，Pi 适配器位于 `packages/pi-taskflow/src/`，测试位于各包的 `test/`，可运行示例位于 `examples/`。发布包内含编译后的 `dist/`；开发时通过 `development` 导出条件直接解析 TypeScript 源码——typecheck 与 test 都无需构建步骤。

## 贡献

欢迎贡献——这是一个年轻、快速发展的项目。在 [GitHub](https://github.com/heggria/taskflow) 上提交 issue 或 PR。适合初学者的贡献内容包括：新的示例流程、阶段类型创意和 TUI 打磨。

## 许可

MIT
