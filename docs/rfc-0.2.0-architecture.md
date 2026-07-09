# RFC: taskflow 0.2.0 系统架构总纲（Master Architecture）

> Status: **Active** · Draft v1 2026-07-08 · **Implementation progress updated 2026-07-09** (S4 ✅)
> 层级：这是凌驾于 [`rfc-0.2.0-dsl-syntax.md`](./rfc-0.2.0-dsl-syntax.md)（DSL 前端）和
> replay 实现之上的**系统架构总纲**。定调 0.2.0 内核形态、模块边界、数据契约、迁移顺序。
> 后续所有 0.2.0 实现 RFC 以本文为锚。
> 关联：[`0.2.0-north-star.md`](./0.2.0-north-star.md)（方向）、
> [`internal/overstory-convergence-roadmap.md`](./internal/overstory-convergence-roadmap.md)（M1-M5 内核路线）、
> [`rfc-0.2.0-three-compile-routes.md`](./rfc-0.2.0-three-compile-routes.md)（DSL 路线之争）、
> [`rfc-0.2.0-s4-mvp.md`](./rfc-0.2.0-s4-mvp.md) / [`rfc-0.2.0-s4-decision-record.md`](./rfc-0.2.0-s4-decision-record.md)（S4 表面）。
>
> **本文回应两个已发现的架构级矛盾**（§0），并把 5 个已拍板的决策（§1）固化成一套
> 可发布、向后兼容的内核替换方案。
>
> ### Implementation status (branch `release/0.2.0`)
>
> | 阶段 | 状态 | 落地要点 |
> |------|------|----------|
> | **S0** | ✅ | `compileTaskflowToFlowIR` + `hashFlowIR` → `ir:<64-hex>`；`usedFallbackHash: false`（well-formed IR） |
> | **S1** | ✅ | `exec/{events,fold}`；runtime 全量 decision emit；fold 差分 + kill-9 rebuild 测试 |
> | **S2** | ✅ | `exec/{step,driver}` **全部 10 kind** + P0 硬化；高级特性 fall-back；默认 OFF。**`race`/`expand` 仍走 imperative**（未进 `EVENT_KERNEL_PHASE_TYPES`） |
> | **S3** | ✅ | `replayRun`；`taskflow_replay` MCP；pi `action=replay` + `/tf replay`；golden + import-lint |
> | **S4** | ✅ | 包 `taskflow-dsl` live：`build`/`check`/`decompile`/`new`；erase `kinds/*` 注册表；parity 测绿。引擎 **12 PHASE_TYPES**（+`race`/`expand`）；gate sugar；skills 对齐 |
> | **S5** | ⬜ **下一主线** | 全 kind 差分绿 → kernel 默认 ON；退休旧 `executePhase` 主路径。预热：`runtime/phases/*` strangler |
>
> North-star 口号：**compiled · resumable · incremental · replayable-for-what-if**。

---

## TL;DR（结论先行）

1. **0.2.0 是一次内核替换**：`runtime` 从"解释执行 Taskflow schema"升级为"**执行 FlowIR 的事件溯源内核**"。FlowIR 从"哈希影子"毕业成**规范编译产物**（默认执行仍以 Taskflow 为主，经 S2 绞杀逐步迁到 driver）。
2. **真编译器自研（S0 ✅）**：在 `taskflow-core` 内自建 `flowir/{schema,compile,hash,cond}`，well-formed flow 上 `usedFallbackHash` 为 `false`。
3. **一个机制长出四样能力**：event log → `trace`、`fold`、`resume`、`确定性重放`、`增量重算`。消解 north-star "resumable vs replayable" 假对立。
4. **绞杀式迁移**：新旧内核并存 + 差分 + 逐 kind flip（S0–S5 每步可发布）。
5. **replay 重新纳入 scope（S3 ✅）**：兑现 0.1.7 承诺；`replayRun` + MCP/pi 已落地。
6. **向后兼容是硬约束**：JSON flow / RunState / `/tf` 语义不破坏。
7. **DSL 是平行前端（S4 ✅）**：`.tf.ts → build → Taskflow → FlowIR`；包 `taskflow-dsl` 已落地（CLI-first；无新 MCP）。

