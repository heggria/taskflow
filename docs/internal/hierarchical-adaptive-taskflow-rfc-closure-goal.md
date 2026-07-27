# Hierarchical Adaptive Taskflow RFC 持续收敛 Goal

> **状态：COMPLETE / RFC CLOSED / P-ADR AND IMPLEMENTATION NOT STARTED**
>
> **目标文档：**
> [`rfc-hierarchical-adaptive-taskflow.md`](./rfc-hierarchical-adaptive-taskflow.md)
>
> **起点：** `feat/0.3.0`，基线提交
> `e11b82109e04f69e56a37aceb3f78934f822ad14`
>
> **当前 RFC 起点：** v3，A1–A32，26 个章节，未暂存、未 commit
>
> **目标版本：** Post-0.3；不得进入或修改 0.3 wire-freeze 范围
>
> **日期：** 2026-07-24
>
> **恢复日期：** 2026-07-25

这不是“继续给 RFC 增加功能”的 Goal。它的唯一目的，是持续审查、删减、
验证和收敛当前架构，直到它同时满足：

1. 产品概念足够简单；
2. 权威和失败语义足够严格；
3. 动态性不会产生第二套 runtime；
4. 每个重要对象都有唯一职责和真相来源；
5. 实现者能够仅凭 RFC 和后续 P-ADR 边界开始工作；
6. 未实现、未验证和未决定的部分都被诚实标记。

最终应能证明：

> Taskflow 以一个稳定 Control Kernel 执行所有模型和外部 effect；以
> Goal Branch Revisions 保存持续变化的理解；以不可变 Plan Segments 和 Runs
> 执行工作；以 Receipts 和 Evidence 驱动下一次规划；以 Candidate、
> replay、Promotion 和 rollback 控制经验扩大作用域。系统没有隐藏 runtime、
> 重复真相、可变历史、无证据完成或跨项目隐式权威。

---

## 1. 不可谈判的架构宪法

RFC 的所有设计、术语、状态机和后续 P-ADR 必须服从：

```text
Mutable understanding, immutable history, scoped promotion.

Every model or external-effect call occurs inside a controlled Run.
Every durable mutation is a Command.
Every trusted claim references Evidence.
Every scope widening is a Promotion.
```

其中：

- “external effect”不包含 Control Kernel 自身由 Command 授权的 journal /
  Artifact 持久化；
- 固定 executable/arguments、无 user/model/project payload、仅用于 process
  birth observation、locking、atomic persistence 或 fencing 的命名 platform
  primitive 可进入 repo-wide kernel allowlist；它不是通用 `child_process`
  例外，不得执行 project script、模型、网络或 domain mutation；
- 一个 Run 可以包含多个 phase Attempts；
- Planner、Router、Clarifier、Reviewer、Evidence Synthesizer、
  Completion Verifier、Candidate Extractor 与普通 Component Agent 使用同一
  Run/Attempt/provider/Receipt 语义；
- Supervisor、Store、Reducer、Projection、Web Handler 不得直接调用模型、
  SubagentRunner、脚本或 effect provider；
- 纯确定性的 fold、validate、hash、project、policy、Link 可以在 Kernel
  内执行，但不得调用模型或产生外部 effect；
- Agent 可以提议和执行，不能成为 journal、权限、终态、Receipt 或 Promotion
  权威。

任一提案违反这些原则，应先被拒绝，而不是通过增加例外继续扩张 RFC。

---

## 2. 授权范围与明确非目标

### 2.1 本 Goal 可以修改

- `docs/internal/rfc-hierarchical-adaptive-taskflow.md`
- 本 Goal 文档中的矩阵、决策记录和迭代状态
- 为 RFC 收敛而新增的只读分析材料或后续 P-ADR backlog 文档，但新增前必须
  证明无法放入现有文档

### 2.2 未获得额外授权前不得修改

- 0.3 master RFC、P1–P16 wire 或已冻结 TypeBox
- `packages/**` 代码和测试
- public README、skills、examples、网站或发布说明
- package version、tag、release、CI、MR

### 2.3 明确不做

- 不把 RFC 长度、章节数、Decision 数量当作完成指标。
- 不用“Graph of Graphs”“AGI”“自我进化”等叙事替代协议和失败语义。
- 不为了显得完整而提前设计所有未来 wire 字段。
- 不把 UserCoordinatorStore 扩张成 User Taskflow 总账。
- 不创建合并所有项目 Runs 的用户级 journal。
- 不允许 Goal Branch、Planner 或模型进程成为独立 writer。
- 不允许 raw transcript、chain-of-thought 或一次成功直接成为 Project Main
  经验。
- 不把 mock、文档示例、HTTP 成功或 Agent 自述当作实现证据。
- 不把当前 RFC 通过格式检查描述成架构闭环。
- 未经明确授权不 stage、commit、push 或创建 MR。

---

## 3. “足够优雅”的可判定定义

优雅不是术语少，也不是图画得简洁。这个 RFC 只有同时满足以下条件，才可称为
足够优雅。

### 3.1 最小本体

每个一等实体都必须回答：

1. 它的唯一职责是什么？
2. 谁是权威 store？
3. 它的稳定 identity 是什么？
4. 哪些字段不可变？
5. 哪个 Command 可以创建或推进它？
6. 它有哪些终态和非终态？
7. 崩溃、竞争、重试如何收敛？
8. 为什么它不能由另一个实体或 projection 推导？

建议的一等实体上限不是数字预算，而是职责预算：

```text
ProjectTaskflowVersion
Goal
GoalBranchRevision
PlanSegmentBinding
Run / Receipt                # 复用 0.3 Kernel
ExperienceCandidate / Promotion
```

以下对象默认应被视为 projection、Artifact 或 event，而不是新的 authority
aggregate，除非反例证明必须升级：

```text
BranchSnapshot
WorkflowOutcome
Observation
CompletionAssessment
AgentInvocation
UI progress
```

### 3.2 单一真相链

必须能够画出且只能画出一条无循环权威链：

```text
Run Events
→ Receipt / Artifacts
→ Branch Revision references and interprets Evidence
→ Branch Snapshot folds Revisions
→ Goal status reduces Branches + Completion Contract
```

禁止出现：

- Receipt、WorkflowOutcome、Observation 各自保存互相冲突的“结果”；
- Branch Snapshot 可以独立写入并覆盖 Revision；
- Goal、Branch、Run 三套状态能够无约束地分别修改；
- Registry projection 可以反向重建或修改权威历史。

### 3.3 单一执行语义

必须满足：

```text
role trigger
→ resolve pinned Component / Agent binding
→ Link immutable Segment
→ admit controlled Run
→ Attempt/provider lifecycle
→ Artifact + Receipt
→ deterministic validation
→ optional Command
```

不能存在：

```text
Supervisor → model SDK
Store → provider
Reducer → SubagentRunner
Web Handler → Planner
fallback → legacy full-power runtime
```

### 3.4 局部可推理

- 一个 Plan Segment execution 只绑定一个 Run。
- Goal-level replan 创建新的 Segment 和 Run。
- Run 内动态性只通过 BoundPlan 已授权的 expansion point 生成不可变
  BoundFragment。
- 一个层的失败不能要求重写另一个层的历史。
- User Taskflow 失败不能破坏已经绑定的 Project ControlStore。
- Project Main promotion 是新版本 + pointer CAS，不是热改活进程。

### 3.5 可退化

关闭 Goal learning、auto-promotion、User Taskflow 或 Component registry 后，
系统仍应退化为合法的 0.3：

```text
Program → BoundPlan → Run → Receipt
```

不能要求旧 Run 伪装成已知 Goal，也不能要求 0.3 reader 理解未来对象才能安全
读取自身数据。

