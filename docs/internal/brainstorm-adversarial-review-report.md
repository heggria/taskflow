# pi-taskflow 降本增效方案 — 交叉验证 + 对抗审查最终裁决报告

**审查范围：** 22 个提案（P01–P22）| **方法：** 4 视角交叉验证 + 2 路对抗攻击 | **日期：** 2026-06-07

---

## 1. Executive Summary

### 审查范围与规模

本次审查对 22 个降本增效方案进行了全面评估。每个方案经历了：

| 审查层 | 说明 |
|--------|------|
| 4 视角交叉验证 | 成本批评家、效率规划师、信息架构师、系统架构师 — 各自审查非本领域方案 |
| 2 路对抗攻击 | Cost/效率 critic 攻击 immediate 方案，System/AI critic 攻击 innovation 方案 |
| 最终仲裁 | 共识则通过，分歧则权衡，攻击颠覆则降级 |

### 最终裁决分布

| 裁决 | 数量 | 方案 |
|------|------|------|
| **Approve** | 6 | P07, P08, P09, P12, P14, P18 |
| **Approve with conditions** | 8 | P01, P03, P04, P06, P11, P16, P17, P20 |
| **Defer** | 6 | P02, P10, P13, P15, P19, P21 |
| **Reject** | 2 | P05, P22 |

### 三大关键元发现

1. **隐式依赖链未被原始方案设计者识别。** P10（scout-driven router）依赖 P03（scout JSON），P15（auto-repair）依赖 P10，P02（模型替换）依赖 P17（cascade routing）。这些链在交叉验证中被发现，若不识别会导致实施失败。
2. **最危险的方案（P22 pipeline 热修复）被对抗攻击完全摧毁。** 运行时 DAG 突变与现有的不可变迭代、无 abort 信号、无 checkpoint 等基础设施完全不兼容。被 unanimous 否决。
3. **最大价值在 prompt 层，而非运行时层。** 审查发现 P09（增量 diff）、P12（防幻觉 review）、P14（决策日志）、P18（agent 名称校验）4 个方案只需 prompt 修改或 ≤10 行代码，无运行时风险，应当优先实施。

---

## 2. 审查方法论

### 2.1 交叉验证矩阵

| 专家 | 专业领域 | 审查的方案 |
|------|----------|-----------|
| 成本批评家 (Cost Critic) | token 成本，模型定价，输出压缩 | P06, P07, P08, P09, P10, P12, P15, P16 |
| 效率规划师 (Efficiency Planner) | 端到端时间，吞吐，延迟优化 | P03, P05, P13, P14, P17, P18, P19, P22 |
| 信息架构师 (Info Architect) | 数据流，schema，契约，状态管理 | P01, P02, P04, P11, P16, P20, P21 |
| 系统架构师 (System Architect) | 运行时架构，扩展性，版本兼容 | P11, P15, P19, P20, P21, P22 |

每个专家审查了 **自身领域之外** 的方案，确保跨领域偏见最小化。

### 2.2 对抗式攻击

两路独立 critic 对最高风险方案进行强制攻击：

| Critic | 攻击目标 | 攻击策略 |
|--------|---------|----------|
| Cost/效率 Critic | 7 个 immediate 方案（P01–P05, P09, P10） | 重构推理链，寻找隐藏依赖、质量侵蚀证据、实施阻力和成本幻觉 |
| System/AI Critic | 6 个 innovation 方案（P15, P16, P17, P19, P20, P22） | 架构可行性攻击，寻找与现有运行时不兼容的根本性缺陷 |

### 2.3 仲裁规则

| 条件 | 裁决 |
|------|------|
| 交叉验证 unanimous 共识 + 对抗攻击 survived | **Approve** (最高置信度) |
| 交叉验证 majority + 对抗攻击 survived/survived-with-conditions | **Approve with conditions** |
| 交叉验证 majority/split + 对抗攻击 survived | 根据攻击暴露的缺陷决定 approve-with-conditions 或 defer |
| 交叉验证 consensus + 对抗攻击 not survived | 降级 — 增加 conditions 或改为 defer |
| 交叉验证 unanimous + 对抗攻击 not survived，存在根本性缺陷 | **Reject** |

---

## 3. 交叉验证结果汇总

### 3.1 成本批评家视角

审查非本领域方案（P06–P10, P12, P15, P16）后发现：

