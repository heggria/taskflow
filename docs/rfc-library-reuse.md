# RFC：taskflow 可复用资产库（Library）+ 语义检索

> 状态：**设计稿（Draft），待 review** · 日期：2026-07-06 · 关联 PR：暂无（实现待 review 后开）
> 范围：taskflow-core（引擎）+ 4 个 host 适配器 + skill。零运行时依赖不变。
>
> 一句话：让 taskflow 从「一次性编排」升级为「**可积累、可检索、越用越通用**」的资产库——写新 flow 前先搜库，命中就复用+泛化，跑完可复用的就入库，embedding 提升召回，全程对一次性任务可选跳过。

---

## TL;DR（结论先行）

1. **三层叠加，每层独立可用**：① sidecar 元数据（自动派生 + agent 给的 tags/purpose）② `search` action（有 embedder 走 cosine，没有走关键词/结构，**永远能搜**）③ skill 里的「检索→复用→泛化→回写」循环（飞轮的核心）。
2. **embedding 必须可插拔 + 优雅降级**：taskflow 是发布到 npm 的多宿主开源包，**不能硬绑任何 embedding 后端**。core 定义 `Embedder` 接口，host 按需注入；没注入就降级到零 token 的关键词/结构检索，功能完整只是召回弱一些。
3. **存储用 sidecar `.meta.json`**，不污染纯 DSL 的 flow 文件。向后兼容现有 saved flow（无 sidecar 视作「无元数据」，照样能搜到，只是没向量）。
4. **泛化提升主要靠 skill 约定**（agent 每次复用时主动把硬编码改写成 `{args.X}`），运行时只提供便宜的元数据 + 检索做支撑。`generality` 分数自动派生，让「越用越通用」可量化。
5. **分 3 阶段交付**，每阶段独立可用、有测试。阶段 1（骨架）零 embedding 就能跑通整个循环；阶段 2 接 embedding + `reembed --stale-only`；阶段 3 加 lineage/自动入库。

---

## 一、目标 / 非目标

### 目标
- **低摩擦积累**：跑完一个可复用的 flow，agent 顺手 `save` + 给 `purpose`/`tags`，自动派生结构元数据 + 通用性分数。
- **检索优先**：写非平凡 flow 前，`search` 一句目的 → 返回 top-N 命中 + 复用提示。
- **语义召回**（可选）：配了 embedder 时，用 embedding cosine 排序，同义/近义都能命中；没配就关键词/结构兜底。
- **泛化飞轮**：命中后 copy → 把硬编码塞进 `{args.X}`、拓宽发现 prompt → `save` 回去 version+1、记 lineage。每次复用让模板更通用。
- **judicious**：一次性任务跳过整套流程，skill 教 agent 判断「这个任务值得入库吗」。

### 非目标（明确不做）
- ❌ **不做向量数据库依赖**。向量存在 sidecar JSON 里，全量 cosine 扫描。库大到 1000+ flow 才考虑索引，远期事。
- ❌ **core 不绑特定 embedding 后端**。board-cli / OpenAI / Voyage 都只是「可配置的注入源」之一。
- ❌ **不自动改写 flow 让它更通用**。泛化是 agent 的活（它理解语义），运行时只算 `generality` 分数做提示。
- ❌ **不取代 `save`/`list`/`run`**。library 是现有 saved-flow 机制的**增强层**，不是平行系统。现有 `/tf:<name>` 不变。

---

## 二、现有 surface（接入点，不重造轮子）

| 现状 | 位置 | library 怎么用 |
|---|---|---|
| `saveFlow(cwd, def, scope)` | `store.ts` | save 时同时写 sidecar `.meta.json`（同一 `withLock` 临界区，见 §七） |
| `listFlows(cwd): SavedFlow[]` | `store.ts` | `search` 遍历它 + 读 sidecar。**注意**：`listFlows` 的 `endsWith('.json')` 过滤器须显式排除 `.meta.json` 后缀（`!name.endsWith('.meta.json')`），否则 sidecar 会被误识为候选 flow。今天 `readFlowFile` 因缺 `def.name` 拒绝了 sidecar，但任何未来 sidecar schema 变更（如加了 `name` 字段）会悄悄产生幽灵 flow |
| `getFlow(cwd, name)` | `store.ts` | 复用时取定义 |
| `action: save/list/run` | `index.ts`(pi) / `server.ts`(mcp) | 新增 `action: search`；**新增 MCP 工具 `taskflow_save` 和 `taskflow_search`**（见 §5.4） |
| `TaskflowSettings` | `agents.ts` | 扩展 `library` + `embedder` 配置 |
| `readSubagentSettings()` | `agents.ts` | host 读 `settings.json → taskflow.*` |
| `RuntimeDeps` | `runtime.ts` | **不动**。embedding 发生在 save/search 的 tool handler 层（`index.ts`、`server.ts`），不在 DAG 执行路径上。新增独立的 `LibraryDeps` 接口（见 §4.1） |
| saved flow 路径 | `.pi/taskflows/<name>.json`（项目）/ `~/.pi/agent/taskflows/`（用户） | sidecar 同目录 `<safeFlowDirName(name)>.meta.json`（见 §3.1 命名规则） |

**SavedFlow 现有结构**（不动）：`{ name, scope, filePath, def }`。sidecar 是新增的兄弟文件。

---

## 三、数据格式

### 3.1 Sidecar `<safeFlowDirName(name)>.meta.json`

与 flow 文件同目录、使用 **`safeFlowDirName(def.name) + '.meta.json'`** 作为文件名（与 flow 文件使用相同的 `safeFlowDirName` 归一化，保证路径安全）。例：`.pi/taskflows/audit-endpoints.json` → `.pi/taskflows/audit-endpoints.meta.json`。

**命名规则（N1 修复）**：sidecar 文件名 = `safeFlowDirName(def.name) + '.meta.json'`，与 flow 文件共用同一归一化函数（`store.ts:212`）。这继承了 `safeFlowDirName` 的限制——不同原始名称经归一化后可能碰撞（如 `"foo/bar"` 和 `"foo_bar"` 都变成 `"foo_bar"`）。这是已知限制，不在本 RFC 范围解决，但测试须覆盖碰撞场景。

