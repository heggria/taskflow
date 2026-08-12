# Control Plane (feat/0.3.0) — Future Notes / 概念留档

> **Status:** ARCHIVED — historical direction, superseded by Trusted Effects.
> **Date:** 2026-08-12
> **Source branch:** `backup/mac-feat-0.3.0-control-plane` (archived under `backup/0.3-archive/`)
> **Not a release definition.** PR #122 明确: *"Historical Control Plane (feat/0.3.0) is not this release definition."*

本文档是 0.3 整合归档时的概念留档。Control Plane 与 Trusted Effects 是**互斥架构**（同一执行权威层的两个竞争实现），代码不可合并；但其中若干**概念**对 TE 路线的未来演进（0.4+）有参考价值，故冻结于此供未来重新设计时借鉴。**抄概念，不抄代码。**

---

## 1. 为什么与 TE 互斥（不可 git 合并）

| 维度 | Trusted Effects (0.3, rc) | Control Plane (feat/0.3.0) |
|---|---|---|
| 机制 | 声明式 `effects[]` + 编译期静态验证 | 命令式 daemon + UDS RPC + ControlStore |
| 授权 | PathRef 白名单 + 资源事务（snapshot→lease→journal→permit→stage→Commit/Restore） | capability tokens + 审批 CAS + 跨进程锁 |
| 执行 | 复用现有 runtime，事务性提交/回滚 | Program→BoundPlan→Run→Receipt 独立闭环 |
| 核心文件 | `schema.ts`/`verify.ts`/`runtime.ts`/`exec/*` | **同一批文件**的深度改写 |

- 两者都解决"谁有权让 flow 写文件/执行"，在同一层级竞争，不是互补模块。
- TE deliverable #5 要求 **single mutation authority**（移除 legacy changeset/gateway authority）；Control Plane 恰恰建立独立的 daemon 级授权权威 → 并存即双权威。
- control-plane 分支不含 `packages/taskflow-core/src/effects/`（0 文件），即两套代码面根本没有交集点可"融合"。
- 合并后果：数百处冲突 + 运行时无法定义"谁授权写文件"。

## 2. Control Plane 要解决什么（历史目标）

RFC 文档: `docs/internal/rfc-0.3.0-control-plane.md` (v7.6, 2026-07-22)
产品句: *"Taskflow links programs under policy and capabilities into immutable BoundPlans/BoundFragments, executes them with one semantic kernel on heterogeneous providers, and records a durable **per-project** journal from which runs, receipts, and replays are derived."*

核心闭环: `Program → BoundPlan → Run → Receipt`
灵魂: single execution semantics · immutable BoundPlan/BoundFragment · durable per-project journal

**Scoped authority (D6):**
- Project ControlStore = Run/Command/Approval/Receipt 权威（官方项目账本）
- UserCoordinatorStore = singleton lease + 全局并发预留 + coordinator 命令（窄权威）
- ControlRegistry = 非权威发现/投影（目录）
- One ControlDomain per project; daemon multi-mount; 0.3 不做 DomainTransfer/合并用户账本

## 3. 值得借鉴的概念（未来 0.4+ 参考）

### 3.1 并发/容量的运行时控制
- `maxActiveRuns` 全局并发预留（UserCoordinatorStore CoordinatorLease / ConcurrencyReservation）
- `controlMode: auto` 默认；coordinated fail-closed；standalone 显式
- `unknown` 状态可 reconcile 且非终态；超时**不得**编造 provider 终态、释放已提交槽位或签发最终 Receipt（§8.4）
- 协调器命令：set maxActiveRuns / force-release（forceRelease 需 risk-ack）

### 3.2 审批协议（P15 / P16）
- Durability modes (D34): `compat-auto-reject`(默认) / `durable-optional` / `durable-required`
- Wire status: pending | approved | rejected | edited | **expired** | cancelled
- 超时 → request `expired` 且 Run → **blocked**（永不 permanent paused / 永不默认 approve）
- Park (D38): durable pending + provider quiescent → RunStatus paused + RunStage parked; approve → queued + re-reserve
- **Durable reservation-release outbox**（host-local）: 先持久化 `ReservationReleaseIntent` 再调用 `normalRelease`，evidence-bound `releaseReservationWithProof`，宿主打开时 drain —— 这个模式对任何"释放外部资源"的持久化场景都有价值
- 审批 CAS: atomic first-commit-wins approve under exclusive store lock