- **P06（review+verify 并行）**：验证了资源冲突假设，reviewer 和 verifier 确实共享不同资源（一个读代码、一个跑测试）。但指出 gate 合并逻辑需要明确设计——现存的 `parseGateVerdict` 支持 JSON 和文本 verdict，可以复用。
- **P07（multi-reviewer 并行）**：确认并行 reduce 模式可行，但指出 reduce agent 的 prompt 需要 anti-anchoring 指令，防止大多数 reviewer 的偏见影响少数正确发现。
- **P08（reviewer 发现共享）**：确认 shared context 已在 taskflow DSL 层通过 `phase.context` 支持，无需运行时修改。
- **P09（增量 diff 审查）**：验证 git diff 命令可以在 executor-fast 阶段执行，但指出新增文件需要特殊处理（无 diff 时读完整文件）。
- **P16（project knowledge cache）**：提出 cache 失效键必须包含 agent 名称，以便 P17 的 agent swap 自然触发重新缓存。

### 3.2 效率规划师视角

审查非本领域方案（P03, P05, P13, P14, P17, P18, P19, P22）后发现：

- **P03（scout JSON 输出）**：确认 token 节省，但指出 DeepSeek V4 Flash（thinking=off）不适合 JSON 生成——模型需要一定的推理能力来正确进行括号匹配和转义。提出可以用 `output: json` phase 定义。
- **P05（maxTokens）**：直接发现根本性问题——`maxTokens` 在 `schema.ts` 的 `Phase` 类型、`runner.ts` 的子进程调用、`agents.ts` 的 frontmatter 解析器中 **都不存在**。这不是一个纯 prompt 修改，而是跨 pi-taskflow + pi CLI 的多文件变更。
- **P13（pipeline context bag）**：发现严重并发问题——`runtime.ts` 使用 `mapWithConcurrencyLimit`，同层 phase 并发执行时无序列化保护。写共享状态会导致竞态条件。
- **P22（pipeline 热修复）**：发现运行时 DAG 不可变性——`runtime.ts` 对拓扑排序后的 layers 使用 `for-of` 不可变迭代，没有 abort 正在运行的 phase、没有 checkpoint 序列化、没有 mutation API。

### 3.3 信息架构师视角

审查非本领域方案（P01, P02, P04, P11, P16, P20, P21）后发现：

- **P01（thinking 降级）**：提出根本性反对——`analyst` 是 pipeline 入口，降级后错误会级联到所有下游阶段。`security-reviewer` 和 `final-arbiter` 的降级风险超过所有 token 节约总和。
- **P02（模型替换）**：指出 `AgentOverride` 在 `agents.ts` 中是静态的（仅设置 model/thinking/tools），没有运行时升级或 fallback 机制。替换 `plan-arbiter` 后如果它失败，无法回退到 Qwen 3.7 Max。
- **P04（verifier 去重）**：提出 trust boundary 问题——verifier 必须独立验证至少 1 个关键测试，不能直接信任 executor 的报告。
- **P11（contract-based agent 输出协议）**：指出可以用现有 `safeParse` + 警告机制逐步部署，提出使用 `output: json` 字段而不是新建验证代码。

### 3.4 系统架构师视角

审查非本领域方案（P11, P15, P19, P20, P21, P22）后发现：

- **P11**：确认 schema.ts 已有 `PhaseSchema` 类型，但添加 contract registry 需要新建模块。
- **P15（early exit + auto-repair）**：提出需要 `RunState` 扩展：`repairLoopCount` 字段和 `inputHash` 去重检测来防止无限循环。
- **P19（自进化 pipeline）**：确认现有代码中没有 analytics 扩展。前期只能收集数据，无法自动调整。
- **P20（预测性质量门）**：提出 `when` 条件字段已在 `PhaseSchema` 中实现，但只应允许升级（upgrade），从不降级（downgrade）。
- **P21（跨 session 知识积累）**：提出知识提取的质量依赖于 gate BLOCK 输出是结构化的。在 P11 稳定之前，自由文本提取噪声太大。

### 3.5 共识 vs 分歧

