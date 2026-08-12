# P6: Canonical hash + ArtifactRef + SecretRef

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §7.2/§11/§12](../rfc-0.3.0-control-plane-v7.6.md)（D25/D26）
> TE 基底: `flowir/canonical-hash.ts`（现有 canonical hash 库）+ `effects/types.ts` SecretRef `{ secretId, issuer? }` + `resources/persistence.ts` contentId/blob 惯例。

## Decision

### Canonical hashes

| Hash | 形式 | 语义 |
|------|------|------|
| `boundPlanHash` / `boundFragmentHash` | `bp:<sha256-hex>` | 稳定 JSON 的全链路审计身份（audit identity） |
| `executionSemanticHash` | `es:<sha256-hex>` | 解析后的执行描述符（复用键，RFC §11 字段集） |

- **单一 canonical hash 库**：仅 Node `crypto.createHash("sha256")`；wire 上不允许第二种哈希算法（防折叠混淆）。TE 已有 `flowir/canonical-hash.ts`，0.3-C 不另起炉灶。
- authority epoch 本身**不进入** executionSemanticHash。
- Class folding 仅在已发布的等价契约下进行。

### ArtifactRef / SecretRef

```text
ArtifactRef { digest, size, mediaType, storageClass, redactionClass }
SecretRef   { secretId, issuer }        // 无内容 digest
```

- `ArtifactRef.digest` **不是 bearer token**：读取需要 当前 principal + project scope + **ledger reachability**（artifact 被授权的 run/command 引用）。
- Secrets 永不进入通用 ArtifactStore 作为 content-addressed blob。TE 的 `SecretRef` 与 RFC 完全一致 → **直接复用**，不新增 wire 类型。

## Wire impact (TypeBox)

- `ArtifactRefSchema` / `SecretRefSchema`（复用 TE `effects/schema.ts` 的 SecretTargetSchema 内嵌形态，抽出为顶层类型）。
- `BoundFragmentSchema` 携带双 hash（见 P7）。

## Status

Accepted for 0.3-C wire freeze。