### 3.3 Capability / enforcement 模型（P8 / §15）
正交能力维度:
| Capability | Values |
|---|---|
| resolution | contained \| unbound |
| mutationMediation | none \| brokered (per mutation) |
| processIsolation | none \| sandboxed (sealed plan) |
| revocation | admission-only \| per-mutation \| `{mode:"bounded-latency", maxLatencyMs}` |

- 不支持 sandbox → **fail closed** (D11)
- capability tokens: grant refs + revalidation; plan ≠ bearer (D19)
- Policy: deny | substitute | attenuate (D10)

### 3.4 持久化/恢复模式（P14）
- files-only ControlStore（非 node:sqlite）: temp + fsync + rename 原子提交批；journal/ projections/ commands/ receipts/ 分段；commit-seq 单调计数器
- 恢复: 重读 journal 段重建投影
- **P14 可信边界反例（重要教训）**: 若 opener 只读项目根内文件，restorer 可用一个更老的完整快照替换全部本地工件（`.taskflow/` + anchor 都在内），opener 无法区分"合法旧状态"与"回滚伪造状态"——**任何 local-only 算法都无法消除这个不可分辨性**。→ 真正的回滚新鲜度需要项目外锚点。TE 的资源事务应保持"before-image 在干净终态后移除"的现状，但未来若要做整根回滚，必须考虑外部锚点（如用户级可信存储/远程证明）。

### 3.5 进程/daemon 监督
- taskflowd / embedded supervisor / standalone: "Swap clerks; do not swap project ledgers"（换执行进程，不换账本）
- UDS hello-before-RPC 握手; singleton fencing epoch; cross-process locks for store header/coordinator state
- wait for exitSettled before dead-pid fail-closed; poll fail-closed when pid dead under running status

## 4. 归档时保留的原始文档（在 backup/0.3-archive 分支内，未复制到 rc）

- `docs/internal/rfc-0.3.0-control-plane.md` — master RFC v7.6（§0-§25 完整）
- `docs/internal/rfc-workspace-capabilities.md`
- `docs/internal/p-adrs/P8-enforcement-capabilities.md`
- `docs/internal/p-adrs/P14-controlstore-engine.md`
- `docs/internal/p-adrs/P15-approval-protocol.md`
- `docs/internal/0.3.0-ga-closure-goal.md` / `0.3.0-ga-traceability-matrix.md`
- `docs/internal/design-org-supervision.md` / `design-dynamic-dag-expansion.md`
- `docs/internal/overstory-convergence-roadmap.md`
- `docs/internal/brainstorm-2026-07-02-feature-roadmap.md`

需要完整细节时 `git show backup/0.3-archive/mac-feat-0.3.0-control-plane:<path>`。

## 5. 未来融合路径（若要做 daemon/审批层）

1. 0.3 按 TE 发（当前定义，L1-L4 绿）
2. Control Plane 保持归档冻结
3. 若未来做操作控制面（daemon/审批/并发预留）: **以 0.3 TE 为基底重新实现**，借鉴 §3 的概念，不 cherry-pick 旧代码；放进 0.4+ 路线图，作为 TE 的"操作层"（TE = 声明式写入授权地基，Control Plane 概念 = 运行时控制面楼）。

## 6. 其他归档分支内容摘要

- `backup/mac-0.3.0-beta.2` — beta.2 时代 web/control 证据链（更早路线，含 Safari/浏览器权威证据）
- `backup/mac-te-tip-3e3d2ed4` — TE 早期 tip（= rc 里 e6efcd4 的前身/变体，内容已并入 rc）
- `backup/mac-dirty-budget-soft-hard` — budget soft/hard reserve WIP（`deterministic.ts`/`runtime.ts`/`schema.ts`/`verify.ts` 增量 + 测试；commit 自注 *"Not for main/rc merge"*，若未来要 budget 功能可单独评估 cherry-pick）
- `backup/mac-stash-*` — Mac 抢救的 stash 片段（老 main 历史 + WIP）
- `codex/0.3.0-trusted-effects-candidate` — 旧 TE 候选（PR #117），内容已被 rc 覆盖