### 3.6 用户认知压缩

Simple 用户只需理解：

```text
Goal
当前进展
需要我的决定
结果与证据
```

Pro 用户才看到 Branch、Revision、Segment、Run、Attempt、hash、Agent pin、
Candidate、Promotion 和 rollback。

如果一个内部实体必须出现在 Simple 才能解释正常流程，应重新检查抽象边界。

---

## 4. 当前可相信的起点

以下只描述当前 `feat/0.3.0` dirty checkout，不是 release 或实现完成声明：

| 事实 | 当前证据 | 严格含义 |
|---|---|---|
| RFC v4 已定义 Goal、Project Main、Goal Branch、Segment/Run、Evidence、Candidate、User Taskflow 与 P-ADR backlog | RFC v4 §3–§25 | 架构 closure candidate，不等于 P-ADR/wire/代码已实现 |
| 一个 Segment execution → 一个 Run 已冻结为方向 | A22、§9.2 | 保护 0.3 Run Kernel，不等于 admission P-ADR 已完成 |
| Run-local dynamic Fragment 与 Goal-level replan 已分开 | A23、§9.3 | 语义边界清楚，不等于所有动态 path 已实现 |
| Goal Branch 当前理解来自不可变 Revision fold | A21、§8 | 避免可变历史，不等于 command/CAS schema 已冻结 |
| 所有 Agent/model/effect 必须进入受控 Run | A29–A32、§6.5、§9.6 | single-runtime 决策已接受，不等于代码无 bypass |
| Planner 输出 Proposal Artifact + Receipt 后才可提交 Revision | §8.7、§9.4 | 因果链已定义，不等于 crash saga 已证明 |
| pre-project 模型路由需要未来 user ControlDomain | A32、§14–§15 | 没有污染 UserCoordinatorStore，但 authority P-ADR 未完成 |
| RFC 初始 15 个 Open Questions 已全部分流 | §25 | 已映射为 architecture answer、P-A0–P-A10 或 H1–H6，不等于 P-ADR 已完成 |
| RFC 与本 Goal 都未暂存 | `git status --short` | 当前变更只存在于本地工作树 |

---

## 5. Definition of Done

所有门必须为 `PASS`。`PARTIAL`、`UNKNOWN`、`TBD` 或只有叙述没有反例/证据，
都不算闭环。

| Gate | 必须成立的事实 | 最低证据 |
|---|---|---|
| G0 来源与边界 | RFC 明确版本、状态、normative dependencies、与 0.3 wire 的关系 | 文档首页 + 逐链接检查 + 与 0.3 RFC 对照 |
| G1 最小本体 | 每个一等实体有唯一职责；projection/Artifact/event 不形成第二权威 | entity classification table + 删除/降级记录 |
| G2 单一 runtime | future Goal/Control role 无任何允许的 supervisor/provider bypass；current legacy bypass 全部盘点、隔离并阻断 future authority，直到 implementation conformance | 调用路径规范 + 代码现状审计 + feature gate + future conformance gate |
| G3 Goal/Branch | Goal、Branch、Revision、fork、supersede、completion reduction 与 `unknown` 语义无冲突 | 状态机 + transition table + 并发反例 |
| G4 Segment/Run | Control Segment、Work Segment、Run-local Fragment、replan、retry、resume、approval 边界唯一 | cardinality table + crash/ambiguity matrix |
| G5 Command/atomicity | 每次 durable mutation 有 Command、idempotency、CAS、writer、crash recovery | command inventory + atomic batch/saga table |
| G6 Evidence | Receipt、Artifact、WorkflowOutcome、Observation、CompletionAssessment 只有一条真相链 | provenance graph + conflicting-evidence cases |
| G7 Promotion | Goal-local learning、Project Candidate、User/shared promotion、replay modes、rollback 与 anti-thrashing 可判定 | scope lattice + effect-free replay contract + rollback cases |
| G8 Authority/storage | Project、user、Coordinator、Registry 权威无重叠；pre-project user ControlDomain 有明确边界 | authority matrix + cross-store saga |
| G9 Concurrency/effects | 并行 Goal/Branch 的 workspace、effect、budget、cancel、unknown 不互相污染 | resource/effect conflict matrix |
| G10 Compatibility | existing Taskflow、legacy Run、0.3 reader/writer、migration、rollback 与 feature negotiation 有明确策略 | compatibility matrix + version-skew cases |
| G11 Agent governance | Agent role、Component pin、model/tool/prompt provenance、unavailable/substitution、malformed output 可恢复 | resolution algorithm + failure table |
| G12 UX | Simple/Pro 映射不隐藏 uncertainty、approval、live effects 或 failed verification | static fixtures + user comprehension criteria |
| G13 P-ADR readiness | 每个待冻结 wire/authority 问题有唯一 P-ADR owner、输入、输出和依赖顺序 | ordered P-ADR backlog |
| G14 文档质量 | 无 Blocker/Major；术语、编号、链接、代码块、图和 normative 用词一致 | 独立 review + Markdown checks |

### 当前状态

| Gate | 状态 | 当前主要缺口 |
|---|---|---|
| G0 | PASS | normative foundations 与 contextual history 已分离；current/specified/target/open 证据纪律已写入 |
| G1 | PASS | entity classification、逐实体八问、record/projection 拆分和 Command ownership 已闭合 |
| G2 | PASS | repo-wide process/effect inventory、四类 classification、allowlist 与 unclassified-site release rejection 已由 independent reviewer 复核 |
| G3 | PASS | legal status/stage、terminal preconditions、multi-Branch reduction、fork/supersede 已冻结 |
| G4 | PASS | Segment/Run cardinality、retry/replan/resume/replay 边界、invalidation 与 crash matrix 已冻结 |
| G5 | PASS | project/user Commands、idempotency/CAS、atomic batch、cross-store saga 与 crash recovery 已列出 |
| G6 | PASS | Claim classes、Assessment ownership、唯一 provenance 链、冲突/staleness reduction 已冻结 |
| G7 | PASS | scope lattice、replay modes、affected-set corpus、risk/canary policy、rollback/quarantine 已冻结 |
| G8 | PASS | 四 store authority matrix、user ControlDomain safety floor 与 binding saga/crash recovery 已冻结 |
| G9 | PASS | topology/enforcement、Approval reservation、ambient-effect 边界和 P-A6 conformance 已由 independent reviewer 复核 |
| G10 | PASS | compatibility/version-skew matrix、feature negotiation、migration/downgrade 与 graceful degradation 已冻结 |
| G11 | PASS | role resolution/pin/provenance、concrete-Agent request、substitution 和 failure behavior 已冻结 |
| G12 | PASS | A–K 十一个 fixtures 覆盖全部 W8 强制场景并进入 deterministic/comprehension acceptance |
| G13 | PASS | P-A0–P-A10 有序 backlog 已定义 owner/input/output/dependency/counterexample/acceptance，并映射全部 15 问 |
| G14 | PASS | 同一 independent reviewer 两轮核验后确认 0 Blocker、0 Major；原 M1–M9 和新依赖环均 CLOSED |

当前 closure blockers：

- 无。RFC-level closure 已满足。
- P-ADR、TypeBox、代码、Web fixtures、single-runtime migration、0.3 GA/release
  仍是后续实施工作，不属于本 Goal 的完成声明。

---

## 6. 收敛工作流与依赖顺序

