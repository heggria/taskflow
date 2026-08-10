# Homepage v4 — Flagship Reset Plan

> **Status:** Proposed — supersedes homepage v3 for the 0.2.0 worktree.
> **Date:** 2026-07-10
> **Scope:** `website/` homepage (`/[lang]`) only.
> **Intent:** 不是修 v3；是整套打回，按更高一级的审美与产品叙事重做。

---

## 0. 先下结论

### 0.1 当前实现为什么还是丑

这不是「再 polish 一下」能救的问题，而是**页面语法本身错了**。

当前首页（已实现的 v3）仍然有以下根本问题：

1. **还是 docs 气，不是 flagship 气。**
   - 顶部还是 Fumadocs 的 docs 型 chrome：大搜索框、工具按钮、GitHub 图标同时抢注意力。
   - 用户第一眼像进了文档首页，不像进了一个被精心 art direct 的产品主页。

2. **Hero 是一条文案 + 一个组件，不是一个“世界”。**
   - 深色 stage 只是白纸上的一张黑卡片。
   - 它没有统治版面，没有形成品牌空间，只是“下面放了个 demo”。

3. **整页仍是典型 SaaS brochure 语法。**
   - 一块 Hero。
   - 一块 install。
   - 一块数字 strip。
   - 一块 cards。
   - 一块 compare table。
   - 一块 CTA。
   这套语法再干净，也还是“模板化企业软件官网”。

4. **高级感并没有建立，只是“简洁”。**
   - 几乎所有内容都被 1px border + rounded card 包住。
   - 大量等权模块平铺，缺少主次断崖。
   - 留白很多，但不是“有张力的留白”，而是“组件之间的空档”。

5. **文案攻击性大于权威感。**
   - `Your host chat is not a dump for subagents.` 记忆点强，但气质偏硬碰硬、偏营销挑衅。
   - 它不是“最贵的那种语气”，而是“最会吵的那种语气”。

6. **“The Collapse”作为唯一电影事件，概念过重。**
   - 它把整个首页绑死在一个 3 秒表演上。
   - 用户看完以后，后面的 install / cards / compare 立刻掉回 brochure 节奏。
   - 真正属于 0.2.0 的优势——**compile / resume / recompute**——反而没有成为第一视觉结构。

7. **动效策略还引入了工程层面的丑。**
   - 当前 `home-reveal` 把大量内容初始设为 `opacity: 0`，必须等交叉观察器触发才显示。
   - 这会导致首屏以下内容在某些 capture / preload /脚本异常情况下出现“大片空白带”。
   - 高级感的前提之一就是：**首帧就完整、稳定、可截图。**

### 0.2 新判断

v4 必须从：

> **“伤口营销 + 单一电影组件 + brochure section grammar”**

切到：

> **“authority-first 的产品雕塑 + 编译器叙事 + 极少但极准的交互”**

不是更凶，更黑，更大字。
而是：**更有统治力、更像系统、更像被设计过的工业品。**

---

## 1. 新北极星

## 一句话

**taskflow 0.2 是 coding agents 的 compiled runtime。**

不是“一个会动的 DAG demo”。
不是“一个 context-isolation feature page”。
而是：

- **verify before spend**
- **resume across sessions**
- **recompute only what changed**

## 视觉隐喻

**The Compiler Bench**

不是熔炉，不是粒子坍缩，不是赛博秀场。
而是一张**被校准过的工作台 / 控制台 / 仪表台**：

- 图是被声明和验证的
- 运行是被隔离和记录的
- 变化是被定位和最小重算的

这比 “Foundry / Collapse” 更贴近 0.2.0 的真实产品重心，也更高级。

## 情绪基调

| 维度 | v4 定调 |
|---|---|
| 气质 | 冷静权威、克制、精准 |
| 不是 | 挑衅、喊口号、做戏剧效果 |
| 视觉 | paper + graphite + rare brass |
| 品牌姿态 | 先证明自己是系统，再允许人想安装 |