---

## §0. 背景：为什么需要这份 RFC（两个矛盾）

### 矛盾 1：DSL RFC 说"runtime 执行 FlowIR"，但 runtime 执行的是 Taskflow

- **起草时现状（2026-07-08）**：`executeTaskflow(state, deps)` 中 `state.def: Taskflow`。FlowIR 仅经 `compileTaskflowToIR` 做分析/哈希；stub `translate` 路径上 `usedFallbackHash` 恒 true。
- **实现后（2026-07-09，S0 ✅）**：真编译器 `compileTaskflowToFlowIR` + `hashFlowIR` 产出 `ir:<64-hex>`，well-formed flow 上 `usedFallbackHash: false`。FlowIR 已是**规范编译/内容寻址产物**（供 `/tf ir`、cache fingerprint、declaredDeps）。**默认执行路径仍是 Taskflow + imperative `executePhase`**；S2 event kernel（默认 OFF）对 agent|script|map|parallel 可走 `exec/driver`。
- **DSL RFC v2 §0.2** 写的是"`taskflow build` → FlowIR，runtime 执行 FlowIR"——**S5 才把默认执行翻到 FlowIR/driver**。
- **overstory roadmap §6.4** 的"大爆炸"风险由 **Q7 绞杀迁移**化解。

→ 本 RFC 拍板：FlowIR **是**规范执行/编译真源方向（Q2=B），用绞杀守住可发布性（Q7）。**S0–S4 已兑现**；**S5（kernel 默认 ON）为下一主线**。

### 矛盾 2：north-star 丢弃了 replay，但 0.1.7 公开承诺过

- **0.1.7 CHANGELOG 原文**：确定性重放"…which **lands in 0.2.0**…"。
- **north-star（07-07）** 一度借 Qwik 的 **"resumable (not replayable)"** 反向定位，与决策重放撞名。
- **已解决（S3 ✅ + north-star 修订）**：口号改为 **compiled · resumable · incremental · replayable-for-what-if**；`replayRun` + MCP/pi 表面已落地。Qwik 的 replayable（hydration）≠ taskflow 的决策 what-if。

---

## §1. 已锁定的架构决策（Decision Record）

| # | Fork | 结论 | 理由 |
|---|---|---|---|
| **Q2** | FlowIR 是否执行产物 | **B — 是**。runtime 通过事件溯源内核执行 FlowIR | 让 trace/resume/replay/recompute 从一个机制长出（§2）；长期对齐 overstory |
| **Q5** | 真编译器来源 | **own — 在 core 自研**（不 vendor overstory `ir/`） | 零外部耦合、无 `private:0.1.0-dev` 漂移债、完全自控；代价=自实现 hash/cond + 自建正确性测试 |
| **Q6** | 状态模型 | **不收敛** RunState→RunTree。RunState 保持公开持久化面（= fold 产物） | 守 published `RunState.json` 向后兼容；内部用 event log，外部面不变 |
| **Q7** | 迁移方式 | **绞杀式**：新旧内核并存 + 差分测试 + 逐 node kind flip | 把"大爆炸内核替换"拆成每步可发布，中和 roadmap 唯一反对 |
| **Q8** | event log 与 trace 关系 | **log 即 trace**。replay=重 fold；0.1.7 "trace 只接 30%" 的问题溶解 | 事件溯源内核按构造发出每个决策事件，不需再补 5 条死线 |

---

## §2. 核心洞察：事件溯源统一 trace / resume / replay / recompute

选 B 的真正价值不在"能写 DSL"，而在**执行模型换成事件溯源后，四样能力从一个机制自然长出**：

```
              event log  ——  driver 按构造发出的每个事件（subagent 调用 + 每个决策）
                  │
   ┌──────────┬───┼───────────┬──────────────┬────────────────┐
   ▼          ▼   ▼           ▼              ▼                ▼
 trace     RunState        resume        确定性重放         增量重算
(=log 本身) (=fold(log))  (=重放 log)  (=换旋钮重fold,0token) (=stale 定点,M5)
```

