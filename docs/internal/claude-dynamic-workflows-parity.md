# Claude Code Dynamic Workflows — 能力对账与「A 能力」范围定义

> 调研日期：2026-06-09　来源：Claude Code 官方文档 `code.claude.com/docs/en/workflows`（v2.1.154+，2026-05-28 Research Preview 起）+ 多方二手报道交叉验证。
> 目的：以「Claude Code dynamic workflow 能做到的，pi-taskflow 用声明式 DAG 也要能做到」为目标，精确定位 gap，框定下一步要实现的「A 能力」。

## 一、Claude Code Dynamic Workflows 是什么（官方口径）

- **本质**：一段 **JavaScript orchestration script**，由 Claude 根据你的任务描述**自动生成**，交给一个**独立 runtime 在后台执行**，主会话保持响应。
- **核心卖点**：plan / loop / branch / 中间结果都活在 **script 变量**里，只有最终答案回到上下文 → 把"控制流从 model-driven 移到 code-driven"。
- **触发**：prompt 里带 `ultracode` 关键字，或自然语言"use a workflow"；`/effort ultracode` 让 Claude 对每个实质任务自动编排。
- **规模**：单次 run ≤16 并发 agent、≤1000 agent 总数。

## 二、能力逐条对账（Claude ✅ → pi-taskflow 现状）

| # | Claude Code 能力 | pi-taskflow 现状 | 判定 |
|---|------------------|------------------|------|
| 1 | 模型自动写编排（描述任务→生成脚本） | 模型可生成 inline `define` DAG | ✅ 对等 |
| 2 | 中间结果不进上下文，只回最终答案 | 核心不变量，只回 final phase | ✅ 对等 |
| 3 | fan-out 大量 subagent（≤16 并发 / ≤1000 总） | `map` + `concurrency` 默认 8 | ✅ 对等（可配） |
| 4 | 保存为命令复用 `/<name>`（项目级 + 用户级） | `/tf:<name>`，project + user scope | ✅ 对等 |
| 5 | 运行时传入 `args` 结构化输入 | `{args.X}` 插值 | ✅ 对等 |
| 6 | adversarial 互审 / 多角度起草择优 | `tournament` + `gate` | ✅ 对等（且声明式） |
| 7 | 每个 stage 可路由不同 model | per-phase `model` / `thinking` / `tools` | ✅ 对等 |
| 8 | 限制：脚本本身无 fs/shell，只有 agent 有工具 | 完全一致（runtime 协调，agent 干活） | ✅ 对等 |
| 9 | 限制：无 mid-run 用户输入（除权限提示） | 一致；分阶段签核用多个 flow | ✅ 对等（我们另有 `approval` phase） |
| 10 | session 内 resume：完成的 agent 返回缓存 | resume **且跨 session** + 输入哈希 + 跨 run memoization | ✅ **超越** |
| 11 | 运行前审批：看 phase 列表 + **看 raw script** + 编辑 prompt 再跑 | 有 `approval` *phase*，但**无"运行前看全图并批准/改写"门** | ⚠️ 部分缺 |
| 12 | **打开生成的 script 文件 → 读 → diff 上一版 → 编辑后 relaunch** | `RunState.def` 已落盘，但**没暴露给用户读/导出/编辑后重跑** | ❌ **缺 = A 能力核心** |
| 13 | 后台运行（session 保持响应） | tool `execute()` 阻塞 | ❌ 缺（已立项，单独 H3） |
| 14 | 进度面板：按 phase 看 agent 数/token/耗时，drill into 单 agent | 有 DAG 渲染，缺 per-agent drill-in 明细 | ⚠️ 部分缺 |
| 15 | 运行管理：pause/resume、stop 单 agent、restart 单 agent | 有 resume；缺运行中 pause / stop-single / restart-single | ⚠️ 部分缺 |

## 三、结论：真正的 gap 是「计划即可读可改写的 artifact」

Claude 的杀手锏不只是"跑得多"，而是把 plan 落成一份**可读、可 diff、可编辑、可重启**的脚本文件（写在 `~/.claude/projects/<session>/`，run 启动时把路径告诉 Claude，用户可以打开它、diff 上一版、改完让 Claude 从改后版本 relaunch）。

pi-taskflow 现状：inline `define` 跑完即逝，用户**拿不到那份 DAG 去审查 / 改写 / 重跑**——尽管 `RunState.def` 其实已经把完整定义存在磁盘上了。**数据地基已具备，缺的是 surface（暴露 + 编辑回路）。**

而我们能做得**比 Claude 更强**：Claude 的 artifact 是命令式 JS（改了只能祈祷它对）；pi-taskflow 的 artifact 是声明式 DAG JSON——**改写后可以先静态验证（无环 / 引用完整 / 无死端 / 预算）再 relaunch**。这正是「声明式优于命令式」立论在编辑回路上的兑现。

## 四、「A 能力」范围定义（建议）

> **A = 计划即 artifact：运行前/中/后，DAG 定义对用户可读、可导出、可编辑、可（静态验证后）relaunch。**

最小完备闭环（按依赖排序）：

1. **导出运行的 DAG**：`/tf show <runId>`（或 `runs-view` 里按键）输出该 run 的 `def`（已落盘，纯 surface）。
2. **运行前审批门（pre-run gate）**：inline `define` 执行前，把"将要跑的 phase 列表 + 静态验证报告"呈现给用户 → 批准 / 看完整 def / 取消。（接 `approval` UI 复用）
3. **编辑后 relaunch**：把某 run 的 `def` 落成可编辑文件 → 用户改 → 重新 `validateTaskflow()` → 通过则作为新 run 执行（已完成且未改动的 phase 命中跨 run 缓存自动跳过）。
4. **（可选增强）diff**：relaunch 时展示改后 def 与原 def 的结构 diff（哪些 phase 变了 → 哪些缓存失效）。

明确**不在 A 范围内**（属后续 horizon）：
- 后台 detach 运行（#13）— 重型，单独立项。
- 运行中 pause / stop-single-agent / restart-single-agent（#15）— 依赖执行模型改造。
- per-agent drill-in 进度面板（#14）— 属"看"的增强，可并行但非 A 主线。

## 五、为什么 A 用 DAG 做反而更优（写进 README 的弹药）

| 维度 | Claude（命令式 script artifact） | pi-taskflow（声明式 DAG artifact） |
|------|----------------------------------|-----------------------------------|
| 编辑后能否先验证 | ✗ 改完只能跑了看 | ✓ relaunch 前 `validateTaskflow()` 静态把关 |
| 改动影响可分析 | ✗ 控制流里看不出 | ✓ 结构 diff → 精确算出哪些缓存失效 |
| 安全交给模型改 | 有风险（可执行代码） | ✓ 纯数据，无 eval |
| 复用粒度 | 整脚本 | ✓ phase 级输入哈希，未改部分 $0 复用 |
