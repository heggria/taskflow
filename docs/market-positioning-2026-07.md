# 全网竞品调研:taskflow 在 2026-07 的真实市场位置

> Research: 2026-07-07. Sources: Claude Code docs, Microsoft Conductor blog/repo,
> awesome-agent-orchestrators list (100+ projects), Augment Code's "9 Open-Source
> Agent Orchestrators", arxiv (MCP Workflow Engine), LangGraph/CrewAI comparisons.
> Fetched via `explore-cli`. Honest positioning — not marketing.

---

## 0. 一句话定位

**taskflow 处在一个极度拥挤的红海。** 它所在的细分赛道("声明式 DAG 编排引擎")
在 2026 年已经有 **Microsoft Conductor** —— 一个微软官方、MIT、能力几乎完全覆盖
taskflow 核心主张的竞品。**taskflow 的技术不输第一梯队,但没有微软的分发与背书,
这是一个"技术并列、市场危险"的位置。**

## 1. 赛道其实是三层 —— 大多数"竞品"和 taskflow 不在一个层

`awesome-agent-orchestrators` 列了 100+ 项目,但仔细分,它们分属三个完全不同的层:

### 第 1 层:会话并行器 / Session Runners(列表 80%+)
代表:crystal, claude-squad, agentbox, nimbalyst, vibe-kanban, constellagent,
thurbox, dmux, parallel-code, Agent Command Center…
- 核心:**在 git worktree 里并行跑多个 coding agent CLI 会话**(Claude Code / Codex / Gemini)
- 编排对象 = **进程/会话**,不是任务图
- **没有声明式 DAG、没有 phase 类型、没有 gate/tournament/loop**
- 是 TUI/dashboard 层,不是编排引擎层
- **→ 不是 taskflow 的直接竞品**(但抢同一批用户的注意力)

### 第 2 层:声明式 DAG 编排引擎(taskflow 真正的同类)
这是 taskflow 的战场,目前公开的玩家只有少数几个:

| 项目 | 背书 | 格式 | 核心主张 | taskflow 对比 |
|---|---|---|---|---|
| **Microsoft Conductor** | **微软官方** | YAML | 声明式 DAG、零token编排、`validate`、parallel/map/script/human-gate/loop、context tier、web dashboard、registry | **几乎完全覆盖 taskflow 主张**;多 Copilot 支持 |
| **bernstein** | 个人 | config | "Deterministic orchestrator, parallel agents, verifies with tests, **Zero LLM tokens on coordination**" | 同样主打零token + 确定性 |
| **tutti** | 个人 | config | "config-driven workflows, typed artifact flow between agents" | 类型化产物流 |
| **skillfold** | 个人 | YAML | "Configuration language + compiler for multi-agent pipelines, compiles YAML into agent skills" | 编译器视角 |
| **MCP Workflow Engine** | 论文 | JSON | "declarative workflow blueprint — JSON directed sequence of MCP tool calls" | MCP-native |

### 第 3 层:Swarms / 自治循环
代表:loki-mode(41 agents/8 swarms/9 quality gates), claude-flow, orc, guild, Hephaestus…
- 多 agent 协作框架,偏向**动态/自治**,常带 ralph-loop(跑到完成)
- 与 taskflow 部分重叠,但理念不同(动态 vs 声明式)

---

## 2. 直接威胁:Microsoft Conductor —— taskflow 的"镜像"

Conductor(2026-05 微软开源)和 taskflow 的主张**几乎一一对应**:

| taskflow 核心主张 | Microsoft Conductor |
|---|---|
| 声明式 DAG(JSON DSL) | ✅ 声明式 DAG(**YAML**) |
| 编排层零 token | ✅ "routing layer consumes zero tokens"(Jinja2 + expr eval) |
| 运行前验证(`verify`/`compile`) | ✅ `conductor validate` + dry-run |
| 上下文隔离 + 显式流 | ✅ 隔离 + **三种 context tier**(accumulate/last_only/explicit) |
| parallel + 动态扇出(`map`) | ✅ static parallel groups + `for each`(动态数组,批量并发) |
| `script` phase(零token shell) | ✅ script steps(shell,捕获 stdout/stderr/exit) |
| `approval`(人机交互) | ✅ human gates(Rich TUI **+ web dashboard**) |
| `loop`(循环/收敛) | ✅ loop-back / evaluator-optimizer(数百次) |
| flow library / search | ✅ workflow registries(团队共享 + version) |
| safety(budget / loop cap) | ✅ max iterations + wall-clock timeout |
| 多 provider/model | ✅ **Copilot + Claude**(per-agent) |
| 让 coding agent 帮写 flow | ✅ ships a Claude skill |
| **背书 / 分发** | ✅ **微软、MIT、microsoft/conductor** |
| **Web 可视化** | ✅ **实时 DAG dashboard**(点节点看 prompt/token/cost) |

