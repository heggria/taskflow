# Adversarial Review R2 — Resources lane (file-transaction / lease / journal / cleanup / GC) — 2026-08-11

> Lane: ADV-R2 Resources. Reviewer: coder profile (kanban t_58558121).
> Target: `rc/0.3.0-trusted-effects` @ `d3b2878` (product candidate `96a32e8`).
> Method: source audit of `packages/taskflow-core/src/resources/{file-transaction,journal,leases,permits,persistence,execution,types}.ts` +
> 14 adversarial probes (crash windows, GC retention, lease double-fault, journal concurrency, mode fidelity),
> plus the focused suites: resource-file-transaction / resource-journal / resource-leases / resource-permits /
> resource-persistence / resources-authority-resolve / effects-{trusted,agent-te,deliverables,gateway-bypass,composition-cache}
> → 104 pass / 0 fail / 4 skipped (root-only permission fault injection skips).

## Findings

| # | Sev | Location | Scenario | Fix/Defer |
|---|-----|----------|----------|-----------|
| F-R2-1 | MED | `file-transaction.ts:603-606` (`#finish` → `this.#onDeferredLeaseRelease?.()`) | Lease release fails 3× (control-plane hiccup) **and** the `onDeferredLeaseRelease` callback throws → `#finish()` throws inside `commit()`'s `finally`, **replacing the durable `{ok:true,…}` return**. Caller (runtime finalize at `runtime.ts:1295`) sees an exception; phase is marked failed while the mutation is durably committed; a retry re-commits → second generation. Violates the module's own invariant "A terminal journal record must remain the operation result" (`file-transaction.ts:235-237`) and AGENTS.md safe-emit. **Probe-proven (P1):** file content `A`, intent `committed-content`, but `commit()` threw `injected deferred-release callback throw` and returned no result. Not reachable through current `execution.ts:564` wiring (`Set.add` cannot throw), but this is the exported shared authority API. | Fix (recommended): wrap the callback in try/catch (log + continue) in `#finish()` and in the prepare-catch call at `file-transaction.ts:727`. ~4 lines; restores the invariant for every caller. |
| F-R2-2 | MED-LOW | `file-transaction.ts:434-438` (`recoverResourceFileIntent` finally) | Startup recovery acquires a lease on the crashed intent's scopes, restores, then `releaseBestEffort` fails 3×. **This path has no deferral/drain hook** — unlike every other lease cleanup (transaction `#finish`, `execution.ts:#releaseLeaseBestEffort`). The leaked lease (`recovery-<uuid>` owner, marker `held`, live process) blocks the recovered scope for the entire session; the next admission on that scope times out until process restart. Fail-closed (no corruption), but a transient control-dir write failure mid-recovery wedges the domain. **Probe-proven (P12):** after recovery with a failing-release coordinator, subsequent acquire `blocked=true`, `leases=1`. | Fix (recommended): give `recoverResourceFileIntent` an optional `onDeferredLeaseRelease` hook wired to the session's `#pendingLeaseReleases` drain, or route the recovery lease through the same drain. |
| F-R2-3 | LOW | `file-transaction.ts:561-571` (`#rejectAndRestore` catch) | Restore fails (external actor replaced the target with a directory) **and** `journal.getIntent` throws → `#settled` is never set, so the transaction stays half-open **after the lease was released**; a second `commit()`/`reject()` passes `#assertOpen` and re-enters the reject path; caller sees an exception instead of a `FileTransactionResult`. Converges to `dirty-unknown` at next startup (fail-closed), no silent corruption. **Probe-proven (P13):** first and second `commit()` both threw the injected journal error; tx never settled. | Fix (recommended): set `#settled = true` before the `getIntent`/`markUnknown` bookkeeping (mirror the prepare catch at `file-transaction.ts:719-722`), so the settled contract holds even under double fault. |
| F-R2-4 | LOW | `file-transaction.ts:502` (`replaceFileAtomic(…, snapshot.mode ?? 0o600)`) | New (`create-file`) files written through the trusted-effects transaction are hard-coded `0o600` regardless of umask; a plain `fs.writeFileSync` under umask 022 yields `0644`. **Probe-proven (P8):** baseline `644`, tx file `600`. Committed artifacts are owner-only → group/other processes (CI, docs server, another OS user) cannot read them; `git status` is unaffected (git tracks only the exec bit). No PathRef mode field exists to request another mode. | Defer: document the `0o600` default; consider honoring umask or adding a mode option to PathRef in a later iteration. More restrictive is safer — divergence, not data loss. |
| F-R2-5 | LOW | `leases.ts:296-297` + `235-244` | Crash between `#createReleaseMarker` (writes `lease-release-<id>-<token>.json`, state `held`) and the state-file write leaves an orphan release marker that is never collected: `#isStale`/`#cleanupReleaseMarkers` only consult records, and no record references the marker. Inert (never blocks) but accumulates across crash/acquire cycles in the control dir. | Defer: startup sweep of `lease-release-*.json` without a matching record, age-gated like the transaction-orphan GC (`file-transaction.ts:258`). |