## 硬规则

1. **Authority first, impulse second.**
2. **Product before metaphor.**
3. **一个首页只能有一个主空间。** 不是一堆 section 拼起来。
4. **凡是像 B2B 模板的模块，宁可删。**
5. **0.2.0 的主叙事必须回到 compile / resume / recompute。**
6. **context isolation 仍重要，但降级为系统结果，而不是整页唯一神话。**

---

## 2. 战略转向：v3 → v4

| 项 | v3 | v4 |
|---|---|---|
| 首页气质 | 痛点营销 + 单一 demo | 权威产品页 + 编译器世界观 |
| Hero 文案 | 伤口/对抗型 | 教义/能力型 |
| 产品舞台 | autoplay Collapse 卡片 | full-width Compiler Bench |
| 视觉主语 | 一张黑卡片 | 一个被设计的系统空间 |
| 页面语法 | brochure 分段 | architectural composition |
| 0.2 主轴 | context isolation | compile / resume / recompute |
| 证明方式 | 电影事件 + 功能块 | 一个系统台面 + 少量精确证据 |
| 安装 | 独立 section | docked install rail |
| 数字表达 | 1 / 0 / 5 / ∞→1 | 不做 billboard numerology |
| Compare | 大表格 | 极简差异 ledger 或并入文案 |
| 动效 | autoplay + reveal | user-led highlight + stable first paint |
| 顶部 chrome | docs 式 HomeLayout | home-specific chrome |

---

## 3. 访客应当在 15 秒内得到什么

### 15 秒

第一次进入的人应该能立即说出：

1. **这是个系统，不是个 prompt 技巧。**
2. **它先验证，再运行。**
3. **它能续跑，能重算变化部分。**
4. **中间过程不回灌宿主。**
5. **它已经跑在我熟悉的 host 上。**

### 60 秒

应该进一步理解：

1. 0.2 的本质不是“加了几个 phase type”，而是**运行时完成了编译器化转身**。
2. JSON / TS 只是 authoring surface，底层是一套 runtime contract。
3. 这不是另一个 workflow slogan，而是**可验证、可恢复、可增量的 orchestration runtime**。

---

## 4. 全页结构（新）

v4 不是把 v3 模块重排，而是**减少模块数量，重写层级**。

### 新顺序

1. **Home chrome**（自定义，不沿用 docs 栏的气质）
2. **Hero doctrine**（纯权威，不吵）
3. **Compiler Bench**（首页主雕塑，统治首屏）
4. **Install rail**（直接挂在 Bench 下，不单独起大 section）
5. **Three capabilities**（verify / resume / recompute，纵向三栏，非 cards）
6. **0.2 ledger**（像系统 release ledger，不像 feature grid）
7. **Authoring surface**（JSON / TS / FlowIR 单一 viewer，多视图切换）
8. **Difference ledger**（极简，不做大 compare table）
9. **Final CTA**（安静、强、短）

### 明确删除

以下内容从首页主结构中移除或降级：

- autoplay `CollapseStage`
- Replay 按钮
- `Runs where you already think` 独立 hosts row
- `1 / 0 / 5 / ∞→1` contract strip
- 大块 compare table
- 卡片式 era grid
- 首屏大搜索框式 docs chrome
- 大面积 JS-hidden reveal

---

## 5. 首屏总构图

### 核心判断

高级感来自**一个强构图**，不是很多干净组件。

### Desktop 构图（推荐）

```text
┌──────────────────────────────────────────────────────────────┐
│ home chrome                                                 │
├──────────────────────────────────────────────────────────────┤
│ left: doctrine copy           right: short authority note   │
│ H1 3 lines                    install/doc CTA               │
│ sub                                                           │
├──────────────────────────────────────────────────────────────┤
│                    FULL-WIDTH COMPILER BENCH                │
│          graph / host return / verify rail / recompute rail │
├──────────────────────────────────────────────────────────────┤
│ docked install rail (5 hosts switcher + command)            │
└──────────────────────────────────────────────────────────────┘
```

