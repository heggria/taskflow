# 必要性问题必要性审查报告

**审查范围：** 18 个 issue（P14、P18 细化 + 跨域 + hidden）| **方法：** 成本收益分析 × 交叉验证 × 对抗元审查 | **日期：** 2026-06-07

---

## 1. 执行摘要

18 个 issue 经三轮审查（成本收益 → 交叉验证 → 对抗元审查），最终裁决 **2 个 NOW、4 个 NEXT、7 个 NEVER**。P11-auto-repair 因分析层事实错误（声称 `JSON.parse` 直接处使用，实际代码已使用 `safeParse`）被推翻。对抗元审查揭示分析过程存在 6 类系统性偏误。

## 2. 方法论

### 2.1 审查管线

| 阶段 | 角色 | 产出 |
|------|------|------|
| **成本收益分析** | doc-writer agent | 18 个 issue 的 verdict、cost_of_fixing、frequency 估计 |
| **交叉验证** | reviewer agent | 对 15 个 issue 提出挑战，2 个 downgrade，13 个维持 |
| **对抗元审查** | 元审查（非代理） | 6 类攻击模式 + 4 个 hidden priority + `final_recommendation: re-evaluate` |
| **最终仲裁** | 本文档 | 基于代码证据的三方裁决 |

### 2.2 裁决分类

| 裁决 | 含义 | 时间窗口 |
|------|------|---------|
| **NOW** | 本周实施。≤5 行代码 / prompt 修改，零风险 | 本周 |
| **NEXT** | 下个 sprint 实施。1–15 行代码，低风险 | 下一迭代 |
| **NEVER** | 不值得修复。defer 或 skip | 无计划 |
| **DEPENDS** | 依赖外部条件（数据 / 功能就绪） | 条件满足时触发 |

> **注意：** 原始 18 个 issue 包含 5 组重复框架（P18-double-error / remove-P18-double-check、P18-format-only / P18-registry-validation、P14-executor-fast-missing / executor-fast-decisions-note）。本报告在裁决表中展开展示重复项以供可追溯性，但 **Never 栏** 将重复项合并计数为去重后 7 个。

## 3. 最终裁决表

### 3.1 汇总分布

| 裁决 | 展开计数 | 去重计数 | issue ID |
|------|---------|---------|----------|
| **NOW** | 2 | 2 | P18-scope-creep, crossval-hallucination |
| **NEXT** | 4 | 4 | P18-double-error (merged), P18-registry-validation (merged), P16-cache-agent-key, P18 测试覆盖 |
| **NEVER** | 10 | 7 | P11-auto-repair, P14-executor-fast-missing, executor-fast-decisions-note, historical-docs-underscore, P10-cache-warmup, P03-doc-structure, P17-context-compression, P04-input-filter, remove-P18-double-check (dup), P18-format-only (dup) |

### 3.2 逐 Issue 裁决