```text
W0 事实基线与 claim audit
  ↓
W1 最小本体与唯一真相链
  ↓
W2 single-runtime Agent/Control Segment 协议
  ↓
W3 Goal Branch / Segment / Run command 与状态机
  ↓
W4 authority / user ControlDomain / cross-store saga
  ↓
W5 Evidence / replay / Promotion / rollback
  ↓
W6 concurrency / workspace / effects / no-progress
  ↓
W7 compatibility / migration / feature negotiation
  ↓
W8 Simple/Pro fixtures
  ↓
W9 P-ADR backlog + independent final review
```

后续工作不得因为某一层“容易写”而跳过前置权威问题。

### W0：事实基线与 claim audit

必须：

- 重新确认 cwd、branch、HEAD、dirty state。
- 通读当前 RFC、0.3 master RFC 和本 Goal。
- 检查 normative dependencies 的当前状态，区分 active、historical、
  superseded-in-part。
- 对每个“current Taskflow supports …”声明定位代码、测试或明确标记
  architecture target。
- 建立 claim → source → confidence → required follow-up 表。

停止线：任何无法确认的 current-state 声明改为 target/unknown，不能靠记忆补齐。

### W1：最小本体与唯一真相链

必须：

- 建立 entity classification：
  `authority aggregate | immutable record | event | Artifact | projection`。
- 对每个对象应用 §3.1 的八问。
- 特别审查：
  `WorkflowOutcome`、`Observation`、`CompletionAssessment`、
  `AgentInvocation`、`BranchSnapshot`。
- 删除重复 store、重复 status、重复“最终结果”字段。
- 将 Project Main 固化为 immutable manifest of refs，而不是长驻 Agent 或
  mutable process。

停止线：如果两个对象可以独立表达相反事实，G1/G6 必须保持 FAIL。

### W2：single-runtime Agent/Control Segment

必须：

- 定义 `ControlledAgentRoleBinding` 的 resolution、pin、substitution 和
  attenuation。
- 冻结 Control Segment purpose：
  route、clarify、plan、review、synthesize、verify、extract、replay。
- 定义 Branch Snapshot → Planning Segment → Planning Run → Proposal Artifact
  → validation → Command 的完整顺序。
- 明确 Planning Run unknown/timeout/cancel/retry/reconcile 行为。
- 定义 pre-project routing Run 的 user ControlDomain owner。
- 审计当前和计划入口，列出所有可能绕过 ControlHost 的 Agent/provider 调用。
- 规定静态 conformance test 或 import/layer boundary，阻止未来 bypass。

停止线：任何 future Goal/Control Agent role 仍可由 Supervisor 直接调用，或
current legacy path 可读写 future authority 时，G2 保持 FAIL。当前代码尚未迁移
属于 implementation/release gate，不能被描述为已完成，但不要求本 docs-only
Goal 越权修改代码。

### W3：Goal Branch / Segment / Run 协议

必须：

- 冻结 Goal、Branch Status/Stage、terminal set 和合法 pairings。
- 冻结 Branch Revision CAS、fork、supersede、adoption、completion reduction。
- 冻结一个 Segment execution → 一个 Run。
- 区分：
  Goal-level new Segment、Run-local BoundFragment、Run retry/Attempt、
  resume/recompute/replay。
- 为以下边界写 crash matrix：
  planning Link、planning admit、proposal Receipt、Revision commit、work Link、
  work admit、work Receipt、synthesis/verification、completion commit。
- 定义被 invalidated 但未开始、正在执行、ambiguous、已完成 Segment 的处理。

停止线：不得通过“最终一致”掩盖同一 Branch 两个 Revision winner 或重复 effect。

### W4：Authority、storage 与 cross-store saga

必须：

- 给出 Project ControlStore、UserTaskflowStore、UserCoordinatorStore、
  ControlRegistry 的 authority matrix。
- UserCoordinatorStore 只能拥有 singleton/concurrency/coordinator commands。
- Registry 只能 discovery/projection。
- pre-project Goal envelope 和 routing/bootstrap Control Runs 只能进入未来 user
  ControlDomain。
- 定义 user Proposal → project binding intent → project accept → user projection
  saga。
- 逐 crash point 证明不会创建第二个 projectId、丢失已接受 Goal 或把 user
  Proposal 当作 project authority。

停止线：若跨 store 需要“原子写两边”才能正确，应回到设计而不是隐藏事务窗口。

### W5：Evidence、replay、Promotion 与 rollback

必须：

- 定义 `verified fact | hypothesis | unknown | invalidated`。
- 所有 fact 必须引用 Receipt、Artifact、verifier、人类决定或权威外部观察。
- 明确 event replay、planner shadow、fixture execution、live canary 的 effect
  和 authority 差异。
- 定义 Candidate scope lattice：
  `goal → project → user → shared`。
- 每次 widening 都需要独立 Evidence、redaction、authorization、replay 和
  rollback。
- 定义 rollback 只切换未来 pointer，不删除历史。
- 定义 promotion cooldown、budget、rollback-triggered disable。

停止线：模型输出、raw trace 或一次成功不能直接进入 Project Main。

### W6：Concurrency、workspace、effects 与 no-progress

必须：

- 定义多 Goal/Branch workspace 模式、shared mode、worktree/overlay 策略。
- 将 logical topology 与 `resolve-only | sandboxed` enforcement 分开；
  worktree/COW 不得被描述为 security boundary。
- 定义 resource/effect declaration、reservation、conflict、stale-context。
- 区分逻辑隔离和共享现实中的 deployment/database/service 冲突。
- 定义 `unknown` 下容量、effect reservation 和后续 Segment 行为。
- 定义 Approval parked-before-effect 时 exclusive reservation 的释放/降级，
  以及继续时 capacity/reservation/pins 的重新获取与校验。
- 定义 no-progress predicate，不仅依赖 Agent 自评。
- 限制 Revision、Segment、fork、depth、time、tokens、cost、effect 和
  promotion frequency。

停止线：无法证明外部 effect 已停止时，不得释放必要 authority/capacity 或启动
冲突 Segment。

### W7：Compatibility、migration 与 feature negotiation

必须：

- 定义 legacy Run 只能作为 `legacy-run`，不能伪造原始 Goal。
- 定义 future schema 的 read/write negotiation 和 unknown-record behavior。
- 定义 0.3 reader、future reader、downgrade、read-only export。
- 定义新对象和现有 BoundPlan/BoundFragment 的关系，不修改 0.3 wire。
- 定义 feature unavailable 时 fail-closed、pause 或 explicit compatibility
  behavior，禁止 silent fallback。

停止线：不能要求旧客户端错误理解新数据仍继续 execute。

### W8：Simple/Pro 可执行 fixture

必须至少准备静态 fixtures：

1. 一个 Goal 跨三次 Run 完成；
2. 一个 Planning Run ambiguous；
3. 两个 Branch 竞争并显式选胜；
4. Main promotion 后旧 Branch pinned；
5. 用户需要 Approval；
6. Goal 保持 unknown；
7. Candidate 被 replay 拒绝；
8. pre-project router 不可用但已绑定 project 可继续。

每个 fixture 同时定义：

- Simple 用户看到什么；
- Pro 用户看到哪些 exact refs；
- 哪些不确定性不能隐藏；
- 哪些操作需要人类决定。

### W9：P-ADR handoff 与独立终审

必须：

- 把所有 Open Questions 分成：
  `RFC must decide | P-ADR must decide | product/human decision | intentionally deferred`。
- 为每个 P-ADR 指定：
  owner boundary、inputs、outputs、dependencies、counterexamples、acceptance。
- 给出依赖顺序，禁止多个 P-ADR 同时声称同一 authority。
- 进行一次独立 adversarial review，问题分为 Blocker/Major/Minor。
- Blocker 和决定 wire/authority 的 Major 全部关闭后再判定 RFC closed。

---

## 7. 每轮 Agent 执行协议

