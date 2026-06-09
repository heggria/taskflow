# 设计：运行时动态子流程 —— `flow { def }`

> **状态**：通过三路对抗审查（risk-reviewer / critic / reviewer）+ 仲裁裁决后重写。
> 裁决文档：`docs/internal/adversarial-review-dynamic-dag-verdict.md`
> **范围（本轮）**：让 `flow` phase 接受**运行时内联定义**（`def`），来源通常是上游 phase 的 JSON 输出。
> phase 在运行中生成一段 DAG（纯数据），runtime **先验证再作为嵌套子流程执行**。
>
> 这是 self-expand / A+B 能力（"运行中根据中间结果生成并执行后续计划"）的落地形态。
> 目标对标：Claude dynamic workflow 跑着跑着根据中间结果生成后续步骤——我们用声明式 DAG 实现，
> 且生成物是**纯数据**（无 eval 风险），注入执行前先做结构验证（环 / 断引用 / 重复 id）。

---

## 0. 为什么不是"动态调度器 + graft 进父 DAG"

初版设计提出新增 `expand:{into,appendTo}` 字段，并把 `runtime.ts::runTaskflowLayers()` 的「静态分层 + for 遍历」**整体重写**为动态调度循环，让运行中新生成的 phase 被注入到**父 DAG 的拓扑里**。

对抗审查否决了这条路径（详见裁决文档），核心理由：

1. **本设计的自身示例就是"一次性 plan-then-execute"**（planner 扫描 → 生成审计 phase → gate 收口）。这根本不需要把节点穿插进父拓扑——一个**嵌套子流程**就够了。
2. **graft 进父 DAG 的调度器引入 3 个真 P0**：crash 后注入丢失（持久化竞态）、就绪判定无法区分"依赖未跑"与"依赖跑失败了"（`join:"any"` 误 skip / 死锁）、`mapWithConcurrencyLimit` 迭代中改 `def.phases` 数组的并发风险。
3. **命名空间前缀 `plan/<id>` 破坏插值正则**（`{steps.plan/step-1.output}` 永不匹配，`/` 不在字符类内）。
4. `appendTo` 把编排逻辑泄漏给 phase 作者，且运行时静默断链。

**结论**：本轮用 **`flow { def }`** ——复用已经存在、已经过测试的嵌套 `executeTaskflow` 路径。子流程在**自己的 steps 命名空间**里执行，上述 P0 全部天然不存在。代价是动态节点**不能**穿插进父拓扑（它们被封装在 flow phase 这一个节点里），这恰恰也消除了 `appendTo` 的耦合问题。

> **graft 进父 DAG / remove / replace 留作后续 horizon**，仅当出现"动态节点必须穿插在既有静态下游之间"的真实需求时再做，届时再单独背那套调度器风险。

---

## 1. 现状：`flow` phase 已经具备的能力

`runtime.ts:661`（`type === "flow"`）当前做法：
```ts
const name = phase.use;                       // 已保存 flow 的名字
const subDef = deps.loadFlow(name);           // 从磁盘加载
// 递归检测：name === state.flowName || stack.includes(name) → 拒绝
// budget 继承、preRead 传递、cache（inputHash）、progress 全部已实现
const subResult = await executeTaskflow(subState, { ..., _stack: [...stack, state.flowName] });
```

也就是说，**子流程执行引擎已经完整**：递归栈检测、预算继承、缓存、进度回调、resume（子流程是自己独立的 RunState 单元）全都有。**唯一缺的，是让 `subDef` 来自运行时的内联数据，而不是磁盘上的已保存 flow。**

---

## 2. DSL 形态：`flow` phase 二选一的来源

`flow` phase 当前要求 `use`（已保存 flow 名）。本轮新增**互斥**的 `def`（内联定义，支持插值）：

```jsonc
{
  "id": "plan",
  "type": "agent",
  "agent": "planner",
  "task": "扫描仓库，输出一个 JSON 对象 {\"name\":\"audit\",\"phases\":[...]}，每个 phase 审计一个文件。",
  "output": "json"
},
{
  "id": "execute-plan",
  "type": "flow",
  "def": "{steps.plan.json}",      // ← 新增：运行时解析为一个完整 Taskflow 定义
  "dependsOn": ["plan"],
  "final": true
}
```

**契约（`flow` phase）**：
- `use` XOR `def`：必居其一，不可兼有（验证强制）。
- `def` 为字符串时 → 先 `interpolate()` 解析占位符（如 `{steps.plan.json}`）→ 再 `safeParse()` 兜 markdown fence → 得到一个对象。
- `def` 也可直接是内联对象字面量（作者手写固定子流程，无需上游生成）。
- 解析结果须是一个 **Taskflow**（`{name, phases:[...]}`）；若是裸 `phases` 数组或 `{"phases":[...]}`，runtime 自动包装成 `{name:"<phaseId>-inline", phases:[...]}`。
- 解析出的 def 立即跑 `validateTaskflow()` + `verifyTaskflow()`（环 / 断引用 / 重复 id / 死端 / gate 穷尽 / 预算）。
- **任何失败 → fail-open**：`flow` phase 标记 `defError`，该 phase 失败但 run 按既有 `optional`/`dependsOn` 语义继续；**已产出的上游 output 不丢**。