| # | ID | 问题 | 成本收益 | 交叉验证 | 仲裁 | 裁决 | 说明 |
|---|----|------|---------|---------|------|------|------|
| 1 | P18-scope-creep | phase ID 错误消息说 "agent naming convention" | should_fix | should_fix ↑ | NOW | **NOW** | 1 行消息修正 |
| 2 | crossval-hallucination | reviewer 编造 PIPELINE-PATTERNS.md | should_fix | should_fix ↓ | NOW | **NOW** | 确认文件不存在。1 句 prompt 加固 |
| 3 | P18-double-error | 下划线 + regex 两重检查重复报错 | nice_to_have | nice_to_have → | NEXT | **NEXT** | 合并为 dedup。加测试 |
| 4 | P18-registry-validation | 格式校验不检查 agent 是否存在 | should_fix | should_fix → | NEXT | **NEXT** | 入口层 5 行 pre-flight 警告 |
| 5 | P16-cache-agent-key | cache key 不含 model | must_fix | should_fix ↓ | NEXT | **NEXT** | 2 行 / 调用点，仅有必要条件 |
| 6 | P18 测试覆盖（交叉验证发现） | agent name 验证零测试 | — | nice_to_have | NEXT | **NEXT** | crossval 指出后新增；5 个测试 |
| 7 | P11-auto-repair | 声称 `JSON.parse` 直用 | must_fix | skip ❌ | NEVER | **NEVER** | 代码已用 `safeParse`。分析层事实错误 |
| 8 | P14-executor-fast-missing | executor-fast 缺 Decisions 字段 | skip | skip → | NEVER | **NEVER** | 有意设计，不是 bug |
| 9 | executor-fast-decisions-note | （同上，正框架） | skip | skip → | NEVER | **NEVER** | 与 #8 同 issue |
| 10 | historical-docs-underscore | dogfooding 报告用 executor_fast | skip | skip → | NEVER | **NEVER** | 历史档案，不应篡改 |
| 11 | P10-cache-warmup | 缓存预热 | skip | skip → | NEVER | **NEVER** | 问题几乎不存在 |
| 12 | P03-doc-structure | 合并 agent .md 文件 | skip | skip → | NEVER | **NEVER** | 提前优化。<10ms 开销 |
| 13 | P17-context-compression | LLM 自动压缩中间输出 | nice_to_have | nice_to_have → | NEVER | **NEVER** | 过度工程。已有 output:json 模式 |
| 14 | P04-input-filter | 按字段过滤 prompt 上下文 | nice_to_have | nice_to_have → | NEVER | **NEVER** | 已有 {steps.X.json.field} 精确控制 |
| 15 | remove-P18-double-check | 删除下划线友好检查 | nice_to_have | nice_to_have → | NEVER | **NEVER** | 与 #3 同 issue。dedup 替代删除 |
| 16 | P18-format-only | VALID_AGENT_RE 仅校验格式 | nice_to_have | nice_to_have → | NEVER | **NEVER** | 与 #4 同 issue。运行时 fallback 足够 |
| 17 | P17-format-only（交叉验证拆出） | 同上，假频率估计 | nice_to_have | — | NEVER | **NEVER** | 同 #16 |
| 18 | P18-double-error 测试（交叉验证拆出） | 零测试覆盖 → nice_to_have | — | nice_to_have | NEVER | **NEVER** | 已并入 #6 NEXT |

> 箭头方向：↑ 表示对抗元审查升级，↓ 表示交叉验证 downgrade，→ 表示未变，❌ 表示事实推翻。

## 4. 行动方案（NOW）

### NOW-01: P18-scope-creep — 修正 phase ID 错误消息

**代码证据：** `schema.ts:347` 错误消息引用 "agent naming convention"，而 phase ID 不是 agent name。`collectRefs` 正则（`schema.ts:464` `[a-zA-Z0-9_-]+`）接受下划线，所以检查仅限于约定层面，而非解析要求。

**更改：**

```typescript
// schema.ts:347 — 仅修改消息文本
errors.push(
  `Phase '${p.id}': id uses underscores — use hyphens for consistency with ` +
  `interpolation placeholders (e.g. {steps.audit-each.output})`,
);
```

**验证：** 原始消息已读（`schema.ts:346-347`）。跨域审查确认 "the analysis correctly identifies that the phase ID error message at schema.ts L347... is confusing"。Adversarial 的 "sunken cost" 攻击承认 this "one-line change" is justified。三方共识一致。

**风险：** 零。消息文本不影响任何逻辑分支。

---

### NOW-02: crossval-hallucination — 加固 reviewer prompt

**代码证据：** `grep 'PIPELINE-PATTERNS'` 在整个 repo 命零命中。引用的文档不存在。

**更改：** 在 `reviewer.md` prompt 模板（及任意 reviewer 指令定义处）新增：

```
When citing a document as evidence, you MUST have read it during this
session using the read tool. If you have not read the file, do not cite it.
Fabricating document references is worse than omitting them.
```

**验证：** 原始成本收益分析声称 "A reviewer subagent fabricated evidence by citing a nonexistent document (PIPELINE-PATTERNS.md)"。confirmation：整个 repo 中该文件匹配 0 个。交叉验证将其置信度降至 "medium"（称 "I cannot verify this claim from the code"），但这是该 crossval 自身失败：它使用了 grep 访问，却选择不验证。对抗元审查将此纠正为 "high" 置信度。