每次开始或自动继续时必须按顺序：

1. 读取本 Goal、目标 RFC、0.3 master RFC。
2. 记录当前 cwd、branch、HEAD、dirty state；保留用户已有改动。
3. 查看 Closure Matrix，选择最高风险的一个 `FAIL/PARTIAL` Gate。
4. 先写出该 Gate 的最小反例或不可区分性边界。
5. 从代码、测试、现有 RFC、P-ADR 获取事实；区分：
   `implemented | specified | proposed | unknown`。
6. 提出最小修正；优先删减、合并、降级 projection，避免增加新一等实体。
7. 只修改目标 RFC 和必要的 Goal 状态。
8. 更新 Gate 状态、Evidence、剩余反例和下一步。
9. 执行 Markdown/链接/fence/whitespace/编号检查。
10. 自审是否产生新的 authority、runtime、truth source 或 silent fallback。
11. 未闭环时继续最高风险 Gate；遇到真正产品/信任决策才请求用户。

每一轮只允许一个主要架构判断，避免同时改变多个依赖层后无法证明因果。

---

## 8. 强制反例集

终审至少必须回答：

1. Planner Run 已 submit 但 acknowledgement 丢失，是否会启动第二个 Planner？
2. 两个 Planner 基于同一 Revision 同时返回合法 Proposal，谁提交？
3. Proposal 已有 Receipt，但 Branch Revision commit 前崩溃，如何重试？
4. Work Segment Link 成功但 admission 容量不足，Branch 当前状态是什么？
5. Work Run unknown 时 Planner 能否继续生成冲突 Segment？
6. Evidence Synthesizer 与 Receipt 对事实判断冲突，谁是权威？
7. Completion Verifier 输出 PASS，但必需 Artifact 丢失，Goal 能否完成？
8. Branch A 成功、Branch B unknown，Goal 如何归约？
9. Main v13 promotion 后，v12 Branch 的下一个 Planning Run使用哪个 Agent pin？
10. Component Agent unavailable 时，能否自动替换模型或 Agent？
11. pre-project Router Run 成功但 project accept acknowledgement 丢失，是否重复创建项目？
12. UserTaskflowStore 不可用时，已绑定 Project Goal 能否继续？
13. event replay 中出现 deployment effect 请求，是否会真实执行？
14. live canary ambiguous 时，是否会 Promotion？
15. Registry 丢失后，能否从 aggregate view 发出 project mutation？
16. Goal Branch revision stream 可读但一个 projection 缺失，是否能重建？
17. 整个项目 store 回滚到旧 Revision 时，系统是否会把旧状态当最新？
18. Simple UI 是否会把 `unknown`、approval、failed verification 隐藏成进度文案？

任何反例没有确定行为、authority 和 Evidence 时，对应 Gate 不得标 `PASS`。

---

## 9. 文档与证据验证

每轮至少执行：

```bash
git diff --check
rg -n '[[:blank:]]+$' docs/internal/rfc-hierarchical-adaptive-taskflow.md
rg -n '^#{1,4} ' docs/internal/rfc-hierarchical-adaptive-taskflow.md
```

并验证：

- Markdown fences 成对；
- 所有相对链接存在；
- §0–§26 连续；
- Decision ID 无重复；
- status/terminal/unknown 用词无冲突；
- `MUST`、`must`、`may`、`proposal`、`target` 不混淆；
- current implementation 声明有代码或测试位置；
- 没有把 post-0.3 对象写进 0.3 wire；
- 没有把格式通过写成架构或实现完成。

若未来进入实现阶段，文档检查不能替代 TypeBox fixtures、fault injection、
scoped tests、packaged E2E 或 clean candidate proof。

---

## 10. 决策与问题纪律

### 可由 RFC 自行收敛

- projection 与 authority entity 的分类；
- 术语、层级和图；
- 一 Segment execution → 一 Run；
- single-runtime 与 direct-call 禁令；
- pure event replay 无 effect；planner shadow 是无 domain effect 的 controlled Run；
- Goal-local 与 promoted learning 边界；
- Simple/Pro 信息层级。

### 必须请求用户或产品/安全责任人的判断

- protocol/UI 是否统一使用 `ProjectTaskflowVersion`；
- Host title revision 的自动接受边界；
- multi-Branch Goal 的产品终态和 winner 语言；
- pre-project user ControlDomain 的 retention/disclosure；
- whole-root rollback 的外部信任模型；
- cross-project promotion 的授权和隐私责任人。

提问时必须提供：

1. 已观察事实；
2. 无法由代码决定的原因；
3. 两个或三个可行选择；
4. 每个选择的安全、兼容和产品代价；
5. 推荐选择及其可回滚性。

---

## 11. 进度记录模板

每轮在本节追加一条简短记录，不粘贴完整 transcript：

```text
Round N · YYYY-MM-DD
Gate:
Counterexample:
Observed facts:
Decision:
Files changed:
Validation:
What this proves:
What this does not prove:
Next highest-risk Gate:
```

记录必须保持：

- 不把 `PARTIAL` 改名为 `PASS`；
- 不删除仍影响结论的历史反例；
- 后续决定若推翻前一决定，写明 supersession；
- 证据路径、commit、代码行或测试必须可重新定位。

### Round 0 · 2026-07-24

```text
Gate: Goal initialization
Counterexample: Planner Agent 若由 Supervisor 直调，会形成第二套无 journal、
  retry、cancel、reconcile、cost 和 Receipt 的 runtime。
Observed facts: RFC v3 已接受所有模型/effect 调用必须属于受控 Run；
  pre-project model routing 因此需要 future user ControlDomain。
Decision: 将 single-runtime、one Segment execution → one Run、
  immutable Branch Revision、scoped Promotion 作为不可谈判宪法。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: Goal/RFC fences balanced；relative links resolve；无 trailing whitespace；
  heading inventory complete；diff whitespace check clean
What this proves: 已有明确收敛目标和停止条件。
What this does not prove: RFC 尚未通过 ontology、atomicity、compatibility 或
  independent adversarial review。
Next highest-risk Gate: G1 minimal ontology and single truth chain。
```

### Round 1 · 2026-07-24

```text
Gate: G0 source and boundary
Counterexample: 将 superseded-in-part 的 FlowIR shadow RFC 或早期 flow{def}
  设计整份列为 normative，会让 implementer 服从已被当前 compiler/runtime
  超越的历史方案。
Observed facts:
  - 0.3 master RFC architecture approved、wire not frozen；
  - workspace capability RFC 是 active design boundary；
  - FlowIR shadow/vendor 方案明确 historical；
  - 早期 dynamic-DAG 文档只裁决 nested flow{def}，当前 runtime 已有
    expand graft；
  - taskflow-core 当前支持 12 phase，但 event kernel 仍排除 race/expand。
Decision:
  - normative foundations 只保留 0.3 Control Plane 与 workspace capability；
  - FlowIR/dynamic-DAG 文档降为 contextual design history；
  - current implementation claim 必须引用当前源码/测试或标
    specified/target/open；
  - 明确 dynamic core support 不等于 0.3 ControlHost/event-kernel parity。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: RFC 的来源层级和 0.3 边界不再依赖已过时的整份文档。
What this does not prove: 其余 current-state claims 尚未完成逐条代码审计。
Next highest-risk Gate: G1 minimal ontology and single truth chain。
```

### Round 2 · 2026-07-24