- **trace**：不再是"只接了 30% 的旁路"（今天 `trace.ts` 定义 7 种决策事件，`runtime.ts` 只 emit 2 种：`gate-verdict`+`unreplayable`；`gate-score`/`budget-hit`/`when-guard`/`tournament-winner`/`cache-hit` 定义了但 0 次 emit）。事件溯源内核**按构造**发出每个事件——**F3"补 5 条死线"的问题直接溶解**。
- **RunState = fold(event log)**：当前 phase 状态是对事件流的 reduce。
- **resume = 重放 log 重建状态**（Qwik 的 "resumable"）。
- **确定性重放 = 拿同一条 log、换决策旋钮（gate 阈值 / budget / 模型路由）重新 fold**，对录制的 subagent 输出重新裁决，**零 token、绝不调模型**（Temporal 的 "replay"）。
- **增量重算 = driver 的 stale-frontier 定点**（M5 已落地）。

> **这一举消解 north-star 的 "resumable vs replayable" 矛盾**：在事件溯源下，resume 和 replay 是**同一条 log 的两种 fold**，不对立。你要的"0.2.0 继续 replay"在 B 架构里是内核的天然能力，不是 bolt-on。

---

## §3. 整体架构（层 + 数据契约）

```
 作者前端                flow.json ─parse─┐        flow.tf.ts ─build(AST transform)─┐
 (Authoring)                             │                                        │  ← taskflow-dsl 包
                                         ▼                                        ▼
                            ┌───────────────────────────────────────────────────────┐
 规范作者 schema            │  Taskflow schema (作者面 DSL, 向后兼容, desugar)         │  schema.ts
 (契约①)                    └───────────────────────────┬───────────────────────────┘
                                                         │ compile（★自研真编译器, Q5）
                                                         ▼
                            ┌───────────────────────────────────────────────────────┐
 规范执行产物               │  ★ FlowIR — 内容寻址 / hash / node·edge / inject·emits   │  flowir/
 (契约②, 唯一执行真源)      └──────────────┬──────────────────────────┬───────────────┘
                              (0 token)     │ executeFlowIR            │ (0 token)
                        verify/compile/diff  ▼                          │
                                    ┌──────────────────────────────────┐│
 事件溯源内核                       │ exec/  driver 定点循环 + step 派发 ││
 (执行)                             │  ├─ 发 EVENT LOG ═════════════╗   ││
                                    │  ├─ observed readSet@version   ║   ││ ← 契约③ event log
                                    │  └─ usage/cost (rates.ts)      ║   ││
                                    └──────────────┬─────────────────╨───┘│
                                       fold │       │ log                  │
                                            ▼       ▼                      │
 状态 + 后执行             ┌─────────────────┐  ┌──────────────────────────┴────┐
 (契约④ RunState)          │ RunState        │  │ replay.ts   重fold(log,新旋钮) │ 纯,0token
                           │ (兼容持久化面)  │  │ recompute/stale.ts (M5)        │
                           └─────────────────┘  └───────────────────────────────┘
```

### 四个数据契约（模块间的连接组织）

| 契约 | 是什么 | 谁产 | 谁消费 | 向后兼容 |
|---|---|---|---|---|
| ① **Taskflow** | 作者面 schema（现有）；JSON 与 DSL 的共同落点 | `parse`(JSON) / `build`(DSL) | 编译器 | 现有 JSON flow 零修改 |
| ② **FlowIR** | 规范执行产物，内容寻址 | `flowir/compile` | 内核 / verify / compile / diff / cache | 新契约（0.2.0 引入为执行真源） |
| ③ **Event log** | append-only 事件流（= trace） | `exec/driver` | fold / replay / recompute / OTel(未来) | 向后兼容读旧 trace（`readTrace` 已容错） |
| ④ **RunState** | 当前状态快照（= fold 产物） | `exec/fold` | resume / `/tf runs` / persist | **published `RunState.json` 必须可加载** |

---

## §4. 模块分解与依赖关系

### 4.1 taskflow-core 模块图（零运行时依赖不变）

