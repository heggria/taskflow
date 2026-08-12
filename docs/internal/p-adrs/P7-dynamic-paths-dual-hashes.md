# P7: Dynamic paths + dual hashes + cache

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §7/§11](../rfc-0.3.0-control-plane-v7.6.md)（D17/D25）
> TE 基底: `resources/schema.ts` PathRef（literalPath/argPath/segments 动态解析）+ `ScopedContentEvidence`（beforeContentId/afterContentId）+ `ExecutionOwner` 身份。

## Decision

Compile+Link 后的动态 IR 产出 **BoundFragment**，携带**双 hash**：

- `boundFragmentHash` — 全链路审计身份（audit identity）
- `executionSemanticHash` — 复用键（reuse key）

```text
BoundFragment {
  parentBoundPlanHash, parentBoundFragmentHash?
  sourceEventId, sourceCommitSeq
  fragmentIRHash, fragmentPolicyHash, capabilitySetHash, authorityEpoch
  boundFragmentHash, executionSemanticHash
}
```

### 动态库存（dynamic inventory）

| 路径 | 规则 |
|------|------|
| flow{def} / nested expand / graft / ctx_spawn subflow | BoundFragment 链 |
| saved flow use | 根部 Link 时 pin irHash/boundPlanHash；**不可变 re-resolve** |
| flat ctx_spawn | SpawnTemplate ceiling → NodeInstance；否则 fragment 或 deny |
| map/loop/tournament items | 义务绑定时确定性 nodeInstanceId |

### Cache 复用谓词（完整，缺一不可）

```text
authority valid ∧ lease/version valid ∧ executionSemanticHash 相等
∧ artifact integrity ∧ output contract OK ∧ re-Link/validate 允许
```

- 禁止盲目 promotedPhases 恢复。
- 缓存存 fragment ArtifactRef、双 hash、事件区间、输出；复用前 re-Link/validate。
- TE 语义映射：`ScopedContentEvidence.beforeContentId/afterContentId` 是 fragment 级 artifact 完整性证据；`capabilityBindingId` 是 authority 证据——cache 命中必须二者同时有效。

## Wire impact (TypeBox)

- `BoundFragmentSchema`（新增，含双 hash + 链上证据字段）。
- `SpawnTemplateSchema`（新增: allowedAgentClasses, allowedProviderClasses, tool/effect ceilings, maxChildren, maxDepth, budgetShare）。

## Status

Accepted for 0.3-C wire freeze。