```text
Gate: G1 minimal ontology and single truth chain
Counterexample:
  - Goal/GoalBranch 若把 immutable identity 与 status/currentRevision 放在同一
    可写记录，事件流和记录字段可以分别表达相反状态；
  - Branch Snapshot checkpoint 若属于 minimum authoritative events，损坏或
    过期 checkpoint 可能覆盖 Revision journal；
  - ProjectTaskflowVersion 若在 promotion 后补写 promotedAt/promotionRecordId，
    “immutable version”名义上不可变、实际上仍被修改；
  - Candidate 若内嵌可变 status，会与 validation/promotion events 形成双真相。
Observed facts:
  - 0.3 的 Run Events/Receipt 已经是执行事实基础，不需要 WorkflowOutcome
    再成为执行权威；
  - Goal、Branch、Candidate 的 lifecycle 可以由 append-only events fold；
  - Snapshot、Outcome、Assessment、Invocation 和 UI progress 都能从权威记录
    或 Artifacts 推导。
Decision:
  - 新增 authority classification table；
  - GoalRecord/GoalProjection、GoalBranchRecord/GoalBranchProjection、
    ExperienceCandidate/ExperienceCandidateProjection 分离；
  - ProjectTaskflowVersion 删除可后写的 promotion 字段；
  - Snapshot checkpoint 从 minimum authoritative event families 移除；
  - 冻结 Run Events → Receipt/Artifacts → Revision evidence refs →
    BranchSnapshot → GoalProjection 的单向真相链；
  - Outcome、Observation、Assessment、AgentInvocation 与 UI projection
    明确不得推进 authority。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: 关键展示对象不再天然成为第二套可写 aggregate；immutable
  record 与 lifecycle projection 在架构层已经分离。
What this does not prove: 每个实体的 Command、CAS、idempotency、terminal
  transitions 和 exact wire 尚未冻结，因此 G1/G5/G6 仍不能 PASS。
Next highest-risk Gate: G2 single-runtime current-code bypass inventory。
```

### Round 3 · 2026-07-24

```text
Gate: G2 single-runtime current-code bypass inventory
Counterexample: RFC 若只规定“未来 Planner 走 Run”，但 Pi、background、resume
  或 emergency fallback 仍可直接注入 SubagentRunner/executeTaskflow，则系统
  仍有两个 admission、Attempt、cancel、reconcile 和 Receipt 语义。
Observed facts:
  - MCP foreground 默认用 ControlHost + host LLM ExecutionProvider；
  - MCP background 明确仍走 0.2 detached runner；
  - MCP resume 直接调用 executeTaskflow；
  - Pi normal/resume/apply-recompute 仍向 executeTaskflow 注入 runTask；
  - ControlHost phase scheduler 已有 provider seam；
  - host LLM provider 的 cancel 当前只更新 adapter-local 状态，未证明 child
    execution 已停止。
Decision:
  - 把 single-runtime 标成 target constraint，不声称 current checkout 已实现；
  - legacy opt-out 只能服务 existing 0.2 program，不能读写未来 Goal authority；
  - future Goal feature 上线前必须覆盖所有 entry path；
  - conformance gate 增加 import/layer allowlist、route fail-closed、
    cancel/reconcile、Receipt provenance 和 legacy isolation tests。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: 已知 bypass 不再被“一个 runtime”的架构叙事隐藏，且关闭
  标准可以由代码路径和测试判定。
What this does not prove: bypass 尚未实现迁移，host LLM cancellation 尚未形成
  可证明 quiescence，因此 G2 仍为 PARTIAL。
Next highest-risk Gate: G3/G4 Segment-Run cardinality and lifecycle conflicts。
```

### Round 4 · 2026-07-24

```text
Gate: G3 Goal/Branch + G4 Segment/Run + project half of G5
Counterexample:
  - 一个 Branch completed 时若直接把 Goal completed，另一 Branch 仍可能部署；
  - invalidated 若能取消“可能已 dispatch”的 Segment，会把未知 effect 当作停止；
  - “resume”若同时表示 Attempt retry、Goal replan、offline replay 和 legacy
    recompute，会破坏 Run identity 与 effect safety；
  - Goal proposed 若同时存在 user/project store，会产生 pre-project 双权威。
Observed facts:
  - 0.3 Run/Attempt/Receipt 已提供 execution identity；
  - Goal-level adaptation需要新的 Segment/Run，而非追加旧 Run；
  - project Goal 只有在 project acceptance 后才需要成为 authority；
  - Branch terminal、Goal terminal 与 projection refresh 可以分别 crash。
Decision:
  - project Goal 从 active 开始；unbound request 只是 future user
    ControlDomain 的 GoalEnvelope；
  - 冻结 Goal/Branch legal status-stage pairs 和 terminal transition proof；
  - multi-Branch Goal terminal 必须等待所有相关 effect settle，再以明确
    completed/cancelled/blocked/failed basis 提交；
  - 冻结 Goal→Branch→Revision→Segment→Run→Attempt/Receipt cardinality；
  - 区分 retry、approval continuation、reconcile、replan、fork、adoption、
    replay、legacy resume/recompute；
  - running/ambiguous Segment 只能请求 supersession 并 settle/reconcile；
  - 建立 planning/work/approval/adoption/completion crash matrix；
  - project durable mutations 建立 Command/writer/idempotency/CAS/batch 表。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: G3/G4 的架构语义已经可以用状态、基数和 crash
  counterexample 判定，不再依赖“最终一致”或 UI 状态猜测。
What this does not prove: exact wire/TypeBox 仍归 P-ADR；user-to-project saga
  尚未有逐 command/crash 表，因此 G5 仍为 PARTIAL。
Next highest-risk Gate: G6 Evidence classification and contradiction handling。
```

### Round 5 · 2026-07-24

```text
Gate: G6 Evidence
Counterexample:
  - Receipt completed 若等于“事实为真”，provider 成功会被误当语义正确；
  - WorkflowOutcome 同时内嵌 facts、hypotheses、obligations、assessment，会与
    Claim/Assessment 记录分别表达冲突结果；
  - 新 Agent 输出若能覆盖旧 Claim，历史不再 immutable；
  - missing/contradictory evidence 若被归零或 false，会产生 fake completion。
Observed facts:
  - Receipt 只能证明其 assurance/provider observations；
  - Artifact digest 只能证明完整性，不证明内容为真；
  - Completion terminal 已由 Project Command 掌权；
  - Branch Revision 可以引用 Claims 而无需 Claim 成为独立 aggregate。
Decision:
  - WorkflowOutcome 降为 Receipt-backed index Artifact，不重复 Claim 和
    obligation disposition；
  - 冻结 verified-fact/hypothesis/unknown/invalidated 四类语义；
  - CompletionAssessment 是 immutable Artifact，不能 terminalize Goal/Branch；
  - contradiction 保留双方并把依赖命题降为 unknown，解决时追加
    invalidation/supersession relation；
  - source precedence 必须预先写入 Constitution/Contract；
  - stale verified Claim 保留历史验证范围，但不能复用于新 scope/digest；
  - 增加 provider success、missing Artifact、authority disagreement、
    stale workspace 和 approval-vs-correctness 反例。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: Receipt、Artifact、Claim、Outcome、Assessment 和 terminal
  Command 现在只有一条单向 provenance，不会以对象名不同形成多份真相。
What this does not prove: exact Claim/Assessment TypeBox 仍归 P-ADR；实现与
  migration 尚未开始。
Next highest-risk Gate: G8 authority matrix and user-to-project saga。
```

### Round 6 · 2026-07-24

