# RFC: taskflow 0.2.0 — TypeScript 函数式 DSL 设计

> Status: design proposal, 2026-07-07. 方向已定(TS 函数式,见
> `docs/0.2.0-research-frontend-paradigms.md` §4)。本文回答:**各种语法怎么表示**。
> 路线:复用 TS(合法 TS + 编译器,像 Solid),不自创语法;显式 rune 函数(像 Svelte 5);
> 自动依赖追踪(像 TC39 signals);编译到 FlowIR 保留静态分析护城河。

---

## 0. 设计原则

1. **合法的 TypeScript** —— 不写解析器。`taskflow build` 把 `.tf.ts` 编译成 FlowIR(就像 Solid 把 JSX 编译成 DOM 更新)。agent 用已有的 TS 能力写,IDE/LSP/类型检查全免费。
2. **显式 rune 函数** —— `agent()` `map()` `gate()` `loop()` `tournament()` 等是编译器识别的"符号"(像 Svelte 的 `$state`),但它们**就是普通 TS 函数**(像 Solid 的 `createSignal`)—— 不跑也能 typecheck。
3. **依赖靠"读"自动建立** —— 读上游不再是字符串 `"{steps.discover.output}"`,而是函数调用 `discover.output`。编译器静态收集依赖(= declared readSet),运行时 onRead hook 收集观察依赖(= observed readSet)—— overstory M2+M3 自动达成。
4. **类型即契约** —— `expect` 用 TS 泛型推导;output schema 用 TypeBox(已有)。

---

## 1. 一个 flow 的骨架

```ts
import { flow, agent, gate, reduce, map, tournament, loop, script, approval } from "taskflow";

export default flow("audit-endpoints", ({ args, budget }) => {
  budget({ maxUSD: 3.0 });

  const discover = agent("List every HTTP endpoint under src/routes...", {
    agent: "scout",
    tools: ["read", "grep", "ls"],
    output: json<{ route: string; file: string }[]>(),   // ← expect 契约,TS 泛型推导
    retry: { max: 2 },
  });

  const audit = map(discover, (item) =>
    agent(`Audit ${item.route} in ${item.file} for missing auth...`, {
      agent: "analyst", concurrency: 4,
    })
  );

  const screen = gate(audit, (findings) =>
    agent(`Cross-check the findings. Delete false positives...`, { agent: "reviewer" })
  );

  return reduce([screen], (input) =>
    agent(`Write a prioritized remediation report from:\n${input.screen.output}`, {
      agent: "doc-writer", final: true,
    })
  );
});
```

**对比 JSON 版**(patterns.md archetype 1):同样的逻辑,JSON 是 25 行嵌套 + 字符串模板 `"{steps.discover.json}"` + 手写 `dependsOn`;TS 版是**线性、有类型、依赖靠传参自动建立**。

---

## 2. 10 种 phase 的语法(完整清单)

### 2a. `agent` —— 单个 subagent
```ts
const files = agent("List .ts files under src/", {
  agent: "scout",
  output: json<string[]>(),           // expect 契约 (TypeBox 推导)
  model: "fast", thinking: "high",    // 可选覆盖
  cwd: "worktree",                    // 工作区隔离
  retry: { max: 3, backoffMs: 500, factor: 2 },
  timeout: 60_000,
  cache: { scope: "cross-run", ttl: "7d" },
  optional: true,                     // 失败不阻断
});
```

### 2b. `map` —— 动态扇出(一个 item 一个 agent)
```ts
const audits = map(files, (f) =>
  agent(`audit ${f}`, { agent: "analyst", label: f, concurrency: 4 })
);
// audits: Result[] —— 类型自动是 agent 输出的数组
```

### 2c. `parallel` —— 静态并发分支
```ts
const [auth, validation, perf] = parallel([
  agent("audit auth", { agent: "analyst" }),
  agent("audit input validation", { agent: "analyst" }),
  agent("audit perf", { agent: "analyst" }),
]);
```

### 2d. `gate` —— 质量门(VERDICT: PASS/BLOCK)
```ts
const verified = gate(audits, { agent: "reviewer", onBlock: "retry" }, (findings) =>
  `Cross-check findings. VERDICT: BLOCK if any HIGH remains, else PASS.\n${findings}`
);

// eval gate —— 零 token 机器门(不调 LLM)
const typecheck = gate.automated(
  () => script("npx tsc --noEmit"),
  { pass: "{exit === 0}" }              // eval 条件
);
```

