# Brainstorm: taskflow 0.2.0 更强的 Phase 类型

> Status: **Brainstorm 存档** · 2026-07-08
> 方法：会话式发散，锚定在 [`rfc-0.2.0-architecture.md`](../rfc-0.2.0-architecture.md) 已拍板的
> **事件溯源 + FlowIR 执行内核**（Q2=B / Q5=own）之上。
> 关联：[`design-dynamic-dag-expansion.md`](./design-dynamic-dag-expansion.md)（`expand` 的前身设计+对抗评审）、
> [`brainstorm-2026-07-frontier-council.md`](./brainstorm-2026-07-frontier-council.md)（旧的 white-space / 明确不做清单）、
> [`design-org-supervision.md`](./design-org-supervision.md)（`escalate`/supervision 的相关设计）。
>
> **核心角度**：这轮不是重提旧点子。0.2.0 换成事件溯源内核后，**一批以前"因架构风险被否/推迟"的
> phase 变便宜、变安全了**。本文按"新内核新解锁什么"重新审视 phase 设计空间。

---

## 0. 组织论点：新内核改变了 phase 设计的成本

**证据（决定性）**：动态 DAG 展开（`flow{def}` / self-expand）当年被对抗评审砍到只做"嵌套子流程"版——真正强大的"把动态节点 graft 进父 DAG"被推迟，因为它在**命令式内核**里有 3 个 P0：

1. crash 后注入丢失（持久化竞态）
2. 三态就绪判定不清（"依赖没跑" vs "依赖跑失败"）→ `join:"any"` 误 skip / 死锁
3. 并发中改 `def.phases` 数组

**而这 3 个 P0，正是事件溯源内核天生解决的**：

| 命令式内核的 P0 | 事件溯源内核如何天然治好 |
|---|---|
| ① 持久化竞态 | event log 就是持久化；注入 = 追加事件，无竞态 |
| ② 三态就绪 | fold 从事件流天然区分 done/failed/pending |
| ③ 并发改数组 | driver 定点从 folded 状态重算 ready 集，不改共享数组 |

→ **0.2.0 的新内核，恰恰是那个被推迟的强 phase 缺的地基。** 这是本文的立论基础。

phase 因此分三桶：**① 新解锁** ｜ **② 变更强** ｜ **③ 仍不做**。此外单列 **④ Moonshot 大胆簇**。

---

## 1. 🔓 Bucket 1 —— 新内核**新解锁**的 phase

| Phase | 干什么（大白话） | 0.2.0 为何解锁（以前被什么挡） | 超能力 |
|---|---|---|---|
| **`expand` 动态图嫁接** | agent 运行中生成一段 DAG，**splice 进正在跑的父图**（不只嵌套子流程） | 3 个 P0 全是命令式内核的病，事件溯源天生治好（§0） | 🔨编译 |
| **`compensate` / saga** | 某 phase 失败→**沿 event log 倒着**触发补偿动作（回滚迁移 / 删已建资源） | 事件溯源就是 saga 的实现方式（Temporal）；以前列为 L 推迟（"无回滚语义"） | ♻️恢复 |
| **`race` 首个胜出** | spawn N 个方案，**取最先完成的**，砍掉其余 | 以前"投机执行"被否（"无回滚 + 违背成本控"）；现 event log 给干净的取消记账 + replay 能算被砍分支成本 | ⏩延迟优化 |
| **`watch` 响应式触发** | 一个 phase 在它**读的东西变了**时自动重跑（持续 / 常驻流） | 这正是响应式内核（signals / observed readSet）本身；以前"stream edges"被否（"核心架构风险最大"），现用响应式而非流边实现 | 🔁增量→连续 |

---

## 2. ⚡ Bucket 2 —— 现有 phase **变更强**

