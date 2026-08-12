# P13: Bootstrap / fresh-install / singleton lock / platforms

> Status: **Accepted** (0.3-C wire-freeze gate — 契约部分；实施在 S2/S3)
> Normative parent: [RFC v7.6 §5](../rfc-0.3.0-control-plane-v7.6.md)（D5/D32）
> TE 基底: `resources/persistence.ts` PersistentFileMutex / 原子写 / fsync 原语；archive P13 的锁语义作为**概念输入**（identity-bound reclaim），不作为已批准实现。
> 说明: archive P13 为 PARTIAL（锁回收硬化证据）；0.3-C 冻结契约与平台决策，锁协议细节在 S2 重新实现并出证据。

## Decision

### controlMode

| Mode | 行为 |
|------|------|
| **auto**（默认） | 确保 registry + project ControlStore；启动/附着 **user singleton multi-mount control**（taskflowd **或** embedded supervisor 竞争**同一** lock/endpoint — D32）；control 起不来 → **fail closed** |
| **coordinated** | 外部 control 必需；down → fail closed |
| **standalone** | **显式**；in-process ControlHost 打开**同一** project ControlStore；单 owner lease；不跨项目声明全局并发 |

**禁止** `auto → standalone` 静默回退。只有显式 `controlMode: standalone`。

### Singleton（D32）

- Embedded multi-mount 必须与独立 `taskflowd` 竞争**同一** user singleton lock + **同一** coordination endpoint（UDS path / pipe name）。
- 输者**作为 client 附着**赢者——不得各自成为独立 multi-mount authority。
- Wire protocol / fencing epoch / UserCoordinatorStore path 与外部 daemon **一致**。
- 拿不到锁然后"本地 multi-mount 单干" → 禁止（silent fork）。

### 排他锁语义（0.3-C 契约）

- Owner 发布用 hard-link create（**绝不** rename-overwrite）；malformed singleton 元数据 fail closed。
- 死 PID 自动接管保持 fail-closed（POSIX/Node 无 compare-and-unlink 绑定 observed inode → 需未来 OS-backed holder 协议，0.3 不做）。
- 协作竞争者用 identity-bound reclaim（archive 概念：fixed claim file + O_EXCL + generation 校验 + rename-to-discard + 可恢复 claim cleanup）。
- Release = 对 acquire 时 device/inode + owner token 的 compare-and-delete（rename-to-discard）。
- `maxAttempts` 是**硬 pass 预算**（非 maxAttempts×K spins）；progress wait 用 generation/claim-aware 等待，不烧预算。

### Fresh-install / upgrade 契约（GA 必须过）

1. Bundled control binary 路径文档化。
2. 首次 `taskflow_run`（或 CLI 等价）默认: 缺 registry 条目/project ControlStore 则创建；启动/附着 singleton control；**无需手工 daemon 配置**完成一次 run。
3. 并发 client 启动: 单实例锁/socket acquire；输者附着赢者（无双写者）。
4. Stale socket: 检测死 peer（pid/lock）→ 移除 socket → 重启。
5. Version skew: 握手拒绝不兼容 client/daemon；升级路径文档化。
6. 平台: **Unix UDS required for 0.3 GA**；Windows named pipe **non-GA**（release notes 明示；lock-file 协调仍适用）。
7. 停机不得损坏 journal；control 恢复前新 admit 失败。

### 布局

- User: `~/.taskflow/control/`（`TASKFLOW_HOME` 可覆写）
- Project: `<root>/.taskflow/control/`（TE 已有 `defaultWorkspaceControlDirectory` 同源惯例）

## Wire impact (TypeBox)

- 握手携带 `protocolMajor` + controlMode（P4）；`BootstrapManifest { controlBinaryPath, controlHome, singletonEndpoint, fencingEpoch }` 新增。

## Status

Accepted（契约）for 0.3-C wire freeze。锁/接管实现与证据在 S2，不阻塞 wire 冻结。