```text
Gate: G1 minimal ontology + G5 Command atomicity + G8 authority/storage
Counterexample:
  - pre-project Goal 若同时写 user/project store，会有两个 Goal authority；
  - project accepted、user acknowledgement 丢失时若重新 bootstrap，会创建第二
    projectId/Goal；
  - UserCoordinatorStore 若保存 routing Receipt 或 binding saga，会从 capacity
    ledger 扩张成用户总账；
  - Registry 若是 acceptance 唯一记录，重建/损坏会改变身份；
  - UserTaskflowStore 若直接写 Project ControlStore，会绕过 project fence。
Observed facts:
  - 0.3 已冻结 Project ControlStore、narrow UserCoordinatorStore 和
    non-authoritative Registry 边界；
  - future pre-project model Run 需要独立 user ControlDomain；
  - cross-store correctness 可以用 stable bindingIntentId 和各自幂等 Command
    完成，不需要伪造分布式原子事务。
Decision:
  - 增加 first-class entity 八问审计；
  - 冻结 Project/UserTaskflow/Coordinator/Registry authority matrix 和 negative
    permissions；
  - UserCoordinatorStore 只保留 singleton/concurrency/coordinator Commands；
  - user ControlDomain 独立 journal/writer/ControlHost，capacity reservation 不
    携带 Goal/Artifact 内容；
  - 冻结 Envelope → user Control Run → binding intent → project acceptance →
    user acknowledgement → Registry projection saga；
  - project writer 对 bindingIntentId 唯一索引，accepted-before-ack 只修复
    projection，不创建新身份；
  - retention safety floor 禁止删除 live/ambiguous、unacknowledged 或仍被
    Promotion 依赖的记录。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: 一等实体、durable mutation 和四个 store 的 authority 已有
  唯一 owner；跨 store crash 不依赖双写原子性。
What this does not prove: retention duration/disclosure copy 和 exact wire 仍由
  产品决策/P-ADR 冻结；代码尚未实现 UserTaskflowStore。
Next highest-risk Gate: G7 Promotion scope lattice and replay authority。
```

### Round 7 · 2026-07-24

```text
Gate: G7 Promotion + G9 concurrency/effects
Counterexample:
  - planner-shadow 若标“无 effect”并由 reducer 调模型，会绕过 single-runtime；
  - project Candidate 若直接改 user/shared 记录，会把一次 scope widening 伪装
    成 status update；
  - 固定抽 N 个历史 Goal 不能覆盖 Candidate 的真实 affected-set；
  - rollback 若等同删除版本，已 pin Goal 与外部 effect 会失去 provenance；
  - 不同 worktree 仍可能同时 deploy/database write；
  - cancel/TTL 若释放 unknown effect reservation，会允许冲突重复 effect；
  - Agent 自述“有进展”可无限重写计划。
Observed facts:
  - model invocation 在本 RFC 定义中本身是 external-effect call；
  - 0.3 capacity 对 unknown/orphan-suspect 已采用保守持有；
  - Branch Revision 和 semantic hashes 可提供确定性 progress comparison；
  - scope widening 可以通过 target-scope 新 Candidate 表达。
Decision:
  - replay modes 增加 execution identity/domain-effect/authority contract；
  - planner-shadow/fixture/canary 都是新 control:replay Run；
  - 冻结 goal→project→user→shared scope lattice，每条 widening 创建新
    target-scope Candidate；
  - project low-risk 才可能 auto-promote；user/shared 永不自动；
  - replay corpus 由 semantic affected-set 与 negative boundary fixtures 决定；
  - live canary default-deny，只允许 read-only、isolated shadow 或 dedicated
    canary namespace；
  - rollback 只切 pointer/eligibility，外部 effect 单独 reconcile/compensate，
    rollback 后 quarantine auto-promotion；
  - 冻结 isolated/read-only/shared-serialized/external-only workspace modes；
  - Link 前声明 resource/effect/idempotency/reconcile，dispatch 前重验；
  - unknown 保留冲突 reservation/capacity；
  - no-progress 使用 Evidence-backed semantic-state delta，不接受 Agent 自评。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: 学习扩大作用域、回滚、并行 Branch 与 external effect 已有
  可判定安全边界。
What this does not prove: exact resource-key schema、canary provider enforcement
  和 replay corpus implementation 仍属于后续 P-ADR/代码。
Next highest-risk Gate: G10 compatibility and feature negotiation。
```

### Round 8 · 2026-07-24

```text
Gate: G10 compatibility + G11 Agent governance
Counterexample:
  - old writer 若忽略 future Goal events 后继续写，会破坏 Branch/Main authority；
  - feature unsupported 若 silent fallback 到 0.2，会让 Planner 绕过 Goal kernel；
  - binary downgrade 若被当 store rollback，future events 与 external effects 会
    从历史消失；
  - Agent definition/model 在 Link 后漂移会让 Receipt provenance 失真；
  - “找不到 Agent 就用 default”会绕过 role policy；
  - user 直接传 concrete Agent 若能扩大 capability，会把配置入口变成授权。
Observed facts:
  - 0.3 header 已有 schemaVersion，client/daemon skew 已采用 reject + matching
    package upgrade；
  - historical Run 可通过外部 future records 建立 Goal link，无需 patch 0.3 wire；
  - role resolution 可在 Link 前用确定性 intersection 完成；
  - provider 可能不暴露 exact model version，必须保留 unavailable。
Decision:
  - 增加 old/new reader/writer/client/daemon compatibility matrix；
  - authority/security unknown fields fail closed，只有 projection-safe 字段可忽略；
  - future capabilities 独立 feature negotiation，不互相隐含；
  - migration fenced/restartable/additive，不改写历史；启用后 downgrade 只能用
    compatible binary disable feature，不能让 old writer 回写；
  - 冻结 Agent role resolution 七步算法与 provenance 最小集；
  - concrete Agent 仅在 Main 暴露 selectable binding 时可请求，且只能收窄；
  - substitution default forbidden，只能在 Link 前按 versioned compatibility
    policy；Link 后必须新 Segment/Run；
  - missing/drift/malformed/unauthorized/cancel-ambiguous failure table 已写入。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: future Goal authority 不会通过 version skew、fallback 或 Agent
  substitution 悄悄退化成另一套语义。
What this does not prove: executable schema、handshake 和 migration 工具尚未实现；
  provider exact model identity 仍可能 unavailable。
Next highest-risk Gate: G12 Simple/Pro static fixtures。
```

### Round 9 · 2026-07-24

```text
Gate: G12 UX + G13 P-ADR readiness
Counterexample:
  - Simple 若只显示 progress 百分比，会把 unknown live effect 隐藏成 0/failed；
  - Work Run finished 若显示 Goal completed，会绕过 Completion Assessment；
  - “selected Branch”时 losing Branch 仍可能 deploy，UI 不能提前完成；
  - open questions 若只保留编号清单，没有 owner/dependency/acceptance，无法形成
    可执行 schema freeze。
Observed facts:
  - Simple 字段都能从 Goal/Branch/Run/effect/Assessment/Promotion projection；
  - safety-critical states 可用静态 authority fixture 同时生成 Simple/Pro；
  - 15 个初始问题已有 architecture answer、product decision 或明确 P-ADR owner。
Decision:
  - 建立 Simple field → authority source → Pro expansion mapping；
  - 增加 active replan、Approval、ambiguous live effect、failed verification、
    selected-but-settling、verified completion 六个 fixture；
  - completion/unknown/Approval/failed-verification 加 deterministic projection
    assertions 与 safety-critical comprehension gate；
  - 建立 P-A0–P-A10 有序 backlog，每项含 owner boundary、inputs、output、
    counterexample 和 acceptance；
  - 将 15 个原 Open Questions 全部映射为 architecture answer、P-ADR 或 H1–H6
    human decision；
  - 对 H1–H6 给出 safest reversible recommendation，等待最终人类接受。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC/Goal fences balanced；relative links resolve；无 trailing
  whitespace；RFC §0–§26 sequential；diff whitespace check clean
What this proves: RFC 的用户语义可以从权威状态生成，且后续 wire 工作有依赖
  顺序和可执行验收，不再是无 owner 的问题清单。
What this does not prove: fixture 尚未实现成 Web 组件；H1–H6 仍需要用户确认；
  P-ADR/代码尚未开始。
Next highest-risk Gate: G14 independent adversarial review and final closure audit。
```

