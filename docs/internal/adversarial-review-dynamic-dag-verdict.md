# 对抗 Review 裁决：运行时 DAG 动态扩展（self-expand / A+B）

> 三路独立对抗审查（risk-reviewer 工程风险 / critic 根本设计假设 / reviewer 架构与代码契合）+ 仲裁收口。
> Run: parallel-mq6oo9hw-359bc3　日期：2026-06-09

## VERDICT：**proceed-with-required-changes**（设计方向成立，但实现前必须先改设计 + 折叠 P0/P1）

三位 reviewer 一致认可的根基：fail-open 不丢工作、`MAX_DYNAMIC_PHASES` 硬帽、resume 靠整体持久化 def、注入后跑 `validateTaskflow` 做无环/重复 id 网。这些**不要再质疑**。

但有 **3 个真 P0**、若干 P1，以及 critic 提出的**两个架构级方向质疑**必须先回应——其中 critic 的 Objection 5（更简方案）可能让整个执行模型改造缩小 6 倍。

---

## 一、架构级方向裁决（critic 提出，最高优先级——决定要不要写那 300 行调度器）

### 裁决 1：先评估 `flow {def}` 更简方案（critic Objection 5）—— **采纳，改设计**
critic 指出：本设计的**自身示例**（planner 扫描→生成审计 phase→gate 收口）其实是「一次性 plan-then-execute」，用**扩展现有 `flow` phase 接受 inline `def`** 即可实现——零执行模型改造、子 DAG 天然命名空间隔离、自动继承 budget/resume/cache、~50 行 vs ~300 行。
- **谁对**：critic 对。设计文档**未论证**「必须把动态节点 graft 进父 DAG」这一硬需求，就直接跳到了重写调度器。
- **行动**：本轮**先实现 `flow { def }`**（inline 子流程定义，运行时解析+验证+作为嵌套 `executeTaskflow` 执行）。这就拿下了 self-expand 的核心价值（A+B 的实质：运行中生成并执行新计划）。
- **dynamic scheduling loop（graft 进父 DAG）降级为后续**：仅当出现「动态节点必须穿插进既有静态下游之间」的真实需求时再做。届时再背 P0-2/P0-3 那套调度器风险。

### 裁决 2：`appendTo` —— **本轮删除**（critic Objection 3 + risk #6 + arch #9）
三方独立指向同一结论：`appendTo` 把编排逻辑泄漏给 phase 作者、引入运行时静默断链失败、与 graft 进父 DAG 强耦合。`flow {def}` 方案下根本不需要它（子 DAG 自带收口）。**删除，不预留。**

### 裁决 3：DSL 形态反转 —— phase 原生产出 phases 为主（critic Objection 3 + arch #11）
不要 `expand.into` 引用式作为主路径。主契约改为：**phase（`output:"json"`）的输出 IS 一个 phase 数组（或 `{"phases":[...]}`）**，`flow {def}` 通过插值引用它（`"def": "{steps.plan.json}"`）。`safeParse` 先行（吃 markdown fence），`{"phases":[...]}` 兜底解包，多余字段由 schema `additionalProperties:false` 自动剥离。

---

## 二、P0 BLOCKERS（编码前必须解决）

> 注：裁决 1 之后，原 risk 的 P0-1/P0-2/P0-3（持久化竞态 / 三态就绪 / 并发改数组）**全部属于"graft 进父 DAG 调度器"路径，本轮 `flow {def}` 方案下不存在**——子流程走现成的嵌套 `executeTaskflow`，无新调度器。这是选简方案的最大收益。

仍然命中 `flow {def}` 路径的 P0：

- **P0-A 命名空间分隔符 `/` 破坏插值与验证**（arch #1 + risk #9）。`interpolate.ts:27` 与 `schema.ts:collectRefs` 的正则字符类都不含 `/`，`{steps.plan/step-1.output}` 永不匹配。
  → **`flow {def}` 方案下子 DAG 在嵌套执行里有独立 steps 命名空间，不需要前缀**——天然规避。若未来做 graft 路径，分隔符用 `--` 或 `__`（已在正则字符类内），**不要用 `/`**。

- **P0-B 注入/子流程 phases 的全字段 ref 重写**（arch #2）。仅 `flow {def}` 内部 phase 互相引用时，因走嵌套执行的独立命名空间，无需重写——**再次被简方案规避**。（graft 路径才需要深度重写 `task/when/over/context/branches/with/from/eval/until/judge` 全字段。）

---

## 三、P1 MUST-FIX（折叠进 `flow {def}` 实现）