### Mobile 构图

- doctrine copy 先
- bench 完整纵向缩放，不拆碎
- install rail 紧接其下
- 绝不出现“首屏只有文案，产品舞台被挤到很下面”

### 首屏原则

1. **Bench 必须比现在大很多。**
2. **Hero 不能再是居中小文案 + 小按钮 + 小组件。**
3. **首屏必须能作为一张单独截图成立。**
4. **scroll 到第二屏之前，用户已经看到了产品的系统形态。**

---

## 6. Hero 文案策略（重新定锚）

### 结论

v4 不再用“伤口+教义”的挑衅型写法作为默认。

**默认改为纯教义 / 纯能力型。**

这是更高级的语气，也更匹配 0.2.0 的编译器定位。

### 推荐 Hero（锁定方案）

#### EN

- Eyebrow: `taskflow 0.2`
- H1 L1: `Verify before spend.`
- H1 L2: `Resume across sessions.`
- H1 L3: `Recompute only what changed.`
- Sub:
  `taskflow turns multi-agent coding work into a compiled runtime: declared graphs, isolated execution, deterministic replay, and incremental recompute across Pi, Codex, Claude Code, OpenCode, and Grok.`
- Micro doctrine:
  `Intermediates stay in the runtime. Only the result returns to the host.`
- CTA 1: `Read the docs`
- CTA 2: `Install`
- Text link: `GitHub`

#### ZH

- Eyebrow: `taskflow 0.2`
- H1 L1: `花 token 前先验证。`
- H1 L2: `跨会话续跑。`
- H1 L3: `只重算变化部分。`
- Sub:
  `taskflow 把多代理编程工作变成可编译的运行时：声明式图、隔离执行、确定性 replay，以及跨 Pi / Codex / Claude Code / OpenCode / Grok 的增量重算。`
- Micro doctrine:
  `中间过程留在运行时里。回到宿主的，只有结果。`
- CTA 1: `阅读文档`
- CTA 2: `安装`
- Text link: `GitHub`

### 为什么这样改

1. **更像产品 doctrine，不像痛点海报。**
2. **直接把 0.2.0 的三件大事摆到最上面。**
3. **把 context isolation 放回“系统结果”的正确位置。**
4. **英文与中文都更稳，不容易显得在吵架。**

### 备选（仅备胎）

如果后续觉得太理性，可以考虑：

- EN: `The compiler for agent workflows.`
- ZH: `面向 agent 工作流的编译器。`

但这更像 category line，感染力弱于三句 creed。

---

## 7. 首页主雕塑：Compiler Bench

### 7.1 定义

它替代 `CollapseStage`，成为首页真正的产品舞台。

**不是电影。是台面。**

### 7.2 组件名

`components/home/compiler-bench.tsx`

### 7.3 它必须同时表达的四件事

1. **Graph is declared**
2. **Runtime verifies before spend**
3. **Host receives only final result**
4. **Changes re-run only the stale frontier**

### 7.4 视觉布局

Bench 分四个功能区，但必须在同一块 dark surface 里完成：

#### A. Graph field（主视野）
- 中央偏左
- 9–12 个节点的真实 graph 形态
- 节点状态包含：pending / verified / cached / stale / running / final
- 不追求复杂；追求秩序与可读性

#### B. Host return panel（右上）
- 一小块干净的 host window
- 只有最终结果
- `finalOutput` label 保留，但更克制
- 不需要“被垃圾灌满再擦除”的戏剧

#### C. Verify rail（左下或下方第一列）
- 极小字 ledger
- 示例：
  - cycles: 0
  - dead ends: 0
  - budget: pass
  - refs: resolved
- 让“verify before spend”第一次变成可见对象