| 状态 | 方案 | 分歧/共识点 |
|------|------|------------|
| **Unanimous** | P05, P07, P08, P09, P12, P14, P18, P19, P22 | 所有专家结论一致 |
| **Majority** | P01, P02, P04, P06, P10, P11, P13, P15, P16, P17, P20, P21 | 多数一致，少数有附加条件 |
| **Split** | P03, P04 | 成本批评家认为低风险，信息架构师/效率规划师认为有条件实施 |

---

## 4. 对抗式审查结果汇总

### 4.1 Immediate 方案攻击结果（Cost/效率 Critic）

| 方案 | 攻击结果 | 关键缺陷 |
|------|---------|---------|
| **P01** (thinking 降级) | ⚠ 有条件幸存 | 提议的 9 个降级中，仅 1 个（recover high→medium）安全。analyst/security-reviewer/final-arbiter 降级的后果超过收益 |
| **P02** (模型替换) | ❌ 被成功攻击 | 缺少 emergency override 机制（P17 未实现）；$0.006/call 节省不值得妥协仲裁质量 |
| **P03** (scout JSON) | ⚠ 有条件幸存 | DeepSeek V4 Flash thinking=off 不适合 JSON；token 节省可能被 JSON overhead 抵消 |
| **P04** (verifier 去重) | ⚠ 有条件幸存 | Trust boundary 必须保留——verifier 不能盲信 executor 的报告 |
| **P05** (maxTokens) | ❌ 被成功攻击（致命） | 代码中不存在 `maxTokens`——跨 pi-taskflow + pi CLI 多文件变更，scout 4096 太激进 |
| **P09** (增量 diff) | ✅ 幸存 | 纯 context 注入，无运行时修改，新文件需特殊处理 |
| **P10** (scout-driven router) | ✅ 幸存 | 依赖 P03 稳定化；保守策略（不确定时选标准 pipeline）可接受 |

**Immediate 方案攻击结论：** P05 被 unanimous 否决。P02 被 defer（依赖 P17）。P03/P04 需要 redesign。P01 大幅削减范围。

### 4.2 Innovation 方案攻击结果（System/AI Critic）

| 方案 | 攻击结果 | 关键缺陷 |
|------|---------|---------|
| **P15** (auto-repair) | ✅ 幸存 | 合理，但需 P03/P10 先稳定；建议 2 次重试硬上限 + inputHash 去重 |
| **P16** (knowledge cache) | ✅ 幸存 | writeFileAtomic 已存在（store.ts）；24h TTL 合理；10-commit 阈值需实证 |
| **P17** (cascade routing) | ✅ 幸存 | 与现有 retry 机制不同（retry=同一 agent 重试，cascade=不同 agent）；需要新的 schema 字段 |
| **P19** (自进化) | ✅ 幸存 | 分 3 阶段实施；过拟合风险需人工审查 |
| **P20** (预测性质量门) | ✅ 幸存 | 只允许 upgrade，从不 downgrade；依赖 P03 |
| **P22** (热修复) | ❌ 被成功攻击（致命） | 完全不可行——运行时 DAG 不可变，无 abort/checkpoint/mutation API |

**Innovation 方案攻击结论：** P22 被 unanimous 否决——是 22 个方案中最危险的。P15/P17/P20 依赖早期方案稳定化后 defer。

### 4.3 被攻击颠覆的方案

| 方案 | 原始 tier | 新裁决 | 攻击成功关键 |
|------|-----------|--------|------------|
| P05 (maxTokens) | immediate → **Reject** | 代码中不存在 | 
| P22 (pipeline 热修复) | long-term → **Reject** | 运行时架构不兼容 |
| P02 (模型替换) | immediate → **Defer** | 缺少 fallback 机制 |
| P01 (thinking 降级) | immediate → **Approve with conditions** | 范围大幅收窄 |
| P03 (scout JSON) | immediate → **Approve with conditions** | 模型选择 + JSON overhead |

### 4.4 经受住攻击的方案（置信度提升）

| 方案 | 攻击后置信度 | 提升原因 |
|------|------------|---------|
| P09 (增量 diff) | 0.92 | 攻击验证了纯 context 注入，无运行时风险，纯增益 |
| P12 (防幻觉 review) | 0.93 | 攻击验证了 prompt 修改的零风险特性 |
| P14 (executor 决策日志) | 0.90 | 攻击验证了无运行时修改、exempt 机械 agent |
| P18 (agent name 校验) | 0.96 | 攻击验证了 ≈10 行代码的防御价值 |
| P06 (review+verify 并行) | 0.70 | 攻击发现 gate 合并逻辑设计需要明确，但确认可实施 |
| P07 (multi-reviewer 并行) | 0.88 | 攻击验证了 runtime 原生支持 parallel + reduce |
| P08 (reviewer 发现共享) | 0.88 | 攻击验证了 phase.context 字段支持 |