### 2e. `reduce` —— 聚合 N → 1
```ts
const summary = reduce([auth, validation, perf], (parts) =>
  agent(`Merge into one ranked summary:\n${parts.auth.output}`, { agent: "doc-writer" })
);
```

### 2f. `tournament` —— best-of-N + judge
```ts
const best = tournament({
  mode: "best",
  judgeAgent: "final-arbiter",
  judge: "Judge on: correctness, blast radius, migration cost. End with WINNER: <n>.",
  branches: [
    agent("conservative fix: minimal diff", { agent: "analyst" }),
    agent("optimal correctness: schema change ok", { agent: "analyst" }),
    agent("adversary: what breaks? propose survivor", { agent: "critic" }),
  ],
});
```

### 2g. `loop` —— 循环到条件/收敛/上限
```ts
const fixed = loop({
  until: "{steps.check.exit === 0}",
  maxIterations: 5,
  convergence: "{steps.check.output hash unchanged}",
  body: (prev) => ({
    check: script("npx tsc --noEmit"),
    fix:   agent(`Fix the type errors:\n${prev.check.output}`, { agent: "executor" }),
  }),
});
```

### 2h. `approval` —— 人机交互
```ts
const approved = approval({
  request: "Review this plan before execution",
  input: plan.output,
  choices: ["approve", "reject", "edit"],
});
```

### 2i. `flow` —— 调用已保存的子 taskflow
```ts
const result = flow("deep-research", { question: "Node.js permission model v20→v22" });
```

### 2j. `script` —— 零 token shell 步骤
```ts
const lint = script("npx eslint src/ --format json", { cwd: "dedicated" });
// lint.exit, lint.stdout, lint.stderr
```

---

## 3. 依赖怎么自动建立(替代 `{steps.X.output}`)

**核心机制:phase 是一个带 `.output` 的值对象。读它 = 建立依赖。**

```ts
const discover = agent("find files", { ... });
const audit    = map(discover, ...);        // ← audit 依赖 discover,因为 discover 被传入
const report   = reduce([audit], (i) =>
  agent(`report from ${i.audit.output}`)     // ← report 依赖 audit,因为读了 .output
);
```

两层追踪(= overstory M2+M3,自动达成):
- **静态(编译时)**:编译器扫 AST,`discover`/`audit` 被引用 → declared readSet(FlowIR inject/emits)。
- **动态(运行时)**:`.output` 的 getter 触发 onRead hook → observed readSet@version。

> 不再有 `dependsOn: ["discover"]` 这种手写字符串。**传参即依赖**,和写普通函数一样。

---

## 4. 控制流(when / join / retry / budget / onBlock)

```ts
flow("x", ({ when, budget }) => {
  budget({ maxUSD: 5, maxTokens: 200_000 });

  const nightly = agent("...", { when: "{env.NIGHTLY === '1'}" });

  const anyReviewer = parallel([
    agent("review a", { join: "any" }),   // OR-join: 任一完成即可
    agent("review b", { join: "any" }),
  ]);

  const robust = agent("...", {
    retry: { max: 3, backoffMs: 1000, factor: 2 },
    onBlock: "retry",                     // gate BLOCK 时重试上游而非 halt
  });
});
```

`when` 两种形态:
- **字符串条件**(兼容现有 eval):`when: "{env.X} contains 'prod'"`
- **TS 函数(新)**:`when: ({ env, steps }) => env.MODE === "prod"` —— 编译器把函数体编译成 eval 条件,保留零 token 静态分析。

---

## 5. args / 传参 / 复用

```ts
export default flow("audit", ({ args }) => {
  args.declare({ dir: { default: "src/routes", type: "string" } });
  const d = agent(`audit ${args.dir}...`);   // args 是响应式的信号
  return d;
});

// 调用:taskflow run audit.ts --args '{"dir":"src/api"}'
// 或保存后:/tf:audit src/api
```

**跨文件复用**(Svelte 5 runes 的关键突破 —— 响应式超越组件边界):
```ts
// lib/flows.ts —— 可复用的 flow 片段,不是完整 flow
export const auditPattern = (target: Signal<string>) =>
  map(agent(`list files in ${target}`), (f) => agent(`audit ${f}`));

// my-flow.ts —— 组合复用
import { auditPattern } from "./lib/flows.ts";
export default flow("x", () => auditPattern(read("src/routes")));
```

---

## 6. 类型推导(这是 TS DSL 杀手锏)