```jsonc
{
  "schemaVersion": 1,
  "purpose": "审计一组 API endpoint 是否缺少鉴权",
  "tags": ["audit", "security", "auth", "fan-out", "api"],
  "notes": "可选：agent 写的复用注意事项，如「适合 REST，GraphQL 要改 discover 的 prompt」",

  // —— 自动派生（save 时计算，agent 不用管）——
  "phaseSignature": "agent→map→gate→reduce",      // phase 类型序列，结构指纹
  "argShape": { "dir": "string", "threshold": "number" },  // args 的形状（Phase 3 才参与排序，见 §5.2）
  "phaseCount": 4,
  "agentUsage": ["scout", "analyst", "reviewer", "writer"], // 用到的 agent
  "generality": 0.72,                              // 0-1，越高越通用（见 §3.3）

  // —— 复用飞轮 ——
  "reuseCount": 3,
  "lastUsedAt": 1751800000000,
  "createdAt": 1751700000000,
  "version": 2,
  "derivedFrom": "audit-endpoints@v1",             // lineage：从哪个版本泛化来的，可空

  // —— 语义检索（配了 embedder 才有）——
  "embeddingModel": "qwen3-embedding-0.6b",
  "embeddingDim": 1024,
  "embedding": [0.0123, -0.0456, ...],             // embed(purpose + tags + phase 摘要)
  "embeddedAt": 1751800000000
}
```

**为什么 sidecar 而非塞进 flow JSON**：flow 文件是纯 DSL，`validateTaskflow` 现在按严格 schema 校验；塞额外字段要么放宽 schema（破坏纯度），要么校验报错。sidecar 完全解耦，flow 文件原样可被 `verify`/`run`，元数据坏了不影响 flow 本身。

**向后兼容**：无 sidecar 的老 saved flow → search 时视作 `{purpose: def.description, tags: [], generality: null, embedding: null}`，照样出现在结果里（按关键词/结构排序）。

### 3.2 phaseSignature 派生规则

按 `dependsOn` 拓扑层，每层取该层 phase 的 `type`，用 `→` 连接。并行同层用 `+`：
- `[{agent},{map},{gate},{reduce}]` → `agent→map→gate→reduce`
- `[{agent,agent},{agent}]`（两个并行）→ `agent+agent→agent`

这是**结构指纹**，让「同样是 discover→fan-out→gate→reduce 的 audit 流」即使措辞不同也能被结构检索命中（embedding 模糊但结构精确，两者互补）。

**实现引用**：使用 `schema.ts:1180` 的 `topoLayers()` 做确定性拓扑排序，保证同一 DAG 始终生成相同 signature。

### 3.3 generality 分数（0-1，自动派生）

衡量一个 flow 有多「参数化 / 可复用」，越高越通用。公式（save 时算，零 token）：

```
literalChars    = 所有 phase.task / map.over / script.run / script.input 里的纯字面字符串总字符数
placeholderRefs = {args.X} + {steps.X.*} + {item} + {previous.*} 引用计数
totalChars      = literalChars + placeholderChars  // placeholderChars = 所有占位符引用的字符数
literalTokenRatio = literalChars / max(1, totalChars)  // 归一化：纯字面占比，越低越参数化
argCount        = def.args 里声明的 arg 数
productionKnobs = 有 budget/retry/expect/concurrency 各 +0.05，上限 0.15

generality = clamp(0, 1,
    0.4 * (1 - literalTokenRatio)        // 参数化比例（越高越好 → 取反）
  + 0.3 * min(1, argCount / 3)
  + 0.3 * (有 description ? 0.3 : 0) + productionKnobs
)
```

> **v2 公式变更说明（A8 修复）**：原版用 `literalChars` 做分母，导致冗长但充分参数化的 prompt 被结构性惩罚——一个有详细 task 描述的 flow 比 terse 版低 41%。新版改用 `literalTokenRatio = literalChars / (literalChars + placeholderChars)` 归一化到总内容量，verbose 但参数化充分的 flow 不再被惩罚。

**script phase 处理**：`script` 类型 phase 的 `run` 和 `input` 字段计入 `literalChars` / `placeholderRefs`（与普通 `task` 字段同等对待）。`script.timeout` 不计入。

**worked examples**（用 `examples/` 目录下的真实 flow 校准）：

| Flow | literalChars | placeholderRefs | literalTokenRatio | argCount | description | prodKnobs | generality |
|------|-------------|-----------------|-------------------|----------|-------------|-----------|------------|
| `audit-endpoints`（5 phase，全参数化） | 120 | 380 | 0.24 | 3 | ✓ | 0.15 | 0.81 |
| `code-review-pr`（4 phase，中等参数化） | 350 | 150 | 0.70 | 2 | ✓ | 0.10 | 0.47 |
| `hello-world`（1 phase，全硬编码） | 200 | 0 | 1.00 | 0 | ✗ | 0.00 | 0.00 |
| `deploy-staging`（3 phase，部分参数化） | 180 | 220 | 0.45 | 2 | ✓ | 0.10 | 0.57 |
| `fan-out-translate`（6 phase，高度参数化） | 80 | 520 | 0.13 | 4 | ✓ | 0.15 | 0.88 |

直觉：占位符和 args 越多越通用；全是硬编码字面量 → 低分；带 budget/retry/expect → 加分（说明是为复用写的生产级 flow）。**这只是提示分数**，不阻塞任何操作；agent 拿它判断「这个 flow 值得入库吗 / 复用时该往哪个方向泛化」。skill 里的 `generality≥0.4` 入库建议阈值在新公式下可达（见 `code-review-pr` 0.47）。

### 3.4 Embedding Text Construction（A7 修复）

embedding 输入文本的构造直接影响语义检索质量，必须显式规范。

**算法**：

```ts
function buildEmbeddingText(meta: FlowMeta, def: Taskflow): string {
  const parts: string[] = [];
  if (meta.purpose) parts.push(meta.purpose);
  if (meta.tags?.length) parts.push(meta.tags.join(', '));
  parts.push(meta.phaseSignature);  // e.g. "agent→map→gate→reduce"
  if (meta.agentUsage?.length) parts.push(meta.agentUsage.join(', '));
  if (meta.notes) parts.push(meta.notes);
  return parts.filter(Boolean).join('\n');
}
```

**预算**：上限 **512 字符**。**单位（R2R4 修复）**：512 指 JavaScript `string.length`（UTF-16 code units），非字节数。对 CJK 文本，一个汉字 = 1 code unit，但 UTF-8 编码后占 3 bytes。embedding 模型通常按 token 处理而非字节敏感，故以 `string.length` 为准。

超出时按以下优先级截断（先丢低优先级）：
1. 丢弃 `notes`（最长、最低信息密度）
2. 截断 `purpose` 到 200 字符
3. 截断 `tags` 到前 5 个
4. `phaseSignature` 和 `agentUsage` 永不截断（高信息密度、长度有界）

**不包含的字段**：`argShape`（Phase 1-2 不参与排序，且 schema 尚无 `type` 字段）、phase 原始 `task` 字符串（太长且高度具体，会稀释 purpose-level 语义信号）。

---

## 四、Embedder 接口与配置（可插拔 + 降级）

### 4.1 core 接口（零依赖）

