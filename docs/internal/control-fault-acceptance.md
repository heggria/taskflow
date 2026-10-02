# Control fault acceptance

Alignment status: READY for the bounded experimental control fixes.

User-approved scope (2026-10-02): preserve reproductions, repair, inject faults,
restart and test installed artifacts. Projects must not share the wrong ledger;
damaged ledgers must not be overwritten; malformed clients must not terminate
the shared service. No production state, publication or remote mutation.

| ID | Confirmed behavior / source | Code | Permanent acceptance |
| --- | --- | --- | --- |
| ISO | User project isolation; P3 binding identity and P13 fail-closed singleton | control-host.ts | project-isolation.test.ts: reject a different project, refuse unbound attached ledger calls, preserve same-project submit across restart |
| STORE | User damaged-ledger preservation; P14 journal authority | store/store.ts | store-corruption.test.ts: missing/malformed header, invalid record, identity/sequence mismatch and damaged complete journal retain bytes; restoring original header recovers committed command |
| UDS | User abnormal-client containment; P4 hello-before-RPC | hello.ts, uds.ts | uds-malformed.test.ts: invalid shapes, pipelined frames after rejection, unexpected handshake exception, subsequent healthy client |

Scope decision: taskflow-control remains private and experimental. Multi-mount
routing is unfinished and is not added here. A second project cannot attach to
the current single-store winner; it fails closed. Same canonical path/device/inode
can attach. A host without projectStorePath can use control status/probe but not
project ledger RPCs. This is isolation, not a claim of implemented multi-mount.

Journal initialization requires an empty store except for writer-lock state.
Recovery validates complete committed batches before trimming a torn tail or
rebuilding projections. Existing crash recovery (header fsync, torn append,
projection interruption), writer locking and restart tests remain required.

Baseline: source candidate 12a327ec97f0bc6531fdae31c3f142f03302f866 plus local
1.0 preparation snapshotted in ca83dce82c34fb39fac36498aff2c4fbfe28c359.
The fault suite has no live model/provider dependency. All destructive cases own
their temporary directories and child processes. The parent acceptance report
binds the final commit to installed artifact hashes and test logs.
