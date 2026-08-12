# P12: Command batch + re-auth disclosure

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §9](../rfc-0.3.0-control-plane-v7.6.md)（D24）
> TE 基底: `resources/journal.ts` WriteIntentJournal（intent + 原子批）+ `resources/permits.ts` MutationPermitRegistry（一次性 permit）+ `resources/authority.ts` InvocationAuthority。

## Decision

`CommandRecord` 是**不可变权威记录**，与其 ControlEvents 在**同一原子提交批次**内落盘（log-structured 或等价）。唯一索引 `(controlDomainId, commandId)` 可从 journal 重建——**不是**可与日志漂移的可变侧表。

### 字段

```text
commandId, requestHash
callerPrincipal, authorizationContextHash
projectId, controlDomainId
status, firstCommitSeq, lastCommitSeq
responseArtifactRef?
recordedAt
```

### 原子批（9.3）

1. 先 durable 写响应 Artifact（rename/fsync，如有）；
2. 原子提交: CommandRecord + 全部 events，分配连续 commitSeq；
3. 然后 RPC 才算 accepted。
孤儿 blob GC；**绝不**接受带悬空引用的 commit。

### Idempotent 执行 vs 披露（9.4）

| 情形 | 行为 |
|------|------|
| 同 commandId + requestHash | **不重放**副作用；返回先前响应体，但**先 live 重查**当前 principal 对该 project/command class 的授权（revocation → deny，即使命令已执行过） |
| 同 id 不同 hash | `TF_IDEMPOTENCY_CONFLICT` |
| 不同 principal 同 id | `TF_CROSS_PRINCIPAL_COMMAND` |

- `authorizationContextHash` 是 accept 时记录的**审计元数据**；披露仍用 live authz。
- TE 对应物: WriteIntentRecord 的 `authorizationPrincipalId` + `authorizationScopeRoot` 已是 intent 级审计字段；CommandRecord 将其提升为 control-plane wire 字段。

### Artifact 访问（9.5）

`ArtifactRef.digest` 非 bearer；读取需 当前 principal + project scope + **ledger reachability**（artifact 被已授权 run/command 引用）。

## Wire impact (TypeBox)

- `CommandRecordSchema`（新增）+ `ControlEventSchema`（新增，含 commandId FK、commandEventIndex、commitSeq、causationId/correlationId）。
- `TF_IDEMPOTENCY_CONFLICT` / `TF_CROSS_PRINCIPAL_COMMAND` 入错误信封（P4）。

## Status

Accepted for 0.3-C wire freeze。
