# P3: Domain + Registry rebuild + clone/worktree identity

> Status: **Accepted** (0.3-C wire-freeze gate)
> Normative parent: [RFC v7.6 §4.1/§4.3.1](../rfc-0.3.0-control-plane-v7.6.md)（D7/D27）
> TE 基底: 项目根锚点模式（`<root>/.taskflow-control.anchor.json` + ControlStore header，P14 定义）；`resources/persistence.ts` 原子写/fsync 原语。

## Decision

- ControlStore **header** 是 `projectId` + `controlDomainId` 的权威来源：
  `{ projectId, controlDomainId, schemaVersion, directoryBinding }`。
- ControlRegistry 是**非权威**发现/投影；Registry 丢失时，下次打开项目路径 → 从 header 重新注册（**不得**从 registry 凭空发明 run 状态）。
- 可选全盘发现仅限显式配置的 discovery roots（默认不整家爬取）。

### clone / copy / worktree / move 身份策略

| 情形 | 决策 |
|------|------|
| **move**（rebind 成功后 inode 证据一致） | 同一 projectId |
| **copy/clone** | **新 projectId**（新 domain），除非显式 "adopt identity" operator 命令 |
| **git worktree** | 新 binding；默认**新 projectId**（避免两个 worktree 共享一个活 journal 而无排他租约） |

- 0.3-C: 每项目一个 ControlDomain；`controlDomainId` 在 daemon 重启、standalone↔daemon 切换、客户端升级时**不变**。
- 无 DomainTransfer（RFC 明确 out of 0.3）。

## Wire impact (TypeBox)

- `ControlStoreHeader`、`ControlRegistryEntry { projectId, controlDomainId, storePath, directoryBinding, mountState, summary? }` 新增 wire types（见 wire-freeze）。
- Registry 条目可重建；header 不可重建（丢失 = fail closed）。

## Status

Accepted for 0.3-C wire freeze。
