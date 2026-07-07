# RFC 补充:三条编译路线对比 — Solid / Svelte / Vue Vapor → taskflow

> Companion to `docs/rfc-0.2.0-typescript-dsl.md`(那是 Solid 路线)。本文回答:
> **① Svelte 路线(编译时指令、运行时擦除)长什么样?② Vue 最新模式(Vapor)长什么样?**
> 三条路线的本质区别 + 各自映射到 taskflow 的形态。

---

## 0. 先厘清:前端三条路线的本质区别

| | Solid 路线 | Svelte 5 路线 | Vue 3.6 Vapor 路线 |
|---|---|---|---|
| rune/symbol 是什么 | **真函数**(运行时返回 signal/对象) | **编译时指令**(运行时擦除) | **模板 → 编译成命令式操作** |
| 运行时还有这些函数吗 | ✅ 有(返回值有意义) | ❌ 擦除(变成执行代码) | ❌ 擦除(变成 DOM/操作指令) |
| 响应式底层 | signal(运行时) | signal(runes 编译后接 signal) | signal(编译后接 signal) |
| 写起来像 | "合法 JS + 钩子" | "带魔法的 JS" | "模板 + 少量脚本" |
| 可否脱离编译器跑 | ✅ 能(降级为普通调用) | ❌ 不能(runes 离开编译器无效) | ❌ 不能(模板离开编译器无效) |
| 混合模式 | 全用 | 全用 | **✅ 逐组件 opt-in(Vapor + 普通 Vue 共存)** |

> 一句话:**Solid = "rune 是真函数";Svelte = "rune 是编译指令(被擦除)";Vue Vapor = "模板编译成命令式 + 可混合"**。
> 三者**底层都是 signals**(2026 共识),区别在**语法层**和**编译策略**。

---

## 1. Svelte 路线:rune = 编译时指令(运行时擦除)

### 核心机制
`agent()` / `map()` / `gate()` **不是真函数** —— 它们是编译器识别的**指令**。
`taskflow build` 把 `.tf.ts` **整个转换**成 FlowIR + 执行计划,运行时**不存在这些调用**。
(就像 Svelte 的 `$state(0)` 编译后变成 `$.state(...)` 内部 API,`$state` 符号本身消失。)

### 长什么样
```ts
import { flow, agent, map, gate, $read, $emit } from "taskflow/compiler";

flow("audit-endpoints", () => {
  $budget({ maxUSD: 3.0 });

  const discover = agent("List every HTTP endpoint under src/routes...", {
    output: $json<{ route: string; file: string }[]>(),
  });
  // ↑ 编译后:discover 不是"调用 agent() 的返回值",
  //          而是 FlowIR 里的一个 node id + 一个编译期生成的依赖边。

  const audit = map(discover, (item) =>
    agent(`Audit ${item.route} in ${item.file}...`)
  );
  // ↑ map() 在编译期展开:扫箭头函数体,生成 per-item 的 phase 模板。
  //   运行时根本没有 map 这个调用。

  gate(audit, { agent: "reviewer", onBlock: "retry" });
});
```

### 编译产物(运行时实际执行的)
```jsonc
// FlowIR — agent/map/gate 这些"调用"全没了,只剩图:
{ "name": "audit-endpoints",
  "nodes": [
    { "id": "discover", "kind": "agent", "inject": [], "emits": ["discover"], "task": "..." },
    { "id": "audit",    "kind": "map",   "inject": ["discover"], "emits": ["audit"] },
    { "id": "gate_0",   "kind": "gate",  "inject": ["audit"], "onBlock": "retry" } ],
  "budget": { "maxUSD": 3.0 } }
```

### Svelte 路线的特征
- **✅ 产物最精简**:运行时零 rune 开销,FlowIR 直接就是可执行图。
- **✅ 静态分析最强**:编译器"看见"一切(每个 rune 都是编译期已知),verify/IR 天然精确。
- **❌ 不能脱离编译器跑**:`.tf.ts` 不 `build` 就没法运行(REPL/调试不友好)。
- **❌ 渐进迁移更难**:要么全转,要么不转(没有"半个 rune")。
- **❌ 对 agent 心智负担略高**:`map(discover, item => ...)` 看着像函数,但 `item` 其实是编译期占位符,不能在 `item` 上做任意运行时运算(只能在编译期子集内)。

---

## 2. Vue Vapor 路线:模板编译成命令式 + 双模式共存

### 核心机制(借鉴 Vue 3.6 Vapor)
Vue Vapor 的两个关键特征:
1. **模板编译成细粒度命令式操作**(跳过中间表示的运行时开销)。
2. **逐组件 opt-in** —— Vapor 组件和普通 Vue 组件**可以共存**于一个项目,渐进迁移。

映射到 taskflow:**JSON flow 和 TS flow 可以混用,逐 phase opt-in**。这是 Vue Vapor 路线**独有**的优势 —— Svelte/Solid 都是"全有或全无",Vapor 是"渐进"。