```
                    ┌─────────────┐   两个前端都汇到这里
   flow.json ──────▶│ schema.ts   │◀────── taskflow-dsl(build)
                    │ (Taskflow)  │
                    └──────┬──────┘
                           │ ★ Q5 自研真编译器
             ┌─────────────▼──────────────────────────────┐
             │ flowir/                                      │
             │  schema.ts   规范 FlowIR 类型(node/edge/kind/inject/emits) 【新】
             │  compile.ts  Taskflow→FlowIR(lowering+归一化) 【translate.ts 毕业】
             │  hash.ts     内容寻址哈希(序/空白无关)        【现有→自研真算法】
             │  cond.ts     when/until/eval→归一化条件 IR     【新, 与 interpolate 共享】
             │  meta.ts / phasefp.ts                          【现有: declaredDeps / phase fp】
             └──────┬──────────────────────────────────────┘
                    │ FlowIR
    ┌───────────────┼────────────────────────────────────────┐
    │ (0 token)     │ executeFlowIR                            │
    ▼               ▼                                          │
 verify.ts     ┌──────────────────────────────────────────┐   │
 compile.ts    │ exec/                                      │   │
 (diff.ts 可选)│  driver.ts  事件溯源定点循环(schedule+fold) │   │
               │  step.ts    10 种 node kind 派发            │─emits─┐
               │  events.ts  事件(log) schema  ◀════════════════════╝  【吸收 trace.ts, Q8】
               │  fold.ts    reduce(log)→RunState             │       │
               └──────┬─────────────────────┬────────────────┘       │
                 fold │                       │ log                    │
                      ▼                       ▼                        │
              RunState(store.ts)   ┌──────────────────────────────────┴─┐
                      │            │ replay.ts   重fold(log,新旋钮)      │ 纯,0token
                      ▼            │ recompute/stale.ts (M5, key on hash)│
             ┌─────────────────┐   └─────────────────────────────────────┘
             │ rates.ts (F1)   │ ← usage/cost 注入 step; codex 补 cost; replay 反事实计价
             │ cache.ts (v3)   │ ← key on flowir/hash.ts
             └─────────────────┘

 runtime.ts ── 收缩为「绞杀开关」: 旧 executePhase(flag) ⇄ 新 exec/driver(flag)
```

### 4.2 依赖约束（结构性护栏，import 图强制）

1. **`replay.ts` 只 import 纯模块**：`events`（读 log）+ `flowir/{schema,cond}` + `deterministic`（`parseGateVerdict`/`overBudget`）+ `scorers`（纯评分器重跑）+ `rates`。**绝不 import `exec/driver`**（那会拖进 process-spawning runner）。→ "replay 永不花 token" 由 import 图**结构性**保证。这与 `replay.ts` 现有 docstring 已声明的约束一致。
2. **`flowir/compile` 是 Taskflow→FlowIR 的唯一入口**：JSON 与 DSL 都经它，保证两个前端产出同一 FlowIR。
3. **`exec/step` 依赖 host 注入的 `SubagentRunner`**（`RuntimeDeps.runTask`）；`events`/`interpolate`/`scorers`/`scorer-runtime`。
4. **core 零运行时依赖不变**：`flowir/*`、`exec/*`、`replay.ts`、`rates.ts` 全是纯模块（仅 typebox）。
5. **`taskflow-core` 永不 import host SDK**（`@earendil-works/*`）——不变。

### 4.3 新包 taskflow-dsl（9 packages + website）

| 内容 | 说明 |
|---|---|
| rune 类型定义 | `flow/agent/map/gate/...` 的 TS 类型（编译指令，见 DSL RFC v2 §0） |
| `build` | AST transform：`.tf.ts` → Taskflow JSON（再经 core 的 `flowir/compile` → FlowIR） |
| `check` | 轻量校验（tsc + rune 签名 + 依赖完整性 + when 谓词子集） |
| `decompile` | FlowIR → `.tf.ts`（代码生成器，语义等价非字面 round-trip，DSL RFC v2 §6.2） |
| 依赖 | `taskflow-core`（Taskflow schema + verify）+ `typescript`（build-time；**因此不能进 core**——core 零依赖铁律） |

> **为什么 DSL 编译器不能进 core**：它需要 AST 库（tsc transformer API）。core 的零运行时依赖铁律禁止。DSL 编译器本质是 build-time 工具（像 bundler 插件），独立成包，产出 Taskflow JSON。core 完全不知道 DSL 存在。