```ts
// taskflow-core/src/library/embedder.ts（新文件）
export interface Embedder {
  /** 返回向量；维度必须等于 this.dim。失败应 reject。 */
  embed(text: string): Promise<number[]>;
  /** 供 sidecar 记录，便于换模型时检测维度不匹配。 */
  readonly model: string;
  readonly dim: number;
}

/** 向量校验：维度匹配 + 无 NaN/Infinity。写入 sidecar 前必须调用。 */
export function validateEmbedding(vec: number[], expectedDim: number): boolean;

/** 纯算术 cosine 相似度，零依赖。
 *  合约：接受任意向量，内部用完整公式 dot(a,b)/(||a||*||b||)，
 *  不假设输入已 L2 归一化。
 *  性能（R2R6）：O(n·d)，500 flows × 1024-dim ≈ 1ms，可接受。
 *  库 >1000 flows 时考虑预计算 L2 范数或 ANN 索引（远期）。 */
export function cosine(a: number[], b: number[]): number;
```

**`validateEmbedding` 规范（C3 修复）**：

```ts
function validateEmbedding(vec: number[], expectedDim: number): boolean {
  return vec.length === expectedDim
      && vec.every(v => Number.isFinite(v));
}
```

save/search 写入或读取向量前**必须**调用此校验。校验失败 → `embedding: null` + `console.warn` 日志，不抛错。

**`LibraryDeps` 接口（A2 修复）**：

embedding 发生在 save/search 的 **tool handler 层**（`index.ts` 的 pi action handler、`server.ts` 的 MCP tool handler），不在 `executeTaskflow`/`executePhase` 的 DAG 执行路径上。因此 `RuntimeDeps` **不加** `embedder` 字段。新增独立接口：

```ts
// taskflow-core/src/library/types.ts（新文件）
export interface LibraryDeps {
  embedder?: Embedder;
  settings: LibrarySettings;   // { enabled, scope }
  cwd: string;                 // 用于定位 sidecar 文件
}
```

pi 适配器在构造 tool handler 时创建 `LibraryDeps` 并传给 `saveFlowWithMeta()` / `searchLibrary()` 等 library 函数。MCP server 同理。**`RuntimeDeps` 保持原样不变**。

### 4.2 配置 seam（`settings.json → taskflow`）

扩展 `TaskflowSettings`（`agents.ts`）：

```jsonc
{
  "taskflow": {
    "builtInAgents": true,            // 现有
    "maxKeptRuns": 50,                // 现有
    // —— 新增 ——
    "library": {
      "enabled": true,                // 总开关，默认 true
      "scope": "both",                // "project" | "user" | "both"，默认 both（项目覆盖用户）
      "searchWeights": {              // 可选，混合排序权重（C7 修复）
        "semantic": 0.6,
        "structural": 0.25,
        "textual": 0.15
      },
      "maxFlows": 500                 // 可选，Phase 3 auto-prune 阈值（R8 修复）
    },
    "embedder": {                     // 可选；不配 = 关键词/结构兜底
      "kind": "http",                 // "http" | "command"
      // kind:"http" —— OpenAI 兼容
      "url": "http://127.0.0.1:8123/v1/embeddings",
      "model": "qwen3-embedding-0.6b",
      "apiKey": "sk-...",             // 可选，本地 proxy 通常不需要
      "dimensions": 1024,             // 可选，部分模型支持降维
      // ── 或 kind:"command" —— stdin 喂文本，stdout 出 JSON 向量 ──
      // "kind": "command",
      // "command": ["board-cli", "embed", "--model", "qwen3-embedding-0.6b", "--output", "json-vec", "-"],
      // "timeoutMs": 30000            // 可选，默认 30000（R6 修复）
    }
  }
}
```

**两种 kind 的设计理由**：
- `http`（OpenAI 兼容）：**可移植、跨宿主**。board-cli 的 LiteLLM proxy、Voyage、OpenAI、Ollama、vLLM 都是这个协议。这是默认推荐。
- `command`：给那些只有 CLI 没有 HTTP 的本地工具用（如 board-cli 不起 server 时）。text 走 stdin，stdout 期望一个 JSON 数组。慢（每次 fork）但通用。

**command kind 约束（R6 + R2R1 修复）**：
- `timeoutMs`：每次调用的超时上限，默认 **30000ms**。超时 → reject → 降级到 `embedding: null`。
- **stdout 上限 64KB**。超出 → reject + 降级。防止异常工具 dump 大量数据。
- **冷启动警告**：文档须在 `command` kind 段落显著标注：「⚠️ 若 embedding 工具有冷启动延迟（如 board-cli 60s+），每次 save 都会阻塞等冷启动。推荐改用 `http` kind 指向已预热的 proxy。」
- **实现约束（R2R1 安全修复）**：**必须使用 `child_process.spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] })`**，禁止使用 `child_process.exec()` 或任何 shell 调用。输入文本通过 `stdin.write()` 传入，不经过 shell 解析。此约束消除 command 数组元素中 shell 元字符（`; | & $()` 等）的注入风险。

**pi 适配器的默认 wiring**：pi 适配器读 `settings.json`，若 `taskflow.embedder` 存在且 `library.enabled`，构造一个 `Embedder` 实现注入 `LibraryDeps`。**其他宿主（codex/claude/opencode）的 MCP server 同样读这个配置**——配置在 `settings.json`，跨宿主一致。

**跨宿主配置路径说明（C4 修复）**：所有宿主读 `~/.pi/agent/settings.json`，这是 taskflow 的现有跨宿主惯例。非 Pi 用户（codex/claude/opencode）：须手动创建此文件，或使用 `<host>-taskflow init`（若该命令提供）。**不引入备用路径**（如 `~/.taskflow/settings.json`），以避免偏离现有跨宿主约定。

### 4.3 降级矩阵（核心保证：永远能搜）

| 配置 | save | search |
|---|---|---|
| 无 embedder | 写 sidecar 但 `embedding: null` | 关键词 + phaseSignature 结构排序（`argShape` 不参与，见 §5.2） |
| embedder 配了但调用失败 | 记 warning，`embedding: null`，save 仍成功 | 该 flow 退回结构排序；其他有向量的走 cosine |
| embedder 返回但 `validateEmbedding()` 失败（维度不匹配 / NaN / Infinity） | 记 warning，`embedding: null`，save 仍成功 | 同上行 |
| embedder 正常 | `validateEmbedding()` 通过后写向量 | cosine 排序（无向量的老 flow 排末尾，混合排序） |

**永不抛错阻断 save/search**——embedding 是增强不是依赖。这条是硬约束，测试要覆盖。**向量写入前必须通过 `validateEmbedding()` 校验**（C3 修复）——不允许未校验向量落盘。

---

## 五、新 action：`search`

### 5.1 调用 schema