#### D. Recompute rail（右下或下方第二列）
- 示例：
  - changed inputs: 1
  - stale frontier: 2 nodes
  - reused from cache: 7
  - re-spend: minimal
- 让 0.2.0 的差异化第一次可视化

### 7.5 交互策略

默认**不 autoplay**。

Bench 应该是：

- 首帧就完整成立
- hover / tap 某个 capability label 时，对应区域高亮
- 可选 1 次极短线条 trace（300–500ms）作为入场礼，不依赖它讲故事

#### 状态标签（建议）

- `verify`
- `run`
- `recompute`

这些不是 tab 切页，而是 spotlight：

- hover `verify` → graph 和 verify rail 提亮
- hover `run` → host return 与 active edge 提亮
- hover `recompute` → stale frontier 与 cache metrics 提亮

### 7.6 把旧 Collapse 怎么处理

旧的“中间态被抹掉，只剩答案”不必完全消失，但**降级**为 Bench 内 `run` spotlight 的一个局部状态变化。

也就是说：

- `Collapse` 不再是首页概念中心
- 它只是 Bench 里一个很短的 micro proof

### 7.7 为什么这样更高级

因为真正贵的设计不是“给你演一段”，而是：

> **你一眼就相信这是一个系统。**

---

## 8. Install rail（挂靠，不独立）

### 结论

安装不能再变成单独的大段内容块。

它应该像**工作台下沿的一条 docked control rail**，直接服务首屏转化。

### 形式

- 5 host segmented control：`Pi / Codex / Claude Code / OpenCode / Grok`
- 当前 host 对应安装命令
- 复制按钮
- 相关 guide 文本链接（轻量）

### UI 原则

- 不要大圆角 pill tabs
- 更像精密控制件：低矮、紧凑、对齐工整
- 不做额外“Same graph, any host”大卡片陪衬

### 文案建议

- Title EN: `Install on the host you already use.`
- Title ZH: `装到你已经在用的宿主上。`

或者直接不单独写标题，只用 rail 自身完成说明。

### 命令源

命令必须继续以 `README.md` 为准：

- Pi: `pi install npm:pi-taskflow`
- Codex: `codex plugin marketplace add heggria/taskflow` + `codex plugin add taskflow@taskflow`
- Claude Code: `claude plugin marketplace add heggria/taskflow` + `claude plugin install claude-taskflow@taskflow`
- OpenCode: `opencode mcp add ...`
- Grok: 当前 guide 为准

---

## 9. 三大能力区：不用卡片，用秩序

### 标题

#### EN
`A runtime, not a prompt ritual.`

#### ZH
`这是一套运行时，不是一次 prompt 仪式。`

### 结构

三栏，使用垂直 hairline 分隔，不使用三张卡片。

| 栏 | EN | ZH |
|---|---|---|
| 1 | Verify | 验证 |
| 2 | Resume | 续跑 |
| 3 | Recompute | 重算 |

### 每栏内容（示意）

#### Verify
- `Static checks before any model call.`
- cycles / dead ends / dangling refs / impossible budgets

#### Resume
- `Runs survive failure and survive sessions.`
- detached / cross-session / trace / replay

#### Recompute
- `Only the affected frontier runs again.`
- content-addressed cache / why-stale / minimal rerun

### 为什么不能再用 card

因为 cards 会把这三件事降格成“并列 feature list”。
而它们在 0.2.0 里不是 feature list；它们是**runtime contract**。

---

## 10. 0.2 section：改成 ledger，不做 grid

### 旧问题

v3 的 `0.2 — the runtime became a system` 虽然方向比 changelog 好，但实现成 6 张小卡片，仍然是 brochure。

### v4 做法

改成**release ledger / system ledger**。

### 标题

#### EN
`0.2 is the compiler turn.`

#### ZH
`0.2 是编译器转身。`

### 副标题

#### EN
`The graph is no longer just run. It is compiled, resumed, replayed, and incrementally recomputed.`

