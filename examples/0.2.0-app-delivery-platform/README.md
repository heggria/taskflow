# 0.2.0 Demo: Autonomous Software Delivery Platform

> ⚠️ **愿景草图,非 0.2.0 首版可运行样例。**

这个 demo 故意展示了 taskflow 0.2.0 DSL 的**完整愿景上限** —— 一个 10 文件的
多 flow agent 应用(像 Vue/Solid 应用那样有 app/flows/components/stores/lib 结构)。

**但其中部分特性在 [`docs/rfc-0.2.0-dsl-syntax.md`](../../docs/rfc-0.2.0-dsl-syntax.md) §7
明确标为 post-0.2.0**(依赖全局响应式运行时 / Shared Context Tree,首版不含):

| post-0.2.0 特性 | 用在哪 | 为什么 post |
|---|---|---|
| `$derived` / `$state` | `app.ts`, `stores/dashboard.ts`, `flows/plan.ts` | 全局响应式派生状态,需响应式运行时 |
| `$store` | `stores/dashboard.ts` | 全局共享 store,需 Shared Context Tree |
| `read()` / `write()` | `app.ts`, `stores/dashboard.ts`, `components/review-changes.ts` | 读写全局 store |
| `flow.component(...)` | `flows/implement.ts`, `components/*` | 带 props 的可复用子 flow,props 响应式语义待定 |

文件内用到这些特性的地方都标了 `// [post-0.2.0]`。

## 0.2.0 首版能跑的部分

- 所有 `agent` / `map` / `parallel` / `gate` / `reduce` / `loop` / `tournament` /
  `approval` / `script` rune
- 编译期类型(`json<T>()`、`item.route` 类型检查)
- 自动依赖追踪(编译期收集 `.output` 引用)
- `when` 字符串条件 + 受限 TS 谓词子集

## 这个 demo 的价值

它是**愿景交流工具** —— 展示"当 0.2.x 补齐全局响应式 + flow.component 后,agent
应用能写成什么样"。不是 0.2.0 首版的参考实现。要看 0.2.0 首版能跑的样例,看
`taskflow new` 生成的骨架 + RFC §B 的 audit-endpoints 示例。

## 文件结构(像 Vue/Solid 应用)

```
app.ts              主入口(编排整个交付流水线)  ← 含最多 post-0.2.0 特性
├── types/          领域模型
├── config/         声明式配置
├── lib/            工具函数(编译期求值)
├── stores/         响应式全局 store            ← post-0.2.0 ($store/$derived)
├── flows/          业务流程(plan / implement)
└── components/     可复用 phase 组件            ← post-0.2.0 (flow.component)
```
