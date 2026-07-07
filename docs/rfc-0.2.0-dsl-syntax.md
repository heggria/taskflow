# RFC: taskflow 0.2.0 TypeScript 函数式 DSL —— 语法规范

> Status: **Draft** · 2026-07-07
> 路线决策:Solid 路线(rune 是真函数,可调试;见 `docs/rfc-0.2.0-three-compile-routes.md`)
> **三个硬约束:**
> 1. **100% 功能覆盖** —— taskflow 当前的每一个字段/能力都有对应 DSL 语法(本文 §A 完整对照表)。
> 2. **向前兼容** —— 现有 JSON flow 零修改继续工作;JSON ↔ DSL 双向可编译(§6)。
> 3. **向前拓展** —— 加新 phase 类型/字段不需要改语法(§7)。

---

## 0. 设计契约

- **`.tf.ts` 是合法 TypeScript。** `tsc` 能过 = 类型正确。`taskflow build` 把它编译成 FlowIR(就像 Solid 把 JSX 编译成 DOM 更新)。
- **rune 是真函数**,运行时返回一个 `Phase<T>` 对象(可 `.output` 读取,自动建立依赖)。离开编译器也能降级运行(解释执行)。
- **依赖靠"读取"自动建立** —— 读 `x.output` = 依赖 `x`。零手写 `dependsOn`(但保留 `dependsOn` 字段作为显式补充,§5.4)。
- **JSON 仍是一等公民** —— `build flow.json` 和 `build flow.tf.ts` 都产出同一个 FlowIR。

---

## 1. 文件骨架

```ts
import { flow, agent, map, parallel, gate, reduce, loop, tournament, approval, flow as subflow, script, json, type Phase } from "taskflow";

export default flow("audit-endpoints", (ctx) => {
  // ctx: { args, budget, scope, strict, share, incremental, concurrency }
  // —— ctx 上的方法对应 Taskflow 顶层字段(见 §2)
  // ... phases 用 rune 声明 ...
  return finalPhase;     // return 标记 final phase(等价 final:true)
});
```

- 文件 `export default flow(name, fn)` = 一个 taskflow(等价 JSON 的顶层对象)。
- `name` 必填;其余顶层字段通过 `ctx` 的方法设置。

---

## 2. 顶层字段(TaskflowSchema)—— 全覆盖

| JSON 字段 | DSL 写法 | 说明 |
|---|---|---|
| `name` | `flow("audit", ...)` 第 1 参数 | 必填 |
| `description` | `flow("audit", { description: "..." }, ...)` 第 2 参数对象 | 可选 |
| `version` | 同上 options 对象 `version: 2` | 可选,默认 1 |
| `args` | `ctx.args.declare({ dir: { default: "src", type: "string", required: true } })` | §3 |
| `concurrency` | `ctx.concurrency(8)` | 默认 8 |
| `budget` | `ctx.budget({ maxUSD: 3, maxTokens: 1e6 })` | §4.1 |
| `agentScope` | `ctx.scope("both")` | "user"\|"project"\|"both" |
| `strictInterpolation` | `ctx.strict()` | 布尔,默认 false |
| `contextSharing` | `ctx.share(true)` | 全局 shareContext |
| `incremental` | `ctx.incremental(true)` | 全局 cross-run 缓存 |
| `phases` | rune 声明自动构成 | §3 |

**示例:**
```ts
export default flow("audit", { description: "Audit all endpoints", version: 2 }, (ctx) => {
  ctx.concurrency(8);
  ctx.budget({ maxUSD: 3.0 });
  ctx.scope("both");
  ctx.incremental(true);          // 全 flow 跨运行缓存
  ctx.args.declare({ dir: { default: "src/routes", type: "string" } });
  // ...
});
```

---

## 3. 通用 Phase 字段(所有 phase 类型共有)—— 全覆盖

每个 rune(`agent`/`map`/...)都接受一个 **options 对象**,承载所有通用字段:

```ts
agent("task string", {
  // —— 身份与执行 ——
  agent: "scout",                          // 用哪个 agent
  id: "discover",                          // 可选显式 id(默认自动生成)
  model: "fast", thinking: "high",         // 模型/思考级别覆盖
  tools: ["read", "grep"],                 // 工具白名单
  cwd: "worktree",                         // 工作目录:路径或 temp/dedicated/worktree

  // —— 输出 ——
  output: "json",                          // "text"(默认) | "json"
  expect: { type: "array", items: { type: "string" } },   // JSON 契约(需 output:json)
  final: true,                             // 标记为 flow 结果(或用 return)

  // —— 控制流 ——
  when: "{env.CI == '1'}",                 // 条件守卫(字符串 eval 或 TS 谓词,§5.1)
  join: "any",                             // "all"(默认) | "any"
  dependsOn: ["plan"],                     // 显式补充依赖(通常自动,§5.4)
  retry: { max: 3, backoffMs: 500, factor: 2 },
  timeout: 60_000,                         // 每 subagent 调用的 ms 上限

  // —— 可靠性 ——
  optional: true,                          // 失败不阻断
  idempotent: false,                       // 有副作用,不自动重试/不缓存
  concurrency: 4,                          // map/parallel 并发覆盖

  // —— 上下文 ——
  context: ["src/api.ts", "{steps.plan.json}"],   // 预读注入
  contextLimit: 8000,                      // 每文件最大字符
  shareContext: true,                      // 开 Shared Context Tree

  // —— 缓存 ——
  cache: { scope: "cross-run", ttl: "7d", fingerprint: ["git:HEAD", "glob:src/**"] },
});
```

> **对照表(§A)列出每一个字段的 JSON↔DSL 映射。** 这里先给直觉,细节在 §A。

---

## 4. 10 种 Phase 类型的专属语法—— 全覆盖

### 4.1 `agent` —— 单个 subagent
```ts
const d = agent("List files under {args.dir}", {
  agent: "scout", output: json<{route:string;file:string}[]>(), expect: {...}, retry: {max:2},
});
```
> `json<T>()` 是 `output:"json"` + `expect` 的类型推导糖(TS 泛型 → TypeBox schema)。

### 4.2 `map` —— 动态扇出
```ts
const audits = map(discover, (item) =>            // over = discover;as 默认 item
  agent(`Audit ${item.route} in ${item.file}`, { agent: "analyst", concurrency: 4 })
);
// 等价 JSON: { type:"map", over:"{steps.discover.json}", as:"item", task:"Audit {item.route}..." }
```
- `over` = 第 1 参数(一个 Phase);`as` = 回调形参名(默认 `item`)。
- 回调体内用 `item.route` —— **编译期类型检查**(对比 JSON 的 `{item.rout}` 拼错运行时才发现)。

### 4.3 `parallel` —— 静态并发分支
```ts
const [a, b, c] = parallel([
  agent("audit auth", { agent: "analyst" }),
  agent("audit perf", { agent: "analyst" }),
  agent("audit validation", { agent: "analyst" }),
], { concurrency: 3 });
// 等价 JSON: { type:"parallel", branches:[{task,agent},...] }
```
- `branches` = 数组参数;每项是 `agent()` 调用或 `{ task, agent }` 对象(二选一,兼容)。

### 4.4 `gate` —— 质量门(三种形态全覆盖)
```ts
// (a) LLM gate —— task 是判断 prompt
const g = gate(findings, { agent: "reviewer", onBlock: "retry" },
  (input) => `Cross-check. VERDICT: PASS/BLOCK.\n${input.output}`);

// (b) eval gate —— 零 token 机器门
const auto = gate.automated(build, {
  pass: ["{steps.build.output} contains 'BUILD SUCCESS'", "{steps.test.json.failures} == 0"],
});

// (c) score gate —— 确定性打分 + LLM judge fallback
const scored = gate.scored(gen, {
  target: "{steps.gen.output}",
  scorers: [{ type: "exact-match", value: "PASS" }, { type: "length-range", min: 10 }],
  combine: "weighted", weights: [1, 1], threshold: 0.8,
  judge: { agent: "reviewer", task: "decide if borderline passes" },
});
```
> 三个 rune(`gate`/`gate.automated`/`gate.scored`)分别对应 JSON 的 `gate`+task / `eval` / `score`。`onBlock` 通用。

### 4.5 `reduce` —— 聚合 N→1
```ts
const summary = reduce([auth, perf, validation], (parts) =>
  agent(`Merge:\nauth:${parts.auth.output}\nperf:${parts.perf.output}`, { agent: "doc-writer" })
);
// 等价 JSON: { type:"reduce", from:["auth","perf","validation"], task:"..." }
```
- `from` = 第 1 参数(Phase 数组);回调参数是命名 map(按数组顺序或显式 key)。

