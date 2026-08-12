# P5: Phase × feature + RunStatus/RunStage 矩阵

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §8/§19](../rfc-0.3.0-control-plane-v7.6.md)（D21/D31/D33）
> TE 基底: `packages/taskflow-core/src/schema.ts` 的 PHASE_TYPES（13 种 closed kinds，含 approval/race/expand）+ `public-surface-0.2.4.json` golden。

## Decision

### Golden 基准

公共 0.2.4 表面（schema、docs/skills、examples、exports、tests、promised errors）→ golden（`packages/taskflow-core/test/fixtures/public-surface-0.2.4.json`），D21 兼容以此为准。

### 0.3 RunStatus（用户可见/API 生命周期）

```text
running | completed | failed | paused | blocked | cancelled | unknown
```

Terminal 仅: `completed | failed | blocked | cancelled`。**`unknown` 非终态**（D33）。

### 0.3 RunStage（控制管线进度）

```text
received | compiled | linked | queued | admitted | executing | parked | reconciling | terminal
```

### 规范配对

| 情形 | RunStatus | RunStage | Slot |
|------|-----------|----------|------|
| durable approval + provider quiescent | paused | **parked** | released (D37/D38) |
| cancel-in-flight + worker 仍活 | paused | executing | held |
| provider ambiguous | unknown | reconciling | held / orphan-suspect |
| 真正结束 | terminal | terminal | 仅 D37 释放 |

### 边界（bounds）

- Auto-reconcile 默认 `maxAttempts=3`（可覆写）；只约束**自动化**，不约束事实。
- 耗尽后: 保持 `unknown`；**无**最终 Receipt；slot → orphan-suspect（仍占 maxActiveRuns）。
- `executing → queued` 非法，除非经 `parked`（或 P5 定义的显式重启路径）。
- Approval 三模式（compat-auto-reject / durable-optional / durable-required，P15）。

### Cancellation import（0.2.4 → 0.3）

| 0.2.4 观察 | 0.3 导入 |
|-----------|---------|
| paused + detachedCancel + worker 仍活 | paused + executing（slot held） |
| paused + detachedCancel + worker 已死/确认 | cancelled + terminal |
| failed 消息仅提及 cancel | 保持 failed（除非有 durable cancel marker） |
| 干净 cancel 无 paused 中间态 | cancelled |

P5 必须包含 resume-after-detachedCancel goldens。

## Wire impact (TypeBox)

- `RunStatus` / `RunStage` 为独立 StringEnum wire 字段；`RunSnapshot` 携带两者 + slot 状态 + needs-operator 标志。
- Phase 类型沿用 TE PHASE_TYPES 作为 feature matrix 的 x 轴（不新增 wire 枚举）。

## Status

Accepted for 0.3-C wire freeze。