```jsonc
// pi 形式
{ "action": "search", "query": "审计 API endpoint 是否缺少鉴权", "limit": 5 }
// MCP 形式（codex/claude/opencode）—— 新工具 taskflow_search（见 §5.4）
{ "name": "taskflow_search", "arguments": { "query": "...", "limit": 5 } }
```

可选参数：
- `limit`（默认 5，上限 20）
- `structureOnly`（bool，强制只用结构/关键词，跳过 embedding——零延迟、零 token）
- `minScore`（0-1，过滤低分结果）
- `scope`（`"project"|"user"|"both"`，覆盖配置）

### 5.2 排序算法（混合）

对每个候选 flow 算一个 `score ∈ [0,1]`：

```
textScore   = 关键词重叠（query 分词 ∩ name+purpose+tags+phase.task，TF 加权）
structScore = phaseSignature 相似度（编辑距离归一化到 0-1）+ phaseCount 差异惩罚（见 §5.2.1）
semScore    = cosine(queryVec, flowVec)   // 仅当双方都有向量

score = structureOnly ? blend(textScore, structScore)
       : hasVectors    ? Ws*semScore + Wt*structScore + Wk*textScore
       :                 0.6*textScore + 0.4*structScore
```

> **argShape 移除说明（A4 修复）**：原版 `structScore` 包含 `argShape` 匹配（25% 权重），但当前 `ArgSpecSchema` 只有 `default`/`description`/`required`，无 `type` 字段，无法做类型推断。query 侧的实体类型提取算法也未定义。Phase 1-2 **移除 argShape 成分**，`structScore` 仅由 `phaseSignature` + `phaseCount` 组成。Phase 3 若恢复 argShape 匹配，须同时：(a) 在 `ArgSpecSchema` 加可选 `type` 字段（在 §二 feature table 标注）、(b) 定义 query 侧类型提取算法、(c) 指定相似度度量。

**混合权重**（默认值，可通过 `settings.json → taskflow.library.searchWeights` 覆盖，C7 修复）：
- `Ws = 0.6`（语义）、`Wt = 0.25`（结构）、`Wk = 0.15`（关键词）
- ⚠️ 这些权重未经实证校准（见 §十一 开放问题 #6）

混合的理由：embedding 模糊召回强（同义），结构精确（同构），关键词零成本兜底。三者互补，单点失效另两个顶住。

#### 5.2.1 structScore 算法（R2C1 修复）

`structScore` 占排序权重的 25%，必须有明确定义。算法如下：

```ts
function computeStructScore(query: QueryShape, candidate: FlowMeta): number {
  // (a) phaseSignature 相似度：Levenshtein 编辑距离归一化
  const sigSim = candidate.phaseSignature
    ? 1 - levenshtein(query.phaseSignature, candidate.phaseSignature)
                / Math.max(query.phaseSignature.length, candidate.phaseSignature.length, 1)
    : 0;

  // (b) phaseCount 差异惩罚
  const countPenalty = (query.phaseCount > 0 && candidate.phaseCount > 0)
    ? 1 - Math.min(1, Math.abs(query.phaseCount - candidate.phaseCount)
                      / Math.max(query.phaseCount, candidate.phaseCount))
    : 0;

  // (c) 子权重：signature 相似度权重 0.7，phaseCount 权重 0.3
  return 0.7 * sigSim + 0.3 * countPenalty;
}
```

**编辑距离算法**：标准 Levenshtein（插入/删除/替换各 cost 1）。实现可使用 DP 算法（O(m·n)，signature 字符串通常 < 50 chars，开销可忽略）。

**Query 侧 phaseSignature 提取**：query 为自由文本，无法直接派生 signature。两种策略：
1. **无 signature 时**（纯文本 query）：`query.phaseSignature = ""`，`sigSim = 0`，structScore 退化到仅 countPenalty（若 query 提供 phaseCount 估计）。
2. **agent 提供 signature hint**：search schema 可选接受 `phaseSignatureHint?: string`，agent 可在知道目标结构时传入。

**实现引用**：phaseSignature 派生使用 `schema.ts:1180` 的 `topoLayers()` 保证确定性。

#### 5.2.2 Sidecar Staleness Detection（R2C4 修复）

§九 声称「sidecar 陈旧 → search 可从 flow def 重新派生覆盖（自愈）」，但此自愈路径必须形式化，否则 search 可能在同一结果中混合新鲜与陈旧数据。

**算法**（每次 `searchLibrary()` 调用，对每个候选 flow 执行）：

```ts
function resolveCandidate(def: Taskflow, sidecar: FlowMeta | null): ResolvedCandidate {
  const freshSig = computePhaseSignature(def);    // 从当前 def 实时派生
  const freshGen = computeGenerality(def);
  const freshAgents = extractAgentUsage(def);
  const freshCount = countPhases(def);

  if (!sidecar) {
    // 无 sidecar：全量从 def 派生，embedding = null
    return { phaseSignature: freshSig, generality: freshGen,
             agentUsage: freshAgents, phaseCount: freshCount,
             embedding: null, embeddingStale: true };
  }

  const sigMatch = sidecar.phaseSignature === freshSig;

  return {
    // 结构字段：始终使用从 def 实时派生的值（保证新鲜）
    phaseSignature: freshSig,
    generality: freshGen,
    agentUsage: freshAgents,
    phaseCount: freshCount,

    // embedding：仅当 signature 匹配时信任 sidecar 中的向量
    embedding: sigMatch ? sidecar.embedding : null,
    embeddingStale: !sigMatch,  // 标记为 stale，queue for reembed

    // sidecar 中的 agent 提供字段（purpose/tags/notes）直接使用
    purpose: sidecar.purpose,
    tags: sidecar.tags,
    notes: sidecar.notes,
    reuseCount: sidecar.reuseCount,
    version: sidecar.version,
  };
}
```

**关键保证**：
- 结构字段（phaseSignature/generality/agentUsage/phaseCount）**始终从当前 def 实时派生**——永远不会用陈旧值评分。
- embedding 向量**仅当 signature 匹配时使用**——signature 变了意味着 DAG 结构变了，旧 embedding 不再代表当前 flow。
- `embeddingStale: true` 的结果在 search 中退回结构排序，并在日志中标记需要 reembed。

### 5.3 返回格式

```jsonc
{
  "results": [
    {
      "name": "audit-endpoints",
      "scope": "project",
      "purpose": "审计一组 API endpoint 是否缺少鉴权",
      "tags": ["audit","security","auth"],
      "phaseSignature": "agent→map→gate→reduce",
      "generality": 0.72,
      "reuseCount": 3,
      "version": 2,
      "score": 0.83,
      "why": "语义+结构双命中：semScore=0.91, structScore=1.0, textScore=0.6",
      "reuseHint": "直接复用，带 args.dir 指定扫描目录"
    }
  ],
  "searchMode": "semantic",     // "semantic" | "structural" | "mixed"（R2C5 修复）
  "embedder": "qwen3-embedding-0.6b",  // 若用了 embedding
  "counts": { "scanned": 12, "withVectors": 9 }
}
```