### Round 10 · 2026-07-24

```text
Gate: G14 author self-red-team (not independent)
Counterexample: 文档在局部段落都合理，仍可能通过术语或字段产生跨章节冲突。
Observed findings and fixes:
  - A27/Promotion gate 曾把 planner-shadow 写成 no external effect，与“model call
    是 external effect”冲突；已改成 controlled Run + no domain effect；
  - Branch “immediate update”可能被读成 mutable Snapshot；已限定为 next
    validated Revision；
  - ExperienceCandidate 的 projectId/sourceGoal/proposedScope 无法表达聚合后的
    user/shared Candidate；已改 ownerScope + sourceRefs；
  - Candidate riskClass 若由 proposer 写入会抢占 validation authority；已移到
    validation projection；
  - immutable BranchRecord 固定 workspaceBindingRef 无法表达 rebase/adoption；
    已改 initial binding，effective binding/Main pin 进入 Revision；
  - Observation 字段/event 与 Evidence Claim 重复；已统一为 Claim references；
  - initial Project Main 缺少独立幂等 Command；已加入
    InitializeProjectTaskflow；
  - replay contradiction/failure copy 与 Claim conflict reducer 不一致；已统一
    unknown → resolving Evidence → invalidation；
  - docs-only Goal 与“current code 无 bypass”完成条件冲突；已区分 RFC closure
    和 implementation release gate，且 legacy path 不得读写 future authority。
Decision:
  - RFC 升为 v4 architecture closure candidate；
  - self-red-team 不冒充 independent review，G14 保持 PARTIAL；
  - H1–H6 和 independent review 是当前唯一 closure blockers。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC 3145 lines / 126 fences balanced；Goal 1061 lines / 44 fences
  balanced；relative links resolve；无 trailing whitespace；RFC §0–§26
  sequential；diff whitespace check clean
What this proves: 当前作者已主动寻找并关闭跨章节本体、authority、replay 和
  compatibility 冲突，没有把格式检查当独立评审。
What this does not prove: 独立 reviewer 尚未给出无 Blocker 结论；H1–H6 尚未
  获得用户接受，因此 RFC 不能 CLOSED。
Next highest-risk Gate: user H1–H6 decision, then independent review。
```

### Round 11 · 2026-07-24

```text
Gate: pre-final requirement-by-requirement audit
Counterexample: “G0–G13 看起来都完整”不是 closure proof；每个 Gate 必须能
  回指 authoritative section，并显式列出反证或缺失证据。
Observed facts:
  - G0–G13 均能定位到 RFC-level evidence；
  - current implementation bypass、P-ADR/code/Web 未实现均已与 RFC closure
    声明分开；
  - H1–H6 尚无用户 decision；
  - Round 10 是作者 self-red-team，不具备 independent reviewer 身份。
Decision:
  - 新增 pre-final audit table，逐项记录 evidence/result；
  - 明确当前证据反驳 RFC CLOSED；
  - 不再通过新增架构层绕开 H1–H6 或 independent review。
Files changed:
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC 3145 lines / 126 fences balanced；Goal 1118 lines / 46 fences
  balanced；relative links resolve；无 trailing whitespace；RFC §0–§26
  sequential；diff whitespace check clean；目标文档仍均为 untracked
What this proves: 剩余 blocker 已收敛为可观察的外部决定/独立评审，而不是
  隐藏的架构缺口。
What this does not prove: H1–H6 尚未接受，G14 尚未 PASS。
Next highest-risk Gate: user H1–H6 decision, then independent review。
```

### Round 12 · 2026-07-24

```text
Gate: strict blocked audit
Blocking condition: H1–H6 需要用户接受/修改；独立 adversarial review 需要用户
  明确授权 subagent，当前作者不能自批 G14。
Consecutive goal turns:
  - Round 10 首次收敛到该 blocker；
  - Round 11 完成 pre-final audit 后 blocker 不变；
  - Round 12 未收到用户 decision/authorization，且没有剩余可由作者独立推进的
    RFC architecture work。
Decision:
  - 不继续增加架构层或伪造 independent review；
  - Goal 状态改为 BLOCKED ON DECISION；
  - 收到用户回复后按 fresh resumed blocked audit 继续。
Files changed:
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: RFC 3145 lines / 126 fences balanced；Goal 1143 lines / 48 fences
  balanced；relative links resolve；无 trailing whitespace；RFC §0–§26
  sequential；diff whitespace check clean；两个目标文档仍为 untracked
What this proves: 已满足连续三轮同一 blocker 的严格 blocked threshold。
What this does not prove: H1–H6 未决定，G14 未 PASS，RFC 仍未 CLOSED。
Resume phrase: 接受 H1–H6，并允许一个独立 subagent 做最终 adversarial review
```

### Round 13 · 2026-07-25

```text
Gate: resume from human decision blocker
User decision:
  - accepted H1–H6 exactly as recommended in RFC §25.2；
  - authorized one independent subagent for final adversarial review。
Decision:
  - RFC/Goal status updated to H1–H6 accepted；
  - start one read-only reviewer that did not author the candidate；
  - reviewer must grade structure/clarity/completeness/accuracy/actionability/
    maintainability and report Blocker/Major/Minor with exact locations；
  - reviewer does not edit files；author closes findings, then asks the same
    reviewer to verify closure and search for new Blocker/Major。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
Validation: pending independent review and final checks
What this proves: product/trust decision blocker is closed and independent
  review is explicitly authorized。
What this does not prove: G14 remains PARTIAL until reviewer verification。
Next highest-risk Gate: independent adversarial review。
```

### Round 14 · 2026-07-25

```text
Gate: independent adversarial review
Reviewer result:
  - 0 Blocker；
  - 9 Major：Goal semantic-revision race、all-Branch terminal reduction、
    cross-scope Promotion authority、workspace isolation overclaim、incomplete
    process/effect inventory、duplicate event truth、P-A2/P-A7 adoption overlap、
    missing UX fixtures、Approval parked reservation；
  - 3 Minor：Control Segment Link wording、§9.3 source/test provenance、audit
    reproducibility。
Decision:
  - G2、G9、G12 暂时降为 PARTIAL，不以“已有段落”冒充 finding closure；
  - 接受全部 findings；不增加新 authority aggregate；
  - 由作者逐项修复后，只让同一 independent reviewer 做 closure verification。
What this proves: 独立 reviewer 未发现 Blocker，但当前候选仍不能 CLOSED。
What this does not prove: 9 个 Major 尚未由 reviewer 验证关闭。
```

### Round 15 · 2026-07-25