### 4.6 `loop` —— 循环到条件/收敛/上限
```ts
const fixed = loop({
  until: "{steps.test.exit === 0}",
  maxIterations: 5,
  convergence: true,                  // 默认 true:输出不变则停
  reflexion: true,                    // 给下一轮注入 {reflexion} 反思
  body: (prev) => ({
    test: script("npx tsc --noEmit"),
    fix:  agent(`Fix:\n${prev.test.output}`, { when: "{steps.test.exit !== 0}" }),
  }),
});
// 等价 JSON: { type:"loop", until, maxIterations, convergence, reflexion, ... }
```

### 4.7 `tournament` —— best-of-N + judge
```ts
const best = tournament({
  mode: "best",                       // "best" | "aggregate"
  judge: "Judge on correctness. WINNER: <n>.",
  judgeAgent: "final-arbiter",
  branches: [                         // 显式分支(或用 variants:N 从 task 生成)
    agent("conservative fix", { agent: "analyst" }),
    agent("optimal correctness", { agent: "analyst" }),
  ],
  // 或者:variants: 3, task: "design a fix"(从单 task 派生 N 个)
});
```

### 4.8 `approval` —— 人机交互
```ts
const ok = approval({
  request: "Approve this plan?",
  input: plan.output,                 // 传给审批者的内容
});
// 等价 JSON: { type:"approval", task:"...", input:"{steps.plan.output}" }
```

### 4.9 `flow` (子流程) —— use / def / with 全覆盖
```ts
// (a) use —— 调用已保存的 taskflow
const r = subflow("deep-research", { question: "..." });      // with = 第2参数

// (b) def —— 内联子流程(动态)
const r2 = subflow.def(() => {                                // 运行时解析
  return agent("dynamic sub-flow based on runtime data");
}, { with: { x: 1 } });
```

### 4.10 `script` —— 零 token shell
```ts
const lint = script("npx eslint src/ --format json", { cwd: "dedicated" });
//    lint.exit / lint.stdout / lint.stderr

const safe = script(["grep", "-r", args.dir, "--files-with-matches"]);  // 数组 = execvp(防注入)
script("cat", { input: "{steps.gen.output}" });                          // stdin 管道
```

---

## 5. 控制流与表达式—— 全覆盖

### 5.1 `when` —— 条件守卫(两种形态)
```ts
agent("...", { when: "{env.MODE} == 'prod'" });               // (a) 字符串 eval(兼容现有)
agent("...", { when: ({ env }) => env.MODE === "prod" });     // (b) TS 谓词(新;编译成 eval)
```
> (b) 编译器把谓词体限定在纯表达式子集内,编译成等价 eval 串,保留**零 token 静态分析**。

### 5.2 插值占位符(全部保留 + 新增类型安全形态)
| 占位符 | JSON | DSL |
|---|---|---|
| `{args.X}` | ✅ | `args.X`(args 是响应式对象) |
| `{steps.ID.output}` | ✅ | `id.output`(读 Phase 对象) |
| `{steps.ID.json}` / `.field` | ✅ | `id.json` / `id.json.field` |
| `{item}` / `{item.field}` | ✅ | `item` / `item.field`(map 回调形参) |
| `{previous.output}` | ✅ | chain 内 `previous.output` |
| `{reflexion}` | ✅ | loop body 内自动可用 |

> **字符串模板仍可用**:`agent(\`Audit ${item.route}\`)` —— 编译器把 `${item.route}` 转成 `{item.route}` 占位符(语义不变,运行时同样插值)。**两种形态等价,保留字符串模板兼容旧习惯。**

### 5.3 `join`(依赖汇聚)
```ts
parallel([...], { join: "any" });        // OR-join
agent("...", { join: "all" });           // 默认 AND-join
```

### 5.4 `dependsOn`(显式补充)
通常不需要(读取即依赖)。但**保留**用于:
- 引用没有赋值的 phase(如 JSON 迁移来的隐式依赖)
- 声明"读取没体现,但逻辑上依赖"的关系(如 gate 的 onBlock:retry 要重跑上游)

```ts
agent("...", { dependsOn: ["plan", "config"] });
```

---

## 6. 兼容性策略(向前兼容的三个保证)

### 6.1 JSON flow 零修改继续工作
- `taskflow run flow.json` / `action=run name=...` / `/tf:name` 全部不变。
- 运行时、缓存、resume、verify —— 全部对 JSON 和 DSL 透明(都走 FlowIR)。

