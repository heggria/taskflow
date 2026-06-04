# pi-taskflow — 设计与可行性方案

> 轻量工作流编排框架 for [pi coding agent](https://pi.dev)
> 灵感来自 Claude Code Dynamic Workflows（2026-05-28 发布），适配 pi extension 生态。

---

## 0. 一句话定位

**让 LLM（或用户）用声明式 DSL 描述一个多阶段工作流，由确定性 runtime 编排 subagent 执行，中间结果不污染主 context，最终只回收结论；工作流可保存为命令、可复用、可恢复。**

---

## 1. 市场调研结论

### 1.1 命名

| 名字 | 状态 | 说明 |
|------|------|------|
| `pi-workflow` | ❌ 已占 | VSCode GUI 扩展（聊天面板/侧栏），**非编排框架**，不冲突 |
| **`pi-taskflow`** | ✅ 可用 | 本项目 |

### 1.2 竞品分析（pi 生态无同类）

| 包 | 模式 | 与 pi-taskflow 差异 |
|----|------|------|
| `pi-pipeline` | SPEC→PLAN→TASKS→VERIFY 固定流水线 | 固定流程，非动态可定义 DSL |
| `pi-agent-flow` | fork subagent 并行调用器（scout/audit…） | 一次性并行调用，无 DAG / 无保存 / 无恢复 |
| `pi-crew` | 重型多 agent 编排 + worktree + 异步 | 太重，用户已弃用 |
| `pi-loop` | planner-worker-judge 固定循环 | 固定架构 |
| `pi-subagents`（官方） | single/parallel/chain 即时调用 | 无持久化工作流定义、无 fan-out scale、无恢复 |

**结论：声明式、可保存、可恢复、支持动态 fan-out 的轻量编排框架在 pi 生态是空白。**

### 1.3 Claude Code Dynamic Workflows 借鉴要点

| 特性 | Claude Code | pi-taskflow 对应 |
|------|-------------|------------------|
| 计划进代码 | Claude 写 JS 脚本 | LLM 产出 **声明式 JSON DSL**（更轻、可审、更安全） |
| 中间结果隔离 | 脚本变量 | runtime 内存 Map，不进 context |
| 规模 | 16 并发 / 1000 agent | 可配置并发上限 + `map` 动态 fan-out |
| 可复用 | 保存为 `/command` | 保存到 `.pi/taskflows/`，注册为 `/tf:<name>` |
| 可恢复 | 同 session 缓存 | run 状态落盘，**跨 session 可恢复**（超越 CC） |
| 质量模式 | 对抗式 review | `gate` / `review` 阶段类型 |

---

## 2. 深度可行性验证（逐项对照 pi 真实 API）

> 全部基于阅读 `@earendil-works/pi-coding-agent` 的 extensions.md / packages.md / json.md / skills.md / prompt-templates.md / development.md + 现有 `~/.pi/agent/extensions/subagent/` 源码。

### ✅ V1. 生成隔离上下文的 subagent，并拿到结构化输出
- **机制**：`spawn("pi", ["--mode","json","-p","--no-session", ...])`，逐行解析 JSON 事件（`message_end` / `tool_result_end`）。
- **证据**：现有 subagent extension 的 `runSingleAgent()` 已完整实现，含 usage 统计、stopReason、错误处理、abort 信号。
- **结论**：**直接复用**，零风险。

### ✅ V2. 并发控制（matching CC 的 scale）
- **机制**：`mapWithConcurrencyLimit(items, concurrency, fn)`。
- **证据**：subagent extension 已有该函数（worker pool 实现）。
- **结论**：复用 + 提高默认上限（CC=16），新增 `map` 阶段做动态 fan-out。

### ✅ V3. 中间结果不进 context window
- **机制**：phase 结果存 runtime 内存 `Map<phaseName, PhaseResult>`；只有最终 phase 的 output 写进 tool `content`；完整轨迹放 `details`（默认不送 LLM，仅 TUI 渲染）。
- **证据**：tool result 的 `content` vs `details` 分离（json.md / 现有 subagent）。
- **结论**：可行，这是相对"裸 subagent 串联"的核心优势。

### ⚠️ V4. 后台执行（session 保持响应）—— 已知约束 + 取舍
- **pi 现实**：工具调用在一个 agent turn 内是**同步阻塞**的；没有 CC 那种独立 workflow runtime 进程。
- **可用手段**：
  - 工具 `onUpdate(partial)` 回调可**实时流式**推进度（subagent parallel 模式已验证）。
  - `ctx.ui.setStatus()` / `ctx.ui.setWidget()` footer/widget 进度。
- **取舍**：
  - **v1（采用）**：工作流作为**单次长工具调用**执行，期间实时流式进度。session 在该 turn 内"忙"，但有完整 phase 进度可视化 —— 与 subagent 现有体验一致，符合"轻量"。
  - **v2（路线图）**：detached 子进程 + 文件状态轮询 + `/tf status` 命令实现**真后台**。复杂度高，非首版。
- **结论**：v1 可行，体验对标 subagent；真后台留作演进。诚实记录此约束。

### ✅ V5. 保存工作流 → 可复用命令
- **三条可用路径**（均已读文档确认）：
  1. `pi.registerCommand()` —— 文档明确支持**运行时注册**（与 registerTool 同源刷新）。
  2. `resources_discover` 事件 —— 动态贡献 prompt/skill 路径（dynamic-resources 示例验证）。
  3. prompt templates（`.pi/prompts/*.md`）—— `/name` 展开为文本。
- **采用方案**：
  - 工作流定义存 `.pi/taskflows/<name>.json`（项目级）/ `~/.pi/agent/taskflows/<name>.json`（用户级）。
  - `session_start` 时扫描目录，为每个工作流 `registerCommand("tf:<name>")`。
  - 始终提供通用 `taskflow` 工具（LLM 调用）+ `/tf run <name> [args]` 命令（用户调用）。
  - 保存新工作流后 `registerCommand` 立即生效（同 session 可用），无需 reload。
- **结论**：可行，比 prompt-template 方案更强（命令直接驱动 runtime）。

### ✅ V6. 状态持久化 / 恢复
- **机制**：
  - `pi.appendEntry(customType, data)` —— 会话内持久化（survive reload）。
  - run 状态额外落盘 `.pi/taskflows/runs/<runId>.json` —— **跨 session 恢复**。
  - 恢复逻辑：按 `phaseName + inputHash` 缓存结果；重跑跳过已完成 phase（与 CC "cached results" 一致）。
- **证据**：todo.ts 示例（从 session entries 重建状态）；appendEntry API（extensions.md）。
- **结论**：可行，且跨 session 恢复**超越 CC**（CC 仅同 session）。

### ✅ V7. 进度可视化（TUI）
- **机制**：复用 subagent 的 `renderCall` / `renderResult`；新增 phase 进度条 / DAG 状态。`ctx.ui.custom()` 做全屏 run 视图（todo.ts 模式）。
- **结论**：可行，有现成范式。

### ✅ V8. 打包发布
- **机制**：`package.json` + `pi` manifest + `pi-package` keyword；pi 核心走 `peerDependencies`；`extensions/` 约定目录。`pi install npm:pi-taskflow`。
- **证据**：packages.md。
- **结论**：可行。

### ✅ V9. Agent 复用
- **机制**：复用 `discoverAgents(cwd, scope, overrides)`，从 `~/.pi/agent/agents/*.md` + `.pi/agents/*.md` 加载；工作流按 agent 名引用；支持 settings.json 的 `subagents.agentOverrides`。
- **结论**：与现有 subagent 体系无缝衔接。

### 可行性总评

| 项 | 结论 |
|----|------|
| 核心编排（spawn/并发/隔离） | ✅ 复用现成代码，零风险 |
| 保存/命令/恢复 | ✅ API 齐全 |
| 真·后台执行 | ⚠️ v1 用流式长调用替代，v2 演进 |
| TUI/打包/agent | ✅ 有范式 |

**整体：高度可行。唯一妥协是"真后台"留 v2，v1 用流式长工具调用，体验对标现有 subagent。**

---

## 3. 架构设计

### 3.1 包结构

```
pi-taskflow/
├── package.json              # pi manifest + peerDeps + pi-package keyword
├── tsconfig.json
├── README.md
├── DESIGN.md                 # 本文件
├── extensions/
│   ├── index.ts              # 入口：注册 tool + commands + 事件
│   ├── runtime.ts            # 编排引擎（DAG 解析 + 调度 + 恢复）
│   ├── runner.ts             # subagent spawn（复用/移植 runSingleAgent）
│   ├── agents.ts             # agent discovery（移植自 subagent/agents.ts）
│   ├── schema.ts             # Taskflow DSL typebox schema + 校验
│   ├── store.ts              # 工作流定义/run 状态读写（.pi/taskflows/）
│   ├── interpolate.ts        # 模板插值 {steps.x.output} / {args.y}
│   └── render.ts             # TUI renderCall/renderResult + 进度视图
├── skills/
│   └── taskflow/
│       └── SKILL.md          # 教 LLM 何时/如何写 taskflow 定义
└── examples/
    ├── audit-endpoints.json
    ├── deep-research.json
    └── migrate-files.json
```

### 3.2 DSL（声明式工作流定义）

```jsonc
{
  "name": "audit-endpoints",
  "description": "审计 src/routes/ 下所有 API 端点的认证检查",
  "version": 1,
  "args": {                          // 调用时传入，{args.dir}
    "dir": { "default": "src/routes" }
  },
  "concurrency": 8,                   // 默认并发上限
  "phases": [
    {
      "id": "discover",
      "type": "agent",               // 单 agent
      "agent": "analyst",
      "task": "列出 {args.dir} 下所有 API 端点，输出 JSON 数组 [{file, route}]",
      "output": "json"               // 解析为结构化数据供 map 用
    },
    {
      "id": "audit",
      "type": "map",                 // ★ 动态 fan-out（scale 核心）
      "over": "{steps.discover.output}",   // 对数组每项起一个 agent
      "as": "item",
      "agent": "analyst",
      "task": "审计端点 {item.route}（文件 {item.file}）的认证检查，列出风险",
      "dependsOn": ["discover"]
    },
    {
      "id": "review",
      "type": "gate",                // ★ 对抗式质量门
      "agent": "reviewer",
      "task": "复核以下审计结果，剔除误报，标注置信度：\n{steps.audit.output}",
      "dependsOn": ["audit"]
    },
    {
      "id": "report",
      "type": "agent",
      "agent": "planner",
      "task": "汇总成最终报告：\n{steps.review.output}",
      "dependsOn": ["review"],
      "final": true                  // 该 phase 输出回收到主 session
    }
  ]
}
```

### 3.3 Phase 类型

| type | 语义 | 并发 |
|------|------|------|
| `agent` | 单 subagent 调用 | 1 |
| `parallel` | 静态多任务并行（固定 task 列表） | ≤concurrency |
| `map` | 对上游数组**动态 fan-out**，每项一个 agent | ≤concurrency |
| `gate` | 质量门 / 对抗 review（可决定是否继续） | 1+ |
| `reduce` | 把多结果聚合为一（synthesize） | 1 |

### 3.4 模板插值

| 占位符 | 含义 |
|--------|------|
| `{args.X}` | 调用参数 |
| `{steps.ID.output}` | 某 phase 的最终输出（字符串） |
| `{steps.ID.json}` | 某 phase 输出解析为 JSON |
| `{item}` / `{item.field}` | map 阶段当前项 |
| `{previous.output}` | 上一 phase 输出（链式简写） |

### 3.5 执行引擎（runtime.ts）

```
1. 校验 DSL（schema.ts）
2. 拓扑排序 phases（dependsOn 建 DAG，检测环）
3. 按层调度：
   - 同层无依赖 phase 并行
   - map 阶段展开为 N 子任务，受 concurrency 限流
4. 每个 phase：
   - 插值 task
   - 命中缓存（phaseName+inputHash 在 run 状态里）→ 跳过
   - 否则 spawn subagent（runner.ts），流式 onUpdate
   - 存结果到内存 Map + 落盘 run 状态
5. gate 阶段可返回 {continue:false} 中止
6. final phase（或最后一个）输出 → tool content 回主 session
7. 全程 details 累积完整轨迹供 TUI
```

### 3.6 对外接口

**(a) LLM 工具：`taskflow`**
```jsonc
// 内联定义直接跑（LLM 动态生成工作流 —— 对标 CC "Claude 写脚本"）
{ "define": { /* 完整 DSL */ }, "args": { "dir": "src/api" } }

// 跑已保存的工作流
{ "run": "audit-endpoints", "args": { "dir": "src/api" } }

// 保存定义为可复用命令
{ "save": "audit-endpoints", "define": { /* DSL */ } }

// 从中断处恢复
{ "resume": "<runId>" }
```

**(b) 用户命令**
| 命令 | 作用 |
|------|------|
| `/tf list` | 列出已保存工作流 + 最近 run |
| `/tf run <name> [args]` | 运行 |
| `/tf:<name> [args]` | 每个保存的工作流自动注册的快捷命令 |
| `/tf resume <runId>` | 恢复中断的 run |
| `/tf show <name>` | 查看定义 |
| `/tf runs` | 全屏 run 历史/状态视图（ctx.ui.custom） |

**(c) 编程接口（供其他 extension）**
```ts
export async function runTaskflow(def, args, ctx): Promise<TaskflowResult>
```

### 3.7 存储布局

```
.pi/taskflows/                       # 项目级定义（可入库共享）
  audit-endpoints.json
~/.pi/agent/taskflows/               # 用户级定义
  deep-research.json
.pi/taskflows/runs/                  # run 状态（恢复用，gitignore）
  <runId>.json                       # {def, args, phases:{id:{status,output,usage,hash}}}
```

---

## 4. 与现有 subagent 的关系

- **不替代，是上层编排**。subagent = 即时调用；taskflow = 可定义/保存/恢复的编排。
- 复用其 spawn / 并发 / usage / TUI 代码（移植进 `runner.ts`，避免硬依赖一个非 npm 的本地扩展）。
- 共享 agent 体系（`~/.pi/agent/agents/*.md` + settings `subagents.agentOverrides`）。

---

## 5. 路线图

| 版本 | 范围 |
|------|------|
| **v0.1** | DSL + schema + runtime（agent/parallel/map/reduce）+ `taskflow` 工具 + `/tf run` + 内存隔离 + 流式进度 |
| **v0.2** | 保存/动态命令注册 + 跨 session 恢复 + `gate` 阶段 + run 历史 TUI |
| **v0.3** | examples + SKILL.md（教 LLM 写定义）+ YAML 支持 + 发布 npm |
| **v0.4** | 真·后台执行（detached + 轮询）+ 成本预估/上限 + 内置 `deep-research` 工作流 |

---

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 真后台执行 v1 缺失 | 流式长调用 + 明确文档；v4 补 |
| map 依赖上游输出结构化 JSON | `output:"json"` + 容错解析 + schema 提示 agent |
| spawn pi 路径解析（bun/node/standalone） | 移植 subagent 的 `getPiInvocation()`（已处理三种运行时） |
| 并发过高耗 token/限流 | concurrency 上限 + 成本预估（v4） |
| 运行时命令注册兼容性 | session_start 扫描注册兜底；保存即注册为增强 |
| DSL 过度复杂 | 保持声明式、5 种 phase 封顶；JS 逃生舱不做（保持"轻量"） |

---

## 7. 下一步

1. 创建 `package.json` + `tsconfig.json` + 骨架目录
2. 实现 `schema.ts`（DSL 校验）+ `interpolate.ts`
3. 移植 `runner.ts` / `agents.ts`（自 subagent）
4. 实现 `runtime.ts`（DAG 调度 + map fan-out）
5. `index.ts` 接线 tool + `/tf` 命令
6. 本地 `pi -e ./extensions/index.ts` 联调
7. examples + SKILL.md + README
8. 发布 `npm publish` → `pi install npm:pi-taskflow`
</content>
</invoke>
