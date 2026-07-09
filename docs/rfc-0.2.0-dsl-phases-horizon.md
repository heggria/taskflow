# RFC: DSL 扩展 Phase 设计（脑暴收编 + 语言表面）

> Status: **Design** · 2026-07-09  
> Source brainstorm: [`internal/brainstorm-2026-07-08-0.2.0-phases.md`](./internal/brainstorm-2026-07-08-0.2.0-phases.md)  
> DSL 基线: [`rfc-0.2.0-dsl-syntax.md`](./rfc-0.2.0-dsl-syntax.md) v2 + [`rfc-0.2.0-s4-mvp.md`](./rfc-0.2.0-s4-mvp.md)  
> Engine foundation: event log + FlowIR (S0–S3) — *why these phases are cheap now*

**目标：** 把「0.2.0 脑暴的更强 phase」收成 **DSL 可写的语言形状**，并分轨：

| 轨 | 含义 |
|----|------|
| **A · 已有能力 / 仅 DSL 糖** | 引擎已有或字段已有，S4 给 rune / 文档 |
| **B · S4.x 引擎 + DSL 一起做** | 新 `PHASE_TYPES` 或大增强；语言先定形，实现跟引擎 |
| **C · experimental 语言预留** | 语法进 `taskflow-dsl/experimental`，引擎未就绪前 build **失败明确**（不静默 no-op） |
| **D · 不做** | 脑暴已否或仍冲突护城河 |

S4 **MVP ship** 仍是 10 种现有 kind 的基本形态；本文件是 **语言 horizon**，与 MVP 出货门正交——**实现可分期，设计先收齐**。

---

## 0. 设计原则

1. **新 phase = 新 rune**（DSL v2 §7）；不塞进万能 `agent({ kind: "..." })`。
2. **1 phase → 1 FlowIR node**（S0 约束）；多节点 lowering 仍 post-0.2.0。
3. **事件溯源优先**：需要「注入图 / 补偿 / 分叉 / 反事实」的，用 event log 语义描述，不发明第二套状态机。
4. **JSON 与 DSL 对称**：每个新 type 必须有 JSON 形态；DSL 只是前端。
5. **未实现 = fail-closed**：experimental rune 若引擎没有 → `TFDSL_PHASE_UNSUPPORTED`，禁止静默删掉。

---

## 1. 现有 10 kind（S4 MVP 必覆盖基本形态）

| type | DSL rune | 备注 |
|------|----------|------|
| agent | `agent` | |
| parallel | `parallel` | |
| map | `map` | 逐项增量 = B 轨增强，不是新 type |
| gate | `gate` / `gate.automated` / `gate.scored` | scored 已在引擎；DSL MVP 可后置糖 |
| reduce | `reduce` | |
| approval | `approval` | 超时回退 = B 轨字段增强 |
| flow | `subflow` / `subflow.def` | `def` 引擎已有；DSL MVP 可先 `use` |
| loop | `loop` | 多 phase body = B 轨 |
| tournament | `tournament` | |
| script | `script` | |

---

## 2. 轨 A —— 已有 / 只需 DSL 收齐

| 能力 | JSON | DSL | 说明 |
|------|------|-----|------|
| 动态子流 | `type:"flow", def:"{steps.plan.json}"` | `subflow.def(plan.json)` 或 `expand.nested(plan)` | 见 `design-dynamic-dag-expansion`；**嵌套**非 graft |
| 评分 gate | `gate` + `score` | `gate.scored(up, { scorers, threshold, … })` | 引擎已有；S4.1 糖 |
| 自动 gate | `gate` + `eval` | `gate.automated(up, { pass: [...] })` | 同上 |
| reflexion | `loop` + `reflexion:true` | `loop({ reflexion: true, … })` | 字段级 |
| 幂等注解 | `idempotent` | opts | 字段级 |

**DSL 补形（建议 S4.1，不改 PHASE_TYPES）：**