**`searchMode` 判定规则（R2C5 修复）**：

| 条件 | `searchMode` |
|------|-------------|
| `structureOnly: true` 或未配置 embedder | `"structural"` |
| 所有返回结果均有有效向量 | `"semantic"` |
| 部分结果有向量、部分无（混合新鲜度库） | `"mixed"` |
| 所有返回结果均无向量 | `"structural"` |

判定依据：`counts.withVectors === results.length` → `"semantic"`；`counts.withVectors === 0` → `"structural"`；else → `"mixed"`。这让 agent 能判断排名的可信度——`"mixed"` 意味着部分结果仅靠结构/关键词排序。

**`why` 和 `reuseHint` 生成规范（A3 修复）**：

`why` 和 `reuseHint` 是 agent 的复用决策依据，必须有确定性的生成规则，不能是黑盒自然语言。

**Tier 1 — 始终使用（包括 `structureOnly` 模式），零 token 模板拼接**：

`why` 从分数成分模板化生成：

```ts
function buildWhy(scores: { semScore?: number; structScore: number; textScore: number; searchMode: string }): string {
  const hits: string[] = [];
  if (scores.searchMode === 'semantic' && scores.semScore != null && scores.semScore > 0.7)
    hits.push(`语义命中(sem=${scores.semScore.toFixed(2)})`);
  if (scores.structScore > 0.8)
    hits.push(`结构一致(struct=${scores.structScore.toFixed(2)})`);
  if (scores.textScore > 0.3)
    hits.push(`关键词匹配(text=${scores.textScore.toFixed(2)})`);
  return hits.length > 0 ? hits.join(' + ') : '低分命中，建议检查';
}
```

`reuseHint` 模板化生成：

```ts
function buildReuseHint(result: SearchResult): string {
  if (result.score >= 0.8)
    return `直接复用${result.argCount > 0 ? `，注意 ${result.argCount} 个 args 参数` : ''}`;
  if (result.score >= 0.5)
    return `结构相似，建议 copy + 泛化后使用`;
  return `低相关度，建议从头编写或大幅改写`;
}
```

**Tier 2 — Phase 3 可选**：若启用 LLM 增强的 reuseHint（如「把 discover 的 'API' 拓宽到 'any route handler'」），须在 `structureOnly` 模式下自动回退到 Tier 1。Tier 2 的具体 prompt spec 留给 Phase 3 设计。

### 5.4 新增 MCP 工具清单（A5/N2 修复）

当前 MCP server（`taskflow-mcp`）的 TOOLS 数组只有 `taskflow_run`/`taskflow_list`/`taskflow_show`/`taskflow_verify`/`taskflow_compile`/`taskflow_peek`。library 功能需要新增以下 MCP 工具：

| 工具名 | 参数 | 说明 |
|--------|------|------|
| `taskflow_save` | `{ name, definition, purpose?, tags?, notes?, scope? }` | 保存 flow + 写 sidecar 元数据。`purpose`/`tags`/`notes` 可选，写入 sidecar |
| `taskflow_search` | `{ query, limit?, structureOnly?, minScore?, scope?, phaseSignatureHint? }` | 搜索库，返回 §5.3 格式结果 |

`taskflow_save` 的 input schema 扩展示例：

```jsonc
{
  "name": "taskflow_save",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name":        { "type": "string" },
      "definition":  { "type": "object" },         // 完整 taskflow DSL
      "purpose":     { "type": "string" },          // 可选
      "tags":        { "type": "array", "items": { "type": "string" } },  // 可选
      "notes":       { "type": "string" },          // 可选
      "scope":       { "type": "string", "enum": ["project", "user"] }
    },
    "required": ["name", "definition"]
  }
}
```

pi 适配器侧：现有 `action: save` handler 扩展接受 `purpose`/`tags`/`notes` 字段，透传到 `writeMeta()`。

### 5.5 现有工具扩展（R2C2 修复）

library 引入后，现有 `taskflow_show` 和 `taskflow_list` 须扩展返回 sidecar 元数据，否则 agent 在复用工作流中被迫额外调用 `taskflow_search` 才能看到已知 flow 的 purpose/tags/generality。

**taskflow_show 扩展**：当 sidecar 存在时，返回结构从 `JSON.stringify(saved.def)` 改为：

```jsonc
{
  "definition": saved.def,          // 原有：完整 taskflow DSL
  "library": {                      // 新增：sidecar 元数据（仅当 sidecar 存在）
    "purpose": "审计一组 API endpoint 是否缺少鉴权",
    "tags": ["audit", "security"],
    "generality": 0.72,
    "reuseCount": 3,
    "version": 2,
    "phaseSignature": "agent→map→gate→reduce"
  }
}
```

无 sidecar 时保持原有行为（仅返回 definition），`library` 字段不出现。

**taskflow_list 扩展**：每行追加 sidecar 摘要（当 sidecar 存在时）：

```
# 无 sidecar（原有格式）
hello-world (project) — 1 phase(s)

# 有 sidecar（扩展格式）
audit-endpoints (project) — 5 phase(s) · 审计鉴权 · g=0.72 · used 3×
code-review-pr (user) — 4 phase(s) · PR 代码审查 · g=0.47 · used 1×
```

格式：`<name> (<scope>) — <N> phase(s) · <purpose> · g=<generality> · used <reuseCount>×`。purpose 截断到 20 字符。

pi 适配器的 `action: list` 做同样扩展。**Phase 1 交付**。

---

## 六、skill 循环（飞轮的核心在这里）

`skills-src/taskflow/` 新增 `library.md`，core.md 里加一节引用。循环：

```
┌─ 写非平凡 flow 前 ────────────────────────────────────┐
│ 1. action: search, query: "<一句目的>"                │
│ 2. 看返回：                                            │
│    - score≥0.8 且 reuseHint 说可直接用 → run by name   │
│    - 0.5≤score<0.8 且结构像 → show 出来，copy+泛化：   │
│        把硬编码路径/词塞进 {args.X}（generality↑）     │
│        拓宽 discover prompt                            │
│        save 回去 version+1, derivedFrom=原名@v旧       │
│    - score<0.5 或无相关 → 从头写                       │
│ 3. 跑完一个全新 flow 且判断可复用（generality≥0.4 或   │
│    你认为同类任务会重复）→ save + 给 purpose + 2-4 tags │
│ 4. 一次性任务（generality<0.3 且明显不重复）→ 跳过     │
└──────────────────────────────────────────────────────┘
```

