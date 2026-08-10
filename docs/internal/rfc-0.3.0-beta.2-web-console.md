# RFC: taskflow 0.3.0-beta.2 — Local Control Console

> **Document version:** v2 (PROPOSED)
> **Release placement:** **0.3.0-beta.2** — not 0.3.1
> **Branch:** `codex/0.3.0-beta.2` (dedicated worktree; based on `feat/0.3.0`)
> **Date:** 2026-07-22
> **Decision already made:** WebUI enters the 0.3.0 prerelease train at beta.2.
> **Decision requested by this RFC:** approve the beta.2 product boundary, browser transport, frontend architecture, and acceptance matrix.
>
> **Normative dependencies:** [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md) v7.7+ and [`P17-browser-protocol.md`](./p-adrs/P17-browser-protocol.md).
> P1–P16 remain authoritative for core control-plane semantics. **P17 independently owns the HTTP/browser wire** and [`web-protocol.ts`](../../packages/taskflow-control/src/web-protocol.ts) is its canonical TypeBox surface. This RFC defines the product and implementation boundary; it does not create a second execution or authority model.

---

## §0. TL;DR

`taskflow-web` is a **local operations and governance console** for the 0.3 control plane:

```text
many project ControlStores
          ↓ mounted by the existing singleton
one local browser console
          ↓
observe Runs · inspect DAG/evidence · approve/cancel/resume
reconcile ambiguity · replay decisions · explain effective policy
```

It is **not** a workflow authoring IDE and **not** a third compiler frontend in beta.2.
It visualizes and controls already-compiled Programs, BoundPlans, Runs, events, and Receipts through the same `ControlHost` semantics used by CLI and MCP.

The console is opened explicitly with `taskflow ui`. It binds an ephemeral server to loopback only, serves a static SPA and a same-origin JSON/SSE adapter, and never becomes the source of truth. No default network listener, no direct browser access to ControlStore files, no cloud account, and no telemetry in beta.2.

### Proposed beta.2 baseline

The release placement is a product decision already made. The remaining W-decisions below are the coherent baseline submitted for approval by this PROPOSED RFC; calling them “frozen” would incorrectly imply the RFC itself had already been accepted.

| ID | Decision |
|----|----------|
| **W1** | Ship the first WebUI beta in **0.3.0-beta.2** and keep a local console in the 0.3 release train. GA scope is split in §20 instead of making every experimental write a hard gate. |
| **W2** | Product identity: **local control console**, not visual workflow builder. |
| **W3** | Browser state is a projection/cache only. Project ControlStore remains Run/Command/Approval/Receipt authority; UserCoordinatorStore remains coordinator-command/concurrency authority. |
| **W4** | Default UX is multi-project through the existing `controlMode:auto` singleton. Explicit standalone is single-project and visibly degraded. No silent auto→standalone fallback. |
| **W5** | `taskflow ui` starts an **on-demand loopback-only** endpoint at an unpredictable `<nonce>.localhost` host. No listener exists before explicit launch; it closes after the final session expires or explicit `taskflow ui --stop`. No always-on config, `0.0.0.0`, LAN, or remote mode in beta.2. |
| **W6** | Static SPA + same-origin JSON commands + SSE observations. Browser never speaks UDS or edits disk stores directly. |
| **W7** | Every mutation is a durable, idempotent control command with `commandId`, live authorization, and CAS/version checks where required. No destructive optimistic UI. |
| **W8** | Aggregate views do not invent a global `commitSeq`. Each row/event retains its `projectId`, `controlDomainId`, and project watermark; aggregate cursor is opaque. |
| **W9** | RunStatus and RunStage remain separate. `unknown/reconciling` is never rendered as failed or terminal; no final Receipt is shown before one exists. |
| **W10** | DAG view is read-only. Dynamic BoundFragments and NodeInstances appear as runtime inventory, never as mutations to the immutable BoundPlan. |
| **W11** | Stack: React 19.2 + Vite 8.1 static SPA + TypeScript 7 + TanStack Router/Query + `@xyflow/react`; no Next.js server or SSR. |
| **W12** | No remote fonts, analytics, CDN scripts, raw HTML rendering, or secret material in browser storage. |
| **W13** | Policy is **explanation-only** in beta.2. P1 defines evaluation/overlay semantics, not a writable PolicyStore or policy command; WebUI does not invent one. |
| **W14** | Risky writes are capability-gated and completely hidden until their independent protocol/state-machine tests pass. |

---

## §1. Product sentence

> Taskflow Console mounts the user’s project control planes into one local, inspectable operations surface, so a developer can see what agents are doing, understand why work ran or was reused, make auditable control decisions, and verify the resulting evidence without merging project authority.

### 1.1 Why beta.2 exists

The 0.3 control plane creates strong semantics that are difficult to feel through command output alone:

- per-project authority versus user-level coordination;
- `RunStatus × RunStage`, including parked approvals and reconciling ambiguity;
- immutable BoundPlans plus dynamic BoundFragments;
- policy deny/substitute/attenuate decisions;
- incremental reuse and `why-stale`;
- zero-token what-if replay;
- immutable Receipts and assurance.

The beta.2 console makes those semantics **visible and operable**. Its job is not to decorate a daemon; its job is to make the control plane legible.

### 1.2 Product principles

1. **Truth before smoothness.** Never turn stale/unknown/ambiguous into a reassuring fake state.
2. **Observe before mutate.** Every risky action first shows current authority, side-effect uncertainty, and expected result.
3. **Project identity is always visible.** Cross-project convenience must not erase jurisdiction.
4. **Evidence is a first-class screen.** Receipt, artifacts, policy decisions, cost, cache reuse, and provenance are not hidden debug tabs.
5. **The browser is replaceable.** Closing, reloading, or upgrading the UI cannot change execution truth.
6. **Local by default and by construction.** Beta.2 is not a hosted SaaS control plane.

---

## §2. Scope

### 2.1 In scope for 0.3.0-beta.2

- Unified multi-project overview from ControlRegistry projections.
- Project directory and mount/identity health.
- Aggregate and per-project Run search/filter/list.
- Run detail: status/stage, BoundPlan, dynamic inventory, NodeInstances, Attempts, provider state, event timeline, cost/tokens, cache/recompute reasoning, artifacts, and Receipt.
- Read-only DAG visualization with a synchronized node inspector.
- Durable approval inbox and approve/reject/edit decision surfaces allowed by P15.
- Cancel, resume, recompute, and manual reconcile through authoritative commands.
- `needs-operator` queue, including guarded force-release.
- Zero-token replay/what-if surface over recorded decisions.
- Read-only effective policy/capability explanation.
- Global `maxActiveRuns` display and guarded update.
- Same-origin browser API, event stream, local authentication, packaging, and real-daemon E2E.