```ts
// A1 — 动态嵌套子流（引擎已支持 flow.def）
const plan = agent("Emit Taskflow JSON {name, phases}", {
  output: json<{ name: string; phases: unknown[] }>(),
});
const runPlan = subflow.def(plan.json, { /* with? */ });

// 别名（文档可写 expand.nested，编译到同一 JSON）
const runPlan2 = expand.nested(plan.json);

// A2 — 评分 / 自动 gate
gate.scored(gen, {
  target: gen.output,
  scorers: [{ type: "contains", text: "OK", weight: 1 }],
  combine: "weighted",
  threshold: 0.8,
});
gate.automated(build, { pass: ["{steps.build.output} contains 'OK'"] });
```

---

## 3. 轨 B —— S4.x 引擎 + DSL 一起做（脑暴稳健前排）

### B1 · `expand` — 动态图**嫁接**（旗舰 · 新 type）

> 与 A 轨 `flow.def` 区别：A = **嵌套**子 flow（子命名空间）；B1 = **splice 进父 DAG**（父拓扑可见新节点）。  
> 事件溯源治好旧 P0（注入丢失 / 三态就绪 / 并发改数组）——见 brainstorm §0。

**JSON 草图：**

```jsonc
{
  "id": "grow",
  "type": "expand",
  "from": "{steps.plan.json}",   // Taskflow 片段或 phases[]
  "mode": "graft",               // graft | nested（nested ≡ 今日 flow.def）
  "maxNodes": 50,
  "dependsOn": ["plan"]
}
```

**DSL：**

```ts
const plan = agent("…", { output: json<TaskflowFragment>() });

// 默认 graft（父图扩展）—— 需引擎 B1
const grown = expand(plan.json, {
  mode: "graft",
  maxNodes: 50,
  onInvalid: "fail", // fail | skip
});

// 显式嵌套（A 轨，可先编译到 type:flow def）
expand.nested(plan.json);
```

**FlowIR：** 1 node `kind:"expand"`；运行时 graft 产生的子节点记入 event log，fold 重建父图。

**解锁连锁：** `loop` 多 phase body、局部子图 map 增强可视为 expand 特例。

---

### B2 · `loop` 多 phase body（增强，非新 type）

```ts
// 今日 MVP
loop({
  maxIterations: 5,
  until: "{steps.refine.json.done} == true",
  task: (prev) => `Fix:\n${prev.output}`,
});

// B2 — 子图 body（引擎支持 loop 内嵌 phases）
loop({
  maxIterations: 5,
  until: "{steps.test.json.pass} == true",
  body: (prev) => {
    const fix = agent(`Fix based on:\n${prev.output}`);
    const test = agent(`Retest:\n${fix.output}`, {
      output: json<{ pass: boolean }>(),
    });
    return test; // final of body subgraph
  },
});
```

编译：`type:"loop"` + `bodyPhases: Phase[]`（或内部 `def` 子图）；**无新 PHASE_TYPES**。

---

### B3 · `race` — 首个胜出（新 type）

```ts
const first = race([
  agent("Try codemod path…"),
  agent("Try AI rewrite…"),
  agent("Try hybrid…"),
], {
  cancelLosers: true,   // 取消未完成分支
  onCancel: "record",   // event log 记账供 replay 算成本
});
```

**JSON：** `type:"race", branches:[…], cancelLosers?:boolean`  
**vs parallel：** parallel 全等；**vs tournament：** tournament 等全部完成再裁判。

---

### B4 · `compensate` / saga（新 type 或 phase 字段）

**形态 1 — 声明式补偿表（推荐先做）：**

```ts
const migrate = agent("Apply migration…", {
  compensate: script("rollback-migration.sh"), // 失败时沿 log 倒序触发
});
```

**形态 2 — 一等 phase：**

```ts
saga({
  steps: [
    { do: agent("create resource"), undo: script("delete resource") },
    { do: agent("wire DNS"), undo: script("unwire DNS") },
  ],
});
```

事件溯源：补偿 = 沿 event log 逆序执行 `undo`；replay 可审计。

---

### B5 · `route` — 类型化路由（新 type 或 desugar）

```ts
const classified = agent("…", {
  output: json<
    | { kind: "bug"; id: string }
    | { kind: "feat"; id: string }
    | { kind: "chore" }
  >(),
});

route(classified.json, {
  bug: (x) => agent(`Fix bug ${x.id}`),
  feat: (x) => agent(`Implement ${x.id}`),
  chore: () => script("echo skip"),
  // 编译期检查：联合成员穷尽；缺 case → TFDSL_ROUTE_EXHAUST
});
```