**Severity counts: 0 Blocker, 0 High, 1 MED (F-R2-1), 1 MED-LOW (F-R2-2), 3 LOW (F-R2-3/4/5).**

## OK coverage (verified)

- **Multi-file crash Commit-or-Restore** — every crash window is consistent:
  crash mid-replace → intent `pending` → startup recovery restores all before-images → `aborted-restored`
  (`resource-file-transaction.test.ts:446` child-process crash; probe P4/P7); crash after the terminal WAL
  append (durability point `journal.ts:522-526`) → `committed-content` retained and dir GC'd (P7); partial
  commit WAL tail → truncated + `dirty-unknown` (`resource-journal.test.ts:189`, P10); partial intent WAL
  tail → orphan dir aged out, files untouched (code walk); double recovery idempotent (P11); missing
  before-image degrades to `dirty-unknown` fail-closed, never silent restore (P3).
- **Post-commit cleanup** — terminal commit/abort GCs before-images (`resource-file-transaction.test.ts:129,157,484`);
  `cleanupStaging` throw does not fail commit (test:368); release-after-durable-unlock failure does not fail
  commit (test:331); committed tx dir removed post-commit, abandoned pending dir retained (P7).
- **Lease** — cross-process contention + dead-owner stale recovery (`resource-leases.test.ts:194`); durable
  release marker survives state-cleanup loss (test:130); corrupt live marker blocks only its overlapping
  scope (test:163); activation+inspection double fault still releases the lease (test:414); failed-state
  release pruned on next acquire (P6); abort cancels waiters but never revokes a granted writer (test:98).
- **Before-image / orphan GC** — `pending`/`dirty-unknown` dirs retained; `reconciled`/terminal removed;
  aged pre-intent orphans collected; fresh pre-intent window preserved (P2 + tests:491,507).
- **Journal concurrency honesty** — WAL order across parallel commits in one domain (P5); cross-process
  disjoint commits get generations 1,2 with no corruption (P9); overlapping pending/dirty scopes block while
  disjoint proceed (`resource-journal.test.ts:131`); explicit reconciliation advances generation durably
  (test:151); `beforeGeneration` CAS in `prepare`; all WAL appends/reads under the persistent mutex with
  unterminated-tail truncation only under the mutex; no-op commit records honest `before==after` evidence
  (P14); restored-abort is terminal and generation-neutral (test:260).
- **Restore correctness** — declared-path bypass → `aborted-restored` + created-parent prune
  (`resource-file-transaction.test.ts:136`, P4); restore over a directory target → fail-closed
  `dirty-unknown`; snapshot manifests content-address verified (`loadRecoverySnapshots`).

## Residual risk

- **External TOCTOU**: the window between `preCommitGuard` (post-state check) and the terminal WAL append is
  not fenced against hostile external writers; the ledger can drift from disk after commit. Documented
  resolve-only limitation (`file-transaction.ts` header, `execution.ts:648-652`); requires a native
  file broker to eliminate.
- **Restore is content+mode only**: `restoreSnapshot` → `replaceFileAtomic` creates a new inode, so mtime /
  ctime / ownership are not part of the "durable pre-state" claim (evidence is contentId-based).
- **Append-only unsharded journal**: fold is O(n) per op; scale/capacity for thousands of intents is
  deferred (scoreboard).
- **F-R2-2 wedge** is the only residual that can degrade availability of a live session (until restart);
  F-R2-1/3 are contract violations on exported API, currently unreachable through `execution.ts`.

## Ready recommendation

**No Blocker, no High. The MVP Commit-or-Restore, lease, journal-concurrency, and before-image/orphan-GC
claims are verified.** Recommend a small pre-GA hardening pass for **F-R2-1 + F-R2-2** (each ~4-10 lines;
F-R2-3 optional with them) because they touch the module's core "committed result must remain the result"
and "cleanup must not wedge the session" invariants under exactly the control-plane failure conditions the
0.3 design promises to survive. F-R2-4/F-R2-5 defer. Product code unchanged in this review; probes were
temporary and removed. CI baseline re-verified at `d3b2878`: focused resource/effects suites 104 pass / 0 fail.