### 2.2 Explicitly out of beta.2

- Visual DAG authoring or node drag-to-edit.
- Editing or compiling `.tf.ts`, full Taskflow JSON, or shorthand JSON.
- Natural-language goal→workflow generation.
- A third compiler frontend or Intent/Spec language.
- Cross-project parent Runs, DomainTransfer, or merged project journals.
- Cloud-hosted console, teams/RBAC administration, public ingress, LAN access, tunnels, or mobile apps.
- Org chart, kanban, chat/session multiplexer, agent hiring, or worktree manager.
- Raw journal editing, direct database/file access, or arbitrary provider controls.
- Hard global budget enforcement; beta.2 shows aggregate Receipt statistics only.
- Plugin marketplace, custom dashboard widgets, or third-party browser extensions.
- Background telemetry or product analytics.
- User/project policy editing or a Web-only PolicyStore/`update-policy` command.

### 2.3 Starting new work

Beta.2 does **not** include an arbitrary workflow editor. A user may:

- resume/recompute an existing Run under existing control semantics;
- replay a recorded Run without execution;
- re-run an existing saved Program only if the frozen CLI/MCP `run` contract can be reused byte-for-byte.

The console must not invent a web-only Program format or a browser-only compile path.

---

## §3. Human model

### 3.1 Primary users

| User | Job |
|------|-----|
| Workflow author | Find the failing/stale node, understand inputs and reuse, inspect outputs and evidence. |
| Local operator | See all active work, capacity, ambiguity, provider health, and recover safely. |
| Approval decider | Review the exact request, upstream evidence, policy, and Run version before deciding. |

One OS principal may perform all three roles in beta.2. The UI still uses capabilities returned by ControlHost; it never assumes that opening the page grants every action.

### 3.2 Daily loop

```text
Open console
  → see active / waiting / needs-operator across projects
  → enter one project Run
  → understand graph + timeline + evidence
  → take an authorized command if needed
  → wait for committed result
  → inspect final Receipt
```

### 3.3 Language shown to users

| Internal term | UI wording |
|---------------|------------|
| Project ControlStore | Project ledger |
| UserCoordinatorStore | Local coordinator |
| ControlRegistry | Project directory |
| RunStatus | Outcome state |
| RunStage | Current execution stage |
| BoundPlan | Compiled plan |
| BoundFragment | Dynamically linked fragment |
| Receipt | Verifiable run receipt |
| orphan-suspect | Capacity held — outcome uncertain |
| needs-operator | Needs your attention |

Technical identifiers remain copyable in detail views and error drawers.

---

## §4. System architecture

```text
Browser
  │  static assets + same-origin JSON/SSE
  ▼
WebGateway (ephemeral loopback endpoint)
  │  thin projection + command adapter
  ▼
ControlHost / singleton supervisor
  ├── ControlRegistry ───────── discovery + aggregate projections
  ├── UserCoordinatorStore ─── maxActiveRuns + coordinator commands
  └── Project ControlStore(s) ─ Run/Command/Approval/Receipt authority
                │
                ▼
         ExecutionProvider(s)
```

### 4.1 Boundary rules

1. `taskflow-web` contains browser code and browser-safe view types only.
2. WebGateway is a thin adapter owned by `taskflow-daemon`; it contains no scheduler, linker, approval state machine, or policy engine.
3. Reads come from ControlHost projections or authorized artifact accessors, not filesystem paths supplied by the browser.
4. Mutations call the same command handlers used by CLI/MCP.
5. The web cache is disposable. Reload must reconstruct truth from stores and cursors.
6. WebGateway cannot mint a Receipt; only ControlHost can.
7. Aggregate views are derived. A mutation always resolves and commits against its home authority.

### 4.2 Launch modes

#### Default: coordinated multi-project

```bash
taskflow ui
```

1. Use `controlMode:auto` bootstrap.
2. Attach to or start the existing user singleton.
3. Ask it to expose an ephemeral loopback WebGateway.
4. Mint a fresh host nonce and launch capability; print the exact URL and open the browser unless `--no-open`.

Concurrent `taskflow ui` calls reuse the same singleton and may reuse the same listener, but each launch gets a fresh one-time capability. They must not create a second coordinator or project writer.

Endpoint lifecycle is explicit:

- launch token TTL: 60 seconds, one successful exchange only;
- browser session idle TTL: 30 minutes; absolute TTL: 8 hours;
- each session is revocable; `taskflow ui --stop` revokes all Web sessions and closes the listener;
- after the final unexpired session is gone, the listener closes; daemon restart does **not** reopen it;
- there is no beta.2 config file/env switch that makes WebGateway always-on.

#### Explicit standalone

```bash
taskflow ui --standalone --project /path/to/project
```

- Exactly one project.
- Persistent badge: **Standalone · no cross-project coordination**.
- No aggregate approvals, global capacity editing, or multi-project claims.
- Never selected as a silent fallback from failed `auto` bootstrap.

### 4.3 Process death

- Closing the browser does nothing to Runs.
- WebGateway death does nothing to Runs.
- Daemon restart reconstructs projections from authoritative stores.
- An in-flight command stores only its non-secret `commandId` as URL operation state. On reload/lost response, the browser first calls `GET /api/v1/commands/:commandId` with live authentication. If no authoritative record exists, it refreshes the target and asks for explicit resubmission; it never blindly retries a body from browser storage.

---

## §5. Information architecture

### 5.1 Application shell

```text
┌──────────────────────────────────────────────────────────────────┐
│ Taskflow  project context / connection / capacity / command state│
├──────────────┬────────────────────────────────────┬──────────────┤
│ Overview     │ Main route                         │ Inspector    │
│ Projects     │ lists / graph / timeline / policy │ selected node│
│ Runs         │                                    │ event/action │
│ Approvals    │                                    │              │
│ Attention    │                                    │              │
│ Policy       │ read-only explanation              │              │
└──────────────┴────────────────────────────────────┴──────────────┘
```