---

## §5. 自研 FlowIR 编译器（Q5=own 的具体范围）

"真编译器" vs 今天的 stub 差在：stub 的 `usedFallbackHash=true`、`hash==flowDefHash`（对 JSON 文本哈希，非对 IR 结构哈希）。自研真编译器要交付：

### 5.1 `flowir/schema.ts`（新）— 规范 FlowIR 类型
- `FlowIRNode { id, kind, inject[], emits[], task?, condRef?, ... }`；`kind ∈ 10 种`（agent/parallel/map/gate/reduce/approval/flow/loop/tournament/script）。
- `FlowIR { name, nodes[], edges[], budget?, concurrency?, ... }`。
- **1:1 投影优先**：每个 Taskflow phase → 一个 FlowIR node。overstory 的 native 多节点 lowering（parallel→N siblings 等）**推迟**（见 §12），先保 hash 稳定。

### 5.2 `flowir/compile.ts`（`translate.ts` 毕业）— Taskflow → FlowIR
- lowering：phase → node（含 desugar 后的字段）。
- 归一化：字段顺序、默认值、空白无关——保证"逻辑等价的 flow 产出同一 IR"。
- declared readSet：`collectRefs` 过 task/over/when/until/eval/branches/with/context + `dependsOn` → `inject`/`emits`（现有 `meta.ts` 逻辑并入）。

### 5.3 `flowir/hash.ts`（现有 → 自研真算法）— 内容寻址哈希
- **硬验收（roadmap M1 门）**：① 逻辑等价（含空白/顺序重排）⟹ 同 hash；② 单字段变更 ⟹ hash 变；③ 确定性（同输入永远同输出，跨进程）。
- **自研而非 vendor**：我们定义哈希的规范化 + 序列化规则（如稳定 key 排序 + 规范 JSON + SHA-256），写自己的 property 测试。不追求与 overstory byte-parity（Q5=own 放弃了这个目标）。
- cache key 升 **`v3:flowir:`** 前缀（现有 `v2:flowdef:` 3-tier lookup 保留一个 release 周期，见 §8）。

### 5.4 `flowir/cond.ts`（新）— 条件归一化
- `when`/`until`/`eval` 表达式 → 归一化条件 IR，供 hash（结构等价）+ replay（重新求值 `when-guard`）+ DSL（谓词子集编译）共享。**与 `interpolate.ts` 共享代码路径**，避免语义漂移。

---

## §6. 事件溯源内核（exec/）

### 6.1 `exec/events.ts`（吸收 trace.ts，Q8）— log schema
- 事件类型 = 现 `TraceEvent` 的超集：`phase-start`/`phase-end`/`subagent-call`/`decision`（7 种 decision：gate-verdict/gate-score/tournament-winner/budget-hit/cache-hit/when-guard/unreplayable）。
- **加 `v`（schema 版本）字段**（现 `TraceEvent` 无版本字段——additive，replay 上线时可检测/迁移旧 log）。
- driver **按构造**发出每个事件（不再是 `runtime.ts` 里手工插 emit 点）——这是 F3 溶解的机制。

### 6.2 `exec/driver.ts` — 事件溯源定点循环
- 拓扑调度 ready 节点（现有 `schema.ts` topo sort）→ 调 `step()` → 收事件 → fold 更新状态 → 重新算 ready 集合，直到收敛/预算/中止。
- `budget`/`abort`/`idle watchdog` 语义保留（现 `runtime.ts` 已有）。
- 增量重算 = 这个定点循环 + stale frontier 作为初始 ready 集（M5 已有算法）。

### 6.3 `exec/step.ts` — 10 种 node kind 派发
- 每个 kind 一个 handler（agent/script/map/parallel/reduce/gate/loop/tournament/approval/flow），从现 `executePhase` 的 10 个分支迁移而来。
- handler 纯粹"执行一个 node → 发事件"，不直接改状态（状态由 fold 派生）。
- host 交互经 `RuntimeDeps.runTask`（不变）。