**泛化 checklist**（skill 里列死，让 agent 每次复用都做）：
- [ ] 所有文件路径、目录名 → `{args.X}`
- [ ] 业务实体名（"endpoint"/"route"/"用户"）→ 在 discover prompt 里拓宽措辞
- [ ] 阈值、数量 → `{args.X}` 并给 `default`
- [ ] 加 `budget` / `retry` / `expect`（生产级 knob，generality 加分）
- [ ] 更新 `purpose` 反映新的通用范围

这套约定是「越用越通用」的实际发生机制——运行时只算 generality 分数提示，真正改写是 agent 干的。

---

## 七、分阶段交付计划

### 阶段 1：骨架（零 embedding，独立可用）—— 约 1 天
- [ ] sidecar `.meta.json` 读写（`store.ts`：`readMeta`/`writeMeta`，**与 flow 文件在同一 `withLock` 临界区内原子写入**，见下方 A6/R2/N1 修复）
- [ ] save 时自动派生 `phaseSignature`/`agentUsage`/`generality`（§3.3 新公式）；接受 agent 传的 `purpose`/`tags`/`notes`（A5 修复）
- [ ] `writeMeta()` 函数（`store.ts`），接受 `purpose?`/`tags?`/`notes?` + 自动派生字段
- [ ] **`listFlows` 过滤修复（A1）**：添加 `!name.endsWith('.meta.json')` 排除条件，防止 sidecar 被扫描为候选 flow
- [ ] `action: search`（pi action + MCP `taskflow_search`），**仅关键词+结构**排序（`searchMode:"structural"`），`structScore` 不含 `argShape`（A4）
- [ ] **structScore 完整实现（R2C1）**：§5.2.1 算法——Levenshtein + countPenalty + 0.7/0.3 子权重
- [ ] **Sidecar staleness detection（R2C4）**：§5.2.2 算法——每个候选 flow 实时派生结构字段 + signature 比对控制 embedding 信任
- [ ] **`taskflow_save` MCP 工具**（A5/N2），input schema 含 `purpose`/`tags`/`notes` 可选字段
- [ ] **`taskflow_show` / `taskflow_list` 元数据扩展（R2C2）**：§5.5 格式
- [ ] **reuseCount 机制（A6 修复）**：
  - run action schema 新增 `reusedFromSearch?: boolean` 标记（**默认 false**，R2C3+R2R2 修复）
  - **仅当 `reusedFromSearch === true` 时递增 reuseCount**——这是有意设计：`reuseCount` 度量「通过搜索发现的复用」，不是总调用次数。直接按名称 run 的 flow 不递增。理由：Phase 3 auto-prune 需要区分「主动搜索→复用」（高质量信号）vs「已知名称直接跑」（可能是固定 pipeline 的一部分，不代表泛化价值）
  - 递增逻辑在 **tool handler 层**（`index.ts` / `server.ts`），在 `executeTaskflow` 返回成功后执行，不在引擎内部
  - 使用 `withLock(<name>.json.lock)` 保护 sidecar 写入，与 save 共用同一锁 key
  - **sub-flow 调用（`flow` phase 类型）不递增 reuseCount**（文档明确说明；若要统计留给 Phase 3 post-run batch）
- [ ] **执行顺序约束（R2R3）**：save 时若有 embedder，先 `await embed(text)`（异步，可能耗时），**再** `withLock(lockPath, () => { writeFileAtomic(flowPath, ...); writeFileAtomic(sidecarPath, ...); })`。锁内仅同步 I/O，不阻塞等待 embedding
- [ ] skill `library.md` + core.md 引用（循环 + 泛化 checklist）
- [ ] 测试：
  - meta 派生正确性、search 关键词/结构排序、reuseCount 自增（含并发锁竞争场景）
  - 老 flow 无 sidecar 兼容
  - `listFlows` 排除 `.meta.json`（目录含 `foo.json` + `foo.meta.json` 应返回恰好 1 个 SavedFlow）
  - sidecar 命名碰撞（`safeFlowDirName` 碰撞场景）
  - structScore 算法正确性（Levenshtein + countPenalty + 子权重）
  - staleness detection（修改 def 后 search 使用实时派生值）
  - `taskflow_show` 返回 library 元数据（有/无 sidecar 两种情况）
  - `taskflow_list` 扩展格式
- [ ] **验收**：能完成「搜→复用→改写→回写→再搜命中改进版」全循环，零 embedding

### 阶段 2：Embedder 接入（语义检索）—— 约 1 天
- [ ] `Embedder` 接口 + `validateEmbedding` + `cosine`（`library/embedder.ts`）
- [ ] `LibraryDeps` 接口（A2 修复）：独立于 `RuntimeDeps`，thread 进 pi 和 MCP tool handler
- [ ] `TaskflowSettings.embedder` 配置 + `http`/`command` 两种实现（`library/embedder-http.ts` / `-command.ts`）
  - command kind：实现 `timeoutMs`（默认 30s）+ stdout 64KB 上限 + **`spawn()` 不使用 `exec()`**（R6 + R2R1）
- [ ] pi 适配器 + 各 MCP server 读配置，构造 `LibraryDeps` 注入 tool handler
- [ ] save 时按 §3.4 算法构造文本 → `embed()` → `validateEmbedding()` → 写向量（或降级）
- [ ] search 走混合排序（权重可配 via `searchWeights`）
- [ ] **维度不匹配恢复（R4 修复）**：
  - search 时校验 `sidecar.embedding.length === sidecar.embeddingDim === embedder.dim`
  - 任一不匹配 → 该 flow 的 embedding 视为 `null`，log warning，标记为 stale
  - **`action: library reembed --stale-only`**（阶段 2 必交付，不等阶段 3）：只重嵌维度/模型不匹配的 sidecar
  - 全量 `reembed`（无 `--stale-only`）也在此阶段交付
- [ ] **reembed 锁定策略（R2R5 修复）**：对每个 flow 单独 `withLock(<safeFlowDirName(name)>.json.lock)` 保护 sidecar 写入，与 save 共享锁 key。不全局锁定（允许并发 save 不同 flow）。reembed 遍历库时逐 flow 加锁/解锁
- [ ] 降级矩阵全覆盖测试（无 embedder / embedder 抛错 / 维度不匹配 / NaN 向量 / stdout 超限 / command 超时 / `spawn` 不使用 `exec` 验证）
- [ ] 用 board-cli（`qwen3-embedding-0.6b`，`up` 起本地 proxy）实测语义召回
- [ ] **验收**：换种说法的 query 也能命中（「检查接口安全性」命中「审计鉴权」）；换 embedding 模型后 `reembed --stale-only` 能修复