可 desugar 为 N 个 `when` + 合成 id；**一等 type** 便于 verify 穷尽性。

---

### B6 · `map` 逐项增量（运行时增强，DSL 几乎不变）

```ts
map(files, (item) => agent(`Audit ${item}`), {
  incremental: true, // 或继承 top-level incremental + per-item cache（已有部分能力）
});
```

语言侧：opts 透传；旗舰是 **runtime/recompute**，不是新 rune。

---

### B7 · `approval` 超时 + 回退（字段增强）

```ts
approval({
  request: "Ship?",
  timeoutMs: 86_400_000,
  onTimeout: "reject", // reject | approve | agent:"risk-reviewer"
});
```

---

### B8 · `watch` — 响应式重跑（新 type · 最大胆稳健轨）

```ts
watch({
  seed: audit,                    // 被观察的 phase 输出 / readSet
  run: (changed) => agent(`Re-audit ${changed}`),
  mode: "on-stale",               // on-stale | continuous（continuous 更晚）
  maxFires: 10,
});
```

MVP 语言可只支持 `on-stale`（接 recompute 语义）；`continuous` 常驻流 → C/D。

---

## 4. 轨 C —— experimental 语言预留（Moonshot A/B）

导入：

```ts
import { fork, counterfactual, quorum, negotiate, escalate, population, selfOptimize, speculate }
  from "taskflow-dsl/experimental";
```

| Rune | 一句话 | 依赖 |
|------|--------|------|
| `fork` / savepoint | 命名存档点，从此分叉新 run | event log fork |
| `counterfactual` | 对已跑 phase 换旋钮 offline replay | S3 `replayRun` 用户级 |
| `quorum` | N 路多数/中位 + 分歧度 | parallel + reduce 模式 |
| `negotiate` | 对立辩论收敛 | multi-agent protocol |
| `escalate` | 督导动态增派/杀掉 | org-supervision / SCT |
| `population` | 进化种群 loop | loop 扩展 |
| `selfOptimize` | 读历史 log 自调参 | 跨 run 索引 |
| `speculate` | 并行未来 + 剪枝 | fork + cancel |

**DSL 示例（仅设计，build 在引擎未就绪时 error）：**

```ts
// 反事实 —— 最短路径接 S3
const cf = counterfactual(review, {
  thresholds: { review: [0.5, 0.7, 0.9] },
  models: { review: ["fast", "strong"] },
});
// → 编译为 meta phase；runtime 调 replayRun，零 token

// 共识
const voted = quorum([
  agent("Answer A"),
  agent("Answer B"),
  agent("Answer C"),
], { mode: "majority", emitConfidence: true });

// 分叉
const sp = fork.save("after-plan");
// 之后 host API / 后续 phase 可 fromSavepoint 开新 run
```

---

## 5. 轨 D —— 仍不做（语言也不预留假 rune）

| 方向 | 理由 |
|------|------|
| 可视化拖拽编辑器 | 护城河是代码/JSON |
| 真 stream edges + backpressure | 用 `watch` 响应式，不背流边 |
| 全自主自改写 flow | 成本失控 |
| Flow algebra merge/project | `flow{use}` + decompile 已够 |
| Artifacts 新 type | `ctx_write`/`ctx_read` 已覆盖 |

---

## 6. 推荐纳入「DSL 设计支持」的优先级（给实现排期）

| 优先级 | 项 | 轨 | 语言工作 | 引擎工作 |
|--------|----|----|----------|----------|
| **P0** | 10 kind 基本 + `subflow.def` / `expand.nested` 糖 | A | S4 | 已有 |
| **P0** | `gate.scored` / `gate.automated` / `reflexion` / `idempotent` 糖 | A | S4.1 | 已有 |
| **P1** | **`expand` graft** | B | rune + IR kind | **新** |
| **P1** | **`loop` multi-body** | B | body 回调 erase | **新** |
| **P1** | **`race`** | B | rune | **新** |
| **P2** | `route` 穷尽路由 | B | rune + check | desugar 或新 type |
| **P2** | `compensate` / saga | B | opts 或 rune | **新** |
| **P2** | approval timeout | B | opts | **小** |
| **P2** | map 逐项增量 | B | opts | recompute |
| **P3** | `watch` on-stale | B | rune | recompute 常驻化 |
| **P3** | `counterfactual` / `quorum` | C | experimental | 粘合 replay / parallel |
| **P4** | fork / speculate / negotiate / … | C | experimental | 研究 spike |