### 长什么样
```ts
import { flow, agent, map, gate, vapor } from "taskflow";

// 一个 flow 可以"混用":部分 phase 用新 TS DSL,部分沿用 JSON 片段
flow("audit", () => {
  const discover = agent("List endpoints...", { output: json<{route:string}[]>() });

  // 旧 JSON phase 可以内联引用(vapor 路线的"共存"特征)
  const legacy = json`{
    "type": "map", "over": "${discover}", "as": "item",
    "task": "Audit {{item.route}}", "agent": "analyst"
  }`;

  gate(legacy, { agent: "reviewer" });
});
```

或者用 **vapor 标记**逐 flow 切换编译模式(像 Vue 的 `vapor: true`):
```ts
// @vapor  ← 这个 flow 用 Vapor 编译(编译成细粒度执行图,零中间开销)
flow("audit", () => {
  const d = agent("...");
  const a = map(d, (i) => agent(`audit ${i.route}`));
  gate(a);
});
// 不加 @vapor 的 flow 仍走"解释执行"路径(兼容老行为/老 host)
```

### Vue Vapor 路线的特征
- **✅ 渐进迁移最顺** —— JSON 和 TS 混用,逐 flow / 逐 phase opt-in(这正是 Vue 哲学:"渐进式框架")。
- **✅ 双后端**:同一 DSL 编译到"解释执行"(老 host / 调试)或"Vapor 执行"(性能),按需选。
- **✅ 最贴合 taskflow 现状** —— 现在已有 JSON flow + 4 个 host,Vapor 的"共存"理念迁移成本最低。
- **❌ 复杂度最高**:要维护两套执行后端(解释器 + Vapor),工程量大。
- **❌ "混用"语义要小心**:JSON phase 和 TS phase 的依赖/类型如何桥接是设计难点。

---

## 3. 三条路线映射到 taskflow 的对比

| 维度 | Solid 路线 | Svelte 路线 | Vue Vapor 路线 |
|---|---|---|---|
| rune 本体 | 真函数(运行时有效) | 编译指令(运行时擦除) | 模板/标记(可混用) |
| `.tf.ts` 不编译能跑吗 | ✅ 能(降级) | ❌ | ⚠️ 部分(标记决定) |
| 运行时开销 | 有(rune 函数调用) | 零(擦除) | 零(Vapor 模式下) |
| 静态分析精度 | 高(AST + 运行时) | **最高**(纯编译期) | 高 |
| 渐进迁移 | 中(可逐 flow) | 难(全有/全无) | **最顺**(逐 phase 混用) |
| agent 调试体验 | **最好**(可断点) | 差(编译后面目全非) | 中 |
| 实现工程量 | 中 | 中 | **大**(双后端) |
| 类型安全 | ✅ tsc 全程 | ✅ tsc + 编译期 | ✅ tsc |

---

## 4. 我的推荐:Solid 路线为主,但偷 Vue Vapor 的"渐进共存"

**主路线:Solid**(rune 是真函数)。理由:
1. **agent 调试** —— taskflow 的核心用户是 agent + 开发者,能断点、能 REPL 调试比"产物精简"重要。Svelte 路线编译后面目全非,调试地狱。
2. **渐进迁移** —— Solid 路线下,`.tf.ts` 不 build 也能跑(降级成解释执行),和现有 JSON flow 共存天然成立。
3. **实现风险低** —— 不用维护双后端(Vapor 路线的代价)。
4. **类型体验最好** —— tsc 全程参与,rune 返回值有真实类型。

**但借鉴 Vue Vapor 的"双模式共存"**:taskflow 已有 JSON flow + 4 host,**保留 JSON 为一等公民**(`taskflow build flow.json` 和 `taskflow build flow.tf.ts` 都产出 FlowIR),等于白得了 Vue Vapor 的"渐进"优势,而不用承担双执行后端的复杂度。

**不选 Svelte 路线**的理由:运行时擦除对 taskflow 这种"agent 需要可观测、可调试、可 resume"的系统代价过大 —— resume 需要运行时状态,Svelte 路线擦除运行时后,很多 overstory 的 observed readSet 运行时追踪会变得别扭。

---

## 5. 一句话总结三条路线(给决策用)

- **Solid**:"rune 是真函数,能调试,产物略重。" ← **推荐**
- **Svelte**:"rune 是编译指令,运行时擦除,产物最精简,但调试难、迁移硬。"
- **Vue Vapor**:"模板编译成命令式 + JSON/TS 可混用,迁移最顺,但要维护双后端。"

> taskflow 选 **Solid + 偷 Vue 的"JSON 共存"**:rune 是真函数(可调试、可 resume),
> 同时 JSON 仍是一等公民(渐进迁移),得两者之长,避两者之短。