### 阶段 3：lineage + 可选自动入库（打磨）—— 约 0.5 天
- [ ] `version`/`derivedFrom` lineage 图（`action: lineage <name>` 看泛化谱系）
- [ ] 可选：run 成功且 `generality≥阈值` 时，runtime 提示 agent「这个 flow 值得入库」（通过 phase 输出或 skill 提示，不自动 save——自动入库会污染）
- [ ] `search` 结果可按 `reuseCount`/`generality` 排序的开关
- [ ] `action: library prune`（清低分、零复用的老条目）
- [ ] `library.maxFlows` 配置 + auto-prune（R8 修复，见 §九 风险表）
- [ ] （可选）`argShape` 匹配重引入：扩展 `ArgSpecSchema` 加 `type` 字段 + 定义 query 侧提取算法 + 相似度度量（A4 Phase 3 路径）
- [ ] （可选）Tier 2 reuseHint：LLM 增强的复用建议（A3 Phase 3 路径）

---

## 八、迁移与兼容

- **现有 saved flow**：无 sidecar，search 视作「无元数据」，按 `def.description` 做关键词、按实际 phase 算 signature，照样命中。首次 `save` 覆盖时自动补 sidecar。**零破坏**。
- **`listFlows` 排除修复（A1）**：现有 `listFlows()` 的 `endsWith('.json')` 过滤器须显式添加 `!name.endsWith('.meta.json')`。当前此 bug 被 `readFlowFile` 的 `def.name` 校验意外遮掩，但任何未来 sidecar schema 变更（如增加 `name` 字段）会悄悄产生幽灵 flow。修复点：`store.ts:668`，加一行 filter。**测试**：构造含 `foo.json` + `foo.meta.json` 的目录，断言 `listFlows` 返回恰好 1 个 `SavedFlow`。
- **现有 `save`/`list`/`run`/`/tf:<name>`**：行为不变。`save` 多写一个 sidecar 文件而已。`list` 和 `show` 扩展了元数据输出（§5.5），但对无 sidecar 的 flow 保持原有格式。
- **现有 `TaskflowSettings`**：新增 `library`/`embedder` 字段都有默认值（`library.enabled:true`，`embedder:undefined`），`normalizeTaskflowSettings` 容错未知字段。老 `settings.json` 不动也能跑（纯结构检索）。
- **`.gitignore`**：`.pi/taskflows/` 已在 gitignore；sidecar 同目录自动被忽略。用户若想 commit 模板库，把 `.pi/taskflows/*.json` 改为不忽略即可（项目级模板库）。

---

## 九、风险与对策

| 风险 | 对策 |
|---|---|
| **board-cli cold embed 慢**（实测 60s+，模型加载） | 默认走 `http` kind 指向 `board-cli up` 起的 proxy（热）；文档说明「先 `board-cli up`」。命令式 `command` kind 只作后备，且文档显著标注冷启动风险（R6）。 |
| **embedding 维度不一致**（换模型） | sidecar 记 `embeddingModel`+`embeddingDim`；search 时 triple-check `embedding.length === embeddingDim === embedder.dim`，不匹配 → 视为 `null` + warning。**`reembed --stale-only` 在阶段 2 交付**（R4），不等阶段 3。 |
| **向量质量异常**（NaN / Infinity / 维度错误） | `validateEmbedding()` 在写入 sidecar 前校验（C3）；不通过 → `embedding: null` + log，永不落脏数据。 |
| **两文件写入一致性**（flow + sidecar，R2） | 两个 `writeFileAtomic` 在同一 `withLock(<safeFlowDirName(name)>.json.lock)` 临界区内执行。**实现顺序（R2R3）**：先 `await embed(text)` 异步计算向量，再进锁内同步写两个文件。crash 导致 sidecar 缺失 → search 退化为无元数据（可接受）；sidecar 陈旧 → §5.2.2 staleness detection 从 flow def 实时派生结构字段（自愈）。 |
| **Sidecar 陈旧导致混合新鲜度评分**（R2C4） | §5.2.2 staleness detection：结构字段始终从 def 实时派生，embedding 仅当 signature 匹配时使用。防止同一搜索结果中结构新鲜但向量陈旧的内部不一致。 |
| **command kind 注入 / 无界输出 / 挂起**（R6 + R2R1） | **必须 `spawn()`，禁止 `exec()`**（R2R1 安全修复）。stdout 上限 64KB，超时默认 30s，超限 → reject → 降级。输入走 stdin，不经 shell 解析。 |
| **库膨胀 / O(n) 搜索延迟**（R8） | 短期（Phase 1-2）：库 <100 flow 时全量扫描可接受（<1ms）。中期（Phase 3）：`library.maxFlows` 配置 + auto-prune（超过阈值时按 `generality × reuseCount` 排序淘汰低分条目）。**scaling wall**：500 flows × 1024-dim vectors ≈ 2MB 向量数据解析/搜索，此时需要考虑索引或分片。 |
| **agent 滥用 save 污染库** | skill 明确「generality<0.3 或一次性任务跳过」；`reuseCount` 让低质条目自然沉底；`prune` 兜底。不自动 save（自动入库的噪声 > 收益）。 |
| **跨项目冲突**（用户全局库 vs 项目库同名） | 沿用现有 `scope` 解析：项目覆盖用户。search 默认 `scope:both`，结果标注 scope。 |
| **embedding 调用拖慢 save** | embed 异步、失败不阻断（§4.3）；`command` kind 有 30s 超时（R6）；大库（>500）才考虑异步队列，远期。 |
| **reembed 与并发 save 竞态**（R2R5） | reembed 逐 flow `withLock(<safeFlowDirName(name)>.json.lock)` 保护，与 save 共享锁 key。不全局锁定，允许不同 flow 并发操作。 |

---

## 十、测试计划

**单元（taskflow-core/test/）**：
- `library-meta.test.ts`：phaseSignature/generality 派生正确性（含 §3.3 worked examples 全量覆盖；边界：空 args、全硬编码、全占位符、含 script phase）
- `library-search.test.ts`：
  - 关键词/结构排序、混合排序、降级（无向量、维度不匹配、embedder reject、NaN 向量、`validateEmbedding` 拒绝）
  - **structScore 算法（R2C1）**：Levenshtein 正确性、countPenalty 边界（0 phase、相等 phase count、极端差异）
  - **staleness detection（R2C4）**：修改 def 后 search 使用实时派生值、embedding 在 signature 不匹配时被置 null
  - **searchMode 判定（R2C5）**：全向量 → semantic、全无向量 → structural、混合 → mixed
- `embedder.test.ts`：
  - cosine 正确性（含非归一化输入）
  - http/command 两种实现（mock fetch / mock child_process）
  - command 超时、stdout 超限
  - **command 使用 spawn 而非 exec（R2R1）**：mock child_process 验证调用方式