```text
Gate: adversarial finding repair
Repairs:
  - display/semantic Goal revision 分离，Completion Contract digest 贯穿
    Proposal、Revision、Segment、Assessment、commit/admission/pre-effect gate；
  - Goal terminal reduction 要求其拥有的所有 Branch terminal，无 detached/
    “non-relevant” escape；
  - scope widening 改为 source Promotion/export → redacted package → target
    validation → exactly-one target Candidate 的幂等 saga；
  - workspace 拆成 logical topology 与 resolve-only/sandboxed enforcement，
    worktree 不再冒充 security boundary；
  - current checkout audit 记录 HEAD/dirty provenance，并扩为 repo-wide
    process/effect classification 和 future allowlist gate；
  - minimum event families 删除 generic status 与重复 Candidate/Promotion
    truth，AgentInvocation 仅为可选 Run diagnostics；
  - P-A2 独占 Branch adoption mutation；P-A7 只产出 Promotion policy/input；
  - §18.7 增至 11 个 Simple/Pro fixtures；
  - Approval parked-before-effect 释放/降级独占 reservation，继续时重新获取
    capacity/reservation 并重验全部 pins；
  - 三个 Minor 的 Link wording、source/test citation、audit reproducibility
    一并修复。
Validation: pending mechanical checks and same-reviewer verification
What this proves: 每个 finding 都有具体 normative repair。
What this does not prove: reviewer 尚未确认无剩余/new Blocker/Major。
Next highest-risk Gate: same-reviewer closure verification。
```

### Round 16 · 2026-07-25

```text
Gate: same-reviewer closure verification + final audit
Independent result:
  - original M1–M9: CLOSED；
  - original L1–L3: CLOSED；
  - repair-time P-A7↔P-A8 dependency-cycle Major: CLOSED；
  - final sandbox/resolve-only wording delta: verified；
  - new Blocker: 0；new Major: 0；G14 PASS。
Final six-dimension scores:
  structure 5/5；clarity 4/5；completeness 5/5；accuracy 4/5；
  actionability 5/5；maintainability 4/5。
Final architecture decision:
  - G0–G14 全部 PASS；
  - RFC status → Architecture closed；
  - Goal status → COMPLETE / RFC CLOSED；
  - CLOSED 仅表示 architecture RFC 闭环，不表示 P-ADR、TypeBox、代码、
    Web fixtures、single-runtime migration、0.3 GA 或 release 已完成。
Mechanical validation:
  - RFC 138 fences、Goal 56 fences，均 balanced；
  - relative links resolve；trailing whitespace 0；
  - RFC §0–§26 sequential；A1–A32 unique；P-A0–P-A10 unique；
  - diff whitespace check clean；
  - two authorized files remain untracked；no stage/commit/push。
Files changed:
  - docs/internal/rfc-hierarchical-adaptive-taskflow.md
  - docs/internal/hierarchical-adaptive-taskflow-rfc-closure-goal.md
```

---

## 12. Pre-final requirement audit

本表是独立终审前的逐要求审计。`PASS` 只表示当前作者能从现有文档定位到足够
的 RFC-level evidence；它不替代 P-ADR、代码实现或独立 reviewer。

| Requirement | Authoritative evidence | Audit result |
|---|---|---|
| G0 source/boundary | RFC header、normative/contextual dependency split、§19.4 | PASS；未把 post-0.3 对象加入 0.3 wire |
| G1 minimal ontology | RFC §4.1 classification + eight-question table；§6–§8 record/projection split | PASS；未发现第二 mutable head |
| G2 single runtime | A29–A32；§6.5；§9.6 repo-wide process/effect inventory + conformance gate | PASS；reviewer 确认 inventory/classification/allowlist 关闭 M5 |
| G3 Goal/Branch | §17.1–§17.4 legal pairs、transitions、multi-Branch reduction、fork/supersede | PASS；terminal Goal 不能掩盖 losing live effect |
| G4 Segment/Run | §9.2、§9.8–§9.10 cardinality、operation boundary、invalidation、crash matrix | PASS；一个 Segment 不会绑定第二 Run |
| G5 Command/atomicity | §15.7 project/user Command inventory；§15.8 cross-store saga/crash table | PASS；没有跨 store 假原子事务 |
| G6 Evidence | §9.4.1–§9.4.3 Claim/Assessment/conflict model；§17.7 truth chain | PASS；Receipt/Artifact/Outcome/Assessment 不会分别 terminalize |
| G7 Promotion | §13.3–§13.8 replay modes、scope lattice、risk、rollback/quarantine | PASS；widening 每次创建 target-scope Candidate |
| G8 authority/storage | §14–§15.5 four-store matrix、negative permissions、user ControlDomain safety floor | PASS；UserCoordinatorStore 未扩张为用户总账 |
| G9 concurrency/effects | §16.4–§16.8 topology/enforcement、resource/effect/approval/unknown/no-progress | PASS；reviewer 确认 worktree 不冒充 sandbox，parked Approval 可安全释放/重获 reservation |
| G10 compatibility | §19.5–§19.8 reader/writer/version-skew/migration/degradation | PASS；old writer 不得写 future store |
| G11 Agent governance | §6.5.1–§6.5.2 resolution/provenance/substitution/failure table | PASS；concrete Agent 只能在 Main allowlist 内收窄 |
| G12 UX | §18.6 mapping、§18.7 eleven fixtures、§18.8 comprehension acceptance | PASS at RFC level；全部 W8 fixture 已复核，Web implementation 尚未开始 |
| G13 P-ADR readiness | §25 P-A0–P-A10 ordered backlog + §25.1 original-question mapping | PASS；owner/input/output/dependency/counterexample/acceptance 齐全 |
| H1–H6 product/trust | RFC §25.2 accepted decisions；user message 2026-07-25 | PASS；H1–H6 已由用户明确接受 |
| G14 independent review | Round 14 findings + Round 15 repairs + Round 16 verification | PASS；同一 reviewer 确认 0 Blocker/0 Major，M1–M9 与 dependency-cycle Major 全部 CLOSED |
| format/links/whitespace | latest local validation；Round 10 record | PASS for current candidate；独立 review 修改后必须重跑 |
| authorized file scope | `git status --short -- <two docs>` | PASS；只有两个目标文档 untracked |
| no code/0.3 wire/stage/commit/push | scoped status + no Git mutation directive/action | PASS for this Goal work |

结论：当前证据支持 `RFC CLOSED`，且只支持 architecture RFC closure。
P-ADR、TypeBox、代码、Web fixtures、single-runtime migration、0.3 GA 与 release
仍未实现或证明。

---

## 13. 最终停止条件

只有同时满足以下条件，才把本 Goal 标记为 `COMPLETE / RFC CLOSED`：

1. G0–G14 全部为 `PASS`。
2. 每个一等实体通过最小本体八问。
3. single-runtime 没有规范例外；已知 current legacy bypass 全部被盘点、隔离，
   且不能读写 future authority，并作为 implementation release blocker。
4. Goal/Branch/Segment/Run/Receipt/Promotion 的 cardinality、authority、
   state、Command 和 crash behavior 无未决冲突。
5. 15 个初始 Open Questions 全部被关闭、转交明确 P-ADR、取得人类决策或带理由
   intentional defer。
6. 所有 Blocker 和决定 authority/wire 的 Major 已关闭。
7. 至少一轮独立 adversarial review 没有发现新的 Blocker。
8. P-ADR backlog 有依赖顺序、owner boundary、counterexamples 和 acceptance。
9. Markdown、链接、fence、编号、whitespace 检查全部通过。
10. 最终报告明确区分：
    - RFC 已闭环；
    - P-ADR 尚未实现；
    - 代码尚未实现；
    - 0.3 wire 未被修改；
    - 没有 GA、release 或产品效果声明。

若剩余问题需要不可由代码或文档推导的人类信任/产品决定：

- 本 Goal 保持 `ACTIVE / BLOCKED ON DECISION`；
- 精确记录阻断问题和安全下界；
- 不继续通过新增架构层绕过决定；
- 不将“等待决定”误写为 RFC closed。

最终交付应只有：

1. 收敛后的 RFC；
2. 完整 Closure Matrix；
3. 有序 P-ADR backlog；
4. 关闭或明确转交的 Open Questions；
5. 独立 review 结论；
6. 验证结果和诚实的未实现边界。