### 6.4 `exec/fold.ts` — reduce(log) → RunState
- `fold(events) → RunState`：把事件流归约成当前 phase 状态快照。
- **RunState 保持现有公开形状**（Q6）——`persist`/`onProgress`/`/tf runs` 消费的还是 RunState，外部无感。
- **resume** = 从持久化的 log 重新 fold（崩溃恢复 = 重放事件，非从 RunState 快照猜）。

---

## §7. 确定性重放（replay.ts）

### 7.1 语义
`replayRun(log, overrides) → ReplayDecision[]`：拿录制的 event log，在**决策旋钮**变化下重新 fold，对录制的 subagent 输出**重新裁决**，**零 token、绝不调模型**。

- `ReplayOverrides`（已存在于 `replay.ts`）：`thresholds`（gate score 阈值）、`budgetMaxUSD`/`budgetMaxTokens`、`models`（只报 cost delta，需 `rates.ts`）、`args`（改文本的 phase → `needs-live-rerun`）。
- `ReplayDecision`（已存在）：`reused`/`verdict-flipped`/`would-block`/`would-exceed-budget`/`needs-live-rerun`/`would-skip`/`threshold-changed`/`failed`。
- 实现 = 重放 log + 重求值：gate 阈值改 → 拿录制的 `gate-score` 事件里的 per-scorer 结果 + 新阈值重跑 `combineScores`（纯，`scorers.ts` 已有）；budget 改 → 拿录制 usage + 新 cap 重跑 `overBudget`（`deterministic.ts` 已有）；when 改 → 重求值 `when-guard`。

### 7.2 与 recompute 的孪生关系
| | recompute（M5 ✅） | replay（0.2.0） |
|---|---|---|
| 触发 | *输入*变了（改文件） | *决策旋钮*变了（阈值/budget/模型） |
| 执行 | **在线**重跑 stale frontier | **离线**重 fold |
| 花费 | 花 token（只花变化节点） | **零 token** |
| 问 | "改了这文件要重跑哪些？" | "当初阈值 0.9 会 BLOCK 吗？" |

两者共用 event log 证据，不共用执行逻辑——后执行层的一对孪生。

### 7.3 命名（修口号碰撞）
- 技术术语保留 **"deterministic replay"**（0.1.7 CHANGELOG 已用，准确）。
- **修 north-star**：**已改** —— 口号为 **"compiled · resumable · incremental · replayable-for-what-if"**（见 `0.2.0-north-star.md`；Qwik 的 replayable 指 hydration，与决策 what-if 不同）。

---

## §8. 向后兼容（硬约束）

| 面 | 约束 | 机制 |
|---|---|---|
| **JSON flow** | 现有 `.json` flow 零修改继续跑 | `parse`→Taskflow→`compile`→FlowIR；新增执行路径不改作者面 |
| **`RunState.json`** | published 旧 run 可加载 | Q6：RunState 保持公开形状；旧 run 走 resume，replay/recompute 对无 log 的旧 run 不可用（可接受，非破坏） |
| **`/tf` 命令 + DSL 语义** | 不破坏 | 绞杀开关默认走旧内核，直到差分全绿才 flip |
| **cache key** | 部署当天不 miss-storm | `v3:flowir:` 新前缀 + 保留 `v2:flowdef:` 3-tier lookup 一个 release 周期（现有迁移模式） |
| **trace 旧文件** | 可读 | `readTrace` 已 partial-line 容错；`events` 加 `v` 字段做版本协商 |

---

## §9. 绞杀式迁移与建造顺序（每步可发布）

roadmap 反对 B 的唯一理由是"大爆炸三层同时改"。绞杀者模式把它拆成 6 个独立可发布阶段：