**「顺便支持脑暴 phase」在语言层的默认承诺：**

1. **文档 + 类型 + experimental 入口**写齐 B1–B5 + C 的 `counterfactual`/`quorum`/`fork` 草形。  
2. **S4 MVP 编译器**：A 轨能 erase 的 erase；B/C 未实现 kind → **明确诊断**（可先认 type 字符串进 JSON passthrough 给未来引擎，或拒绝——推荐 **S4 拒绝未知 type，S4.x 放行已实现**）。  
3. **不把 Moonshot 全塞进 MVP 出货门**。

---

## 7. FlowIR / schema 扩展约定

新增 `PHASE_TYPES` 时：

1. `schema.ts` 注册 + `validateTaskflow`  
2. `flowir` `FlowIRNodeKind` 闭集扩展  
3. `exec/step` kind 或 imperative 分支  
4. DSL rune + skills  
5. 本文件状态表打勾  

**建议新增 type 名（稳定字符串）：**

| type | rune |
|------|------|
| `expand` | `expand` / `expand.nested` |
| `race` | `race` |
| `compensate` | `compensate` 或 `saga` |
| `route` | `route` |
| `watch` | `watch` |
| `counterfactual` | `counterfactual`（experimental） |
| `quorum` | `quorum`（experimental） |
| `fork` | `fork`（experimental） |

---

## 8. 与 S4 MVP 的关系（改写一句话）

| 文档 | 范围 |
|------|------|
| `rfc-0.2.0-s4-mvp.md` | **可发布表面**：现有 10 kind 基本 + CLI |
| **本文** | **语言 horizon**：脑暴 phase 的 DSL 形状与分期 |
| 引擎 S4.x / S6 | 按 §6 表落地 type |

S4 出货门 **不变**（demo FlowIR == hand JSON）。  
S4 实现时 **可提前** 接受 JSON 里未知 type 的透传策略由实现定；DSL erase **只生成已支持 type**。

---

## 9. 最小「脑暴进语言」示例（作者可见的未来）

```ts
import { flow, agent, map, race, expand, gate, reduce, json } from "taskflow-dsl";
// 未实现的：
// import { counterfactual, quorum } from "taskflow-dsl/experimental";

export default flow("brain-storm-shaped", (ctx) => {
  ctx.budget({ maxUSD: 5 });

  const discover = agent("List hot paths", {
    output: json<{ path: string }[]>(),
  });

  // race：三路谁先好用谁（B3）
  const approach = race([
    agent("Static analysis plan…"),
    agent("LLM-only plan…"),
    agent("Hybrid plan…"),
  ], { cancelLosers: true });

  // expand.nested：今日即可（A）；expand graft：B1
  const planJson = agent(`Turn into audit Taskflow JSON. Approach:\n${approach.output}`, {
    output: json<{ name: string; phases: unknown[] }>(),
  });
  const dynamic = expand.nested(planJson.json);

  const perFile = map(discover, (item) =>
    agent(`Deep dive ${item.path}`),
  );

  gate(perFile, { agent: "reviewer", onBlock: "retry" }, (i) =>
    `Quality check:\n${i.output}`,
  );

  return reduce([dynamic, perFile], () =>
    agent("Merge dynamic plan results + per-file notes"),
  );
});
```

---

*一句话：脑暴 phase 不是丢进「以后再说」，而是 **DSL 先有形状、分轨落地**——A 轨立刻进语言糖，B 轨 `expand`/`race`/`loop-body`/`route`/`compensate` 做 S4.x 引擎+语言，C 轨 experimental 接 replay/共识/分叉，且绝不静默假实现。*