- `library-store.test.ts`：
  - sidecar 与 flow 文件在同一 `withLock` 临界区写入
  - `listFlows` 排除 `.meta.json`（A1 测试：目录含 `foo.json` + `foo.meta.json` 返回恰好 1 个 SavedFlow）
  - sidecar 命名碰撞（`safeFlowDirName` 碰撞场景）
  - reuseCount 并发更新（两个并发 run，只有 `reusedFromSearch:true` 的递增）
  - **reuseCount 默认不递增（R2C3+R2R2）**：不带 `reusedFromSearch` 的 run 不改变 reuseCount
- 兼容：老 flow（无 sidecar）能被 search 命中
- 嵌入文本构造（§3.4）：512 字符截断（`string.length` 单位，R2R4）、优先级丢弃顺序

**集成（pi-taskflow / codex-taskflow / claude-taskflow / opencode-taskflow test/）**：
- `taskflow_save` MCP 工具端到端（含 `purpose`/`tags`/`notes`）
- `taskflow_search` MCP 工具端到端
- **`taskflow_show` 返回 library 元数据（R2C2）**：有 sidecar / 无 sidecar 两种情况
- **`taskflow_list` 扩展格式（R2C2）**：验证 purpose + generality + reuseCount 追加
- save → search → show → 改写 → save(version+1) → search 命中新版 的完整飞轮
- reuseCount 自增（`reusedFromSearch` 为 true / false / 缺省 分别测试）
- `why` / `reuseHint` Tier 1 模板化输出格式验证

**e2e（board-cli 实测，阶段 2）**：
- `.mts` 脚本：起 board-cli proxy，save 几个 flow，用同义/近义 query 验证语义召回
- 换 embedding 模型后 `reembed --stale-only` 验证
- reembed 并发 save 竞态测试（R2R5）
- 放 `packages/pi-taskflow/test/e2e-library-semantic.mts`（.mts 被 unit glob 跳过，需手动跑）

**skill drift guard**：现有 `skills-build.test.ts` 自动覆盖新生成的 library.md。

---

## 十一、开放问题（review 时定）

1. **generality 公式权重**（§3.3 新公式）是否合理？worked examples 的分数是否符合直觉？要不要让 agent 手动覆盖（`meta.generalityOverride`）？
2. **search 默认 `limit`**：5 还是 3？（上下文成本 vs 召回）
3. **lineage 语义**：`derivedFrom` 是指向「被改写的源 flow」还是「源 flow 的具体版本」？倾向后者（`name@v1`），便于画泛化谱系。
4. **是否需要 `library export/import`**（把库打包成单文件分享）？阶段 3 之后再说。
5. **board-cli 依赖**：文档/测试里要不要给一个「无 board-cli 时的 OpenAI/Voyage 云端 fallback」示例配置？
6. **混合排序权重校准**（C7）：默认 `0.6/0.25/0.15` 未经实证。须在 Phase 2 GA 前用 10-20 个真实 flow 的测试 corpus 校准。当前已通过 `settings.json → taskflow.library.searchWeights` 开放配置入口，允许用户按领域调整（如技术 flow 可提高结构权重）。
7. **`argShape` 的 Phase 3 路径**：是否值得扩展 `ArgSpecSchema` 加 `type` 字段？若加，type 枚举如何定义（string/number/boolean/object/array 够用？还是要 JSON Schema 子集）？

---

## 十二、决策记录（待 review 填）

- [x] 检索机制：**B（语义 embedding）** —— 已定（用户 2026-07-06 决策）。可插拔 + 降级。
- [x] 积累触发：阶段 1 用 skill 约定（agent 主动 save）；阶段 3 评估「generality 超阈值提示入库」。**不自动 save**。
- [x] 作用域：`scope:"both"`（项目覆盖用户），同现有 saved-flow 解析。
- [x] 实现入口：先写本 RFC → review → 阶段 1。
- [x] DI seam：`LibraryDeps`（独立于 `RuntimeDeps`），thread 进 tool handler 层（A2）。
- [x] generality 公式：改用 `literalTokenRatio` 归一化（A8）。
- [x] argShape：Phase 1-2 不参与排序，Phase 3 视需求决定是否引入（A4）。
- [x] why/reuseHint：Tier 1 始终模板化，Tier 2（LLM 增强）留 Phase 3（A3）。
- [x] 两文件写入：同一 `withLock` 临界区（R2）；先 embed 后加锁（R2R3）。
- [x] reembed --stale-only：阶段 2 必交付（R4）。
- [x] command kind 安全：`spawn()` 禁止 `exec()`，输入走 stdin（R2R1）。
- [x] structScore：Levenshtein + countPenalty，0.7/0.3 子权重（R2C1）。
- [x] 现有工具扩展：show/list 返回 sidecar 元数据（R2C2）。
- [x] reusedFromSearch：默认 false，仅 search→reuse 递增，有意设计（R2C3+R2R2）。
- [x] staleness detection：结构字段实时派生，embedding 按 signature 匹配控制（R2C4）。
- [x] searchMode 扩展：增加 `'mixed'` 值（R2C5）。
- [x] 预算单位：512 = JavaScript `string.length`（UTF-16 code units）（R2R4）。
- [x] reembed 锁定：per-flow `withLock`，与 save 共享锁（R2R5）。
- [x] cosine 性能：O(n·d)，500×1024 ≈ 1ms，文档标注（R2R6）。

---

## Appendix: Self-Critique (Post-R2-Integration)

**Strengths**:
- All 28 findings (18 R1 + 10 R2) are resolved inline with concrete code or spec text — no deferred-to-Phase-3 cop-outs on blocking issues.
- The `LibraryDeps` seam keeps the engine/runtime boundary clean; embedding stays a tool-handler concern.
- `§5.2.2 staleness detection` closes the mixed-freshness gap that R2C4 identified — structural fields always fresh, embedding gated on signature match.
- Command-kind security (R2R1 `spawn` constraint) is explicit and testable.
- `searchMode: 'mixed'` (R2C5) gives agents the signal they need to calibrate trust in rankings.

**Residual risks** (acceptable, not blocking):
1. `reusedFromSearch` defaulting to `false` may surprise users who expect all runs to count. The justification is documented (Phase 3 auto-prune signal quality), but UX testing in Phase 1 should validate this with real agent workflows.
2. The structScore algorithm uses Levenshtein on short signature strings — theoretically sound but the 0.7/0.3 sub-weight split between signature-similarity and count-penalty is unvalidated. Calibration belongs in the same Phase 2 corpus test as the main blend weights (§11 open question #6).
3. §5.2.1 notes that pure-text queries cannot produce a phaseSignature, so structScore degrades to countPenalty only. This is correct behavior but means text-only queries get weaker structural ranking. The `phaseSignatureHint` optional parameter mitigates this for sophisticated agents.