#### ZH
`图不再只是被运行；它开始被编译、被续跑、被 replay、被增量重算。`

### 内容形式

不要 6 张等权卡片。
改为 6 行 dense ledger：

| tag | line |
|---|---|
| S4 | TypeScript DSL compiles to FlowIR |
| Core | verify / trace / replay / detached runs |
| Cache | content-addressed cross-run reuse |
| Recompute | why-stale + minimal frontier rerun |
| Hosts | Pi / Codex / Claude Code / OpenCode / Grok |
| Runtime | intermediates isolated; final result returned |

### 视觉风格

- 左窄右宽
- 左侧 mono tag
- 右侧一句干净解释
- 行与行之间用 hairline，不用 box 包起来

---

## 11. Authoring surface：从“双窗”改成“单体多视图”

### 旧问题

JSON / TS 两个并排 code window 太像教程区，太像 DevRel 栏目。

### 新方案

**一个 viewer，三种 surface：**

- `JSON`
- `TypeScript`
- `FlowIR`

### 为什么必须加 FlowIR

因为 v4 的主叙事已经回到“compiled runtime”。
只展示 JSON / TS，仍然像“两个写法”。
加入 FlowIR，用户才会真正理解：

> 上层 authoring 不同，底层 contract 统一。

### 形式

- 左：代码 viewer
- 右：annotations / key invariants
- 或者上方切换，下面一块宽 viewer

### UI 原则

- 不浮、不漂、不双开窗比赛
- 不追求炫技染色
- 更像精确样本台

---

## 12. Difference section：极简，不做 compare table

### 旧问题

大 compare table 容易立刻掉回 B2B SaaS 模板。

### v4 做法

只保留一个极简 difference ledger。

### 标题

#### EN
`What changes when the graph is data.`

#### ZH
`当图成为数据，事情会怎么变。`

### 4 行就够

| 维度 | taskflow | ad-hoc |
|---|---|---|
| plan | declared and versioned | re-derived in prose |
| spend | verified first | discovered during execution |
| failure | resumed | restarted |
| change | minimally recomputed | broadly rerun |

### 样式

- 不用大 check / minus 图标
- 不用反色大表头
- 只用线、字重、对齐建立秩序

如果排版后仍显模板感，**宁可删掉整段**。

---

## 13. Final CTA：安静地收，不再吼

### 方向

CTA 不再是“二次痛感宣判”。

更高级的做法是：**像一句总结，而不是最后再营销一次。**

### 推荐 copy

#### EN
- Title: `Build the graph once. Rerun it precisely.`
- Body: `Verify before spend. Resume across sessions. Return only the result.`
- Primary: `Read the docs`
- Secondary: `Install`

#### ZH
- Title: `图只搭一次，之后精确重跑。`
- Body: `先验证，能续跑，只把结果带回宿主。`
- Primary: `阅读文档`
- Secondary: `安装`

### 视觉

- 不做超重黑底大 billboard
- 可以是低对比深带，或与 hero 呼应的 paper-dark band
- 高级感靠节制，不靠最后一拳

---

## 14. 视觉系统（重写）

## 14.1 颜色

### 原则

- 不用纯白，不用纯黑
- light mode 走 **paper**，dark stage 走 **graphite**
- accent 从亮橙降为**brass / ember**，降低“提醒感”，提高“材料感”

### 建议 token

| token | value | role |
|---|---|---|
| `--home-paper` | `42 18% 97%` | 页面底纸 |
| `--home-ink` | `220 10% 11%` | 正文主字 |
| `--home-muted` | `220 6% 42%` | 次字 |
| `--home-rule` | `220 10% 86%` | hairline |
| `--home-surface` | `42 14% 99%` | 浅层面 |
| `--home-bench` | `220 12% 7%` | 主舞台 |
| `--home-bench-fg` | `40 18% 95%` | 舞台文字 |
| `--home-brass` | `28 46% 52%` | 稀有强调 |