- Desktop-first operations UI; minimum fully supported width 1024px.
- At narrower widths, the inspector becomes a drawer. Mutating operator actions may require desktop width; observation remains usable.
- URL may carry non-secret navigation state: project, Run, selected node, tab, filters, and a command operation id (`op`). Replay override bodies, launch/CSRF/session tokens, request hashes, artifact contents, and other sensitive values stay in memory or explicit downloaded JSON—not the URL.

### 5.2 Routes

| Route | Purpose |
|-------|---------|
| `/` | Overview: active Runs, approvals, attention queue, capacity, Receipt stats. |
| `/projects` | Registered projects, mount state, identity/binding health. |
| `/projects/$projectId` | Project summary, effective policy, recent Runs. |
| `/runs` | Aggregate Run list with project identity on every row. |
| `/projects/$projectId/runs/$runId` | Authoritative Run detail shell. |
| `...?tab=graph&node=$nodeInstanceId` | DAG + node/attempt inspector. |
| `...?tab=timeline&cursor=$cursor` | Project event timeline. |
| `...?tab=evidence` | artifacts, cache/reuse explanation, Receipt/assurance. |
| `...?tab=replay` | zero-token what-if replay. |
| `/approvals` | Aggregate refs to pending durable approvals. |
| `/attention` | `unknown/reconciling`, orphan-suspect, store/registry/provider issues. |
| `/policy` | Read-only host/user/project/invocation layers and effective capability explanation. |
| `/settings` | maxActiveRuns, build/protocol info, local session controls. |

The aggregate URL never treats bare `runId` as globally unique. Project identity is part of all authoritative Run routes and commands.

### 5.3 Overview

Required cards:

- Active admitted Runs / `maxActiveRuns`.
- Pending durable approvals.
- Needs-operator count.
- Running, parked, reconciling, terminal counts.
- Receipt-derived cost/token totals for selectable time range, labeled **statistics**.
- Incremental reuse: estimated tokens/USD avoided, with methodology link.
- Project mount health.

All totals show stream state, coverage, and authority independently. Missing/unmounted project stores produce partial-data warnings, not zeroes.

### 5.4 Run detail

The header always shows:

- project name + `projectId`;
- `runId`, BoundPlan/Fragment hash, Program source identity;
- RunStatus **and** RunStage;
- provider and current Attempt;
- created/updated timestamps;
- policy/assurance badges;
- available actions from live capabilities.

Tabs:

1. **Graph** — read-only plan and runtime inventory.
2. **Timeline** — committed events, command causation, provider observations.
3. **Inputs & outputs** — resolved inputs and safe output rendering.
4. **Incremental** — cache hit/miss, fingerprint, `why-stale`, recompute impact.
5. **Evidence** — ArtifactRefs, Receipt, assurance and verification.
6. **Replay** — offline overrides and resulting fold.

---

## §6. DAG and dynamic inventory

### 6.1 Visual grammar

| Visual | Meaning |
|--------|---------|
| Solid node | Node declared in immutable BoundPlan. |
| Nested/attached group | BoundFragment linked at runtime. |
| Dashed template | SpawnTemplate, not yet instantiated work. |
| Numbered child | Dynamic NodeInstance. |
| Ring/badge | Attempt count and current Attempt state. |
| Edge | Dependency/control edge from compiled semantics. |

Color is never the only signal. Every state also has text/icon and accessible name.

### 6.2 Interaction