| 阶段 | 做什么 | 差分/验收门 | 可发布价值 | 承接 |
|---|---|---|---|---|
| **S0** ✅ | 自研 `flowir/{schema,compile,hash,cond}`；`usedFallbackHash→false`；runtime 仍执行 Taskflow | hash byte-determinism + 敏感度（`flowir-*.test.ts`） | cache-key 更精准；FlowIR 成规范 | roadmap M1 剩余（自建版） |
| **S1** ✅ | 加 `exec/{events,fold}`；旧 executePhase 全量 decision emit；`fold(log)` 对齐 RunState | 差分 + kill-9 rebuild 测试 | **trace 完整 + 事件溯源（F3 溶解）** | F3 / Q8 |
| **S2** ✅ | 建 `exec/{driver,step}`；**原 10 kind**（复杂路径简化版；score/reflexion 等仍可走 imperative） | parity + s2-complete 测试；默认 OFF | 每 kind 可 flip；默认 ON 在 S5 | Q7 |
| **S3** ✅ | `replayRun()` + `taskflow_replay` + `/tf replay` + 黄金 fixtures + import-lint | 未改旋钮 → 全 reused；改阈值/budget 可测 | **0.1.7 承诺的 replay 旗舰落地** | F2 / replay |
| **S4** ✅ | 包 `taskflow-dsl`：`.tf.ts→build→Taskflow→compile→FlowIR` + `check`/`new`/`decompile`；+ Horizon B `race`/`expand` 引擎 kind | DSL parity（含 map+json+templates）`hashFlowIR` 相等；`test:dsl` 绿 | DSL 作者面 + 12 kind JSON | DSL RFC v2 / s4-mvp |
| **S5** ⬜ | 全 kind 差分绿 → 新 driver 设默认；退休旧 executePhase；可选 race/expand kernel handlers | 全量回归 + e2e 绿 | 内核替换完成 | — |

**顺序优雅之处**：`rates.ts`(F1) 落在 S1/S2（cost 进 event/usage）；F3 在 S1 自然溶解；replay(S3) 与 DSL(S4) 已并行落地；**下一主线是 S5**。S5 预热：`runtime/phases/<kind>.ts` strangler（避免 `runtime.ts` 巨石阻 flip）。

---

## §10. 包拓扑（9 packages + website）

| 包 | 变化 |
|---|---|
| `taskflow-core` | flowir/ 毕业为真编译器；新增 exec/；trace→events；replay 实现；rates 新增。**零依赖不变** |
| `taskflow-mcp-core` | 新增 `taskflow_replay` 工具；action 表更新 |
| `taskflow-hosts` | codex-runner 补 cost（接 rates）；其余 runner 无感 |
| `pi-taskflow` | 新增 `/tf replay` 命令 + 渲染；绞杀开关的 host 侧 flag |
| `codex/claude/opencode/grok-taskflow` | 无感（经 mcp-core 共享） |
| **`taskflow-dsl`（新 · S4 ✅）** | rune 类型 + erase kinds 注册表 + build/check/decompile/cli；依赖 core + typescript；**不**依赖 runtime/exec |

---

## §11. 风险与验证门

| 风险 | 级别 | 缓解 |
|---|---|---|
| 内核替换回归（新 driver 与旧行为不一致） | **HIGH** | S1/S2 差分测试是硬门：`fold(log)==旧RunState`、新内核逐 kind ==旧内核；702 测试是回归网 |
| RunState 兼容破坏（旧 `RunState.json` 加载失败） | **HIGH** | Q6：RunState 公开形状不变；旧 run 走 resume；加载器容错 |
| 自研 hash 正确性（逻辑等价漏判/误判） | MED | S0 硬验收门 + property 测试（现有 `flowir-hash.test.ts` 扩展） |
| cache miss-storm（v3 前缀切换） | MED | v2→v3 3-tier lookup 一个 release 周期 |
| replay 花了 token（import 图破坏） | MED | §4.2 结构护栏：replay 不 import exec/driver；**已加** `replay-import-lint.test.ts` |
| scope 蔓延（S2 逐 kind 拖太久） | MED | 每 kind 独立可发布；可先发 agent/script，复杂 kind 后续版本 |
| DSL 与内核耦合（S4 依赖 S0-S3） | LOW | DSL 只产 Taskflow JSON，与内核解耦；可并行 |

**跨阶段验证门**（对齐 roadmap §5）：
- **S0** ✅：`hashFlowIR` 确定性 + 敏感度。
- **S1** ✅（测试 oracle）：跑完 → 只保留 event log → `foldEvents` 重建 phase 终端状态（`fold-kill9-rebuild.test.ts`）。
- **S3** ✅：未改旋钮 replay → 全 `reused`；阈值/budget 覆盖（`replay.test.ts`）。
- **S4** ✅：`packages/taskflow-dsl/test/*` parity + kinds coverage；skills 与 12 kind 对齐。
- **S5** ⬜：增量重算成本比 —— 周一 $6/8 agents → 周二改 1 文件 → ≤2 节点 $0.40（旗舰 demo）；+ kernel 默认 ON 全量回归。