### accent 使用规则

只允许用于：

1. Bench 中 active path / verified state / recompute delta
2. Copy success / tiny success mark
3. 极少数 CTA focus ring

不允许用于：

- section 标题渐变
- 到处发光
- card 边框到处上色
- 全页按钮同色抢戏

## 14.2 字体与排版

### 方向

不靠花哨字体取胜，靠：

- display 的尺度
- 字重悬崖
- 行宽控制
- 微文案的 mono discipline

### 规则

| 角色 | 规格 |
|---|---|
| Hero display | 3-line，`font-weight: 600`，`line-height: 0.98–1.04`，tracking 微负 |
| Section title | 2.1–2.8rem，600 |
| Body | 1rem–1.06rem，400，`max-width: 34–38rem` |
| Micro mono | 11–12px，全页只在 label/tag/rail 中使用 |

### 新原则

- 不再把所有按钮都做成 pill
- 不再把所有标题都居中
- 不再让所有模块同样重、同样圆、同样白

## 14.3 形体语言

| 元素 | 规则 |
|---|---|
| Button | 10–12px radius，非 pill |
| Surface | 能不用卡片就不用卡片 |
| Card | 仅在确有容器需求时使用 |
| Rules | hairline 是主组织工具 |
| Shadow | 极少、极软，只给 Bench |

## 14.4 间距

### 旧问题

当前页面有很多“看起来空”的高度，不是高级，是模块之间的真空。

### v4 规则

- 每一屏都必须有明确视觉重心
- section 之间的距离依内容密度定，不机械复用 `py-24`
- Bench 下沿与 install rail 之间距离要短，形成一个整体
- 第二屏不允许再出现大片无主留白

---

## 15. 动效系统（收敛）

## 15.1 结论

v4 的动效要从“舞台表演”退回“阅读辅助”。

## 15.2 允许

- Bench 的小范围 spotlight
- 一次性 path trace（可选）
- host install rail 的 copy 成功状态
- 轻量 enter（从已可见基线做 4–8px 位移）

## 15.3 禁止

- autoplay 整段电影
- Replay 按钮
- 全局 hover lift
- blur-heavy reveal
- 依赖 JS 才看得到正文
- 无限循环演出

## 15.4 重要工程规则

**首帧可见性优先于动效。**

也就是说：

- 任何正文 section 默认都应 visible
- JS 只能做 enhancement，不能做 reveal gating
- `prefers-reduced-motion` 下所有内容都应静态完整成立

---

## 16. Home chrome：必须脱离 docs 样子

### 这是 v4 的关键变更之一

如果首页继续沿用 Fumadocs 的重搜索框顶栏，它无论多干净，都还是 docs frontpage。

### v4 要求

首页使用 **home-specific chrome**：

- 左：`taskflow`
- 中/右：`Docs` / `Examples` / `GitHub`
- theme / locale 保留，但更轻
- 搜索不以大框形式压在 hero 上方

### 备注

docs 页面仍可继续用 Fumadocs 标准 chrome。
但 homepage 不能再被 docs UI 气质绑架。

---

## 17. 文件与组件计划

## 17.1 新建 / 重写

| 文件 | 动作 | 说明 |
|---|---|---|
| `docs/internal/homepage-v4-plan.md` | 新建 | 本文档 |
| `website/app/[lang]/page.tsx` | 重写 | 结构、copy、homepage shell |
| `website/app/globals.css` | 重写 home 部分 | tokens / layout / rail / bench |
| `website/components/home/compiler-bench.tsx` | 新建 | 替代 collapse-stage |
| `website/components/home/install-rail.tsx` | 新建或重构 | 替代 install-strip 的视觉语法 |
| `website/components/home/home-header.tsx` | 新建 | homepage 专属 chrome |
| `website/components/home/era-ledger.tsx` | 新建 | 0.2 ledger |
| `website/components/home/authoring-switcher.tsx` | 新建 | JSON / TS / FlowIR |
| `website/components/home/difference-ledger.tsx` | 新建 | 极简差异区 |