| Phase | 升级 | 以前的障碍 | 超能力 |
|---|---|---|---|
| **`loop` 多 phase body** | 循环体从"单个 agent 任务"→ **test→fix→retest 子图** | DSL RFC v2 §4.6 明标 post-0.2.0（"需引擎支持循环内子图"）；被 `expand` 解锁 | ♻️（最想要的增强） |
| **`map` 逐项增量** | 改 1 个 item 的输入 → **只重跑那 1 项**，不重跑整个 map | roadmap §6.3 推迟（"map 吐整个数组，scope 爆炸"）；事件溯源逐项事件天然可寻址 | 📉增量（补全"改 1 文件→重跑 1 项"旗舰叙事） |
| **`route` / switch 类型路由** | 按**类型化判别式**（`json<T>` 联合）精确激活 1 个分支 | 以前"tagged-union routing"被否（"需 schema 先行 + 无需求"）；现 FlowIR + 类型输出让路由**编译期可验证穷尽性** | 🔨编译 |
| **`gate`/`approval` 类型化裁决** | 裁决用类型化 schema + approval **超时 + 回退** | frontier council white-space #4/#13（无竞品有）；event log 让多轮 / 超时**可恢复** | ♻️恢复 |

---

## 3. 🚫 Bucket 3 —— 仍然不做（新内核**没**改变判断）

| 方向 | 理由（仍成立） |
|---|---|
| 可视化拖拽编辑器 | 与"JSON / 代码即护城河"冲突 |
| Flow algebra（merge/project/compose） | `flow{use}` + decompile 已覆盖 |
| Artifacts（类型化文件输出） | `ctx_write`/`ctx_read` 已覆盖 |
| Stream edges + backpressure | `watch`（Bucket 1）用响应式拿到真需求，不背流边架构风险 |

---

## 4. 🌌 Bucket 4 —— Moonshot 大胆簇（"flow 是活体，不是静态程序"）

> **心智跃迁**：在事件溯源 + FlowIR-as-data + 确定性重放下，flow 不再是"你跑一次的静态程序"，而是
> **可分叉、可回溯、能观察自己、能改写自己的活体进程**。event log 之于 flow ≈ git 之于代码 + 训练数据之于模型。

### 4.1 时间旅行 / 分叉（event log 当 git 用）

| Phase | 干什么 | 新内核为何让它可能 |
|---|---|---|
| **`fork` / savepoint** | 给运行中的 flow 打命名存档点，之后能**从存档点分叉出新 run**（复用到存档点的 log，再岔开） | 事件溯源下"分叉一个 run" = fork 一条 log，几乎白得。跑到第 5 步→分叉→并行试 3 种第 6 步 |
| **`speculate` 投机分叉** | 决策点**同时展开多个未来**（fork log 并行跑），胜者留下、败者剪掉但**保留其 log 供 replay 复盘"没走的路"** | 投机执行以前被否（"无回滚"）；现在剪一个分支 = 丢一条 log，天然可回滚 + replay 能算被剪分支成本 |

### 4.2 零成本反事实（replay 当模拟器用）

| Phase | 干什么 | 新内核为何让它可能 |
|---|---|---|
| **`counterfactual` 一跑多变体** | 跑完一个 phase，**立刻用 N 组不同旋钮（模型/prompt/阈值）replay 它**，复用缓存的上游，近乎零边际成本产出对比 | replay + 内容寻址缓存 = "试 3 个模型看哪个当时最好，不花 3 倍钱"。把 eval/实验变成**运行时一等原语** |
| **`sandbox-twin` 数字孪生排练** | 真动手前，先对**录制环境的 replay**跑一遍验证，通过了再真跑 | replay 能重放录制环境 = 可模拟。"三思而后行"变一等能力（dry-run 终极形态） |

### 4.3 自我进化（跨运行 log 当训练信号）

| Phase | 干什么 | 新内核为何让它可能 |
|---|---|---|
| **`self-optimize` 自调优** | 一个 phase **读自己所有历史 run 的 log**，按 p50/p95 成本·延迟·成功率**自动调**模型/并发/重试 | 跨运行 event log + 费率表(F1) = 现成训练信号。"flow 从自己的历史里学"——无竞品在自我调优 |
| **`population` 进化循环** | loop 不再是单一血脉迭代，而是**维护候选种群**，每代对最优做变异/交叉，多代收敛（遗传算法） | event log 记录谱系；比 reflexion-loop（单线反思）高一维 |

### 4.4 群体智能（比 tournament 更进一步）