---

## §12. 非目标（0.2.0 明确不做，防 scope 蔓延）

1. **overstory native 多节点 lowering**（parallel→N siblings / tournament→map+gate）。S0 用 1:1 投影，保 hash 稳定。native lowering 推迟到内核替换稳定后。
2. **RunState → overstory RunTree 收敛**（Q6）。RunState 保持公开面；内部收敛留 post-0.2.0 mapping RFC。
3. **map item-level 精确重算**（单 item 变只重跑该 item）。已知限制，推迟。
4. **精确 `ir-changed` diff**（只失效结构变化的切片）。S5 先"全失效(默认)+refuse(flag)"，精确 diff 后续 RFC。
5. **`flow.component` / `$store` / `$derived`**（全局响应式）。依赖 Shared Context Tree，DSL RFC v2 §7 已标 post-0.2.0。demo 里加 `// [post-0.2.0]`。
6. **`{env.X}` 占位符**：DSL RFC v2 §C 留待实现时定（0.2.0 纳入 or 只推 script 注入）。

---

## §13. 待定 / 已决

1. **`build` AST transform 实现选型**（S4）：**已决（落地）** — TypeScript compiler API（`typescript` package）AST erase，非 Babel；见 `taskflow-dsl/src/build/erase/*`。
2. **replay 命名**：**已决** — 模块 `replay.ts`；用户面 `/tf replay` + `taskflow_replay`；口号 **replayable-for-what-if**。
3. **event log 存储**：**已决（S1）** — 与 `trace.jsonl` 同形状；`Event = TraceEvent & { v }`；`upgradeTraceEvent` 读旧行。
4. **绞杀开关的默认策略**：**已决（S2 切片）** — 默认 OFF；`RuntimeDeps.eventKernel` 或 `PI_TASKFLOW_EVENT_KERNEL=1|true`；显式 `false` 覆盖 env。**S5 再翻默认 ON。**
5. **S3 与 S4 并行 vs 串行**：**已决（均已落地）** — 下一主线 **S5**；S5 预热为 runtime phases 模块化 + race/expand kernel handlers（可选）。

---

## 附 A：north-star 需要修订的点（本 RFC 触发）

| north-star 现状 | 需改为 | 原因 |
|---|---|---|
| 口号 "compiled, **resumable (not replayable)**, incremental" | **已改** → **compiled · resumable · incremental · replayable-for-what-if**（见 `docs/0.2.0-north-star.md`） | 与确定性重放同名碰撞；0.1.7 已承诺 replay |
| 吸收思想表 "resumable, not replayable \| Qwik \| ✅已落地" | **已改** → resumable + 独立一行「确定性重放 / S3」 | replay 重新纳入 scope |
| §六 执行顺序（只列 DSL + 旗舰 demo） | 加 replay(S3) 作为与 DSL 平行的主线 | 两条主线在 FlowIR 汇合 |

## 附 B：决策记录溯源

| 决策 | 由谁定 | 日期 | 记录 |
|---|---|---|---|
| Q2=B（FlowIR 执行产物） | 项目主 | 2026-07-08 | 本 RFC §1 |
| Q5=own（自研编译器） | 项目主 | 2026-07-08 | 本 RFC §1 |
| Q6/Q7/Q8（状态模型/绞杀迁移/log=trace） | 建议 + 项目主未反对 | 2026-07-08 | 本 RFC §1，实现时可复核 |

---

*一句话总纲：0.2.0 把 runtime 换成执行 FlowIR 的事件溯源内核（Q2=B，自研编译器 Q5=own），让 trace/resume/replay/recompute 从一个机制长出；用绞杀式迁移（Q7）守住每步可发布与向后兼容；DSL（taskflow-dsl 新包）与 replay（兑现 0.1.7 承诺）是在 FlowIR 汇合的两条平行主线。*