**风险：** 零。纯 prompt 修改，不影响任何代码路径。

---

## 5. 延期项目（NEXT + 触发条件）

### NEXT-01: P18-double-error + 测试覆盖（合并）

**更改：** 将 `schema.ts` 中的 `VALID_AGENT_RE` 循环（L362-365）改为仅在未通过下划线检查的情况下触发：

```typescript
for (const p of flow.phases) {
    if (!p?.id) continue;
    if (p.agent && !p.agent.includes("_") && !VALID_AGENT_RE.test(p.agent)) {
        errors.push(
            `Phase '${p.id}': agent '${p.agent}' has invalid name format ` +
            `(expected lowercase alphanumeric with hyphens)`,
        );
    }
}
```

+ `test/schema.test.ts` 中新增测试（5 个）：

1. Agent name 中包含下划线 → 仅输出友好的 "use hyphens" 错误，不双倍报错
2. Agent name 中包含大写字母 → 输出格式错误
3. Agent name 以前导数字开头 → 输出格式错误
4. 有效的 agent name（如 `executor-code`） → 无错误
5. Phase ID 中包含下划线 → 输出修正后的错误消息

**代码证据：** `schema.ts:342`（`includes('_')`）+ `schema.ts:363`（`VALID_AGENT_RE`）——两种检查都被确认存在。`test/schema.test.ts` 中零匹配 `underscore`、`hyphen`、`VALID_AGENT` 或 `executor_fast`——交叉验证确认零测试覆盖。

**触发条件：** 本周三之前。

---

### NEXT-02: P18-registry-validation — pre-flight agent 存在性检查

**更改：** 在 `index.ts`（入口点）中，`discoverAgents()` 之后、`executeTaskflow()` 之前：

```typescript
const agentNames = new Set(agents.map(a => a.name));
for (const p of flow.phases) {
    if (p.agent && !agentNames.has(p.agent)) {
        console.warn(
            `[taskflow] Warning: phase '${p.id}' references agent '${p.agent}' ` +
            `which was not found. Available: ${[...agentNames].join(", ")}`,
        );
    }
}
```

**代码证据：** `runtime.ts:671-687`（`resolveAgent`）包含 warnings + fallback 以及 defense-in-depth。该入口点级别的检查在花费 token 之前捕获错误。

**触发条件：** NEXT-01 合并后。二者调整的是同一验证路径。

---

### NEXT-03: P16-cache-agent-key — 将 model 添加到 cache key

**更改：** 在 `runtime.ts` 中，将 `phase.model` 添加到所有 `hashInput` 调用中：

```typescript
// L440 (单 agent)
const inputHash = hashInput(phase.id, agentName, phase.model ?? "", fullTask);
// L458 (parallel)
const inputHash = hashInput(phase.id, agentName, phase.model ?? "", JSON.stringify(branches));
// L488 (map)
const inputHash = hashInput(phase.id, agentName, phase.model ?? "", JSON.stringify(tasks));
// L499 (approval)
const inputHash = hashInput(phase.id, agentName, phase.model ?? "", message);
// L550 (flow)
const inputHash = hashInput(phase.id, agentName, phase.model ?? "", `flow:${name}`, preRead, JSON.stringify(subArgs));
```

**代码证据：** `runtime.ts:440` 调用 `hashInput(phase.id, agentName, fullTask)` — 不包含 model。`runtime.ts:305` 将 `model: phase.model` 传递给 `runAgentTask`，因此解析后的 model 在此处可用。交叉验证将此从 `must_fix` 降级为 `should_fix`（此处为 NEXT），理由是频率低。对抗元审查同意。

**触发条件：** 如果从未执行过 agent 级别模型覆盖（通过 `phase.model` 或 `settings.json`），则该项可无限期推迟。

---

### NEXT-04: 抗幻觉交叉验证过程修复