> Conductor 在 taskflow 的**每一个核心主张**上都有对等能力,且多了:
> **微软背书、web dashboard、context tier、Copilot 集成**。

---

## 3. taskflow 在第 2 层里**仍然独有**的东西(真正的护城河)

把 Conductor/bernstein/tutti/skillfold 摆一起,taskflow **真正只有别人没有的**:

### 🥇 跨运行内容寻址缓存 + 增量重算(最硬的护城河)
- `cache` + `why-stale` + `recompute`:git/glob/file/env 指纹 → 内容寻址缓存 + TTL
- **Conductor / bernstein / tutti / skillfold 文档均未提及任何缓存机制**
- 这是 taskflow 唯一一个"别人完全没有、且工程上很难抄"的能力
- 价值:重跑类似任务时跳过未变 phase —— 长 audit / 迁移 / 研究场景的成本碾压

### 🥈 tournament(best-of-N + judge)
- 多个竞品变体 + 裁判选最优/聚合
- 其他第 2 层项目都是 agent/parallel/script/gate,**没有 first-class 的 tournament**
- 价值:需要"多角度起草 + 选优"的场景(规划、文案、方案对比)

### 🥉 嵌入 4 个 host 作为原生插件
- pi / codex / claude / opencode —— taskflow 编排的是**真正能读写文件、跑命令的 coding subagent**
- Conductor 是**独立 CLI 调 API agent**(文件操作要靠 MCP)
- 但这个差异在缩小(Conductor 也接 MCP + script steps)

### phase 类型更丰富
- taskflow 12 种（agent/parallel/map/gate/reduce/approval/flow/loop/tournament/script/race/expand）
- Conductor ≈ agent/parallel/script/human-gate(+ routes)
- 但 Conductor 的 `routes`(Jinja2 条件)很灵活,能模拟不少

> **诚实判断:护城河真实存在,但很窄。** 缓存是最硬的一块;tournament/多host是加分项。
> 如果 taskflow 不把"缓存 + 增量重算"做成**明显的、用户可感知的优势**,会被 Conductor 的分发碾压。

---

## 4. 定位结论

```
                         分发/背书/可见性
                              ▲
                  Conductor ●  │
                              │  ← 微软在这,taskflow 远在下方
                              │
        taskflow ●            │
                              │
   bernstein ●  tutti ●       │
                              │
   ───────────────────────────┼─────────────────────▶ 编排引擎深度
                              │
                              │     taskflow ●──── 接近顶端(12 phase + 缓存)
                              │     Conductor ●─── 也很高
                              │
```

- **引擎深度**:taskflow ≈ 第一梯队(和 Conductor 并列,phase 类型更丰富,缓存独有)
- **分发/背书**:taskflow **远远落后**于微软 Conductor
- **赛道拥挤度**:**红海**(100+ 项目,第 2 层已有 5 个声明式 DAG 引擎)

**一句话:taskflow 是一个"技术领先、但面临微软正面对标 + 赛道极度拥挤"的项目。**

---

## 5. 这对 0.1.7 / 未来方向意味着什么

三条可能的路(按激进程度):

### 路线 A:死守护城河 —— 把"缓存 + 增量重算"做成杀手锏
- 0.1.7 把 cache/why-stale/recompute 做成**一等公民 UX**:一个命令看清"什么变了、
  什么能复用、省了多少 token/钱",甚至和 Conductor 做个公开 benchmark。
- 定位语:"Conductor 重新跑一遍要全花 token;taskflow 只重算变的部分。"
- 风险:护城河窄,微软哪天加个缓存就没了。

### 路线 B:换战场 —— 不和 Conductor 比"引擎",比"嵌入 coding agent 的体验"
- Conductor 是独立 CLI;taskflow 是 pi/codex/claude/opencode/grok 里的**原生编排**。
- 0.1.7 投入"在 host 里用起来最顺"(更好的 TUI、`/tf:` 命令、和 host skill 融合、
  内置 deep-research/audit flow 让用户装完即用)。
- 定位语:"不是又一个 CLI,是你现在的 coding agent 长出来的编排能力。"
- 风险:第 1 层(session runners)也在抢这个位置。

### 路线 C:差异化品类 —— 走"可验证 + 可缓存的工作流"这个 Conductor 没占的细分
- taskflow 有 `verify`(零token静态分析)和 `cache`。把它俩绑成一个**新品类主张**:
  "the only orchestrator that **verifies before it spends, and remembers what it spent**"。
- 这避开了和 Conductor 在"声明式 DAG"上的正面参数对比,占一个心智位置。
- 这需要产品叙事 + 一个能演示这个差异的杀手级 flow(比如增量重跑 500 文件迁移)。

> **我的建议:路线 C 为主,B 为辅。** A 单独撑不住(护城河太窄),B 是执行层面,
> C 是唯一能建立心智壁垒的方向。0.1.7 的 feature 应该围绕"可验证 + 可缓存"讲故事
> 并配一个让用户**立刻感知到差异**的内置 flow。