1. **静态路径零改动**（arch #5 + risk 验证#4）。`flow {def}` 是**新增 flow phase 的一个分支**，完全不碰 `runTaskflowLayers`/`topoLayers`——535 测试零回归。这正是简方案。
2. **`flow` phase 校验 `use` XOR `def`**（schema）：二者必居其一、不可兼有；`def` 解析后跑 `validateTaskflow` + `verifyTaskflow`（arch #8：死端/gate 穷尽/预算需对子图重算）。
3. **递归深度上限**（risk #7 + arch #14）。`flow {def}` 嵌套 + `loop` 可乘积爆炸。复用现有 `flow` 递归检测，并加 `MAX_DYNAMIC_NESTING` 硬帽（如 5 层）+ 子流程 phase 计数计入运行级上限。
4. **`loop` + 动态 `def` 组合语义必须明确**（critic Objection 1，**最重要的能力裁决**）。这是真正拉开与 Claude 差距的点：数据依赖的迭代（第 N 轮计划依赖第 N-1 轮**结果**）。
   - 裁决：用 **`loop` body 内放一个 `flow {def}` phase**，每轮 `loop.lastOutput` 喂给 planner 重新生成子 def → 执行 → `until` 判停。文档必须给一个完整 worked example + 执行 trace。
   - 这把"一次性 fan-out"（map 已能做）升级为"迭代式重规划"（Claude 命令式 for+依赖前轮结果的等价物）。
5. **零 phase 子 def 当 no-op**（arch #7）：`def` 解析出空数组 → 子流程直接返回空 output，不报错。
6. **LLM 输出契约**（arch #11）：文档明确——裸 JSON phase 数组；`safeParse` 先行；`{"phases":[...]}` 兜底；多余字段自动剥离；子 phase 里的 `expand`/`def` 嵌套受深度帽约束。

## 四、P2/P3（nice-to-have）

- P2 子 def 解析失败 → fail-open：发起链路保留、`flow` phase 标 `defError`、run 继续（risk #1 精神延续到子流程）。
- P2 并发计数器原子性依赖 Node 单线程协作调度——文档注明（risk #10）。
- P3 TUI：子流程 phase 正常渲染（嵌套 executeTaskflow 已有渲染路径），不闪烁（arch #13）。

## 五、对设计文档的修改清单

1. **重写 §1/§2**：主方案从「expand 字段 + 动态调度器」改为「`flow` phase 接受 inline `def`」。`expand:{into,appendTo}` 整个删除。
2. **新增"为什么不直接 graft 进父 DAG"决策段**：明确 graft（穿插父拓扑）是后续 horizon，本轮用子流程隔离换取零执行模型改造与零回归。
3. **新增 §"loop + flow{def} 迭代重规划" worked example**（回应 critic Objection 1）。
4. **改 README/定位措辞**（critic Objection 2）：删掉"better than Claude because we validate"，改为"声明式 DAG 是纯数据→可安全 LLM 生成（无 eval 风险）+ 注入前剔除结构性错误（环/断引用）降低 LLM 失误的爆炸半径"。验证是真优势但范围比原话窄。
5. **改动文件清单补全**（arch #3/#4/#6）：加 `skills/.../SKILL.md`、`README.md`；`desugar()` 见到 `def`-only 行为明确；`applyExpansion`/子流程解析逻辑放 `runtime.ts`（或新 `expand.ts`），**不放 schema.ts**。
6. **测试清单补全**（arch #7）：`flow{def}` inline 执行 / 空子 def no-op / 子 def 验证失败 fail-open / 嵌套深度帽 / `loop`+`flow{def}` 迭代 / resume 跨子流程边界 / 535 回归。

## 六、CONFIRMED-SOUND（三方一致，实现者不必再纠结）

- fail-open：子 def 失败保留发起 output、run 继续。
- 硬帽防自我繁殖（沿用 LOOP_HARD_MAX / TOURNAMENT_HARD_MAX 模式）。
- resume 靠整体持久化 def（`flow{def}` 下子流程自身已是现成 resume 单元）。
- 注入后 `validateTaskflow`（无环 + 重复 id）是正确安全网。
- 用现有插值系统引用 phase 输出作为子 def 来源，优雅且一致。

---

### 一句话给实现者
**本轮不写动态调度器。实现"`flow` phase 接受 inline `def`（来自上游 phase 的 JSON 输出），运行时验证后作为嵌套子流程执行"，并明确 `loop`+`flow{def}` 的迭代重规划组合。** 这用 ~50 行拿下 A+B 的实质能力、零执行模型改造、零回归——graft 进父 DAG 与 remove/replace 留作后续 horizon。