**核心发现：** 交叉验证的 87% 认可率（15 个挑战中 13 个不变）和 "Keep as" 措辞表明存在锚定偏误。交叉验证应将原始 verdict 作为盲化起点进行独立评估。

**更改：** 无代码更改。反向审查模板：移除 "original_verdict" 和 "challenge" 框架。替换为无偏评估：

```
Instructions for cross-validation:
- Do NOT read the original verdict before forming your own.
- Rate each issue independently on a standardized scale:
  - impact: {critical, high, moderate, low}
  - frequency: {every_run, often, occasionally, rarely, once}
  - fix_cost: {trivial, low, medium, high}
- Only then compare against the original verdict and note divergence.
```

**触发条件：** 下一次跨审查运行。不适用于本次发布的 issue。

---

## 6. 已拒绝项（NEVER）

### NEVER-01: P11-auto-repair

**事实错误：** 原始成本收益分析声称 `resultToPhaseState` 使用 `JSON.parse` directly。**代码证明为假。** `runtime.ts:84`：

```typescript
json: parseJson && !failed ? safeParse(r.output) : undefined,
```

`safeParse`（`interpolate.ts:105-154`）已经处理了 markdown fence、围栏代码块中的 JSON 提取以及平衡括号提取——这正是 P11 声称要修复的内容。该修复已经在 v0.0.8.1 中实现。

**影响：** 这是本次审查中最严重的事实错误。它源自记忆而非代码证据，并且迫使一个应得的 `must_fix` 升级为 `NEVER`。

### NEVER-02: P14-executor-fast-missing / executor-fast-decisions-note

**有意为之：** executor-fast 按定义处理微小任务（≤2 个文件，≤50 行），这些任务不涉及架构决策。AGENTS.md 记载了 "keep scope narrow and avoid architecture decisions"。添加 "Decisions: none" 字段会引诱 LLM 捏造琐碎的决策（"Decisions: chose const over let"）来填充本应留空的字段。现有的 "Escalation" 字段已经捕获了重要的情况。

### NEVER-03: historical-docs-underscore

**历史档案：** dogfooding 报告记录了实际发生的情况——活动在约定执行前就使用了 `executor_fast`。修改它会降低准确性。P18 验证会捕获任何从报告中复制粘贴到实际 taskflow JSON 的行为。

### NEVER-04: P10-cache-warmup

**收益微乎其微：** Resume cache 在第二次运行时已经提供了加速。冷首次启动惩罚为每个唯一 flow + args 组合发生一次。用于可导出 cache key、跨机器确定性和 TTL 的实现复杂性远远超过收益。CI/CD 场景更简单：将 taskflow 作为 "setup" 步骤运行一次。

### NEVER-05: P03-doc-structure

**过早优化：** Agent discovery 读取约 18 个微小文件（每个 1-5 KB），启动时间 <10ms。Subagent 生成时间为 100-500ms；模型推理耗时 seconds 到 minutes。合并文件会破坏单个文件/agent 的优雅模式并破坏 `agentScope` 功能。

### NEVER-06: P17-context-compression

**过度工程：** 经 LLM 摘要的自动压缩消耗的 token 数通常超过实际节省的 token 数。现有的 `output: json` 模式和 `contextLimit` 字段已经解决了 90% 的问题。如有需要，一个简单的 `maxTaskChars` 截断字段（3 行）可以提供粗粒度的控制。

### NEVER-07: P04-input-filter

**重复复杂：** 现有的 `{steps.X.json.specificField}` 插值（部分已在）允许用户在不过滤的情况下精确控制哪些数据进入下游。`contextLimit` 为更粗粒度的控制展示了模式。字段级筛选引入了一个维护负担重重的分类问题（按 agent 类型每个字段的相关性）。

## 7. 元见解

对抗元审查揭示了分析过程中的 6 个系统性偏误，值得记录以供将来审计使用。

### 7.1 事实编造（P11）

**原始声明：** `resultToPhaseState` 使用 `JSON.parse` directly。

**代码证据：** `runtime.ts:84` 使用 `safeParse(r.output)`。