---

## 5. 最终裁决表

| ID | 方案名称 | 原始 Tier | 最终裁决 | 置信度 | 交叉验证 | 对抗攻击幸存 | 调整后优先级 | 维度 |
|----|---------|-----------|---------|--------|---------|------------|------------|------|
| P09 | 增量 Diff 审查 | low-cost | **Approve** | 0.92 | unanimous | ✅ | **Immediate** | cost |
| P08 | Reviewer 发现共享 | low-cost | **Approve** | 0.88 | unanimous | ✅ | **Immediate** | info-flow |
| P07 | Multi-Reviewer 并行 | low-cost | **Approve** | 0.88 | unanimous | ✅ | **Low-cost** | efficiency |
| P12 | 防幻觉 Review | low-cost | **Approve** | 0.93 | unanimous | ✅ | **Immediate** | quality |
| P14 | Executor 决策日志 | medium | **Approve** | 0.90 | unanimous | ✅ | **Immediate** | quality |
| P18 | Agent Name 校验 | low-cost | **Approve** | 0.96 | unanimous | ✅ | **Immediate** | quality |
| P09 staged | 增量 Diff（stage 2） | — | — | — | — | — | **Immediate** | — |
| P01 | Thinking 降级（缩窄） | immediate | **Approve w/ cond** | 0.82 | majority | ⚠ 有条件 | **Low-cost** | cost |
| P06 | Review+Verify 并行 | low-cost | **Approve w/ cond** | 0.70 | majority | ✅ | **Medium** | efficiency |
| P03 | Scout JSON 输出 | immediate | **Approve w/ cond** | 0.75 | split | ⚠ 有条件 | **Medium** | cost |
| P04 | Verifier 去重 | immediate | **Approve w/ cond** | 0.80 | split | ⚠ 有条件 | **Medium** | cost |
| P11 | Contract 输出协议 | medium | **Approve w/ cond** | 0.78 | majority | ✅ | **Medium** | info-flow |
| P16 | Project Knowledge Cache | medium | **Approve w/ cond** | 0.75 | majority | ✅ | **Medium** | efficiency |
| P17 | Cascade 模型路由 | medium | **Approve w/ cond** | 0.72 | majority | ✅ | **Medium** | cost |
| P02 | Qwen → MiMo 替换 | immediate | **Defer** | 0.90 | majority | ❌ 有条件 | **Long-term** | cost |
| P10 | Scout-Driven Router | low-cost | **Defer** | 0.78 | majority | ✅ | **Long-term** | efficiency |
| P15 | Early Exit + Auto-Repair | medium | **Defer** | 0.82 | majority | ✅ | **Long-term** | efficiency |
| P13 | Pipeline Context Bag | medium | **Defer** | 0.92 | unanimous | ✅ | **Long-term** | info-flow |
| P19 | 自进化 Pipeline | long-term | **Defer** | 0.82 | unanimous | ✅ | **Long-term** | innovation |
| P20 | 预测性质量门 | long-term | **Approve w/ cond** | 0.78 | majority | ✅ | **Long-term** | innovation |
| P21 | 跨 Session 知识积累 | long-term | **Defer** | 0.78 | majority | ✅ | **Long-term** | innovation |
| P05 | 输出 Token 上限 | immediate | **Reject** | 0.96 | unanimous | ❌ | **Drop** | cost |
| P22 | Pipeline 热修复 | long-term | **Reject** | 0.95 | unanimous | ❌ | **Drop** | innovation |

---

## 6. 推荐实施路线图

### Week 1 — Immediate（纯 prompt / ≤10 行代码，零风险）