| Phase | 干什么 | vs 现有 |
|---|---|---|
| **`quorum` 共识** | 跑 N 个，输出取**多数投票/中位数**，分歧度作为置信信号（self-consistency） | tournament=裁判选最优；quorum=群体求共识 + 出置信度 |
| **`negotiate` 辩论** | N 个对立立场的 agent **互相辩**到收敛（非各自对任务），裁判收口 | 对抗协作/debate 成一等原语；每轮可 replay |

### 4.5 相关（org-supervision 设计的延伸）

| Phase | 干什么 | 关联 |
|---|---|---|
| **`escalate` 动态督导** | 督导 phase **经 event log 监控运行中的子任务**，动态增派 worker / 重分配 / 杀掉低效者 | `design-org-supervision.md`（ctx_spawn/ctx_report）；event log 是督导的可观测性 |

---

## 5. 排序与首推

### 5.1 稳健候选（Bucket 1+2）排序

| 优先 | Phase | 一句话理由 |
|---|---|---|
| **1** | `expand` 动态图嫁接 | **旗舰**——事件溯源正是它缺的地基，已设计+已对抗评审，直接兑现"agent 编排的编译器"叙事 |
| **2** | `loop` 多 phase body | 最想要的增强，被 #1 直接解锁 |
| **3** | `map` 逐项增量 | 补全"改 1 文件只重算 1 点"的增量旗舰故事 |
| **4** | `compensate`/saga | 真实副作用流的安全网，事件溯源下自然 |
| **5** | `race` 首个胜出 | 便宜，填延迟优化空白（tournament=最优、parallel=全等，都不是首个胜出）|
| 6 | `route` 类型路由 | 编译期可验证，比 N 个 `when` 干净 |
| 7 | `watch` 响应式触发 | 最大胆——常驻/连续流，把"增量"推到极致 |

> **关键连锁**：`expand` 一旦落地，`loop` 子图 和 `map` 逐项几乎白得——它们都是"局部子图"的特例。
> **`expand` 不只是一个 phase，是解锁一串 phase 的元能力。**

### 5.2 Moonshot 诚实分层

| Tier | Phase | 判断 |
|---|---|---|
| **A｜大胆但 0.2.0 够得着** | `fork`/savepoint、`counterfactual`、`quorum` | 只是 event-log + replay + cache 的巧用，无新内核机制 |
| **B｜Moonshot，需研究 spike** | `speculate` 剪枝、`self-optimize`、`population`、`negotiate`、`escalate` | 要新机制 + 真风险（成本爆炸/收敛性/评估偏差/督导语义），带 kill-criteria 立项 |
| **C｜仍太远/冲突** | 真流式、全自主自改写 flow | 违背成本可控 / 护城河，暂不碰 |

### 5.3 首推
- **稳健旗舰**：`expand`（元能力，连带解锁 loop 子图 + map 逐项）。
- **大胆但够得着**：`fork`/savepoint + `counterfactual`——几乎是事件溯源内核的免费副产品，把 taskflow 从"编排器"抬到"可实验的活体运行时"；且 `counterfactual` 是**把已有 replay 直接变成用户级杀手锏**的最短路径，正好接上 0.1.7 承诺的确定性重放。

---

## 6. 一句话最狂愿景

> **flow 从"运行一次的程序"变成"能分叉试错、零成本反事实、从自己历史学习的活体"。**
> `expand` 让它**长出**新节点，`fork` 让它**分叉**，`counterfactual` 让它**假设**，`self-optimize` 让它**进化**——
> 这四个合起来，taskflow 不再是编排器，是 **agent 工作流的活体运行时**。

---

## 7. 下一步（未定，待选）

1. 挑 `expand` 深挖成 phase 设计草案（DSL 形态 + FlowIR node 语义 + 与 `flow{def}` 现有路径的关系 + graft-into-parent 的事件溯源实现）。
2. 挑 `fork` + `counterfactual` 深挖（DSL 形态 + event-log 分叉语义 + 与 replay 复用）。
3. 用 taskflow 自己跑一轮对抗式 brainstorm（4 路发散 → critic 收敛 → arbiter 裁决）把 Moonshot 簇压测 + 定 kill-criteria。
4. 把 Bucket 1+2 的排序纳入 `rfc-0.2.0-architecture.md` §5 的建造顺序（作为 S2 之后的 phase 扩展 horizon）。