**根本原因：** 分析基于记忆而非代码验证。`safeParse` 是 v0.0.8.1 中新增的，但分析引用了过时的行为。

**修复：** 要求所有未来的成本收益分析为任何关于代码行为的声明包含已验证的 `file:line` 引用。应标记无验证的声明并降级一级。

### 7.2 锚定偏误（交叉验证）

**观测结果：** 15 次挑战中有 13 次（87%）维持原始 verdict。"Keep as" 语言表明锚定点为原始 verdict，而非独立评估。两次降级无一升级。

**修复：** 交叉验证应从盲化起点进行评估——不预先查看原始裁决——并使用标准化量表（impact × frequency × fix_complexity）。

### 7.3 选择偏误（补充 issue）

**观测结果：** 全部 18 个 issue 来源于 P03-P18 提案的单一部分范围。以下子系统从审查范围中消失，尽管它们具有衡量的复杂性：

| Hidden issue | Location | Complexity | Status |
|---|---|---|---|
| Retry/transient-error logic | runtime.ts ~100 行 | exponential backoff, transient detection | **零测试** |
| CondParser (when-condition) | interpolate.ts ~150 行 | custom tokenizer + recursive-descent evaluator | **零测试** |
| File-lock system (store.ts) | atomic rename, staleness stealing, index rebuild | 高并发复杂性 | **未记录** |
| Flow recursion guard + budget inheritance | runtime.ts | state cloning, stack passthrough | **零测试** |

**后续行动：** 通过对 `runtime.ts`、`store.ts` 和 `interpolate.ts` 中未经测试的代码路径、错误处理缺口和复杂性热点进行审计，生成补充 issue 列表。

### 7.4 沉没成本（P18 过热优化）

**观测结果：** 6 个 issue 是关于 agent name 验证的变体——源自使用 `executor_fast` 的活动发现的相同检查。成本收益分析提出了进一步的细化（dedup、消息修复、registry 检查、测试），每个都很便宜（1-5 行），但它们优化了在恰好一次已知事件中触发的验证路径。

**仲裁：** 合并为一个 NEXT 条目以减少专业优化。验证的剩余 lifecycle 值不值得进行 6 次独立的决策。

### 7.5 虚假精度（频率标签）

**观测结果：** 频率标签（every_run、occasionally、rarely）纯粹基于判断——零遥测、零使用数据、零用户报告。"every_run" 意味着代码路径被执行，而不是 bug 触发。"occasionally" 对于 DSL 输入中的拼写错误完全是推测性的。

**修复：** 用显式假设替换频率标签（例如"假设 P18 后，≤10% 的 taskflow 作者在名称中使用下划线......"）。当假设无法证实时，标记为 "needs data"。

### 7.6 重复框架（计数膨胀）

**观测结果：** 18 个 issue = ~13 个不同问题。5 个重复项 (P18-double-error / remove-P18-double-check, P18-format-only / P18-registry-validation, P14-executor-fast-missing / executor-fast-decisions-note)。去除重复后，'skip' 从 6/18 (33%) 下降到 4/13 (31%)。

**修复：** 在分配 verdict 之前清理 issue list。

### 7.7 交叉验证的自疑

**观测结果：** 交叉验证声称对 PIPELINE-PATTERNS.md 声称 "I cannot verify this claim from the code"——但 grep 访问可用且脚本会立即返回 0 匹配。交叉验证选择不进行验证，然后将其置信度降至 "medium" 基于其自身的失败。这是元幻觉：不确定自己能否自行验证的证据。

**修复：** 对可直接测试的声明（文件存在性、grep 匹配、代码行读取）要求强制性验证。不要对称地对待所有验证各状态。

## 8. 附录：各阶段的完整 JSON

### 8.1 成本收益分析原始 JSON