| 顺序 | 方案 | 改动量 | 风险 | 依赖 |
|------|------|--------|------|------|
| 1 | **P09** — 增量 diff 审查 | pipeline context 配置 | none | 无 |
| 2 | **P08** — reviewer 发现共享 | pipeline context 配置 | none | 无 |
| 3 | **P07** — multi-reviewer 并行 | pipeline 模板配置 | none | 无 |
| 4 | **P12** — 防幻觉 review | reviewer.md 修改 | none | 无 |
| 5 | **P01** — thinking 降级（缩窄版） | 3 个 .md frontmatter 修改 | low | 需 A/B quality gate |
| 6 | **P14** — executor 决策日志 | executor.md 修改 | none | 无 |
| 7 | **P18** — agent name 校验 | runtime.ts ≈10 行 | none | 无 |

### Week 2 — Low Cost

| 顺序 | 方案 | 改动量 | 风险 | 依赖 |
|------|------|--------|------|------|
| 8 | **P03** — scout JSON 输出（redesign） | scout.md 修改 + output:json | medium | P01 A/B gate 数据 |
| 9 | **P11** — contract 输出协议（warnings-only） | schema.ts + gate phase | medium | P03 稳定化 |
| 10 | **P16** — knowledge cache（phase 1） | scout.ts 增量 | medium | 无 |

### Week 3 — Medium

| 顺序 | 方案 | 改动量 | 风险 | 依赖 |
|------|------|--------|------|------|
| 11 | **P04** — verifier 去重（redesign） | executor/verifier.md 修改 | medium | P03 (scout JSON for test report) |
| 12 | **P06** — review+verify 并行 | pipeline 模板 + gate 合并 | medium | P04 验证设计 |
| 13 | **P17** — cascade 路由（phase 1） | schema.ts + runner.ts | medium-high | 无 |

### Week 4+ — Long-Term

| 顺序 | 方案 | 前置条件 | 备注 |
|------|------|---------|------|
| 14 | **P10** scout-driven router | P03 stable (>95% compliance) | — |
| 15 | **P15** auto-repair | P03 + P10 稳定 | 需 runtime 扩展 |
| 16 | **P02** 模型替换 | P17 cascade in place | — |
| 17 | **P13** context bag（read-only） | 无 | 写-写共享遥遥无期 |
| 18 | **P19 / P20 / P21** | 数据基础设施 | 第二季度 |

### Dropped

| 方案 | 原因 | 重新评估条件 |
|------|------|------------|
| **P05** (maxTokens) | 不存在此机制，跨 repo 5+ 文件变更 | 当 pi CLI 添加 `--max-tokens` 标志时 |
| **P22** (pipeline 热修复) | 与运行时架构不兼容 | 除非 runtime 重构为可中断 DAG（非计划中） |

---

## 7. 被否决/降级方案分析

### P05 — 输出 Token 上限（Reject）

**置信度：** 0.96（unanimous）

crossval 和对抗攻击同时发现根本性缺陷：`maxTokens` 机制在以下 3 个代码位置**都不存在**：
1. `schema.ts` 的 `Phase` 类型定义
2. `runner.ts` 的子进程参数传递
3. `agents.ts` 的 frontmatter 解析器

这不是一个 `.md` frontmatter 修改，而是**跨 pi-taskflow + pi CLI 的多文件、跨包特性**。Scout 的 4096 token 上限过于激进——当前中等复杂度的代码库探索输出轻易超过 6000–10000 tokens。被截断的输出若被下游误判为失败，将触发无限重试循环。

**重新评估条件：** pi CLI 添加 `--max-tokens` 标志，且 schema.ts 的 PhaseSchema 扩展支持此字段。

### P22 — Pipeline 热修复（Reject）

**置信度：** 0.95（unanimous）

System/AI Critic 的攻击完全摧毁了此方案。关键不兼容点：

```
runtime.ts 拓扑迭代: for-of 不可变 (unanimous 确认)
无 phase abort 机制: 正在运行的 map/parallel phase 无法中断
无 checkpoint: 中断后无法 replay
无 mutation API: 运行时无法修改 DAG
与 P13 共享状态冲突: 写-写竞态对热修复不可接受
```

**替代方案（安全）：** gate 输出 pipeline 修改**建议**，由人类审批后，下次运行应用更改。

**重新评估条件：** runtime 层重构为可中断 DAG（目前无此计划）。

### P02 — Qwen → MiMo 替换（Defer）

**置信度：** 0.90（majority）

主要被 crossval 否决：`AgentOverride` 在 `agents.ts` 中是静态的——只能设置 model/thinking/tools，没有运行时升级或 fallback 机制。替换 `plan-arbiter` 后如果 MiMo 表现不佳，无法回退到 Qwen 3.7 Max。