## 17.2 退役 / 移出首页

| 文件 | 动作 | 说明 |
|---|---|---|
| `website/components/home/collapse-stage.tsx` | 从首页移除 | 可保留做实验或 docs 素材，但不是 homepage 主舞台 |
| `website/components/home/hosts-row.tsx` | 移除 | 独立 hosts row 不再需要 |
| `website/components/home/reveal.tsx` | 首页停用或重写 | 不再允许 default hidden SSR baseline |

## 17.3 结构性调整

| 项 | 结论 |
|---|---|
| `HomeLayout` | 不再作为首页主气质来源；可保留框架能力，但 chrome 需改写 |
| metadata | 保持当前 SEO 思路，但文案同步新定位 |
| i18n | EN / ZH 完全对等 |

---

## 18. 需要明确删除的旧实现习惯

1. 居中 Hero + 下面放一个 demo 卡片
2. section-by-section brochure cadence
3. 所有东西都 rounded-2xl
4. 所有信息都 boxed
5. 大量轻灰边框卡片
6. billboard numerology（1 / 0 / 5 / ∞→1）
7. compare 大表格
8. autoplay movie
9. docs search bar 压英雄区
10. JS-hidden reveal 首屏以下正文

---

## 19. 验收标准（v4）

## 19.1 审美层

- [ ] 首屏单独截图即可成立，像旗舰，不像 docs 首页
- [ ] 首页不再由一堆 box 组成
- [ ] Bench 是“世界”，不是“组件”
- [ ] 不再出现明显的 SaaS 模板语法
- [ ] 没有多余 billboard 数字和 compare 噪声

## 19.2 叙事层

- [ ] 15 秒内用户能复述 verify / resume / recompute
- [ ] 用户知道 intermediates stay in runtime, only result returns
- [ ] 用户知道它已经运行在 5 个 hosts 上
- [ ] 用户理解 0.2 的升级不是 changelog，而是 compiler turn

## 19.3 工程层

- [ ] full-page screenshot 没有大段空白 reveal bug
- [ ] `prefers-reduced-motion` 下完整成立
- [ ] 375px / 768px / 1440px 都有构图
- [ ] `npm run build` 通过
- [ ] 无 console error
- [ ] EN / ZH copy 对等

---

## 20. 执行顺序（等你 GO 后）

### Phase A — architecture reset
- home-specific chrome
- hero new copy
- page structure rewrite

### Phase B — Compiler Bench
- component skeleton
- state spotlight
- reduced motion

### Phase C — Install rail + capabilities
- host switcher
- command validation
- three-column runtime contract

### Phase D — ledger surfaces
- 0.2 ledger
- authoring switcher
- difference ledger

### Phase E — polish
- spacing pass
- capture pass
- 375 / 1440 QA
- metadata + i18n cleanup

---

## 21. 最终裁决

**v3 的问题不是不够努力，而是努力方向仍是“把 SaaS landing 做得更干净”。**

v4 必须承认：

> taskflow 0.2 最强的不是“一个漂亮的 collapse 动画”，而是它已经有资格把自己呈现成一个 compiled runtime。

所以首页应该像：

- 一张被校准过的工作台
- 一套可验证的系统
- 一种高密度但不喧哗的 authority

而不是：

- 一个 demo 组件
- 若干功能卡片
- 一套更干净的 brochure

---

## 22. 你的确认口令（建议）

你如果认可这个方向，直接回复：

- `按 v4 方案执行`

如果你要加限制，可以说：

- `按 v4 方案执行，不要 autoplay，首页要自定义 chrome`
- `按 v4 方案执行，Hero 用 compiler category line，不用三句 creed`

---

*End of plan. This document supersedes `docs/internal/homepage-v3-plan.md` for the 0.2.0 homepage direction.*