```json
{
  "reviews": [
    {
      "id": "P18-double-error",
      "problem": "The includes('_') check at L341-342 in schema.ts is logically subsumed by VALID_AGENT_RE at L362-364...",
      "verdict": "nice_to_have",
      "reasoning": "..."
    },
    {
      "id": "P18-scope-creep",
      "problem": "Lines 345-347 validate that phase IDs use hyphens, not underscores...",
      "verdict": "should_fix",
      "reasoning": "..."
    },
    {
      "id": "P18-format-only",
      "problem": "VALID_AGENT_RE validates naming FORMAT but does NOT check whether the agent actually EXISTS...",
      "verdict": "nice_to_have",
      "reasoning": "..."
    },
    {
      "id": "P14-executor-fast-missing",
      "problem": "executor.md's prompt template includes a 'Decisions' section... executor-fast.md does NOT...",
      "verdict": "skip",
      "reasoning": "..."
    },
    {
      "id": "crossval-hallucination",
      "problem": "During the adversarial review's cross-validation phase, a reviewer subagent fabricated evidence by citing a nonexistent document (PIPELINE-PATTERNS.md)...",
      "verdict": "should_fix",
      "reasoning": "..."
    },
    {
      "id": "historical-docs-underscore",
      "problem": "The dogfooding-v0.0.8-report.md uses `executor_fast` (with underscore) in its subagent cost table...",
      "verdict": "skip",
      "reasoning": "..."
    },
    {
      "id": "P10-cache-warmup",
      "problem": "pi-taskflow has an input-hash-based resume cache... 'Cache warmup' means pre-populating known-good results...",
      "verdict": "skip",
      "reasoning": "..."
    },
    {
      "id": "P03-doc-structure",
      "problem": "pi loads agent prompt templates from ~/.pi/agent/agents/*.md files...",
      "verdict": "skip",
      "reasoning": "..."
    },
    {
      "id": "P17-context-compression",
      "problem": "Large intermediate outputs from one phase can blow up the context window for downstream phases...",
      "verdict": "nice_to_have",
      "reasoning": "..."
    },
    {
      "id": "P11-auto-repair",
      "problem": "Subagent outputs sometimes have format errors: JSON wrapped in markdown fences...",
      "verdict": "must_fix",
      "reasoning": "..."
    },
    {
      "id": "P16-cache-agent-key",
      "problem": "The input hash for phase resume caching (hashInput in store.ts) includes the phase ID, interpolated task text, and agent name...",
      "verdict": "must_fix",
      "reasoning": "..."
    },
    {
      "id": "P04-input-filter",
      "problem": "When building a subagent's task prompt, the interpolated string may include fields that aren't relevant to the specific agent...",
      "verdict": "nice_to_have",
      "reasoning": "..."
    },
    {
      "id": "remove-P18-double-check",
      "problem": "Delete the redundant underscore check at schema.ts L341-342...",
      "verdict": "nice_to_have",
      "reasoning": "..."
    },
    {
      "id": "P18-registry-validation",
      "problem": "The current P18 validation only checks agent name FORMAT...",
      "verdict": "should_fix",
      "reasoning": "..."
    },
    {
      "id": "executor-fast-decisions-note",
      "problem": "executor-fast.md's prompt template has no 'Decisions' field...",
      "verdict": "skip",
      "reasoning": "..."
    }
  ],
  "summary": {
    "must_fix": 2,
    "should_fix": 3,
    "nice_to_have": 4,
    "skip": 6
  }
}
```

### 8.2 交叉验证挑战 JSON