每次调用节省 ~$0.006，而一次错误仲裁可触发 $0.05–0.10 的重新执行。净收益为负。

**重新评估条件：** P17（cascade routing）实现之后，arbiter 可以安全地降级到低成本的 fallback 模型。

### P13 — Pipeline Context Bag（Defer）

**置信度：** 0.92（unanimous）

crossval 发现严重并发问题：`runtime.ts` 的 `mapWithConcurrencyLimit` 使同层 phase 并发执行，无序列化保护。写入共享状态会导致竞态条件和不可预测的行为。

**可实施子集：** 只读共享 context（上游写入，下游通过 interpolation 读取）——经确认已部分支持。写-写共享遥遥无期。

---

## 8. 元发现

### 8.1 方案之间的隐式依赖

攻击暴露了原始方案设计者未识别的依赖链：

```
P03 (scout JSON) ←── P10 (scout router) ←── P15 (auto-repair)
                              ↑                     
P16 (knowledge cache) ←──  P03 (cache invalidation key needs agent name)
                              ↑
                        P17 (cascade routing — agent swap invalidates cache)
                              ↑
                        P02 (model swap — needs cascade for fallback)
```

这意味着：
- 不能先实施 P10 而跳过 P03
- 不能先实施 P02 而跳过 P17
- P16 的 cache invalidation 键必须包含 agent name（为 P17 铺路）
- P10 的 misclassification rate <10% 门槛必须在 P15 之前达到

### 8.2 跨方案模式

| 模式 | 涉及方案 | 启示 |
|------|---------|------|
| **Prompt-only 高价值** | P09, P12, P14, P18 | 4 个方案共需 ≈10 行代码 + prompt 修改，无运行时风险 |
| **Pipeline 配置变更** | P06, P07, P08 | 利用已有的 `parallel` / `reduce` / `context` 字段 |
| **Schema 扩展** | P11, P17, P16 | 需要 schema.ts 新的可选字段 |
| **运行时扩展** | P13, P15, P17 | 需要 runner.ts / runtime.ts 修改 |
| **架构级变更** | P22 | 完全不可行 |

### 8.3 盲区

审查发现以下领域没有任何方案覆盖：

1. **Token 成本可见性**：当前无法在运行中实时查看每个 phase 的真实 token 消耗。所有节省估计都是理论值。
2. **L1 模型的行为基准**：没有方案针对 MiMo/Minimax/DS-Flash 的实际 JSON 合规率、thinking 深度、幻觉率建立数据集。
3. **并行加速的边际收益曲线**：没有方案估算 `parallel` 阶段的边际收益——当 reviewer 数量 > 3 时，冲突解决成本可能超过并行收益。

---

## 9. 风险清单

### 实施路线图的关键风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| P01 thinking 降级导致质量下降 | medium | high | A/B quality gate：20 task pairs, >5% 质量下降则回滚 |
| P03 JSON 合规率不足 | medium | high | 使用 thinking-enabled 模型（非 DS-Flash off）；hard fail on parse error |
| P06 gate 合并逻辑有缺陷 | low | medium | 集成测试全覆盖 gate 逻辑后再上线 |
| P09 diff context 不足 | low | low | reviewer 仍可以通过额外 `read` 获取全量文件 |
| P12 防幻觉约束过严 | low | low | reviewer 执行时间增加 but 质量提升抵消 |
| P15 auto-repair 无限循环 | medium | high | `repairLoopCount > 2 → fail` + `inputHash` 去重 |
| P13 共享状态竞态 | high | high | 推迟实施；先提供只读 context |
| P17 cascade 延迟 | low | medium | 级联仅作为 retry 耗尽后的最后一次尝试 |

### 推荐监控指标

| 指标 | 用途 | 预期基线 |
|------|------|---------|
| A/B 质量下降率 | P01 gate | <5% |
| Scout JSON 合规率 | P03 gate | >95% |
| Scout pipeline 误分类率 | P10 gate | <10% |
| Gate BLOCK 率 | 整体健康 | 当前基线 |
| 每个 phase 的真实 token 成本 | 审计 | 收集 baseline |

---

*本报告基于 2026-06-07 的交叉验证 + 对抗审查结果生成。所有数据来自 synthesis 裁决，无自行编造。*
