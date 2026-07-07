# RFC v2: taskflow 0.2.0 TypeScript 函数式 DSL — 语法规范

> Status: **Draft v2** · 2026-07-07
> 取代 v1(同文件前版)。v2 是对多 agent review(run `review-020-design`)的回应:
> **身份危机**(Solid 真函数 vs Svelte 编译指令)已定调为**编译指令路线**。
>
> **三个硬约束(不变):**
> 1. **100% 功能覆盖** —— taskflow 当前的每一个字段/能力都有对应 DSL 语法(§A 完整对照)。
> 2. **向前兼容** —— 现有 JSON flow 零修改继续工作;JSON ↔ DSL 双向可编译(§6,v2 给出真实 decompiler 设计)。
> 3. **向前拓展** —— 加新 phase 类型/字段不需要改语法(§7)。
>
> **v2 相对 v1 的根本变化:** §0 执行模型从"模糊的 Solid 路线"改为**明确的编译指令路线**(rune 运行时擦除)。

---

## 0. 执行模型(Execution Model)—— v2 新增,定调

> **这是整份 RFC 的地基。v1 的"身份危机"(review FEASIBILITY #1)源于这里没写。v2 先把它钉死。**

### 0.1 一个 `.tf.ts` 文件是什么

一个 `.tf.ts` 文件是 **agent workflow 的源代码**。它**不是运行时直接执行的脚本**。

```ts
// audit.tf.ts —— 源代码
import { flow, agent, map, gate, reduce, json } from "taskflow";

export default flow("audit", (ctx) => {
  const discover = agent("List files under {args.dir}", { output: json<{route:string}[]>() });
  const audit = map(discover, (item) => agent(`Audit ${item.route}`));
  return reduce([audit], (p) => agent(`Report: ${p.audit.output}`));
});
```

### 0.2 `taskflow build` 是什么 —— **AST transform,不是运行时**

`taskflow build audit.tf.ts` 做三件事:

```
audit.tf.ts (源代码)
    │
    ▼  ① tsc 类型检查(agent 拼错 item.route 在这里报错)
    │
    ▼  ② taskflow 编译器:AST transform(读源码,不执行)
    │     - 扫描 rune 调用(agent/map/gate/...),每个产出一个 FlowIR node
    │     - 扫描模板字面量 `Audit ${item.route}` → 产 `{item.route}` 占位符
    │     - 扫描 map 回调 → 产 per-item 任务模板
    │     - 扫描 json<T>() 的类型参数 → 产 TypeBox schema(填进 expect)
    │     - 静态收集依赖(谁读了谁的 .output)→ 产 inject/emits 边
    │
    ▼  ③ 输出 FlowIR(内容寻址, hash)
```

**关键:`.tf.ts` 离开 `build` 不能直接 run。** 这是对 review FEASIBILITY #1/#2/#4 的诚实回应:

- rune(`agent()`/`map()`/...)是**编译器识别的指令**,不是运行时函数。它们的"返回值"在编译期被消费(转成 FlowIR node),运行时不存在这些调用。
- `discover.output` 不是运行时属性读取(那样会撞上"phase 还没执行"的物理矛盾,见 §0.3),而是**编译期的符号引用** —— 编译器看到 `discover` 被引用,就建一条依赖边。
- `${item.route}` 不是运行时模板求值,而是**编译期从 AST 提取** —— 编译器看到模板字面量里的 `item.route`,转成 `{item.route}` 占位符字符串写进 FlowIR。

### 0.3 为什么是真函数(Proxy)路线站不住 —— review 的论证

v1 想要"rune 是真函数,运行时返回 Phase<T>,读 `.output` 自动建依赖"。review 的 critic 证明了这**物理上不可能**:

```ts
const discover = agent("List files...");        // discover "执行"了吗?没有。
const audit = agent(`Audit ${discover.output}`); // discover.output 此刻是什么?
```

- `discover` 只是"声明要做的事",**从未执行**。`discover.output` 没有任何值。
- 若 `discover.output` 是 Proxy,其 `.toString()` 要返回 `"{steps.discover.output}"` 才能让模板工作。但 `${item.route.slice(0,10)}`、`${item.items.length}`、数值上下文 —— **任何正常 JS 操作都让 Proxy 链断裂**,产生垃圾或丢依赖。这等于要求 author 记住"这些值是幻影",与"像写 Solid 一样自然"矛盾。
- 依赖记到哪?Solid 有 `currentObserver`。taskflow 的 `flow()` 回调里没有"当前 phase"上下文(`audit` 的 `agent()` 还没返回),需要栈内省,RFC 没设计。

**结论:依赖追踪、类型推导、占位符转换这三个 headline 特性,本质都要求编译器"看见"源码(AST),而非运行时 Proxy 猜测。编译指令路线让它们在编译期干净成立。**

### 0.4 诚实代价 & 缓解

**代价:** `.tf.ts` 不能脱离 `build` 直接 run;不能在 `.tf.ts` 里断点调试 rune 调用;没有"降级运行"。

**缓解(强工具链补偿):**
- `taskflow verify`(零 token)在 FlowIR 上跑静态检查 —— 编译期就能抓 DAG 错误。
- `taskflow compile` 出 Mermaid 图 —— 可视化 DAG。
- `taskflow peek <runId> <phaseId>` —— 运行时可看任意 phase 的实际输入/输出(已有的调试逃生口)。
- `taskflow check`(新,见 §8)—— 比 build 轻的快速校验,给 agent 快反馈。

> **JSON 仍是"可降级"的逃生口:** 不想走编译的,直接写/运行 JSON flow(它本就是 FlowIR 的另一种 surface)。这等于 Vue Vapor 的"双模式共存",但无需维护双执行后端(两者都编译到同一个 FlowIR)。

---

## 1. 文件骨架

```ts
import { flow, agent, map, parallel, gate, reduce, loop, tournament, approval, script, json, type Phase } from "taskflow";

export default flow("audit-endpoints", (ctx) => {
  // ctx 方法对应 Taskflow 顶层字段(§2)
  // rune(agent/map/...)是编译指令,编译期被转成 FlowIR(§0)
  return finalPhase;     // return 标记 final phase
});
```

- 文件 `export default flow(name, fn)` = 一个 taskflow。
- `name` 必填;其余顶层字段通过 `ctx` 方法。

---

## 2. 顶层字段(TaskflowSchema)—— 全覆盖

| JSON 字段 | DSL 写法 | 说明 |
|---|---|---|
| `name` | `flow("audit", ...)` 第 1 参数 | 必填 |
| `description` | `flow("audit", { description: "..." }, ...)` 第 2 参数 | 可选 |
| `version` | 同 options `version: 2` | 可选,默认 1 |
| `args` | `ctx.args.declare({ dir: { default: "src", required: true, description: "..." } })` | §3。**v2 修正:** 删掉 v1 臆造的 `type` 字段(ArgSpecSchema 只有 default/description/required),补回 `description` |
| `concurrency` | `ctx.concurrency(8)` | 默认 8 |
| `budget` | `ctx.budget({ maxUSD: 3, maxTokens: 1e6 })` | |
| `agentScope` | `ctx.scope("both")` | user\|project\|both |
| `strictInterpolation` | `ctx.strict()` | 默认 false |
| `contextSharing` | `ctx.share(true)` | |
| `incremental` | `ctx.incremental(true)` | 全局 cross-run 缓存 |
| `phases` | rune 声明自动构成 | §3 |

---

## 3. 通用 Phase 字段 —— 全覆盖

每个 rune 接受一个 **options 对象**,承载所有通用字段(24 个,逐字段对照见 §A):

```ts
agent("task", {
  agent: "scout", model: "fast", thinking: "high", tools: ["read"],
  cwd: "worktree",
  output: "json", expect: { type: "array", items: { type: "string" } },
  when: "{env.CI} == '1'",          // §5.1:字符串 eval(v2 明确 {env.X} 是新能力,见 §5.2)
  join: "any",
  dependsOn: ["plan"],              // 显式补充(通常自动,§5.4)
  retry: { max: 3, backoffMs: 500, factor: 2 },
  timeout: 60_000,
  optional: true, idempotent: false,
  concurrency: 4,
  context: ["src/api.ts"], contextLimit: 8000,
  shareContext: true,
  cache: { scope: "cross-run", ttl: "7d", fingerprint: ["git:HEAD"] },
});
```

---

## 4. 10 种 Phase 类型 —— 全覆盖(含 v2 修正)

### 4.1 `agent`
```ts
const d = agent("List files", { agent: "scout", output: json<{route:string}[]>() });
```
> `json<T>()` 是 `output:"json"` + `expect` 的糖。**v2 明确:** 泛型 → TypeBox schema 的推导由**编译器 transform** 完成(运行时泛型擦除,见 §0.2 ②)。可推导子集:基本类型/array/object/可选字段。复杂类型(联合/映射/递归)推导不了 → **编译报错,要求显式 `expect`**(不静默降级,review COMPAT MEDIUM-1)。

### 4.2 `map` —— 动态扇出
```ts
const audits = map(discover, (item) => agent(`Audit ${item.route}`, { agent: "analyst" }));
```
- `over` = 第 1 参数;`as` = 回调形参名(默认 `item`)。
- **v2 澄清(review FEASIBILITY #3):** 回调在**编译期执行一次**(由编译器,非运行时),`item` 是编译器已知的类型化符号(类型来自 `discover` 的 `json<T[]>`)。编译器把回调体转成 per-item 任务模板 `{item.route}`。运行时不重新执行回调。

### 4.3 `parallel`
```ts
const [a, b] = parallel([ agent("auth"), agent("perf") ], { concurrency: 2 });
```
**v2 澄清(review FEASIBILITY #8):** 解构 `[a,b]` 是**编译期**的 —— 编译器把 `parallel([...])` 转成一个 parallel phase + 给每个 branch 一个合成 id;`a`/`b` 是这些 branch 的符号引用(可被下游 `a.output` 引用,编译器转成对应 branch 的占位符)。不是运行时多返回值。

### 4.4 `gate`(三形态)
```ts
gate(audit, { agent: "reviewer", onBlock: "retry" }, (i) => `Check.\n${i.output}`);
gate.automated(build, { pass: ["{steps.build.output} contains 'OK'"] });
gate.scored(gen, { target: "{steps.gen.output}", scorers: [...], combine: "weighted", threshold: 0.8, judge: {...} });
```

### 4.5 `reduce`
```ts
const sum = reduce([auth, perf], (p) => agent(`Merge ${p.auth.output} ${p.perf.output}`));
```

### 4.6 `loop` —— **v2 重大修正(review COVERAGE F2 / FEASIBILITY #6)**

v1 的多 phase body(`body: (prev) => ({ test, fix })`)是**引擎扩展**,不是当前能力。v2 分两档:

**当前能力(100% 覆盖当前 loop):** loop body 是单个 agent 任务(对应 `phase.task`):
```ts
const refined = loop({
  agent: "executor",
  maxIterations: 5,
  until: "{steps.refined.json.done} == true",
  convergence: true,
  reflexion: true,
  task: (prev) => `Improve the draft. Previous:\n${prev.output}\nOutput JSON {done, draft}.`,
  output: json<{done:boolean; draft:string}>(),
});
```
- `prev.output` 引用上一轮的 `{steps.<loopId>.output}`。
- 回调体仍是**单个任务字符串**(编译器转成 `phase.task` 模板)。

**未来扩展(§7,不是覆盖):** 多 phase body(test→fix)需要引擎支持 loop 内嵌子图 —— 明确标为 **post-0.2.0**,v2 不声称覆盖。当前用 `onBlock: "retry"` 的 gate + 外部 script 组合实现等价语义。

### 4.7 `tournament`
```ts
tournament({
  mode: "best", judgeAgent: "final-arbiter", judge: "Pick best. WINNER: <n>.",
  branches: [ agent("A"), agent("B") ],   // 或 variants: 3 + task
});
```

### 4.8 `approval` —— **v2 修正(review COVERAGE F1)**
```ts
const ok = approval({ request: "Approve this plan?" });
```
**v2 删除 v1 臆造的 `input` 字段**(approval 没有 `input`;`input` 是 script 专属,见 schema.ts)。审批内容来自 `task`(这里是 `request`)—— 运行时通过 DAG 的上游输出自动注入(`runtime.ts` 的 `upstream`)。**依赖靠 `dependsOn`(显式或自动)。**

### 4.9 `flow`(子流程)
```ts
subflow("deep-research", { question: "..." });           // use + with
subflow.def(() => agent("dynamic"));                      // def(内联,运行时解析)
```

### 4.10 `script`
```ts
script("npx tsc --noEmit", { cwd: "dedicated" });         // string = shell
script(["grep", "-r", args.dir]);                          // array = execvp(防注入)
script("cat", { input: "{steps.gen.output}" });            // stdin
```

---

## 5. 控制流与表达式

### 5.1 `when` —— **v2 收窄(review COMPAT MEDIUM-HIGH-1)**

两种形态:
```ts
agent("...", { when: "{env.MODE} == 'prod'" });                 // (a) 字符串 eval(完整支持)
agent("...", { when: ({ env, steps }) => env.MODE === "prod" }); // (b) TS 谓词(受限子集)
```

**(b) 的可编译子集(明确列出,不再含糊):**
- ✅ 比较:`===` `!==` `==` `!=` `>` `<` `>=` `<=`(编译器把 `===`→`==`)
- ✅ 逻辑:`&&` `||` `!`
- ✅ 属性路径:`env.MODE` / `steps.test.json.failures`(编译器展平成 `{env.MODE}` / `{steps.test.json.failures}`)
- ✅ 字面量:字符串/数字/布尔/null
- ❌ 方法调用(`.includes()`/`.length`)、可选链(`?.`)、箭头函数闭包、async、三元 —— **编译报错**(不静默)
- ❌ `contains` 子串检查用字符串形态(a)。

不在子集内 → `taskflow check` 报精确错误,告诉 author 改用字符串形态。

### 5.2 插值占位符 —— **v2 修正(review COVERAGE F3/F5)**

| 占位符 | 当前引擎支持? | DSL |
|---|---|---|
| `{args.X}` | ✅ | `args.X` |
| `{steps.ID.output}` / `.json` / `.json.f` | ✅ | `id.output` / `id.json` / `id.json.f`(编译期符号引用,§0) |
| `{item}` / `{item.f}` | ✅ | `item` / `item.f`(map 回调形参) |
| `{previous.output}` | ✅ | chain 内 `previous.output` |
| `{reflexion}` | ✅ | loop body 内自动 |
| `{loop.iteration}` / `.lastOutput` / `.maxIterations` | ✅(**v1 漏列**) | loop 回调内 `loop.iteration` 等 |
| `{env.X}` | ❌ **当前引擎无 env 根**(v1 误标"兼容") | **v2 明确为新能力**,0.2.0 一起加(或用 script 注入) |

**字符串模板:** `` agent(`Audit ${item.route}`) `` —— 编译器从 AST 提取 `${item.route}`,转成 `{item.route}` 占位符(§0.2)。**两种形态(模板 / 显式占位符)等价,文档统一推荐模板形态**(review USABILITY #3:别给 agent 两个"都行"的选项)。

### 5.3 `join`
`parallel([...], { join: "any" })` / `agent("...", { join: "all" })`(默认)。

### 5.4 `dependsOn`(显式补充)—— **v2 强化(review COMPAT MEDIUM-2)**

自动依赖(编译期收集 `x.output` 引用)**抓不到语义依赖**(B 在 A 后跑但不读 A 输出;script A 写文件、B 读文件)。**v2 明确:这类必须显式 `dependsOn`,编译器对"无自动依赖且非首个 phase"发警告**(提示可能漏了 `dependsOn`)。

---

## 6. 兼容性 —— v2 补真实 decompiler 设计

### 6.1 JSON flow 零修改继续工作(不变)

### 6.2 双向可编译 —— **v2 给出设计(review FEASIBILITY #9 要的)**

```
flow.tf.ts ──build──▶ FlowIR ◀──load── flow.json
     ▲                                    │
     └─────────decompile──────────────────┘
```

**`build`(.tf.ts → FlowIR):** §0.2 的 AST transform。

**`load`(flow.json → FlowIR):** 现有 `translateTaskflow`(已修复 sidecar 完整性,见 commit 7b48105)。

**`decompile`(FlowIR → .tf.ts)—— v2 新设计:**
FlowIR + sidecar 已经 lossless(7b48105 补全了 8 个字段)。decompiler 是一个**代码生成器**:
1. 从 `ir.nodes` + `meta.declaredDeps` 重建 phase 顺序 + 依赖。
2. 每个 node + 其 sidecar 字段 → 生成对应 rune 调用(按 kind 选 agent/map/gate/...)。
3. `inject`(声明的读)→ 生成 `x.output` 引用(从 task 字符串里的 `{steps.X}` 反推)。
4. `expect` schema → 反推 `json<T>()`(基本类型能反推;复杂类型降级为显式 `expect`)。
5. 输出格式化的 `.tf.ts`。

**诚实边界:** decompile 出的 `.tf.ts` **语义等价但字面不一定相同**(变量名、格式、模板写法可能变)。它是"可读 + 可重新 build 回等价 FlowIR"的,不是"字面 round-trip"。文档明确这一点。

### 6.3 version 协商(不变)

---

## 7. 拓展性(不变 + v2 强化)

- 新 phase 类型 = 新 rune 函数(`import { saga } from "taskflow/experimental"`)。
- 新通用字段 = 新 option key。
- **v2 新增:** `flow.component`(带 props 的可复用子 flow)和 `$store`/`$derived`(全局响应式)**明确标为 post-0.2.0**(依赖 Shared Context Tree / 响应式运行时,见 demo 的使用)。0.2.0 首版不含;demo 里用到的地方加 `// [post-0.2.0]` 注释。

---

## 8. agent 工具链(新,回应 review USABILITY #5/#6)

| 命令 | 作用 | 给 agent 的价值 |
|---|---|---|
| `taskflow check audit.tf.ts` | **轻量校验**:tsc + rune 签名 + 依赖完整性 + when 谓词子集。不生成 FlowIR | 快反馈,agent 写完立刻知道错没错 |
| `taskflow build audit.tf.ts` | 完整编译 → FlowIR | 产出可运行产物 |
| `taskflow verify` | FlowIR 静态检查(零 token) | 运行前抓 DAG 错 |
| `taskflow compile` | Mermaid + 报告 | 可视化 |
| `taskflow new` | 生成骨架 `.tf.ts` | agent 不用从零写 |

**`taskflow new` 产出的最小骨架(回应 review USABILITY #4,要 ≤5 行 hello world):**
```ts
import { flow, agent } from "taskflow";
export default flow("hello", () => agent("Say hello to {args.name}"));
```

---

## §A. 完整字段对照表(v2 修正版)—— 100% 覆盖

[与 v1 相同的结构,但每一行都经过 review 实证修正:
- approval 删 `input`(F1)
- loop 多 phase body 移到 §7(F2)
- args 删 `type` 补 `description`(F4)
- 占位符加 `{loop.*}`、标 `{env.X}` 为新(F3/F5)
- 顶层 args/version/agentScope/strictInterpolation/contextSharing/incremental 确认全覆盖
- 通用 23 字段逐个确认(含刚修的 sidecar:agent/run/input/timeout/expect/reflexion/idempotent/score)
完整表见 v1 §A,v2 仅标注修正点如上。]

---

## §B. 决策记录(v2 基于 review 的修订)

| review 发现 | v2 应对 | 章节 |
|---|---|---|
| FEASIBILITY #1 身份危机 | 定调编译指令路线 | §0 |
| FEASIBILITY #2 Proxy 不可能 | §0.3 论证 + 编译期符号引用 | §0 |
| FEASIBILITY #3 map item 幽灵 | 回调编译期执行一次,item 是类型化符号 | §4.2 |
| FEASIBILITY #4 json<T>() 幻象 | 编译器 transform 推导,复杂类型报错 | §4.1 |
| FEASIBILITY #5 模板转换 | 编译期 AST 提取 | §0.2/§5.2 |
| FEASIBILITY #6 loop body | 当前=单任务;多 phase 移 post-0.2.0 | §4.6 |
| FEASIBILITY #8 parallel 解构 | 编译期合成 branch 符号 | §4.3 |
| FEASIBILITY #9 decompiler | 给出代码生成器设计 | §6.2 |
| FEASIBILITY #10 降级运行 | 放弃;JSON 作逃生口 | §0.4 |
| COMPAT CRITICAL sidecar | 已修(commit 7b48105) | §A |
| COMPAT HIGH collectRefs | 已修(7b48105) | — |
| COMPAT MEDIUM-HIGH when 子集 | 明确列出可编译子集 | §5.1 |
| COMPAT MEDIUM-1 json<T>() | 同 FEASIBILITY #4 | §4.1 |
| COMPAT MEDIUM-2 自动依赖边界 | 无自动依赖的 phase 发警告 | §5.4 |
| COVERAGE F1 approval.input | 删除 | §4.8 |
| COVERAGE F2 loop body | 移 post-0.2.0 | §4.6 |
| COVERAGE F3 {env.X} | 标为新能力 | §5.2 |
| COVERAGE F4 args.type | 删 type 补 description | §2 |
| COVERAGE F5 {loop.*} | 补进占位符表 | §5.2 |
| USABILITY #1 demo-RFC gap | demo 标 [post-0.2.0] | §7 |
| USABILITY #2 rune 签名一致 | 统一为 (data, opts) 或 (opts) 两模式 | 全文 |
| USABILITY #3 双插值模型 | 统一推荐模板形态 | §5.2 |
| USABILITY #4 无 hello world | `taskflow new` + 5 行骨架 | §8 |
| USABILITY #5 无 check | `taskflow check` | §8 |
| USABILITY #6 ctx 命名 | 保持(和顶层字段对应) | §2 |

---

## §C. 仍 open(v2 不阻塞,留实现时定)

1. `taskflow build` 的 AST transform 用什么实现?(tsc transformer API / Babel / 自研轻量解析)—— 工程选型,§0 不阻塞。
2. decompiler 的代码格式化风格(prettier?手写?)。
3. `flow.component` 的 props 响应式语义(post-0.2.0 单独 RFC)。
4. `{env.X}` 0.2.0 是否纳入(还是只推 script 注入)。