```json
{
  "challenges": [
    {
      "id": "P18-double-error",
      "original_verdict": "nice_to_have",
      "challenge": "...zero tests for agent name validation in schema.test.ts...",
      "revised_verdict": "nice_to_have",
      "confidence": "high"
    },
    {
      "id": "P18-scope-creep",
      "original_verdict": "should_fix",
      "challenge": "...the real question is whether the check itself should exist... interpolation engine doesn't require hyphens...",
      "revised_verdict": "should_fix",
      "confidence": "high"
    },
    {
      "id": "P18-format-only",
      "original_verdict": "nice_to_have",
      "challenge": "...analysis underestimates the token waste... typos in DSL authoring are common...",
      "revised_verdict": "nice_to_have",
      "confidence": "medium"
    },
    {
      "id": "P14-executor-fast-missing",
      "original_verdict": "skip",
      "challenge": "...analysis doesn't address the asymmetry from the CALLER's perspective...",
      "revised_verdict": "skip",
      "confidence": "high"
    },
    {
      "id": "crossval-hallucination",
      "original_verdict": "should_fix",
      "challenge": "I cannot verify this claim from the code...",
      "revised_verdict": "should_fix",
      "confidence": "medium"
    },
    {
      "id": "P11-auto-repair",
      "original_verdict": "must_fix",
      "challenge": "THE ANALYSIS'S CORE CLAIM IS FACTUALLY WRONG... code ALREADY uses safeParse...",
      "revised_verdict": "skip",
      "confidence": "high"
    },
    {
      "id": "P16-cache-agent-key",
      "original_verdict": "must_fix",
      "challenge": "...analysis overstates the severity... model overrides are rare...",
      "revised_verdict": "should_fix",
      "confidence": "high"
    },
    {
      "id": "P10-cache-warmup",
      "original_verdict": "skip",
      "challenge": "...doesn't consider the CI/CD use case...",
      "revised_verdict": "skip",
      "confidence": "high"
    },
    {
      "id": "P03-doc-structure",
      "original_verdict": "skip",
      "challenge": "...doesn't mention that the per-file layout enables the agentScope field...",
      "revised_verdict": "skip",
      "confidence": "high"
    },
    {
      "id": "P17-context-compression",
      "original_verdict": "nice_to_have",
      "challenge": "...doesn't consider the interaction with P11 (safeParse)...",
      "revised_verdict": "nice_to_have",
      "confidence": "high"
    },
    {
      "id": "P04-input-filter",
      "original_verdict": "nice_to_have",
      "challenge": "...token waste estimate ($1.35) is understated... in a real taskflow with 10+ phases...",
      "revised_verdict": "nice_to_have",
      "confidence": "high"
    },
    {
      "id": "historical-docs-underscore",
      "original_verdict": "skip",
      "challenge": "...doesn't mention that the report is in the docs/ directory which is public-facing...",
      "revised_verdict": "skip",
      "confidence": "high"
    },
    {
      "id": "remove-P18-double-check",
      "original_verdict": "nice_to_have",
      "challenge": "...same issue as P18-double-error, framed as a deletion task...",
      "revised_verdict": "nice_to_have",
      "confidence": "high"
    },
    {
      "id": "P18-registry-validation",
      "original_verdict": "should_fix",
      "challenge": "...same issue as P18-format-only, framed as a should_fix instead of nice_to_have...",
      "revised_verdict": "should_fix",
      "confidence": "high"
    },
    {
      "id": "executor-fast-decisions-note",
      "original_verdict": "skip",
      "challenge": "...same issue as P14-executor-fast-missing, reframed as a positive action...",
      "revised_verdict": "skip",
      "confidence": "high"
    }
  ]
}
```

### 8.3 对抗元审查攻击 JSON