- Pan/zoom/fit/search.
- Keyboard navigation between nodes and dependencies.
- Click/select opens node inspector without changing execution.
- Filter by status, phase kind, provider, cache, policy decision, or dynamic/static origin.
- “Follow live” is opt-in and pauses when the user manually navigates.
- Large graphs collapse completed subtrees and dynamic groups by default.
- React Flow is configured explicitly read-only: `nodesDraggable={false}`, `nodesConnectable={false}`, `edgesReconnectable={false}`, `elementsSelectable={true}`, `deleteKeyCode={null}`, and no connect/reconnect/delete handlers. A CSS cursor is not a security or immutability boundary. See the official [`<ReactFlow />` API](https://reactflow.dev/api-reference/react-flow).
- The canvas has a synchronized semantic tree/list alternative with node status, dependencies, dynamic origin, attempts, selection, filters, and “open inspector” actions. Every graph task must be completable from this keyboard/screen-reader route; the canvas itself is not the only representation.

### 6.3 Immutability rule

No browser gesture edits BoundPlan topology. Runtime fragments are shown as linked descendants with provenance:

```text
source BoundPlan hash
  → link event / causation id
  → BoundFragment hash
  → instantiated NodeInstances
```

If authoring is added later, it requires a separate compiler-frontend RFC and must round-trip through Taskflow/FlowIR. It cannot be smuggled into this graph component.

---

## §7. Authoritative views and browser DTOs

### 7.1 Projection envelope

Browser DTOs are derived views, not new domain entities. The names below are frozen by P17/TypeBox; there is no second illustrative envelope:

```ts
type WebSuccess<T> = {
  ok: true;
  requestId: string;
  schemaVersion: "web.v1";
  data: T;
};

type WebFailure = {
  ok: false;
  requestId: string;
  schemaVersion: "web.v1";
  error: ControlError;
};

type WebObservationState = {
  streamState: "connected" | "catching-up" | "disconnected";
  coverage: "complete" | "partial";
  authority: "verified" | "unverified";
  observedAt: number; // Unix ms
  registryRevision?: string;
};
```

Closed command/security schemas reject unknown properties. Presentation DTO compatibility follows P17; the browser never treats a successfully parsed projection as mutation authority.

### 7.2 Required views

| View | Authoritative inputs |
|------|----------------------|
| `BootstrapView` | negotiation, buildInfo, principal, mode, offered capabilities, UI session. |
| `CoordinatorSummary` | UserCoordinatorStore lease/capacity/reservations. |
| `ProjectSummary` | Registry entry plus verified project-store header/open status. |
| `RunSummary` | project Run projection. |
| `RunDetail` | Run projection + BoundPlan/Fragments + node/attempt projections. |
| `ApprovalSummary` | reference plus live read from approval’s home project store. |
| `AttentionItem` | derived actionable condition with recoveryAction and sideEffects. |
| `ReceiptView` | immutable Receipt plus current artifact verification result. |
| `PolicyExplanation` | host/user/project/invocation intersection and decisions. |

### 7.3 Aggregate correctness

- Cross-project list order is a convenience sort by recorded timestamps, not a global causal order.
- No aggregate row may expose a synthetic global `commitSeq`.
- Each row includes project identity and its own watermark.
- The opaque cursor is a signed/MACed vector checkpoint bound to protocol version, principal hash, normalized query hash, stable sort, registry revision, and every visible project’s `(nextCommitSeq, minAvailableCommitSeq)`.
- Ordering is total: requested sort key, then `projectId`, `controlDomainId`, and `runId`; arrival order is never a tie-breaker.
- Registry/mount-set change, principal/query/sort mismatch, expiry, tampering, or compaction past a saved watermark returns `TF_CURSOR_EXPIRED`; the browser discards the aggregate snapshot and checkpoint-resyncs.
- Clicking a row refreshes it from the home Project ControlStore before enabling mutation.
- Registry/index loss may make aggregate lists incomplete; reopening a project rebuilds discovery as specified by P3.
- Search results display all three observation axes and may not authorize actions by themselves. `connected` does not imply complete coverage or verified authority.

---

## §8. Browser transport

### 8.1 Endpoint model

The browser API is local and versioned under `/api/v1`. P17—not P1–P16—owns its exact success/error envelopes, request/query DTOs, pagination, auth, SSE, and artifact contract. The canonical implementation is `packages/taskflow-control/src/web-protocol.ts`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/session/exchange` | Exchange one-time launch capability for browser session. |
| `GET` | `/api/v1/bootstrap` | Negotiation, build, principal, mode, capability summary. |
| `GET` | `/api/v1/projects` | Registry-backed project list. |
| `GET` | `/api/v1/runs` | Aggregate filtered Run list. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId` | Authoritative Run detail projection. |
| `GET` | `/api/v1/approvals` | Aggregate approval refs with three-axis observation state. |
| `GET` | `/api/v1/attention` | Needs-operator and health queue. |
| `GET` | `/api/v1/policy/explanation` | Read-only effective policy decisions. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/artifacts/:digest` | Authorized, ledger-reachable artifact read. |
| `GET` | `/api/v1/events` | SSE stream with opaque resumable cursor. |
| `POST` | `/api/v1/commands` | All project/coordinator mutations. |
| `GET` | `/api/v1/commands/:commandId` | Live-reauthorized durable command outcome/recovery. |

JSON success is `{ok:true, requestId, schemaVersion:"web.v1", data}`; failure is `{ok:false, requestId, schemaVersion:"web.v1", error:ControlError}`. Default page limit is 50, maximum 200. No endpoint accepts a ControlStore path, arbitrary filesystem path/URL, principal id, or caller-selected authority location.

### 8.2 Command envelope

`WebCommandRequest` is a closed TypeBox discriminated union; there is no `payload: unknown` escape hatch:

| `kind` | Required command fields beyond `commandId` |
|--------|--------------------------------------------|
| `approve` | project/domain/Run ids, `expectedRunVersion`, `approvalRequestId` |
| `reject` | same approval identity plus optional reason |
| `edit-approval` | same approval identity, `editKind`, content-addressed edit artifact digest |
| `cancel-run` | project/domain/Run ids, `expectedRunVersion`, optional reason |
| `resume-run` | project/domain/Run ids, `expectedRunVersion` |
| `recompute-run` | project/domain/Run ids, `expectedRunVersion`, non-empty unique phase ids |
| `reconcile-run` | project/domain/Run ids, `expectedRunVersion` |
| `set-max-active-runs` | value, expected current value, expected coordinator epoch |
| `force-release` | reservation id, expected state/revision/coordinator epoch/project/Run, exact acknowledgement |

`update-policy` is intentionally absent. Unknown fields and unknown command kinds fail closed.

### 8.3 Mutation rules

1. Generate `commandId` before submit and retain it until a committed outcome is read.
2. Disable repeat submission visually, but correctness relies on server idempotency, not the button.
3. While the original body remains in live memory, uncertain transport may retry with the same `commandId` and identical body. After reload, query `GET /commands/:commandId` first; absent record requires target refresh and explicit resubmission, never blind body recovery.
4. Re-authorize every command against current principal and current project authority.
5. Use `expectedRunVersion` for approval and stale-sensitive mutations.
6. Render `TF_STALE_VERSION` as “state changed; refresh and decide again,” never auto-retry with a new version.
7. Do not optimistically mark approve/cancel/resume/force-release as successful.
8. A success toast describes the committed command outcome only. `approve` success means re-queued/re-reserved—not completed; `cancel` success is terminal only after provider quiescence proof.

### 8.4 Command-specific safeguards

| Command | Required safeguard |
|---------|--------------------|
| approve/reject/edit | Live approval detail, audience auth, expectedRunVersion, race result. |
| cancel | First win durable CAS, then ask provider; only proven quiescence may produce `cancelled/terminal`. Missing/ambiguous handles become `unknown/reconciling`, hold capacity, and create no Receipt. |
| resume/recompute | Show phases affected, expected token/cost impact when knowable, and required re-admission. |
| reconcile | Show last provider observation and bounded automation history. |
| set-max-active-runs | CoordinatorCommandRecord + expected value/epoch; atomically **reject** a value below current occupancy. |
| force-release | Operator capability + exact reservation state/revision/epoch/project/Run CAS + exact typed acknowledgement; mark guarantee `operator-overridden`. |

The WebUI never offers “mark failed,” “mark completed,” “free slot,” or “issue Receipt” shortcuts.

---

## §9. Live observation and cursors

### 9.1 SSE, not a second event system

SSE transports committed control observations to the browser. It is not itself the journal and cannot be replay authority.

```text
ControlStore commit / Registry revision / coordinator change
  → authorized web event envelope
  → SSE
  → query-cache patch or invalidation
  → periodic/checkpoint verification
```

### 9.2 Closed SSE frame union

```ts
type WebStreamFrame =
  | { type: "checkpoint"; id: string; cursor: string; observedAt: number;
      registryRevision: string; projectWatermarks: WebProjectWatermark[] }
  | { type: "change"; id: string; cursor: string; observedAt: number;
      kind: string; resourceType: string; resourceId: string;
      projectId?: string; controlDomainId?: string; commitSeq?: number;
      registryRevision?: string }
  | { type: "heartbeat"; id: string; cursor: string; observedAt: number }
  | { type: "reset-required"; id: string; cursor: string; observedAt: number;
      error: ControlError };
```

The SSE `id` equals the opaque cursor. The frame normally invalidates/refetches an authoritative view. Large outputs, artifacts, secrets, and full journal payloads are not pushed through SSE.

### 9.3 Reconnect

- Browser reconnects with its last opaque cursor.
- `TF_CURSOR_EXPIRED` triggers checkpoint/bootstrap refetch, then a new stream.
- Reconnect is bounded with backoff and visible connection status.
- No duplicate event may duplicate a command side effect; events only update projections.
- If SSE is unavailable, use bounded low-frequency polling and show degraded-live status.
- Multi-tab sessions may each observe; server idempotency/CAS arbitrates mutations.

### 9.4 Observation truth has three axes

Every live page independently shows:

- **streamState:** `connected | catching-up | disconnected`;
- **coverage:** `complete | partial`;
- **authority:** `verified | unverified`.

This prevents “SSE connected” from being misread as “all project stores present” or “this row is authoritative.” Partial coverage or unverified authority never enables a mutation without a successful home-store refresh.

---

## §10. State presentation

### 10.1 Status × stage matrix

| RunStatus | RunStage | UI meaning | Terminal? | Slot expectation |
|-----------|----------|------------|-----------|------------------|
| `running` | `executing` | Worker active | No | held |
| `paused` | `parked` | Durable approval waiting; provider quiescent | No | released via D37/D38 |
| `paused` | `executing` | Cancel/stop in progress while work may be live | No | held |
| `unknown` | `reconciling` | Provider outcome ambiguous | **No** | held/orphan-suspect |
| terminal status | `terminal` | Proven completion/failure/block/cancel | Yes | released only via D37 |

The UI must never collapse the first four rows into a single “not running” state.

### 10.2 Attention queue

An `AttentionItem` contains:

- what is uncertain or blocked;
- affected project/Run/reservation;
- last proven observation;
- current `recoveryAction` and `sideEffects` level;
- safe next actions allowed by capability;
- whether capacity remains held;
- link to CommandRecord/event evidence.

`unknown/reconciling` remains visible until reconciled or explicitly force-released. Dismissing a UI notification does not resolve authority state.

### 10.3 Receipt presentation

- Show final Receipt only when one exists.
- While running/reconciling, label available material **checkpoint evidence**, never “receipt pending success.”
- Display event manifest/root, commit bounds, artifact refs, buildInfo, provider outcome, integrity, provenance, and enforcement assurance.
- Re-verification may report an artifact as missing/unknown without mutating the immutable Receipt.
- Export downloads a stable JSON artifact; printed/pretty view is derived.

---

## §11. Approval UX

### 11.1 Inbox

Aggregate inbox rows are references into project stores:

- project and Run identity;
- requested action/message;
- owner/audience;
- created/deadline;
- current RunStatus/Stage;
- stream/coverage/authority state and expected Run version.

Opening a row refreshes the authoritative request before actions appear.

### 11.2 Decision screen

Required context before deciding:

- exact approval message and allowed decisions;
- relevant upstream output/artifacts, subject to authz/redaction;
- BoundPlan/Fragment hash;
- policy/capability explanation;
- timeout policy and deadline;
- race warning if another client may decide.

### 11.3 Race semantics

- Approve/reject/edit uses P15 CAS.
- First committed decision wins.
- Losing clients receive stale/race state and refresh.
- Approve commits `running/queued` plus a re-reservation and then awaits the normal dispatcher/provider path. It never writes `completed/terminal` or a Receipt merely because a human approved.
- Cancel-first makes later approval fail as cancelled.
- Approval-first may still be followed by an authorized Run cancel.
- Timeout never defaults to approve.

### 11.4 Edit

- Edit output: schema-aware editor, OutputContract validation, diff preview.
- Edit plan: only if P15 exposes the existing re-Link contract; otherwise beta.2 renders it unavailable.
- WebUI does not implement an independent plan editor.

---

## §12. Incremental and replay UX

### 12.1 Why-stale

For a selected node, show:

- prior executionSemanticHash versus current candidate;
- which semantic inputs changed;
- cache scope/TTL/fingerprint state;
- upstream invalidation path;
- policy/authority reason preventing reuse;
- estimated recompute fan-out.

Do not claim exact money saved when provider pricing or token counter is missing. Label estimates and methodology.

### 12.2 Recompute

Before submit:

- highlight the transitive downstream set;
- show phases expected to be reused versus re-executed;
- show re-admission/policy implications;
- require confirmation if a completed Run will create live work.

### 12.3 What-if replay

Replay is explicitly separated from live execution:

```text
Recorded events + local overrides → replayRun fold → hypothetical result
```

- Persistent banner: **Simulation · zero-token · no provider calls**.
- Override bodies remain in memory and are exportable only through an explicit JSON download/copy action. The URL may contain a non-sensitive local scenario label, never the override body.
- Results compare original versus hypothetical gate/when/tournament decisions.
- “Apply and execute” is not part of beta.2 unless it goes through existing resume/recompute commands with a new explicit confirmation.

---

## §13. Policy and capability UX

### 13.1 Explanation first

Show the four layers independently:

```text
host ∩ user ∩ project ∩ invocation = effective authority
```

For each agent/model/tool/root/budget/provider capability, show:

- source layer;
- allowed/denied/substituted/attenuated result;
- canonical decision reason;
- authoritative layer provenance and the current principal’s effective capability.

Catalog availability must not be displayed as permission.

### 13.2 Read-only beta.2 boundary

P1 defines how host/user/project/invocation policy is intersected and recorded. It does not define an authoritative persistent PolicyStore, policy revision protocol, or `update-policy` command. Therefore beta.2 renders every layer and its provenance read-only. It may link to the authoritative file/CLI workflow when one is separately defined, but it cannot save, patch, or invent policy state.

Policy editing requires a separate ADR that names the authority, atomic persistence, revisions/CAS, command/event audit, validation, rollback, and cross-process behavior. Until then, no edit control or hidden API exists.

### 13.3 Revocation truth

When policy changes through an external authoritative mechanism, the UI distinguishes:

- new admissions denied;
- live work awaiting bounded-latency mediation;
- best-effort cancellation requested;
- provider state unknown;
- verified quiescence.

It must not imply that saving policy instantly killed already-running external processes unless assurance proves it.

---

## §14. Local security model

### 14.1 Network exposure

- Bind `127.0.0.1` on an OS-selected port. The browser origin is an unpredictable 128-bit Base32 hostname: `http://<hostNonce>.localhost:$PORT`.
- Require the exact `Host: <hostNonce>.localhost:$PORT` and exact matching `Origin` on browser API requests; reject `localhost`, `127.0.0.1`, alternative ports/hosts, forwarded-host overrides, and DNS-rebinding patterns.
- Do not listen by default; endpoint exists only after explicit `taskflow ui`, and follows the W5 session/listener lifecycle.
- No `--host 0.0.0.0` escape hatch in beta.2.
- WebGateway does not replace the retained UDS/named-pipe daemon control transport.

### 14.2 Browser session bootstrap

1. CLI requests a random 256-bit, 60-second, single-use launch capability from the authenticated local daemon.
2. CLI opens `http://<hostNonce>.localhost:$PORT/#launch=$TOKEN`.
3. SPA exchanges the fragment token over same-origin POST.
4. Server rotates it into a host-only cookie with an unpredictable per-listener name, `HttpOnly`, `SameSite=Strict`, and `Path=/`; beta.2 uses HTTP loopback and does not falsely claim a `Secure` cookie. The session is additionally bound to the exact host nonce and port.
5. SPA removes the fragment immediately; token is never stored in localStorage/sessionStorage.

Cookies for one host are shared across ports, so port choice alone is not isolation ([RFC 6265 §8.5](https://datatracker.ietf.org/doc/html/rfc6265#section-8.5)). The unpredictable hostname, cookie name, exact Host/Origin checks, CSRF token, and session binding are one combined defense. Query-string bearer tokens and long-lived localStorage tokens are forbidden.

### 14.3 Request defenses

- Exact Origin validation plus the host-only SameSite cookie and per-session CSRF header/token for mutations.
- Content Security Policy: self only; no remote scripts, frames, fonts, or connections.
- `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, strict referrer policy.
- 30-minute idle and 8-hour absolute session TTL; explicit “revoke browser sessions.”
- Capability checks on every request, not only at page load.

### 14.4 Content safety

- Agent output renders as plain text/code by default.
- Optional Markdown renderer forbids raw HTML, scripts, iframes, event handlers, and automatic remote media loads.
- Artifact MIME type and disposition are enforced server-side.
- Artifact responses set canonical `Content-Type`, `Content-Length`, digest `ETag`, `X-Content-Type-Options: nosniff`, restrictive CSP, `Cache-Control: no-store`, and sanitized `Content-Disposition`; beta.2 rejects Range requests.
- SecretRef values are never returned.
- ArtifactRef digest is not a bearer; access requires current authz and ledger reachability.
- Sensitive output is excluded from browser persistence and service-worker caches. Beta.2 has no service worker/offline cache.

---

## §15. Frontend architecture and toolchain

### 15.1 Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| UI runtime | React 19.2 | Matches the repository’s current frontend generation and mature ecosystem. |
| Build | Vite 8.1 | Static SPA, Rolldown-based build, no second production server. |
| Language | TypeScript 7 | Aligns with the 0.3 root toolchain; no TS compiler-API dependency. |
| Local gateway | Node 22 `node:http` + native Web Streams/SSE | Keep the daemon adapter small; no Express/Fastify or second application framework. |
| Routing | TanStack Router | Typed path/search state for project/Run/node/replay deep links. |
| Server state | TanStack Query | Snapshot cache, mutation state, and SSE-driven invalidation. |
| DAG | `@xyflow/react` | Interactive graph primitives; beta.2 remains read-only and owns its accessibility acceptance. |
| Styling | Tailwind CSS 4 + local tokens | Reuse current repo baseline; no runtime CSS-in-JS. |
| Icons | `lucide-react` | Reuse current repository dependency. |
| Formatting/lint | Biome 2 | Reuse website baseline. |
| Tests | Vitest + Testing Library + Playwright | Unit/component plus real browser/daemon acceptance. |

Version families are architectural choices; exact patches are pinned in `pnpm-lock.yaml` at scaffold time. Current official references: [React releases](https://react.dev/versions), [Vite 8.1](https://vite.dev/blog/announcing-vite8-1), [TanStack Router](https://tanstack.com/router/latest/docs/framework/react), and [React Flow](https://reactflow.dev/learn).

### 15.2 Why not reuse the Next.js website runtime

- Console has no SEO, SSR, RSC, or public content-delivery requirement.
- A Next server would create another long-lived Node server beside taskflowd.
- Static assets served by the authenticated WebGateway keep one local origin and one process authority.
- Documentation website and operational console have different deployment/security boundaries.

Shared visual tokens/components may be extracted later; production runtimes remain separate.

### 15.3 State ownership

```text
URL/search params       → navigable local view state
TanStack Query cache    → disposable server projection cache
React component state  → ephemeral interaction state
ControlHost/stores      → all durable domain truth
```

No general client store is added initially. Add one only if a measured cross-route client-state problem cannot be represented by URL or query cache.

### 15.4 Rendering strategy

- Route-level code splitting.
- DAG/large artifact viewers lazy-loaded.
- Virtualized Run/event/approval lists.
- Web Worker for expensive graph layout when graph size crosses threshold.
- SSE events invalidate narrow query keys; avoid refetching the entire console on every event.
- React transitions may preserve interaction responsiveness, but must not hide committed-state freshness.

---

## §16. Package layout

```text
packages/
├── taskflow-web/
│   ├── src/
│   │   ├── routes/          # typed route tree
│   │   ├── api/             # browser protocol client + schemas
│   │   ├── features/
│   │   │   ├── overview/
│   │   │   ├── projects/
│   │   │   ├── runs/
│   │   │   ├── graph/
│   │   │   ├── approvals/
│   │   │   ├── attention/
│   │   │   ├── replay/
│   │   │   └── policy/
│   │   ├── components/
│   │   └── styles/
│   ├── test/
│   └── dist/                # static assets + asset manifest
├── taskflow-control/
│   └── src/web-protocol.ts  # browser-safe TypeBox contracts; no node:* imports
├── taskflow-daemon/
│   └── src/web/
│       ├── gateway.ts       # loopback HTTP/SSE thin adapter
│       ├── session.ts       # launch/session/CSRF
│       ├── projections.ts   # ControlHost → DTO only
│       └── assets.ts        # serve taskflow-web dist
└── taskflow-cli/
    └── src/ui.ts            # taskflow ui launch command
```

### 16.1 Import constraints

- `taskflow-web` may import only browser-safe protocol/type exports from `taskflow-control/web-protocol`.
- `web-protocol.ts` may depend on TypeBox and leaf types but must not import `node:*`, stores, providers, daemon, or runners.
- WebGateway may call public ControlHost services; it must not reach into store implementation files.
- A CI import-lint guards both boundaries.
- Static assets are packaged reproducibly; no runtime CDN dependency.

### 16.2 Published artifacts

- `taskflow-web` ships immutable hashed assets and an asset manifest.
- `taskflow-daemon` declares the compatible web asset/protocol version.
- `taskflow ui` checks daemon/web compatibility before opening.
- Development may use Vite HMR through a proxy; production always uses built assets and the real WebGateway contract.

---

## §17. Failure and recovery UX

| Condition | Required behavior |
|-----------|-------------------|
| Daemon unavailable in `auto` | Show bootstrap failure and explicit recovery; never silently create standalone authority. |
| Protocol incompatible | Blocking compatibility page with client/daemon buildInfo and upgrade action. |
| SSE disconnected | Set `streamState=disconnected`; retain snapshot without claiming authority, reconnect with backoff, disable mutations until home refresh. |
| Cursor expired | Fetch checkpoint/bootstrap, replace projections, resubscribe. |
| Registry partial/lost | Mark aggregate coverage partial; project reopen rebuilds identity from store header. |
| Project moved/copied/worktree conflict | Show binding evidence and only authorized P3 rebind/adopt actions. |
| Command HTTP response lost | Query `GET /commands/:commandId`; retry an identical body only while it remains in live memory. Show “outcome checking,” not failure. |
| `TF_STALE_VERSION` | Refresh exact object and require a new human decision. |
| Provider ambiguous | `unknown/reconciling`, capacity held, attention item; no fake terminal. |
| Artifact missing after retention | Receipt remains immutable; integrity displays `unknown`. |
| Browser reload during mutation | Recover the non-secret `op=commandId`, query the durable CommandRecord with live authz; absent record requires refresh + explicit resubmit. |

Errors display `code`, `recoveryAction`, `sideEffects`, affected authority, and copyable correlation/command ids. Raw stack traces are developer details, not the primary message.

---

## §18. Accessibility, privacy, and performance budgets

### 18.1 Accessibility

- WCAG 2.2 AA target for hard-GA routes.
- Full keyboard operation for navigation, lists, dialogs, approvals, and graph selection.
- Visible focus, reduced-motion support, semantic headings/landmarks, screen-reader live regions for command results.
- Status never communicated by color alone.
- Destructive confirmations name the project, Run, and consequence.

### 18.2 Privacy

- No analytics/telemetry in beta.2.
- No remote assets or automatic remote URL fetches from agent output.
- No service worker or offline persistence.
- Query cache lives in memory and is cleared on logout/session expiry.
- Sensitive replay/command/session material never enters route/search state or browser persistence.
- Copy/export actions are explicit and respect redaction class.

### 18.3 Performance budgets

Measured on a supported local Node/browser environment:

- Initial shell JavaScript: ≤ 250 KiB gzip; graph/artifact features lazy-loaded.
- Warm local overview interactive: ≤ 1.5 s p95 with 100 projects / 10,000 Run summaries.
- Committed event to visible state: ≤ 250 ms p95 on loopback while SSE is healthy.
- Run/event lists remain responsive at 10,000 rows through virtualization.
- Graph remains navigable at 2,000 visible nodes; larger inventories start collapsed/filtered and use worker layout.
- No unbounded browser retention of event history; timeline pages/cursors are bounded.

If a budget proves unrealistic, change it with measured evidence in this RFC rather than silently dropping the test.

---

## §19. Testing strategy

### 19.1 Contract tests

- TypeBox request/response validation for every browser endpoint and command.
- Browser-safe import lint (`node:*` forbidden transitively).
- Golden semantics shared across CLI/MCP/Web: same command → same ControlHost result/error.
- RunStatus × RunStage full matrix.
- Aggregate cursor tamper/expiry/principal/query/sort/registry/compaction matrices; no global sequence invention.
- Approval success is `running/queued` with a held reservation and no Receipt until provider terminal truth.
- Cancel with missing/ambiguous provider proof is `unknown/reconciling`, holds capacity, and creates no Receipt.
- Lowering maxActiveRuns below occupancy rejects atomically; force-release compares the full reservation CAS and is idempotent.

### 19.2 Component tests

- Loading, empty, disconnected, partial, unverified, forbidden, incompatible, and error states for every hard-GA route.
- Keyboard/focus behavior and automated accessibility checks.
- Graph selection, dynamic fragment grouping, and large-graph collapse.
- React Flow interaction props stay read-only and the synchronized semantic tree completes the same navigation/inspection tasks.
- Approval and destructive confirmation content.
- No raw HTML/script/remote media execution from hostile agent output.

### 19.3 Real integration tests

Use temp project ControlStores and a real taskflowd/WebGateway process:

1. launch `taskflow ui --no-open`;
2. exchange one-time session;
3. mount at least two projects;
4. create/observe Runs through ControlHost;
5. reconnect SSE from cursor;
6. issue web commands and verify CommandRecords/events in home stores;
7. restart daemon and prove projections/commands recover;
8. verify browser never writes store files directly.
9. let every session expire and prove the listener closes; restart daemon and prove it does not reopen.

### 19.4 Adversarial matrices

- Two tabs approve/reject same request.
- Cancel versus approval race.
- Command committed but HTTP response lost.
- Cursor expiration during high event volume.
- Registry wipe and project reopen.
- Project copy/worktree identity conflict.
- Provider ambiguity and force-release.
- Launch/session theft and replay, hostile `localhost`, cross-port cookie injection, exact Host/Origin, CSRF, DNS rebinding, malicious output, artifact path traversal.
- 100 projects × 10,000 Runs × partial mounts.

Mock-only success is not beta.2 acceptance.

---

## §20. Release and GA gates

### 20.1 Product commitment

- [ ] Publish a local console in `0.3.0-beta.2`; do not relabel the whole product as 0.3.1 to avoid finishing its safety baseline.
- [ ] Keep project ControlStores authoritative and the browser disposable; no merged user-level Run ledger or Web-only state machine.
- [ ] Keep policy explanation read-only until a separate authoritative policy persistence ADR exists.

### 20.2 Hard 0.3.0 GA core

These capabilities must be complete—not hidden—before 0.3.0 GA:

- [ ] `taskflow ui` explicitly launches/attaches the singleton; no listener before launch, public/LAN path, daemon-restart reopen, or silent standalone fallback.
- [ ] P17 session/Host/Origin/CSRF/cursor/artifact contract and hostile-local-process matrix pass against packaged dist.
- [ ] Overview accurately aggregates multiple project stores and independently labels stream state, coverage, and authority.
- [ ] Project and Run routes always carry project identity; aggregate Run list, authoritative Run detail, timeline, read-only DAG/dynamic inventory, and semantic accessibility tree work.
- [ ] RunStatus × RunStage remains truthful, especially `paused/parked`, `paused/executing`, and `unknown/reconciling`.
- [ ] Approval inbox and approve/reject/edit use P15 CAS; approve re-queues/re-reserves and waits for provider outcome before terminal/Receipt.
- [ ] Cancel is a durable idempotent command; terminal cancel requires quiescence proof, while ambiguous/missing provider knowledge holds capacity and surfaces attention.
- [ ] Read-only effective policy explanation shows provenance and deny/substitute/attenuate decisions without implying edit authority.
- [ ] Receipt/evidence never appears before true terminal outcome; artifact reads require live authz + ledger reachability and never disclose SecretRefs.
- [ ] Stop/rollback of WebGateway changes no Run/store truth; browser reload and lost response recover through command query, not blind retry.

### 20.3 Capability-gated high-risk writes

The first beta.2 and GA may omit these controls without violating the product commitment. A control is **entirely hidden** unless its backend advertises the live capability and its independent matrix is green; a disabled button, experimental query flag, or direct hidden API is not omission.

| Capability | Independent enablement gate |
|------------|-----------------------------|
| resume/recompute | Durable idempotency, re-admission, affected-set preview, cost caveat, restart/lost-response tests |
| manual reconcile | Bounded provider history, no fake terminal, unknown/needs-operator recovery tests |
| set maxActiveRuns | CoordinatorCommandRecord, expected value/epoch, atomic reject-below-occupancy, multiprocess tests |
| force-release | Full reservation state/revision/epoch/project/Run CAS, exact ack, idempotency, operator-overridden audit |
| re-run saved Program | Exact frozen CLI/MCP run contract; no web-only compiler path |

Policy editing is not in this table: it is out of scope, not a hidden capability.

### 20.4 Quality follow-through

- [ ] Receipt JSON export and local verification UX.
- [ ] Large-graph performance target and full keyboard/tree parity.
- [ ] Cross-browser matrix on supported current Chrome/Edge, Firefox, and Safari.
- [ ] Why-stale and zero-token replay remain visibly distinct from live execution.

Any attempt to weaken the hard GA core or promote a high-risk write without its gate is an explicit product/architecture re-decision, not a schedule interpretation.

---

## §21. Implementation order

```text
0. Validate Web consumer needs; freeze P17 independently from P1–P16
1. Browser-safe TypeBox protocol + projection/command/query/cursor/SSE/artifact contract tests
2. taskflow ui + loopback WebGateway + session/CSRF/CSP
3. Static React/Vite shell + typed routes + bootstrap/compatibility
4. Projects + aggregate Runs + three-axis observation model
5. Run detail + timeline + SSE cursor/reconnect
6. Read-only DAG + dynamic inventory + node/attempt inspector
7. Approvals + truthful cancel command UX (hard GA core)
8. Capability-gated resume/recompute/reconcile/maxActiveRuns/force-release
9. Incremental why-stale + zero-token replay + Receipt/evidence
10. Read-only policy explanation
11. Security/a11y/performance/adversarial matrices
12. Packaged-dist real-daemon E2E + 0.3.0-beta.2 publish
```

The WebUI starts after the control wire and thin CLI surfaces are coherent. Browser-consumer requirements belong in P17 rather than being retroactively attributed to P1–P16.

---

## §22. Release, compatibility, and rollback

### 22.1 Versioning

- First release: `0.3.0-beta.2`.
- `taskflow-web`, `taskflow-daemon`, `taskflow-cli`, and browser protocol advertise compatible build/protocol versions.
- Web assets and daemon API must come from a compatible release set; mixed incompatible versions fail closed with upgrade guidance.
- The console graduates into 0.3.0 GA; it is not described as a 0.3.1 feature.

### 22.2 Compatibility

- Browser UI does not weaken D21 CLI/MCP compatibility.
- 0.2.x project evidence remains imported/read according to the master migration contract; WebUI does not execute against a foreign 0.2 writer.
- Unknown browser fields are ignored only in non-security presentation DTOs; command/security schemas fail closed according to P4/P1.

### 22.3 Rollback

- Disable/stop the WebGateway and continue with CLI/MCP.
- Browser caches are disposable and contain no required state.
- Beta.2 introduces no WebUI-only authority store and no WebUI-only Run state.
- If beta.2 adds projection indexes, they are rebuildable and may be deleted without losing project truth.
- Store rollback remains governed by the 0.3 master RFC; the UI cannot promise a stronger rollback tier.

---

## §23. Decisions intentionally deferred

These are not beta.2 holes:

| Topic | Earliest follow-up |
|-------|--------------------|
| Visual/AI workflow authoring and a third compiler frontend | Separate compiler/authoring RFC |
| Hosted multi-user console and RBAC | Separate network/security architecture |
| Remote browser access/tunnels | Separate threat model; not a hidden flag |
| Mobile operator app | Post-GA product decision |
| Custom dashboards/plugins | Post-GA extension model |
| Cross-project workflow/atomic coordinator Receipt | Separate coordinator-domain RFC |
| Hard global budget | Separate authority/accounting RFC |

---

## §24. Structured status

```text
Release placement: Approved by product direction — 0.3.0-beta.2
Product identity: Proposed — local observe/govern console, not authoring frontend
Browser transport: Proposed — on-demand loopback JSON/SSE
Frontend stack: Proposed — React 19.2 + Vite 8.1 static SPA
Authority model: Inherited/frozen from control-plane RFC v7.7+
Browser wire: P17 accepted as beta.2 implementation baseline; web.v1 TypeBox surface exists
Implementation: WebGateway/UI not started; next gate is exact session/Host/Origin threat-model tests
```

---

*End RFC v2. The beta.2 console exists to make the 0.3 control plane observable, governable, and provable—not to create another workflow language or another source of truth.*