### 6.2 JSON ↔ DSL 双向可编译
```
flow.tf.ts  ──build──▶  FlowIR  ◀──load──  flow.json
     ▲                                          │
     └─────────────decompile────────────────────┘
```
- `taskflow build flow.tf.ts → flow.json`(发布产物,兼容老 host)
- `taskflow decompile flow.json → flow.tf.ts`(老项目渐进迁移)
- **FlowIR 是唯一的中间表示**,两种语法都是它的 surface syntax。

### 6.3 版本协商(`version` 字段)
- 顶层 `version: 2`(DSL 默认)和 `version: 1`(老 JSON)都合法。
- 编译器按 version 选语法解析;运行时不关心来源。

---

## 7. 拓展性(向前拓展的两个机制)

### 7.1 加新 phase 类型 —— 不改语法
新 phase 类型 = 新增一个 rune 函数,不破坏现有:
```ts
// 未来:新增 saga phase(带补偿)
import { saga } from "taskflow/experimental";
const r = saga({ compensate: "...", ... });
```
rune 是普通函数,**新能力 = 新 export**,老 flow 不受影响。

### 7.2 加新通用字段 —— options 对象开放扩展
通用字段都挂在 options 对象上。新增字段 = 加 option key:
```ts
agent("...", { /* 未来 */ priority: "high", tags: ["audit"], telemetry: {...} });
```
TypeScript 的 `PhaseOptions` 接口增量扩展;未识别字段走 `additionalProperties` 策略(默认警告,不报错)。

### 7.3 用户自定义 rune(组件)
```ts
// 用户封装自己的编排原语(= 自定义 rune)
export function auditFiles(files: Phase<string[]>, opts) {
  return map(files, (f) => agent(`audit ${f}`, opts));
}
// 用法和内置 rune 一样
const r = auditFiles(discover, { agent: "analyst" });
```

---

## 8. shorthand(简单任务,§非完整 flow)

```ts
import { taskflow } from "taskflow";

// 完全等价 JSON shorthand:
taskflow.task({ task: "summarize src/", agent: "explorer" });
taskflow.tasks([{ task: "audit auth" }, { task: "audit perf" }]);
taskflow.chain([{ task: "step1" }, { task: "from {previous.output}" }]);
```

---

## §A. 完整字段对照表(JSON ↔ DSL)—— 100% 覆盖证明

### 顶层
| JSON | DSL | ✓ |
|---|---|---|
| name | flow(name) | ✅ |
| description | flow(name, {description}) | ✅ |
| version | flow(name, {version}) | ✅ |
| args | ctx.args.declare() | ✅ |
| concurrency | ctx.concurrency() | ✅ |
| budget{maxUSD,maxTokens} | ctx.budget() | ✅ |
| agentScope | ctx.scope() | ✅ |
| strictInterpolation | ctx.strict() | ✅ |
| contextSharing | ctx.share() | ✅ |
| incremental | ctx.incremental() | ✅ |
| phases | rune 声明 | ✅ |

### Phase 通用
| JSON | DSL option | ✓ |
|---|---|---|
| id | id: | ✅ |
| type | rune 选择 | ✅ |
| agent | agent: | ✅ |
| task | rune 第1参数 / 回调 | ✅ |
| dependsOn | dependsOn: (+自动) | ✅ |
| join | join: | ✅ |
| when | when: | ✅ |
| retry{max,backoffMs,factor} | retry: | ✅ |
| output | output: / json<T>() | ✅ |
| expect | expect: / json<T>() | ✅ |
| model | model: | ✅ |
| thinking | thinking: | ✅ |
| tools | tools: | ✅ |
| cwd | cwd: | ✅ |
| final | final: / return | ✅ |
| optional | optional: | ✅ |
| idempotent | idempotent: | ✅ |
| concurrency | concurrency: | ✅ |
| context | context: | ✅ |
| contextLimit | contextLimit: | ✅ |
| cache{scope,ttl,fingerprint} | cache: | ✅ |
| shareContext | shareContext: | ✅ |
| timeout | timeout: | ✅ |

### Phase 类型专属
| Phase | JSON 字段 | DSL | ✓ |
|---|---|---|---|
| map | over / as | map(over,(item)=>...) | ✅ |
| parallel | branches[] | parallel([...]) | ✅ |
| reduce | from[] | reduce([...],fn) | ✅ |
| flow | use / def / with | subflow(name,with) / subflow.def(fn) | ✅ |
| script | run / input | script(run,{input}) | ✅ |
| loop | until/maxIterations/convergence/reflexion | loop({until,...}) | ✅ |
| tournament | variants/branches/judge/judgeAgent/mode | tournament({...}) | ✅ |
| gate | onBlock/eval/score | gate()/gate.automated()/gate.scored() | ✅ |