```ts
const discover = agent("...", { output: json<{ route: string; file: string }[]>() });
//    ^? Phase<{ route: string; file: string }[]>

const audit = map(discover, (item) => agent(`audit ${item.route}`));
//    ^? Phase<Finding[]>
//                                    item.route 字符串 —— 编译期就知道,拼错就报错
```

**JSON DSL 现在的痛点**:`{item.rout}` 拼错要到运行时才发现;`"{steps.discover.json}"` 是纯字符串,没有类型。
**TS DSL**:`item.route` 拼错 = 编译失败;整个 flow 在 `taskflow build`(→ FlowIR)前先过 `tsc`。

---

## 7. 编译路径(保留护城河)

```
.tf.ts (合法 TS,agent 写)
   │  tsc 类型检查 (agent 拼错立刻报错)
   ▼
taskflow build  ← 扫 rune 函数调用,收集依赖,生成
   ▼
FlowIR  (内容寻址, hash)  ← /tf verify 在这里跑,零 token
   ▼
runtime execute  (observed readSet 自动追踪 → cache + recompute)
```

- **`/tf verify` / `/tf ir`** 仍然工作(在 FlowIR 层),护城河不丢。
- **JSON 仍然支持**:`taskflow build flow.json` → 同一个 FlowIR。**双向可编译**(DSL ↔ JSON),老用户零迁移成本。

---

## 8. shorthand(简单任务不用写完整 flow)

```ts
// 内联在 host agent 的调用里,等价于现在的 task/tasks/chain
taskflow.run({ task: "summarize src/", agent: "explorer" });
taskflow.parallel([{ task: "audit auth" }, { task: "audit perf" }]);
taskflow.chain([{ task: "step1" }, { task: "step2 from {prev}" }]);
```

---

## 9. 完整对照:Archetype 5 (tournament) JSON → TS

**JSON(现状):**
```jsonc
{ "id": "strategy", "type": "tournament", "mode": "best",
  "judgeAgent": "final-arbiter",
  "judge": "Judge on: correctness, blast radius, migration cost. WINNER: <n>.",
  "branches": [
    { "task": "conservative fix", "agent": "analyst" },
    { "task": "optimal correctness", "agent": "analyst" },
    { "task": "adversary", "agent": "critic" } ],
  "dependsOn": ["context"], "final": true }
```

**TS(0.2.0):**
```ts
const context = agent("gather context", { agent: "scout" });

const strategy = tournament({
  mode: "best",
  judgeAgent: "final-arbiter",
  judge: "Judge on: correctness, blast radius, migration cost. WINNER: <n>.",
  branches: [
    agent("conservative fix", { agent: "analyst" }),
    agent("optimal correctness", { agent: "analyst" }),
    agent("adversary: what breaks?", { agent: "critic" }),
  ],
});  // dependsOn 自动 = [context],final 用 return 标记
```

**收益**:少 3 个字段(`dependsOn` 自动、`final` 用 return、`id` 可省);branches 是真数组(可 `.map()`/条件构造);类型检查。

---

## 10. Open questions(下一步要定的)

1. **rune 函数是"真函数"还是"纯编译器符号"?**
   - Solid 路线:真函数,运行时也有意义(返回 signal/phase 对象)—— 更灵活、可在 REPL 调试。
   - Svelte 路线:纯编译器符号(运行时被擦除)—— 更轻、bundle 更小。
   - 建议:**Solid 路线**(agent 调试 + 渐进迁移更重要)。

2. **响应式粒度** —— `discover.output` 读一次建一条边,还是整个 phase 是一个 signal?
   - 建议沿用 overstory 的 **phase 级 signal**(LLM 调用是昂贵原语,不需要 DOM 那种节点级粒度)。

3. **JSON 共存策略** —— 双向编译 vs JSON 仅作为编译产物?
   - 建议双向(JSON 仍是一等公民,DSL ↔ JSON 互转),保证 saved flow / 老用户零成本。

4. **`when`/`eval` 的 TS 函数编译** —— 把 TS 谓词编译成 eval 条件串,需要限定子集(禁止副作用/闭包捕获)。
   - 这是技术上最 tricky 的一点,需单独 RFC。

---

## 11. 北极星

> **taskflow 0.2.0: Write agent workflows like Solid components.**
> **TypeScript-native, compiler-tracked dependencies, only what changed re-runs.**
> **The first framework to bring 2026's frontend reactivity consensus to agents.**