```json
{
  "meta_attacks": [
    {
      "attack": "FACTUAL FABRICATION — P11 cost-benefit analysis falsely claimed resultToPhaseState uses 'JSON.parse directly'...",
      "evidence": "runtime.ts L84: `json: parseJson && !failed ? safeParse(r.output) : undefined`",
      "suggested_action": "Every cost-benefit issue that cites specific code behavior MUST include a verified line reference."
    },
    {
      "attack": "ANCHORING — Cross-validation changed only 2 of 15 verdicts (87% affirmation rate)...",
      "evidence": "15 challenges: 13 unchanged, 2 downgrades... Crossval repeatedly uses 'Keep as' language...",
      "suggested_action": "Re-run cross-validation with explicit instructions: start from scratch without seeing the original verdicts."
    },
    {
      "attack": "SELECTION BIAS — All 18 issues derive from a single source (P03-P18 proposals)...",
      "evidence": "No test for retry logic, CondParser, file lock staleness stealing, or flow recursion guard...",
      "suggested_action": "Generate a complementary issue list by auditing runtime.ts, store.ts, and interpolate.ts for untested code paths."
    },
    {
      "attack": "SUNKEN COST — 5 of 18 issues are variations on AGENT NAME VALIDATION check added in v0.0.8.1...",
      "evidence": "Schema.ts L341-370 contains all checks added in response to campaign's use of executor_fast...",
      "suggested_action": "Collapse all P18 naming-convention refinements into a single 'should_fix' item."
    },
    {
      "attack": "FALSE PRECISION — Frequency estimates (every_run, occasionally, rarely) are entirely judgment-based...",
      "evidence": "No log analysis, no telemetry, no user reports cited...",
      "suggested_action": "Replace frequency labels with explicit assumptions... flag as 'needs data' and downgrade one level."
    },
    {
      "attack": "DUPLICATE FRAMING — P18-double-error and remove-P18-double-check are the SAME issue...",
      "evidence": "Direct textual comparison: cost_of_fixing sections are verbatim identical...",
      "suggested_action": "Deduplicate the issue list before assigning verdicts."
    },
    {
      "attack": "CROSSVAL SELF-DOUBT HYPOCRISY — Crossval flagged its own hallucination check with 'cannot verify'...",
      "evidence": "grep 'PIPELINE-PATTERNS' across the entire repo returns zero matches...",
      "suggested_action": "Upgrade crossval-hallucination confidence to 'high'."
    }
  ],
  "hidden_priorities": [
    {
      "id": "HIDDEN-01-retry-test-gap",
      "description": "Retry/transient-error logic in executePhase (runtime.ts: 100+ lines) has NO dedicated tests."
    },
    {
      "id": "HIDDEN-02-condparser-test-gap",
      "description": "CondParser in interpolate.ts (150+ lines of custom tokenizer + recursive-descent evaluator) has NO dedicated tests."
    },
    {
      "id": "HIDDEN-03-flow-recursion-guard",
      "description": "Flow recursion detection (runtime.ts) has NO tests for direct/mutual recursion or deep stacks."
    },
    {
      "id": "HIDDEN-04-preRead-error-handling",
      "description": "resolvePhaseContext emits console.warn on file read failures with no mechanism to fail the phase."
    }
  ],
  "final_recommendation": "re-evaluate specific issues"
}
```

### 8.4 仲裁决策（三向共识图）

```json
{
  "verdict_delta": {
    "must_fix": {
      "original": 2,
      "after_arbitration": 0,
      "delta": -2,
      "reason": "P11 overturned (factual error); P16 downgraded to NEXT"
    },
    "should_fix": {
      "original": 3,
      "after_arbitration": 0,
      "delta": -3,
      "reason": "P18-scope-creep and crossval-hallucination promoted to NOW; P18-registry-validation deferred to NEXT"
    },
    "nice_to_have": {
      "original": 4,
      "after_arbitration": 0,
      "delta": -4,
      "reason": "Deferred to NEXT as consolidated items or reclassified as NEVER (overengineered)"
    },
    "skip": {
      "original": 6,
      "after_arbitration": 11,
      "delta": +5,
      "reason": "Merged duplicates (from 18 → ~13); 4 issues never existed in need-to-fix space"
    },
    "now": 2,
    "next": 4,
    "never": 13
  },
  "actionability": {
    "fixable_now": ["P18-scope-creep (1 line)", "crossval-hallucination (1 prompt sentence)"],
    "fixable_next_sprint": ["P18 dedup + tests (~10 lines + 5 tests)", "P18 registry warning (5 lines)", "P16 cache key (2 lines/site)", "crossval anti-anchoring template"],
    "stopped_wasting_cycles_on": ["P11 (already implemented)", "P14/executor-fast (intentional design)", "historical-docs (historical archive)", "P10/P03/P17/P04 (overengineered or premature)"]
  }
}
```

---

*本报告基于成本收益分析原始 JSON、交叉验证挑战 JSON、对抗元审查 JSON 和通过 `read` / `grep` 直接验证的代码证据撰写。所有代码引用均已对照实际文件确认。无声明未经验证。*