### 插值 & shorthand
| 能力 | DSL | ✓ |
|---|---|---|
| {args.X} | args.X | ✅ |
| {steps.ID.output/json} | id.output / id.json | ✅ |
| {item} / {item.f} | item / item.f | ✅ |
| {previous.output} | previous.output | ✅ |
| {reflexion} | loop body 内自动 | ✅ |
| shorthand task/tasks/chain | taskflow.task/tasks/chain | ✅ |

---

## §B. 完整真实示例(对照 JSON)

```jsonc
// JSON(现状)
{ "name": "audit-endpoints", "budget": {"maxUSD":3}, "phases": [
  { "id":"discover", "agent":"scout", "task":"List endpoints under {args.dir}. JSON array.", "output":"json",
    "expect":{"type":"array","items":{"type":"object","required":["route","file"]}}, "retry":{"max":2} },
  { "id":"audit", "type":"map", "over":"{steps.discover.json}", "agent":"analyst", "concurrency":4,
    "task":"Audit {item.route} ({item.file}) for missing auth." },
  { "id":"screen", "type":"gate", "agent":"reviewer", "onBlock":"retry",
    "task":"Cross-check. Delete false positives. VERDICT: PASS/BLOCK.\n{steps.audit.output}" },
  { "id":"report", "type":"reduce", "from":["screen"], "agent":"doc-writer",
    "task":"Write report:\n{steps.screen.output}", "final":true }
]}
```

```ts
// DSL 0.2.0(等价,100% 覆盖,自动依赖,有类型)
import { flow, agent, map, gate, reduce, json } from "taskflow";

export default flow("audit-endpoints", (ctx) => {
  ctx.budget({ maxUSD: 3 });
  ctx.args.declare({ dir: { default: "src/routes", type: "string" } });

  const discover = agent(`List endpoints under ${ctx.args.dir}. JSON array.`, {
    agent: "scout", output: json<{ route: string; file: string }[]>(), retry: { max: 2 },
  });

  const audit = map(discover, (item) =>
    agent(`Audit ${item.route} (${item.file}) for missing auth.`, { agent: "analyst", concurrency: 4 })
  );

  const screen = gate(audit, { agent: "reviewer", onBlock: "retry" },
    (i) => `Cross-check. Delete false positives. VERDICT: PASS/BLOCK.\n${i.output}`);

  return reduce([screen], (p) =>
    agent(`Write report:\n${p.screen.output}`, { agent: "doc-writer" })   // return = final
  );
});
```

---

## §C. 覆盖率自检清单

- [x] 10 种 phase 类型全覆盖(agent/map/parallel/gate/reduce/loop/tournament/approval/flow/script)
- [x] gate 三形态全覆盖(task / eval / score)
- [x] flow 三形态全覆盖(use / def / with)
- [x] script 两形态全覆盖(string shell / array execvp / input stdin)
- [x] 全部 24 个通用 phase 字段
- [x] 全部 11 个顶层字段
- [x] 全部 6 个插值占位符
- [x] shorthand(task/tasks/chain)
- [x] MCP/Pi actions 不受影响(run/save/resume/list/agents/init/verify/compile/ir/provenance/why-stale/recompute/cache-clear/search —— 都操作 FlowIR,与 surface syntax 无关)
- [x] JSON 向前兼容(零修改)
- [x] 双向编译(tf.ts ↔ json)
- [x] 拓展性(新 phase = 新 rune 函数;新字段 = 新 option key)

---

## §D. 待定决策(open questions,不阻塞本 RFC)

1. **`when` 的 TS 谓词允许子集** —— 哪些 JS 表达式可编译成 eval?(纯比较/逻辑 OK;闭包捕获/异步 待定)
2. **`flow.component`(带 props 的可复用子 flow)的精确签名** —— 见 demo,但 props 的响应式语义需单独 RFC。
3. **`$store`/`$derived`(全局响应式)是否进 0.2.0 首版** —— 它依赖 overstory Shared Context Tree,可能作为 0.2.x 渐进加入。
4. **`json<T>()` 的泛型 → TypeBox schema 推导深度** —— 基本类型/array/object OK;复杂联合/条件类型可能降级为 unknown + 运行时校验。