**子流程 steps 命名空间天然隔离**：子流程内 phase 互相引用 `{steps.x.output}` 在子 `executeTaskflow` 的独立上下文里解析，与父流程的 steps **互不冲突**——无需任何命名空间前缀重写。这是简方案相对 graft 路径的最大结构收益。

> **LLM 输出契约**（写进 SKILL.md）：planner agent 应输出**纯 JSON**，形如 `{"name":"...","phases":[{...}]}` 或裸 `phases` 数组；允许 markdown ```json 围栏（`safeParse` 会剥）；多余字段由 `additionalProperties:false` 自动剔除。

---

## 3. 真正的能力跃迁：`loop` + `flow{def}` 迭代重规划

一次性 `flow{def}` 等价于"plan-then-execute"。但 Claude 命令式工作流真正难复刻的是**数据依赖的迭代**——第 N 轮的计划依赖第 N-1 轮的**结果**。这用 `loop` body 内嵌 `flow{def}` 表达：

```jsonc
{
  "id": "iterative-refine",
  "type": "loop",
  "maxIterations": 5,
  "until": "{steps.iterative-refine.json.done} == true",
  "body": {
    "id": "round",
    "type": "agent",
    "agent": "planner",
    "task": "上一轮结果：{previous.output}\n据此决定下一步：要么输出 {\"done\":true}，要么输出 {\"phases\":[...]} 描述本轮要执行的子任务。",
    "output": "json"
  }
}
```

> 注：`loop` 的 body 若需要"先规划再执行子任务"，可让 body 本身是一个 `flow{def}`，或在 loop 后接一个 `flow{def}` 消费收敛后的计划。完整 worked example 见 §7 的 `examples/`。

**这把"一次性 fan-out"（`map` 已能做）升级为"迭代式重规划"**——每轮 planner 看到前一轮**结果**再决定下一轮**做什么**，正是 Claude `for` 循环里"读 result → 决定 next plan"的声明式等价物，且每轮生成的子计划**执行前都过验证**。

---

## 4. 不变量保护（逐条）

| 不变量 | 保护方式 |
|--------|---------|
| **DAG 必须无环** | 子 def 在执行前跑 `validateTaskflow`（含 cycle detection）；失败 → fail-open，父图不受影响 |
| **运行前可验证** | 静态父图不变；动态子 def 在**执行瞬间**过完整 `validateTaskflow` + `verifyTaskflow`——"先验证再执行"延伸到运行时生成物 |
| **不破坏 resume** | `flow` phase 是单一节点；子流程是独立 RunState 子单元（现状已支持）。父 run 持久化时 `flow` phase 的输入哈希含解析后 def → resume 命中既有缓存语义 |
| **不破坏缓存** | `flow` phase 的 `inputHash` 已含 `flow:<name>` + args；改为含**解析后 def 的内容哈希**，子 def 变 → 缓存失效（正确），子 def 同 → 命中（正确） |
| **只回 final phase** | `finalPhase()` 父图逻辑不变；子流程的 final 由子 `executeTaskflow` 自己收口，只把 finalOutput 作为 `flow` phase 的 output 上回 |
| **不丢工作 (fail-open)** | 子 def 解析/验证失败 → `flow` phase 标 `defError` 失败，但上游 output 保留，run 按 `optional`/`dependsOn` 继续 |
| **终止性** | 复用现有 `_stack` 递归检测；新增 `MAX_DYNAMIC_NESTING`（如 5）限制 `flow{def}` 嵌套深度；`loop` 自身硬帽 `LOOP_HARD_MAX_ITERATIONS=100` 约束迭代次数 → 乘积有界 |
| **id 唯一** | 子流程独立命名空间，与父图 id 不冲突；子 def 内部重复 id 由 `validateTaskflow` 捕获 → fail-open |

---

## 5. 改动文件清单

| 文件 | 改动 | 对账 |
|------|------|------|
| `schema.ts` | `PhaseSchema` 加可选 `def: Type.Unknown()`（[flow] 内联定义，字符串走插值或对象字面量）；`validateTaskflow` 把 flow 的 `requires 'use'` 改为 **`use` XOR `def`**；导出 `MAX_DYNAMIC_NESTING` | arch #3/#6：`applyExpansion` 不再需要；逻辑留 runtime |
| `runtime.ts` | `flow` 分支：若有 `def` → `interpolate`(若字符串) → `safeParse` → 包装成 Taskflow → `validateTaskflow` + `verifyTaskflow` → 失败则 `defError` fail-open；否则复用现有嵌套 `executeTaskflow`（`use` 路径不动）。`inputHash` 含解析后 def 内容哈希。`PhaseState` 加可选 `defError` | arch #5：静态/use 路径零改动 → 535 测试零回归 |
| `interpolate.ts` | 无需改（`{steps.X.json}` 已支持） | risk 验证：插值能力已足够 |
| `render.ts` | 无需改（嵌套子流程已有 subProgress 渲染路径） | arch #13：不闪烁 |
| `index.ts` | 工具 description 提一句 `flow { def }`；不动调度 | — |
| `skills/SKILL.md` | **必加**：`flow{def}` 用法 + LLM 输出契约（纯 JSON phases）+ `loop`+`flow{def}` 迭代示例 | arch #3：AGENTS.md "Modifying DSL Schema" checklist 要求 |
| `README.md` | 定位措辞：删 "better than Claude because we validate"，改为"生成物是纯数据→可安全 LLM 生成（无 eval）+ 注入前剔除结构错误降低失误爆炸半径" | critic Objection 2：验证是真优势但范围比原话窄 |
| `store.ts` | 无需改（def 整体持久化已覆盖） | — |

> `desugar()` 不变：`def` 只在全量 DAG 规格里有效；shorthand（task/tasks/chain）不产出 flow phase，无需处理（arch #4）。

---

## 6. 测试清单（`test/`）

| 文件 | 覆盖 | 对账 |
|------|------|------|
| `test/flow-def-basic.test.ts` | 上游 phase 产出 `{name,phases}` → `flow{def}` 解析执行 → finalOutput 上回 | 核心路径 |
| `test/flow-def-wrap.test.ts` | 裸 `phases[]` / `{"phases":[...]}` / markdown fence 三种形态都正确包装解析 | arch #11 LLM 契约 |
| `test/flow-def-validate.test.ts` | 子 def 含环 / 重复 id / 断引用 / 死端 → `defError` fail-open、父 run 继续、上游 output 保留 | risk #1 + arch #8 |
| `test/flow-def-empty.test.ts` | 子 def 解析出**空 phases** → no-op，flow phase 返回空 output 不报错 | arch #7 |
| `test/flow-def-xor.test.ts` | `use` 与 `def` 同时存在 → 验证报错；都不存在 → 验证报错 | schema |
| `test/flow-def-nesting.test.ts` | `flow{def}` 嵌套超 `MAX_DYNAMIC_NESTING` → 拒绝、不挂死 | risk #7 终止性 |
| `test/flow-def-loop.test.ts` | `loop` + 内嵌动态 def 的迭代重规划：每轮 def 依赖前轮结果，`until` 判停 | critic Objection 1 |
| `test/flow-def-resume.test.ts` | run 在 flow phase 完成后中断 → resume 命中缓存、不重跑子流程 | risk resume |
| `test/runtime-branches.test.ts`（既有）| 回归：`use` 路径与所有静态 phase 行为不变 | arch #5 零回归 |
| `package.json` | 新测试文件加入 `test` 脚本 | AGENTS.md |

---

## 7. 验收

- `npm run typecheck` clean；`npm test` 全绿（含新测试），现有 535 测试**零回归**（`use` 路径与调度器未触碰）。
- e2e 示例：
  - `examples/dynamic-plan-execute.json` —— planner 扫描目录 → `flow{def}` 执行逐文件审计 → gate 收口（一次性 plan-then-execute）。
  - `examples/iterative-replan.json` —— `loop` + 内嵌动态 def，每轮依据前轮结果重新规划直至收敛（迭代重规划）。

---

## 8. 明确不在本轮范围（后续 horizon）

- **graft 进父 DAG**（动态节点穿插既有静态下游之间）+ 配套动态调度器——仅当出现真实需求时再做，届时单独评审那套调度器 P0。
- 「删 / 改」未执行节点（完整可变拓扑）。
- 跨 run 拓扑学习（D）。
- 运行中 pause / stop-single-agent。

## 9. 与初版设计的差异摘要（给读过旧文档的人）

| 维度 | 初版（已否决） | 本版 |
|------|---------------|------|
| 机制 | `expand:{into,appendTo}` 字段 + 注入父 DAG | `flow` phase 加 `def` 内联定义 |
| 执行模型 | 重写 `runTaskflowLayers` 为动态调度循环 | **不动调度器**，复用嵌套 `executeTaskflow` |
| 命名空间 | `plan/<id>` 前缀 + 全字段 ref 重写 | 子流程独立命名空间，**无需前缀** |
| 改动量 | ~300 行 + 3 个 P0 风险 | ~50 行，P0 全部天然规避 |
| 回归面 | 535 测试全部隐式跑新调度器 | `use`/静态路径零触碰，零回归 |
| graft 进父拓扑 | 支持 | 不支持（留后续） |
