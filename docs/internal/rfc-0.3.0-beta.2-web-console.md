# RFC: taskflow 0.3.0-beta.2 — Local Task Workspace + Pro Console

> **Document version:** v7 (PROPOSED)
> **Release placement:** **0.3.0-beta.2** — not 0.3.1
> **Branch:** `codex/0.3.0-beta.2` (dedicated worktree; based on `feat/0.3.0`)
> **Date:** 2026-07-23
> **Decision already made:** WebUI enters the 0.3.0 prerelease train at beta.2.
> **Decision requested by this RFC:** approve the simple-by-default product model, Pro progressive disclosure, deterministic Task/verification/content projection, UI/UX quality bar, beta.2 minimum delivery contract, browser/static transport, frontend architecture, authoritative read-model boundary, joint reference-screen/copy/golden-fixture gate, and acceptance matrix.
>
> **Normative dependencies:** [`rfc-0.3.0-control-plane.md`](./rfc-0.3.0-control-plane.md) v7.7+ and [`P17-browser-protocol.md`](./p-adrs/P17-browser-protocol.md) v5.
> P1–P16 remain authoritative for core control-plane semantics. **P17 v5 provisionally owns the target HTTP/browser contract and deterministic Simple presentation/content projection.** [`web-protocol.ts`](../../packages/taskflow-control/src/web-protocol.ts) becomes its canonical executable surface only after the v5 conformance delta and fixtures pass. This RFC defines the product and implementation boundary; it does not create a second execution or authority model. P17 is not wire-frozen until its handlers, projection functions, content catalogs, codecs, compatibility fixtures, static-delivery tests, and hostile-input tests pass.

---

## §0. TL;DR

`taskflow-web` is a **simple-by-default local task workspace** backed by the complete 0.3 control plane:

```text
many project ControlStores
          ↓ mounted by the existing singleton
one calm task-first workspace
          ├── Simple (default): Tasks · Needs your input · Results
          └── Pro (opt-in): DAG · timeline · evidence · policy · recovery
```

It is **not** a workflow authoring IDE and **not** a third compiler frontend in beta.2.
It presents already-compiled Programs, BoundPlans, Runs, events, and Receipts as approachable tasks while preserving the same `ControlHost` semantics used by CLI and MCP.

The console is opened explicitly with `taskflow ui`. It binds an ephemeral server to loopback only, serves a static SPA and a same-origin JSON/SSE adapter, and never becomes the source of truth. No default network listener, no direct browser access to ControlStore files, no cloud account, and no telemetry in beta.2.

The visual and interaction quality target is deliberately close to the calm, content-first product language associated with OpenAI and Anthropic: restrained chrome, strong typography, generous spacing, one clear next action, and complex material in a dedicated secondary pane. It does **not** copy their trademarks, proprietary fonts, logos, or exact trade dress.

### Proposed beta.2 baseline

The release placement is a product decision already made. The remaining W-decisions below are the coherent baseline submitted for approval by this PROPOSED RFC; calling them “frozen” would incorrectly imply the RFC itself had already been accepted.

| ID | Decision |
|----|----------|
| **W1** | Ship the first WebUI beta in **0.3.0-beta.2** and keep a local console in the 0.3 release train. GA scope is split in §20 instead of making every experimental write a hard gate. |
| **W2** | Product identity: **local task workspace with an opt-in Pro console**, not a default operations dashboard and not a visual workflow builder. |
| **W3** | Browser state is a projection/cache only. Project ControlStore remains Run/Command/Approval/Receipt authority; UserCoordinatorStore remains coordinator-command/concurrency authority. |
| **W4** | Default UX is multi-project through the existing `controlMode:auto` singleton. Explicit standalone is single-project and visibly degraded. No silent auto→standalone fallback. |
| **W5** | `taskflow ui` starts an **on-demand loopback-only** endpoint at an unpredictable `<nonce>.localhost` host. No listener exists before explicit launch; it closes after the final session expires or explicit `taskflow ui --stop`. No always-on config, `0.0.0.0`, LAN, or remote mode in beta.2. |
| **W6** | Static SPA + same-origin JSON commands + SSE observations. Browser never speaks UDS or edits disk stores directly. |
| **W7** | Every **control-plane domain mutation** is a durable, idempotent control command with `commandId`, live authorization, and CAS/version checks where required. Session exchange/revocation is ephemeral security state; why-stale, replay, and recompute preview are pure analysis and never masquerade as commands. No destructive optimistic UI. |
| **W8** | Aggregate views do not invent a global `commitSeq`. Each row/event retains its `projectId`, `controlDomainId`, and project watermark; page and stream cursors are distinct and opaque. |
| **W9** | RunStatus and RunStage remain separate. `unknown/reconciling` is never rendered as failed or terminal; no final Receipt is shown before one exists. |
| **W10** | DAG view is read-only. Dynamic BoundFragments and NodeInstances appear as runtime inventory, never as mutations to the immutable BoundPlan. |
| **W11** | Stack: React 19.2 + Vite 8.1 static SPA + TypeScript 7 + TanStack Router/Query + React Aria Components + CSP-safe native SVG for the read-only DAG; Node ≥22.19 compatibility, Node 24 LTS primary, Node 26 forward CI; no Next.js server or SSR. |
| **W12** | No remote fonts, analytics, CDN scripts, raw HTML rendering, or secret material in browser storage. |
| **W13** | Policy is **explanation-only** in beta.2. P1 defines evaluation/overlay semantics, not a writable PolicyStore or policy command; WebUI does not invent one. |
| **W14** | Risky writes are capability-gated and completely hidden until their independent protocol/state-machine tests pass. |
| **W15** | “Beta.2 complete” means every **Must ship** row in §2.1 and §7.4 is implemented against real authorities and packaged-dist E2E, including Simple/Pro disclosure and usability gates. Capability-gated rows may be absent only when the backend does not advertise them; Deferred rows are outside the browser protocol. |
| **W16** | **Simple is the default for every new browser session without an explicit Pro deep link.** It exposes Tasks, Workspaces, Needs your input, human-readable progress, results, and contextual safety actions. It does not expose raw control-plane vocabulary as primary navigation. |
| **W17** | **Pro is progressive disclosure, not a second product.** It reveals graph/timeline/node/attempt/evidence/policy/coordinator/diagnostic surfaces and capability-gated expert writes over the same routes, P17 DTOs, authorization, and authority. |
| **W18** | Switching modes never changes capability, authorization, Run truth, or command semantics. Critical failure, uncertainty, approval, and cancel state remain visible in Simple; Pro may expose more evidence, never more truth. |
| **W19** | UI/UX quality is a release gate: OpenAI/Anthropic-class restraint and interaction quality, local Taskflow design tokens, high-quality light/dark themes, complete loading/empty/error/recovery states, keyboard/a11y parity, screenshot matrices, and novice task testing. |
| **W20** | Brand inspiration is behavioral, not derivative: no OpenAI/Anthropic names, logos, proprietary fonts, copied assets, or pixel-copying in the shipped product. Taskflow retains its own identity. |
| **W21** | Simple Task headline/hierarchy come from one browser-safe, deterministic `projectTaskPresentation()` projection over authoritative Run/BoundPlan/node/Receipt inputs; observation, decision, and error layers use their separately named deterministic projections. Pages and components never independently guess “current step,” progress, verification, result, risk, or next action. |
| **W22** | Receipt existence is not verification. The UI uses the closed verification states `verified | partially-verified | verification-unavailable | verification-failed | not-yet-verified | not-applicable`, derived by P17 v5 rules and accompanied by check-level provenance. |
| **W23** | Server DTOs carry source coverage/authority/watermarks; each browser tab owns its connection/reconnect state. “SSE connected” is never serialized by an ordinary JSON handler as if it were server authority. |
| **W24** | Compatibility is asymmetric and executable: request/security/cursor/command schemas are strict closed; presentation producers are strict, while presentation consumers tolerate only additive fields at marked extension points. Removed/changed required fields, enum branches, discriminants, or semantics require a protocol-major change. |
| **W25** | The application shell is part of the beta.2 delivery contract: API/static/fallback route partition, cache/MIME/security headers, build manifest compatibility, source-map policy, and unauthenticated-shell data boundary are frozen in P17 v5. |
| **W26** | Content design is a product-safety layer and a beta.2 hard release gate. Taskflow’s normative voice is **calm, truthful, concrete, and action-oriented**: the “reliable colleague” is a design metaphor, not a persona that claims feelings, intent, certainty, or elapsed-time promises. |
| **W27** | Components render whole, versioned `WebContentMessage` keys and typed arguments emitted by deterministic projection. They do not concatenate translatable sentences, surface raw `ControlError.message` as primary copy, ask an LLM to rewrite authority, or create page-local state wording. |
| **W28** | Simple and Pro use the same voice and semantic message. Simple translates the practical consequence; Pro adds exact terms, provenance, identifiers, and raw diagnostics in a separate technical layer. Pro never becomes “log voice.” |
| **W29** | The pre-component approval gate is joint: the nine reference-screen families, the reachable-state copy matrix, exact field-level golden fixtures/provenance, narrow-layout proofs, and comprehension script are approved together. A polished screen without deterministic and correctly understood copy does not pass. |
| **W30** | Complete evidence is pageable, not one unbounded JSON document. Run detail carries bounded first pages; fragments, graph, Attempts, timeline, artifacts, and Receipt events have version-bound continuation plus full-envelope byte budgets. |
| **W31** | Locale evidence is explicit: `en` is the default five-user comprehension locale with zero allowed severity-1 findings; `zh-CN` has complete semantic/visual/a11y parity plus two independent native-level linguistic reviews. Beta.2 makes no equal `zh-CN` five-user claim. |

---

## §1. Product sentence

> Taskflow Workspace turns agent execution into a calm list of understandable tasks, so an ordinary engineer can see what is happening, handle what needs them, and trust the result—while Pro mode keeps the full control-plane evidence and recovery depth available without merging project authority.

### 1.1 Why beta.2 exists

The 0.3 control plane creates strong semantics that are difficult to feel through command output alone:

- per-project authority versus user-level coordination;
- `RunStatus × RunStage`, including parked approvals and reconciling ambiguity;
- immutable BoundPlans plus dynamic BoundFragments;
- policy deny/substitute/attenuate decisions;
- incremental reuse and `why-stale`;
- zero-token what-if replay;
- immutable Receipts and assurance.

The beta.2 workspace makes those semantics **understandable before it makes them inspectable**. Its job is not to decorate a daemon or teach internal nouns; its job is to let a user confidently answer:

1. What is running?
2. Does anything need me?
3. What happened?
4. Can I trust the result?

Pro mode answers the deeper “why exactly?” and “how do I recover?” questions.

### 1.2 Product principles

1. **Truth before smoothness.** Never turn stale/unknown/ambiguous into a reassuring fake state.
2. **Observe before mutate.** Every risky action first shows current authority, side-effect uncertainty, and expected result.
3. **Simple before complete.** Default screens show the minimum information required to understand and act; completeness remains one deliberate disclosure away.
4. **Workspace identity is always understandable.** Simple shows the human workspace name; Pro exposes exact project/domain identity. Cross-project convenience never erases jurisdiction.
5. **Evidence outcome is always visible.** Simple shows whether a result is verified and why that matters; Pro exposes Receipt, artifacts, assurance, cost, cache reuse, and provenance.
6. **One obvious next action.** Each region has at most one primary action. Secondary and expert actions are visually subordinate.
7. **Progressive disclosure, not feature removal.** Pro preserves the full operational surface without forcing it into the default experience.
8. **Calm is functional.** Typography, spacing, hierarchy, and motion reduce cognitive load; decoration does not compete with task state.
9. **The browser is replaceable.** Closing, reloading, or upgrading the UI cannot change execution truth.
10. **Local by default and by construction.** Beta.2 is not a hosted SaaS control plane.

---

## §2. Scope

### 2.1 Beta.2 delivery contract

The following classification is normative. **Must ship** rows block `0.3.0-beta.2`. **Capability-gated** rows may be absent only when the corresponding closed feature/command id is not advertised by the backend; the route must not contain a disabled, hidden-query, or directly callable substitute. **Deferred** rows are outside the beta.2 browser protocol.

| Surface | Delivery class | Beta.2 completion condition |
|---------|----------------|-------------------------------|
| `taskflow ui`, application shell/static manifest, launch exchange, exact Host/Origin, session/CSRF, compatibility failure, listener shutdown | **Must ship** | Real CLI → daemon → browser packaged-dist E2E; API/fallback/cache/CSP/source-map boundaries pass; no listener before launch or after final session expiry/stop |
| Simple default shell: Home, Tasks, Needs your input, Workspaces, human task detail | **Must ship** | New session opens Simple; one canonical Task presentation projection/golden matrix and ordinary-engineer usability matrix pass without exposing internal nouns as primary UI |
| Pro disclosure: Overview, Projects, Runs, graph, timeline, evidence, policy, diagnostics | **Must ship** | One opt-in mode switch exposes all implemented expert surfaces without route/resource/action truth changing |
| App shell, Overview, Projects, aggregate Runs, project detail | **Must ship** | Simple and Pro are projections of the same multi-project real-store data; explicit stream/coverage/authority axes remain available; no synthetic global sequence |
| Authoritative Run detail, bounded timeline, read-only DAG, dynamic inventory, node/attempt inspector | **Must ship** | Simple task summary/steps/result and Pro technical detail both come from §7.5 sources; no fixture-only projection |
| Approval inbox and authoritative approval detail | **Must ship** | Simple “Needs your input” inspection works even when decisions are not offered; Pro adds P15 evidence/version detail |
| Attention queue and truthful `unknown/reconciling` presentation | **Must ship** | Simple uses human recovery language without hiding uncertainty; Pro exposes capacity/side-effect evidence; home authority refresh gates actions |
| Durable cancel | **Must ship** | Idempotent command query/recovery; terminal only after provider quiescence proof |
| Receipt/evidence, authorized artifact download, JSON export | **Must ship** | Simple shows the six-state verification projection; Pro exposes complete Receipt/check/evidence; ledger reachability, pre-header immutable-snapshot digest, redaction and disposition matrix pass |
| Why-stale and zero-token replay | **Must ship** | Simple offers plain-language “Why did this run again?”; Pro owns replay and raw fingerprint detail; zero provider calls and no durable mutation |
| Read-only policy/capability explanation | **Must ship** | Simple explains contextual allow/block in human language; Pro exposes full provenance and deny/substitute/attenuate decisions; no writable PolicyStore |
| SSE/checkpoint reconnect and bounded polling fallback | **Must ship** | Cursor expiry/restart/compaction tests; observation axes remain independent |
| Approve/reject decisions | **Capability-gated; enabled in the current packaged candidate** | P15 CAS plus private exact-continuation checkpoint, durable original BoundPlan reload, restart-safe dispatcher handoff, non-replay fixtures and packaged browser E2E; decision never implies provider completion |
| Edit approval | **Capability-gated separately** | Content-addressed edit artifact, schema/re-Link validation, edited BoundPlan persistence, dispatcher handoff |
| Resume/recompute and recompute preview | **Capability-gated** | Durable idempotency, re-admission, affected-set preview, restart/lost-response tests |
| Manual reconcile | **Capability-gated** | Bounded provider history and no-fake-terminal recovery matrix |
| Update `maxActiveRuns` | **Capability-gated** | Typed CoordinatorCommandRecord, expected value/epoch, reject-below-occupancy multiprocess tests |
| Force-release | **Capability-gated** | Full reservation CAS, exact acknowledgement, operator-overridden audit |
| Re-run saved Program | **Capability-gated** | Existing CLI/MCP run contract reused exactly; no browser compiler |

The beta.2 baseline remains complete when an independently gated write is absent and unadvertised. In the current packaged candidate, approve/reject have passed their independent gate and are advertised alongside cancel; edit and high-risk recovery writes remain wholly absent. Adding those gated commands later does not redefine the core workspace or allow disabled controls to masquerade as support.

### 2.2 Simple and Pro contract

Simple and Pro are presentation modes over the same resource:

| Surface | Simple (default) | Pro (opt-in) |
|---------|------------------|--------------|
| Navigation | Home · Tasks · Needs your input · Workspaces | Adds Overview · Projects · Runs · Policy · Diagnostics |
| Home | Needs your input, active tasks, recent results | Capacity, status/stage distributions, mount health, Receipt/reuse statistics |
| Workspace | Human name, health sentence, recent tasks | Project/domain ids, binding, ControlStore header, watermark, policy provenance |
| Task list | Title, workspace, plain-language state, last activity | Run id, status × stage, provider, filters, watermarks |
| Task detail | Summary, progress, active step(s), result, verification, contextual action | BoundPlan/Fragments, graph, timeline, nodes, Attempts, provider observations |
| Approval | What is requested, why, impact, approve/reject when offered | P15 audience/version/CAS, evidence refs, handoff and race detail |
| Attention | What is uncertain, whether work may still be running, safest next step | Side-effect classification, reservation/capacity, provider history, recovery code |
| Evidence | Closed six-state verification outcome with reason, safe artifact preview/download | Full Receipt, check matrix, manifest, assurance, digests, provenance and raw JSON export |
| Incremental | Plain-language “why this ran/reused” | Fingerprints, changed components, affected-set preview, replay overrides |
| Policy | Contextual “why allowed/blocked/changed” | Full host/user/project/invocation intersection and capability decisions |
| Settings | Language, theme, Pro switch, build compatibility, revoke sessions | Coordinator detail and capability-gated capacity controls |
| Advanced writes | Cancel remains contextual; approve/reject appear when offered | Adds advertised edit/recompute/reconcile/maxActiveRuns/force-release controls |

Normative mode rules:

1. A new browser session without explicit non-secret URL view state opens Simple.
2. `view=pro` is optional non-secret navigation state. Mode is otherwise memory-only; beta.2 does not add localStorage, sessionStorage, a preference database, or a ControlStore record for it.
3. Switching mode preserves route, selected Task/node/artifact, filters that exist in both modes, scroll anchor where practical, and any in-flight command status.
4. Switching may lazy-load Pro-only DTOs. It cannot write domain state, change authorization, alter `supportedFeatures`, or turn an unavailable command into an available one.
5. A direct link to a Pro-only surface opened in Simple shows a calm explanation and one **Open Pro** action without losing the target. It does not return a fake 404.
6. Simple never hides an approval, failed/blocked/uncertain outcome, possible live side effect, disconnected/unverified state, incompatible protocol, security error, or required operator action.
7. Pro does not become a dense “everything dashboard.” It uses the same typography, spacing, hierarchy, drawers, and progressive disclosure as Simple.
8. Accessibility preferences, light/dark theme, and reduced motion are independent of Simple/Pro.

### 2.3 Capability visibility

Feature availability has two levels:

1. `WebBootstrapView.supportedFeatures` and `supportedCommands` are closed protocol enums describing what this packaged backend actually implements.
2. Authoritative resource details carry server-computed `availableActions`; the browser does not reimplement status, policy, provider, or CAS eligibility.

If a command is not globally supported, it is not rendered. If it is globally supported but unavailable for the current resource, the UI may show an unavailable action only when the server returns a safe reason. Search results and stale aggregate rows never supply action authority.

### 2.4 Explicitly out of beta.2

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
- Project identity rebind/adopt, raw mount mutation, and ControlStore repair from the browser; beta.2 links to the separately authorized CLI workflow.

### 2.5 Starting new work

Beta.2 does **not** include an arbitrary workflow editor. A user may:

- resume/recompute an existing Run under existing control semantics;
- replay a recorded Run without execution;
- re-run an existing saved Program only if the frozen CLI/MCP `run` contract can be reused byte-for-byte.

The console must not invent a web-only Program format or a browser-only compile path.

When the backend does not advertise saved-Program rerun, Simple empty states say that Taskflow Workspace observes work started from the CLI or a supported host and provide a copyable, authoritative getting-started command/link. They do not show a non-functional **New task** button. If rerun is advertised, the primary action is **Run saved workflow** using the exact existing contract.

---

## §3. Human model

### 3.1 Primary users

| User | Job |
|------|-----|
| New or occasional user | Understand what agents are doing, whether anything needs them, and whether a result is trustworthy without learning control-plane vocabulary. |
| Ordinary engineer | Follow Tasks across Workspaces, inspect useful outputs, understand reruns/reuse, and take safe contextual actions. |
| Pro operator/workflow author | Inspect graph/timeline/node/Attempt/policy/evidence internals and recover ambiguous execution safely. |
| Approval decider | Understand the request and impact in Simple; inspect exact evidence, version, policy, and race state in Pro when needed. |

One OS principal may perform all three roles in beta.2. The UI still uses capabilities returned by ControlHost; it never assumes that opening the page grants every action.

### 3.2 Daily loop

```text
Open workspace (Simple)
  → see Needs your input / Active tasks / Recent results
  → open one Task
  → understand progress, active step(s), result, and verification
  → take one contextual action if needed
  → open Pro only for exact graph/timeline/evidence/recovery detail
```

### 3.3 Language shown to users

| Internal term | UI wording |
|---------------|------------|
| Project / Project ControlStore | Workspace; storage authority appears only in Pro technical details |
| Run | Task |
| RunStatus × RunStage | Plain-language task state; exact pair appears in Pro |
| BoundPlan | Steps |
| BoundFragment | Dynamically added steps |
| NodeInstance | Step |
| Attempt | Attempt / retry, shown only when relevant; full list in Pro |
| Approval | Needs your input |
| Receipt | Verification details |
| Artifact | Result / file, with type-specific wording |
| why-stale | Why did this run again? |
| orphan-suspect | Taskflow cannot yet confirm whether work is still running |
| unknown/reconciling | Checking whether the task is still running |
| needs-operator | Needs your attention |
| ControlRegistry / UserCoordinatorStore / commitSeq | No Simple label; exact technical term only in Pro |

Simple copy follows “what happened → why it matters → what you can do.” Error codes, exact identifiers, raw statuses, protocol/build data, and correlation ids remain copyable from **Technical details** or Pro; they are not the primary message.

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

Simple is a quiet task workspace:

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Taskflow                                         connection · avatar│
├───────────────┬───────────────────────────────┬─────────────────────┤
│ Home          │ Task workspace                │ Result / detail     │
│ Tasks         │ title · progress · next step  │ opens only when     │
│ Needs input 2 │ result · contextual action    │ content benefits    │
│ Workspaces    │                               │ from a second pane  │
│               │                               │                     │
│ Pro     ○     │                               │                     │
│ Settings      │                               │                     │
└───────────────┴───────────────────────────────┴─────────────────────┘
```

Pro expands the same shell; it does not replace it:

```text
Home / Tasks / Needs input / Workspaces
  + Overview / Projects / Runs / Policy / Diagnostics
  + graph, timeline, node, Attempt and evidence tabs
  + technical inspector and advertised expert actions
```

- The sidebar is navigation, not a dashboard. Counts appear only when actionable.
- The main pane has one dominant reading/action flow. It does not tile every feature into equal-weight cards.
- A right pane opens for a substantial result, artifact, approval evidence, node detail, or Pro inspector—matching the side-by-side work pattern of document/artifact tools—then collapses without losing the Task.
- Simple never places capacity, protocol, policy layers, raw ids, or provider telemetry in the global header.
- Desktop-first full experience starts at 1024px. Below that, the right pane becomes a full-height drawer; observation and core approval/cancel flows remain usable.
- URL may carry non-secret navigation state: workspace, Task, selected step/artifact, tab, filters, `view=pro`, and command operation id (`op`). Replay bodies, launch/CSRF/session tokens, request hashes, artifact contents, and sensitive values remain in memory or explicit downloads—not the URL.

### 5.2 Routes

| Route | Simple behavior | Pro addition |
|-------|-----------------|--------------|
| `/` | Home: Needs your input, active Tasks, recent results | `view=pro` adds capacity, distribution, mount health, Receipt/reuse statistics |
| `/tasks` | Searchable aggregate Task list with Workspace on every row | Exact Run filters, status/stage, provider, timestamps, watermarks |
| `/needs-input` | Approvals and uncertain Tasks phrased as clear user decisions | P15/attention/side-effect/recovery details |
| `/workspaces` | Human Workspace list and health sentence | Project binding, mount and identity health |
| `/workspaces/$projectId/domains/$controlDomainId` | Workspace summary and recent Tasks | Store header, watermark, policy provenance |
| `/workspaces/$projectId/domains/$controlDomainId/tasks/$runId` | Authoritative Task summary, progress, result and contextual action | Full technical Task shell |
| `...?view=pro&tab=graph&node=$nodeInstanceId` | Pro invitation preserving target | DAG + node/Attempt inspector |
| `...?view=pro&tab=timeline&cursor=$cursor` | Pro invitation preserving target | Project-local event timeline |
| `...?view=pro&tab=evidence` | Verification summary remains visible | Full artifacts, cache/reuse, Receipt/assurance |
| `...?view=pro&tab=replay` | Pro invitation preserving target | Zero-token what-if replay |
| `/workspaces/$projectId/domains/$controlDomainId/tasks/$runId/input/$approvalRequestId` | Authoritative “Needs your input” detail | Audience/version/CAS/evidence/handoff detail |
| `/policy?view=pro` | Contextual explanation links here through an Open Pro interstitial | Full read-only policy/capability layers |
| `/diagnostics?view=pro` | Actionable uncertainty stays in Needs your input | Coordinator, provider, store, registry and attention diagnostics |
| `/settings` | Memory-only language override, theme, mode, build compatibility, local session controls | Coordinator detail and advertised capacity controls |

Browser route vocabulary is user-facing; P17 API paths remain `/projects` and `/runs`. The URL never treats a bare `runId` as globally unique. Exact project/domain identity remains in every authoritative Task route and command even when Simple visually emphasizes the Workspace name.

### 5.3 Simple Home

Home is a reading order, not a metric-card wall:

1. **Needs your input** — omitted entirely when empty; highest-severity actionable items first.
2. **Active tasks** — at most eight rows before “View all,” each with Workspace, plain-language state, deterministic active-step summary, and last activity.
3. **Recent results** — at most eight rows with verification outcome and completion time.

The top area may contain one compact sentence such as “3 tasks are active · 1 needs you.” It may not contain more than three headline numbers, charts, token/cost totals, mount internals, or a grid of equally weighted cards.

Disconnected, partial, or unverified aggregate truth appears as one calm, persistent status strip explaining the practical consequence. Missing projects never become zero.

An empty Home says **No tasks yet**, explains where Tasks come from, and offers exactly one real next step: **Run saved workflow** when advertised, otherwise a copyable CLI/host getting-started action. It never implies that beta.2 contains a hidden authoring flow.

### 5.4 Simple Task detail

The default Task page has one vertical story:

1. Workspace breadcrumb, Task title, plain-language state, last activity.
2. One short status sentence answering what is happening now.
3. **Needs your input** panel when applicable, including impact and one primary action.
4. Progress/steps: completed, current, waiting and blocked; implementation-only nodes are grouped.
5. Result/output preview in the right pane when substantial.
6. Verification summary: one of the six closed verification states—with stable reason and explanation.
7. Secondary disclosure: activity summary, “Why did this run again?”, downloads, and **Open Pro details**.

Raw ids, hashes, provider, exact status/stage, policy badges, Attempt count, capacity and protocol data do not appear in the default header. A user can always open **Technical details** without enabling all of Pro.

### 5.5 Pro Task detail

Pro preserves the Task summary and adds:

1. **Graph** — read-only plan and runtime inventory.
2. **Timeline** — committed events, command causation, provider observations.
3. **Inputs & outputs** — resolved inputs and safe output rendering.
4. **Incremental** — cache hit/miss, fingerprint, why-stale, recompute impact.
5. **Evidence** — ArtifactRefs, complete Receipt, assurance and verification.
6. **Replay** — offline overrides and resulting fold.
7. **Technical** — ids, build/protocol, RunStatus × RunStage, provider, Attempt, watermarks and available expert actions.

Pro tabs are lazy-loaded and visually subordinate to the human Task summary. Enabling Pro does not turn the page into a full-screen graph by default.

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
- The graph is a Taskflow-owned SVG projection. Node/edge geometry uses SVG attributes and the checked-in stylesheet only; it does not write `style` attributes, inject runtime CSS, or require a weaker `style-src` policy. It exposes selection and viewport controls but no connect/reconnect/delete topology handlers. A cursor or omitted drag handle is not the immutability boundary; the component has no mutation command path.
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

Browser DTOs are derived views, not new domain entities. P17 v5 is the exclusive wire authority for exact envelope, source-observation, view, projection, query, bound, and compatibility shapes; this product RFC deliberately does not reproduce them. Conceptually, every response carries protocol/request identity, every aggregate/detail carries explicit coverage and authority where required, and no successful decode becomes mutation authority.

Closed command/security schemas reject unknown properties. Presentation producer/consumer compatibility follows §22.2/P17 v5; the browser never treats a successfully parsed projection as mutation authority.

### 7.2 Required views

| View | Authoritative inputs |
|------|----------------------|
| `WebBootstrapView` | negotiation, buildInfo, content catalog/keyset compatibility, principal, mode, closed supported features/commands, UI session. |
| `WebOverviewView` | registry + coordinator + mounted project projections/Receipts, derived with coverage/authority. |
| `WebCoordinatorSummary` | UserCoordinatorStore lease/capacity/reservations. |
| `WebProjectSummary` / `WebProjectDetail` | Registry entry plus verified project-store header/open status. |
| `WebRunSummary` | project Run projection plus canonical `WebTaskPresentationSummary`. |
| `WebRunDetail` / `WebRunGraphView` / `WebNodeDetail` | Run projection + bounded first pages and continuation endpoints for fragments/graph/attempts/timeline/artifacts/Receipt events + BoundPlan provenance + why-stale/replay availability. |
| `WebApprovalSummary` / `WebApprovalDetail` | reference plus live read from approval’s home project store. |
| `WebAttentionItem` | Derived actionable condition with a closed bilingual `WebContentMessage`; raw kind/disposition/recovery/side-effect enums remain Pro diagnostics rather than Simple guidance. |
| `WebReceiptView` | immutable Receipt plus closed current `WebVerificationPresentation`. |
| `WebWhyStaleView` / `WebReplayResult` | pure cache/trace analysis with no provider call or durable write. |
| `WebPolicyExplanation` | host/user/project/invocation intersection and decisions. |

### 7.3 Aggregate correctness

- Cross-project list order is a convenience sort by recorded timestamps, not a global causal order.
- No aggregate row may expose a synthetic global `commitSeq`.
- Each row includes project identity and its own watermark.
- The aggregate envelope carries complete cross-project coverage once; each Run row and nested presentation carry only that row’s verified project/domain observation. Repeating the full mount/watermark vector per row is forbidden, and row-local authority cannot upgrade partial aggregate coverage.
- The opaque page cursor is a signed/MACed vector checkpoint bound to protocol version, principal hash, normalized query hash, stable sort, the exclusive keyset tuple of the last row actually returned, exact auto/standalone registry mode/revision, and canonical hashes of the full registry context, visible mounts, and every visible project’s `(projectId, controlDomainId, nextCommitSeq, minAvailableCommitSeq)`. The hashes preserve the complete semantic binding without copying the unbounded vectors into the token. The next page starts strictly after that tuple in the bound sort direction; a cursor never points at the first omitted row. Standalone uses the literal P17 sentinel and exactly one mount; it does not fabricate a registry revision. The distinct SSE cursor carries canonical registry/mount/project-identity hashes plus the ordered `nextCommitSeq` position array required for self-contained resume, and never carries page keyset state.
- Ordering is total: requested sort key, then `projectId`, `controlDomainId`, and `runId`; arrival order is never a tie-breaker.
- Registry/mount-set change, principal/query/sort mismatch, expiry, tampering, or compaction past a saved watermark returns `TF_CURSOR_EXPIRED`; the browser discards the aggregate snapshot and checkpoint-resyncs.
- Clicking a row refreshes it from the home Project ControlStore before enabling mutation.
- Registry/index loss may make aggregate lists incomplete; reopening a project rebuilds discovery as specified by P3.
- Search results display all three observation axes and may not authorize actions by themselves. `connected` does not imply complete coverage or verified authority.

### 7.4 Screen-to-endpoint delivery matrix

This matrix is the minimum browser surface. A route is not complete because a component can render fixtures: its named DTO, authority path, failure states, and packaged-dist handler must exist.

| Product surface | Required P17 v5 endpoint(s) and view(s) | Disclosure | Beta.2 class |
|-----------------|------------------------------------------|------------|--------------|
| Launch and shell | P17 static/route/asset manifest contract; `POST /session/exchange`, `GET /bootstrap`, `POST /session/logout`; `WebSessionView`, `WebBootstrapView` | Both; Simple default | **Must ship** |
| Home / Overview | `GET /overview`; `WebOverviewView` | Simple reading flow; Pro metrics/health | **Must ship** |
| Workspaces / Projects | `GET /projects`, `GET /projects/:projectId/domains/:controlDomainId`; `WebProjectSummary`, `WebProjectDetail` | Simple identity/health; Pro store/binding | **Must ship** |
| Tasks / aggregate Runs | `GET /runs`; `WebPage<WebRunSummary>` with canonical `WebTaskPresentationSummary` | Simple rows; Pro filters/technical columns | **Must ship** |
| Task shell and graph | `GET .../runs/:runId`, `GET .../runs/:runId/fragments`, `GET .../runs/:runId/graph`, `GET .../nodes/:nodeInstanceId`, `GET .../nodes/:nodeInstanceId/attempts`; `WebRunDetail`, canonical `WebTaskPresentation`, paged fragments/graph/Attempts, `WebNodeDetail` | Simple summary/steps/result; graph/node Pro | **Must ship** |
| Timeline | `GET .../runs/:runId/timeline`; `WebPage<WebTimelineEvent>` | Simple activity summary; raw timeline Pro | **Must ship** |
| Evidence and artifact | `GET .../runs/:runId/receipt`, `GET .../runs/:runId/artifacts`, plus `GET .../artifacts/:digest`; paged `WebReceiptView`, `WebArtifactRef` | Simple verification/result; complete pageable evidence Pro | **Must ship** |
| Why-stale and replay | `GET .../why-stale`, `POST .../replay`; `WebWhyStaleView`, `WebReplayRequest`, `WebReplayResult` | Plain why-stale Simple; replay/raw fingerprints Pro | **Must ship** |
| Approvals | `GET /approvals`, `GET .../approvals/:approvalRequestId`; `WebApprovalSummary`, `WebApprovalDetail` | Simple Needs your input and contextual approve/reject when advertised; CAS/evidence Pro | **Must ship**; decisions remain closed capability ids and are enabled only after their independent gate |
| Attention | `GET /attention`; `WebAttentionItem` | Actionable human item Simple; diagnostic queue Pro | **Must ship** |
| Policy | `GET /policy/explanation`; `WebPolicyExplanation` | Contextual sentence Simple; full page Pro | **Must ship read-only** |
| Live observation | `GET /events`; closed `WebStreamFrame` union plus bounded polling fallback over the corresponding GET endpoints | Both | **Must ship** |
| Cancel | `POST /commands`, `GET /commands/:commandId`; `cancel-run` branch and `WebCommandOutcome` | Contextual Simple and Pro | **Must ship** |
| Approval/recovery/capacity writes | `POST /commands`, `GET /commands/:commandId`; advertised closed command branches only | Approve/reject contextual; other expert writes Pro | **Capability-gated** |
| Recompute preview | `POST .../recompute-preview`; `WebRecomputePreviewRequest`, `WebRecomputePreview` | Pro | **Capability-gated with recompute** |
| Session emergency revoke | `POST /sessions/revoke-all`; `WebSessionRevocationView` | Settings in both | **Must ship** |

Each navigable screen implements the applicable `loading`, `empty`, `ready`, `partial`, `unverified`, `disconnected`, `forbidden`, `incompatible`, and `error` states. `partial`, `unverified`, and `disconnected` are independent overlays, not mutually exclusive replacements for domain status.

### 7.5 Authoritative read-model matrix

P17 DTOs do not authorize a new browser database. Before a field can be declared implemented, `ControlHost` must expose a browser-neutral typed read service for it and the service must name its durable authority or deterministic derivation:

| Browser data | Required ControlHost read source | Authority / reconstruction rule |
|--------------|----------------------------------|---------------------------------|
| Bootstrap, build, mode, content compatibility | negotiation + buildInfo + verified web asset/content manifest + live session/capability evaluator | Singleton/host process; catalog selects wording only, and session state is ephemeral and not Run authority |
| Overview totals and health | registry, coordinator snapshot, mounted project summaries and Receipts | Derived at read time; every total carries coverage/authority, never stored as a global ledger |
| Project detail | registry binding plus verified ControlStore header/watermark | Registry locates; project ControlStore proves identity and current authority |
| Workspace/Task display names | persisted Program/project display metadata, or a deterministic sanitized source-name/short-id fallback | Never synthesized by an LLM or inferred from output; exact ids remain available in Pro |
| Task presentation metadata | compiler/binder-emitted `BoundPresentationIndex` with `{authoredPhaseId, groupId, role, ordinal, label}` per node | Rebuildable sidecar keyed by plan/fragment hash + compiler/projection version and excluded from execution/content hashes; missing metadata degrades authority and progress |
| Run list/detail | project run index and durable Run projection | Home Project ControlStore |
| Simple headline/steps/progress/result/action + verification | server-side browser-safe `projectTaskPresentation()` over the exact source snapshot | Pure deterministic P17 projection serialized in Run summary/detail; all consumers share golden fixtures and may not fork the rules |
| Decision wording | server-side `projectDecisionPresentation()` over current authoritative approval/action context | Serialized in approval detail/Task decision set; browser cannot reclassify authored prose |
| Observation wording/action gate | browser-only `projectObservationPresentation()` over serialized source observation + exclusive tab reducer epoch + exact resource refresh stamp | Never serialized; reconnect alone cannot authorize a stale detail |
| Failure wording | browser-only `projectControlErrorPresentation()` over the complete failure envelope + closed surface/operation/action context | Never serialized; a naked backend error or component-local context is invalid |
| BoundPlan provenance and graph | durable content-addressed BoundPlan read API plus bounded graph paging | Original BoundPlan bytes/hash must survive restart; all nodes/edges are deterministically recoverable without an unbounded response |
| Dynamic inventory | durable BoundFragment snapshots plus link/causation journal events | Home Project ControlStore; immutable parent plan is never rewritten |
| Node/Attempt/provider detail | durable NodeInstance/Attempt projections and provider observations | Home Project ControlStore; provider reads may enrich but never replace recorded truth |
| Timeline | project journal plus compaction index | Project-local sequence only; page bounds respect `minAvailableCommitSeq` |
| Approval detail | approval record, typed requested operation (or explicit generic class), current Run/version, BoundPlan and referenced evidence | Home Project ControlStore with P15 audience/live authorization; authored request text is quoted context, not decision wording |
| Receipt, verification and artifacts | immutable Receipt store, event-manifest verifier, ArtifactStore, current check results, ledger reachability and verified immutable artifact snapshot | Home Project ControlStore and content-addressed artifact bytes; complete evidence is paged under one Receipt/Run version and Receipt existence is never the verification predicate |
| Why-stale | cache/fingerprint provenance service over recorded inputs and current observable fingerprints | Pure analysis; unavailable causes are explicit, not guessed |
| Replay | trace/event artifact read API plus pure `replayRun` | Zero provider calls and zero durable mutation |
| Policy explanation | current host/user/project/invocation evaluation trace | Read-only P1 evaluation; no Web-only PolicyStore |
| Capabilities and actions | current build support intersected with principal, policy, provider and resource state | Computed server-side on every authoritative detail read |

The current summary-only `RunProjection` is insufficient for the required Task screen. Stable display titles, durable BoundPlan/BoundFragment reload, fragment/graph/node/Attempt/timeline/artifact/Receipt paging, approval detail, artifact reachability, why-stale, and replay read APIs are implementation prerequisites—not values WebGateway may synthesize. A field may be absent only when its P17 branch explicitly models `unsupported` or `unavailable`; missing backend data must not be replaced with empty arrays, fixture graphs, generated prose, or a misleading verified state.

### 7.6 Capability and action contract

P17 v5 defines closed `WebFeatureId` and `WebCommandKind` enums.

- `WebBootstrapView.supportedFeatures` answers “can this packaged backend implement this protocol feature?”
- `WebBootstrapView.supportedCommands` answers “does this backend implement this durable command kind at all?”
- Authoritative details expose `availableActions`, computed from current principal, policy, provider capability, Run/approval/reservation state, and current CAS version.
- A global command may be supported while a particular resource action is unavailable. In that case the server may return a safe, typed reason; the browser does not reverse-engineer eligibility.
- An unadvertised command has no button, hidden route, keyboard shortcut, or directly callable undocumented body. An advertised action carries the exact identity and expected-version inputs needed to construct its closed request; the browser never copies them from a stale aggregate row.
- Capability changes invalidate affected query data. They do not retroactively authorize an already-open confirmation dialog.

---

## §8. Browser transport

### 8.1 Endpoint model

The browser API is local and versioned under `/api/v1`. P17—not P1–P16—owns its exact success/error envelopes, request/query DTOs, response-byte budgets, pagination, auth, SSE, artifact, presentation/content-projection and static-delivery contract. The target executable schema and sole post-conformance endpoint source is `packages/taskflow-control/src/web-protocol.ts` through its `WEB_ENDPOINTS` registry; router, generated client, and this generated inventory must remain bijective under `scripts/check-web-protocol-docs.mjs`. It is not canonical until the P17 v5 conformance gate passes.

<!-- BEGIN GENERATED: RFC-WEB-ENDPOINTS -->
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/session/exchange` | Exchange one-time launch capability for browser session. |
| `POST` | `/api/v1/session/logout` | Revoke the current browser session and clear its host-only cookie. |
| `POST` | `/api/v1/sessions/revoke-all` | Revoke all sessions for this listener without mutating control-plane truth. |
| `GET` | `/api/v1/bootstrap` | Negotiation, build, principal, mode, capability summary. |
| `GET` | `/api/v1/overview` | Derived multi-project operational summary with three-axis observation state. |
| `GET` | `/api/v1/projects` | Registry-backed project list. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId` | Verified project identity, store health, policy summary, and recent Runs. |
| `GET` | `/api/v1/coordinator` | Coordinator lease, capacity, epoch, and reservation counts. |
| `GET` | `/api/v1/coordinator/reservations/:reservationId` | Current reservation state, revision, and project/domain/Run binding. |
| `GET` | `/api/v1/runs` | Aggregate filtered Run list. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId` | Authoritative Run detail projection. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/fragments` | Bounded immutable fragment summaries with continuation. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/graph` | Bounded deterministic graph chunk with boundary edges and continuation. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/timeline` | Project-local, cursor-bounded committed timeline. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId` | Authoritative node with bounded first Attempt page, provider observations, inputs/outputs, and provenance. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId/attempts` | Bounded Attempt history with continuation. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/artifacts` | Bounded authorized artifact/reference verification rows with continuation. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/receipt` | Bounded immutable Receipt core and event-manifest continuation. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/why-stale` | Pure cache/fingerprint explanation. |
| `POST` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/replay` | Pure zero-provider, zero-mutation what-if replay. |
| `POST` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/recompute-preview` | Capability-gated pure affected-set preview; does not submit recompute. |
| `GET` | `/api/v1/approvals` | Aggregate approval refs with three-axis observation state. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/approvals/:approvalRequestId` | Authoritative approval detail, evidence, current version, and available actions. |
| `GET` | `/api/v1/attention` | Needs-operator and health queue. |
| `GET` | `/api/v1/policy/explanation` | Read-only effective policy decisions. |
| `GET` | `/api/v1/projects/:projectId/domains/:controlDomainId/artifacts/:digest` | Authorized, ledger-reachable artifact read. |
| `GET` | `/api/v1/events` | SSE stream with opaque resumable cursor. |
| `POST` | `/api/v1/commands` | All project/coordinator mutations. |
| `GET` | `/api/v1/commands/:commandId` | Live-reauthorized durable command outcome/recovery. |
<!-- END GENERATED: RFC-WEB-ENDPOINTS -->

P17 v5 exclusively owns the exact success/failure shapes. Ordinary JSON is capped at 2 MiB including its envelope, Run detail/pure analysis at 4 MiB, graph and all JSON absolutely at 8 MiB. A page includes the next row when the complete envelope remains at or below its budget; if more rows remain, its cursor records the last returned keyset and continuation starts strictly after it. Standard page default/maximum is 50/200, graph is 500/2,000, and Receipt events are 100/200. Large values become authorized artifact references. No endpoint accepts a ControlStore path, arbitrary filesystem path/URL, principal id, or caller-selected authority location.

Session lifecycle endpoints mutate only listener-local security state. Why-stale, replay, and recompute preview are pure analysis endpoints: they create no `commandId`, journal record, provider call, Run version, or Receipt. Every control-plane domain mutation goes through the durable command endpoints.

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

### 8.5 Wire-level ownership

P17 v5, not ad hoc handler behavior, owns:

- exact HTTP status-to-`ControlError` mapping and when an outcome remains HTTP 200;
- cookie name/attributes, `X-Taskflow-CSRF`, exact Host/Origin comparison, request media type and size limits;
- page/stream cursor encoding, MAC, key lifetime, expiry, restart and compaction behavior;
- SSE event name, line encoding, heartbeat, maximum frame/queue/stream count, overflow reset, and proxy-buffering headers;
- artifact MIME allowlist, redaction classes, inline/download rules, byte limits, digest/ETag, and safe disposition.
- deterministic Task/observation/decision/error presentation, content catalogs, verification projection, strict-producer/tolerant-consumer compatibility, HTTP defense constants, and application-shell/static route partition.

The RFC deliberately does not duplicate those byte-level constants. A handler that returns a structurally similar object but violates P17 v5 is non-conforming.

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
      sourceObservation: WebSourceObservation }
  | { type: "change"; id: string; cursor: string; observedAt: number;
      kind: WebChangeKind; resourceType: WebChangeResourceType; resourceId: string;
      projectId?: string; controlDomainId?: string; commitSeq?: number;
      registryRevision?: string }
  | { type: "heartbeat"; id: string; cursor: string; observedAt: number }
  | { type: "reset-required"; id: string; cursor: string; observedAt: number;
      error: ControlError };
```

The SSE `id` equals the opaque cursor. The frame normally invalidates/refetches an authoritative view. Large outputs, artifacts, secrets, and full journal payloads are not pushed through SSE.

`WebChangeKind` is exactly `created | updated | deleted | invalidated`. `WebChangeResourceType` is exactly `overview | project | coordinator | reservation | run | graph | timeline | node | approval | attention | policy | artifact | command`. These are closed wire enums, not strings with undocumented values. Adding a value requires the compatibility treatment in §22.2; a client-local `unknown` normalization may trigger full refetch, but `unknown` is not a server escape hatch.

### 9.3 Reconnect

- An initial subscription may send one opaque query `cursor`; a browser reconnect may send `Last-Event-ID`. Each is limited to 8 KiB. When both exist they must be byte-identical or the request fails with `TF_INVALID_ARGUMENT`; the validated `Last-Event-ID` is the canonical resume value.
- An empty value starts from a fresh checkpoint. Neither header nor query value accepts a page cursor.
- `TF_CURSOR_EXPIRED` triggers checkpoint/bootstrap refetch, then a new stream.
- Reconnect is bounded with backoff and visible connection status.
- No duplicate event may duplicate a command side effect; events only update projections.
- If SSE is unavailable, use bounded low-frequency polling and show degraded-live status.
- Multi-tab sessions may each observe; server idempotency/CAS arbitrates mutations.

### 9.4 Observation truth has three axes

P17 v5 exclusively owns the exact observation types and reducer. The server serializes source coverage/authority/watermarks; each browser tab owns stream/resync state and a monotonic invalidation epoch. A successful verified authoritative-detail refresh creates a resource-bound refresh stamp at the current epoch. Disconnect/reset/principal changes advance the epoch, so an old “verified” detail cannot re-enable a sensitive action.

The browser-only `projectObservationPresentation(input)` composes the serialized source observation, tab-local reducer state, aggregate/detail scope, and optional resource refresh stamp. It renders the persistent strip and action gate but never changes the Task’s Run headline/status. Its reducer transitions and full scope × stream × resync × coverage × authority × refresh-stamp matrix are golden-tested. Standalone still uses the literal `"standalone"` sentinel and exactly one visible mount; it never invents a registry revision.

This prevents “SSE connected” from being misread as “all project stores present” or “this row is authoritative.” Partial coverage or unverified authority never enables a mutation without a successful home-store refresh.

---

## §10. State presentation

### 10.1 One deterministic Task presentation projection

Simple is not allowed to infer product language independently in Home, Task lists, Task detail, Needs your input, notifications, or result panes. Task detail consumes P17 v5 `WebTaskPresentation`; aggregate surfaces consume only its canonical `WebTaskPresentationSummary`. Both are produced server-side by the same browser-safe pure projection family and serialized into the corresponding Run DTO:

```ts
projectTaskPresentation(input: WebTaskPresentationInput): WebTaskPresentation
summarizeTaskPresentation(full: WebTaskPresentation): WebTaskPresentationSummary
```

The input is an immutable sanitized snapshot of authoritative Run/BoundPlan/BoundFragment/node/Attempt/Receipt/current-verification data plus ControlHost-computed `resolvedFinalOutput`, `WebSourceObservation`, current-principal decision disposition, and server-computed `availableActions`. The function performs no I/O, reads no wall clock except an injected `observedAt`, calls no model/provider, and writes no store. Conceptually its output carries source/version, headline/detail, active-step/group summaries, progress, result, verification, presentation action, optional decision set, decision provenance, and typed warnings. P17 v5 alone freezes the exact fields, enums, bounds, and additive extension points; this RFC does not maintain a second TypeScript shape.

English and Simplified Chinese are complete versioned catalogs keyed by the semantic messages; localization may translate whole messages but cannot change the decision, consequence, risk, or action. An LLM-generated summary is never an authority input.

Projection rules:

1. **Parallel work has multiple active steps.** `activeStepCount` counts every non-settled visible group that is currently executing or is the immediate blocking/waiting frontier; `activeSteps` carries the first 20 in stable BoundPlan-ordinal/node order. Copy uses singular only when the count is one; it never chooses an arbitrary “current” branch. `stepGroupCount` counts all groups while `stepGroups` is bounded to 200; complete inventory remains paged in Pro.
2. **Grouping is compiler/binder metadata, not CSS intuition.** Every bound node has durable/reconstructable presentation metadata `{authoredPhaseId, groupId, role:"step"|"implementation", ordinal, label}` in a rebuildable `BoundPresentationIndex` sidecar keyed by plan/fragment hash + compiler/projection version. The sidecar is excluded from execution/content hashes, so UI labels cannot invalidate execution/cache. User-authored semantic phases are `step`; desugared plumbing, loop/map/tournament bookkeeping, fragment-link helpers, and provider handoff nodes are `implementation` and group under their nearest authored semantic ancestor. Missing or contradictory metadata is `authority:"unverified"` and blocks numeric progress; the browser does not guess from phase names.
3. **Progress counts presented groups, not raw Attempts or runtime helper nodes.** `semantics:"exact"` is allowed only after the runtime inventory is sealed—no loop/map/expand/flow fragment can create another presented group—and source authority is verified. `semantics:"lower-bound"` may report `completed` known groups but has no percentage or stable denominator. `semantics:"indeterminate"` carries no counts. Simple renders `completed/total` or a progress bar only for `exact`; lower-bound copy says “{completed} steps finished so far.”
4. **Result selection is deterministic.** The ControlHost read service computes `resolvedFinalOutput` with the shared core `resolveFinalOutput` helper before building the browser-safe input. The presentation projection selects `text | json | artifact | error | none`, a safe bounded preview/reference, and that exact source identity; it does not import runtime/store code or rewrite the result. Multiple final artifacts remain an ordered list, never an invented “best” artifact.
5. **Primary action is deterministic and non-authoritative.** Selection order is: `open-required-input` for a current-principal decision; `refresh-authority` when a refresh can restore safe actionability; `open-result` for a terminal result; `open-error-details` for a terminal error; otherwise `none`. Durable command eligibility still comes only from `availableActions`. Cancel and other destructive commands remain contextual secondary actions.
6. **Approval choices are a decision set, not a preferred action.** When approve/reject are both offered, `decisionSet` contains both in stable order with equal visual weight and no default. `primaryAction` opens the decision context; it never selects approve.
7. The exact reachable Run state × graph topology × dynamic-inventory × Receipt/verification × observation × action matrix is covered by committed golden JSON fixtures, with negative fixtures rejecting impossible or contradictory combinations. Summary fields must be an exact subset of the full projection for the same Run version; every Simple surface renders the same headline, bounded active-step summary, progress semantics, verification state, and presentation action.

### 10.2 Simple state language

Simple derives stable copy from exact domain state; it never asks an LLM to summarize authority:

| Domain truth | Simple headline | Required supporting sentence |
|--------------|-----------------|------------------------------|
| `running/executing`, one active step | Working | “Taskflow is working on {activeStepLabel}.” |
| `running/executing`, multiple active steps | Working on {activeStepCount} steps | Name up to two steps, then disclose the complete ordered set |
| queued/admitting | Waiting to start | Explain capacity/policy only when it affects the user |
| `paused/parked` with approval | Needs your input | State what decision is needed and that no worker is currently active |
| `paused/executing` during cancel | Stopping | “Work may still be active while Taskflow confirms it has stopped.” |
| `unknown/reconciling` | Checking whether the task is still running | “The outcome is not confirmed. Some work may still be running.” |
| blocked | Couldn’t continue | Give the blocking reason and safest available next action |
| failed terminal | Failed | State that execution ended and offer result/error details |
| cancelled terminal | Cancelled | State that execution is confirmed stopped |
| completed terminal | Completed | Show the independently derived verification label; Receipt existence alone never adds “Verified” |

Headlines use sentence case, not shouting status chips. Status color is secondary to text/icon. At most one state badge appears beside the Task title; other facts live in the status sentence or disclosure.

Connection/source truth is deliberately not another Task status: `projectObservationPresentation()` shows **Live updates paused**, **Some workspaces couldn’t be checked**, or **Current authority couldn’t be verified** in the persistent strip and never replaces unavailable data with zero.

### 10.3 Pro status × stage matrix

| RunStatus | RunStage | UI meaning | Terminal? | Slot expectation |
|-----------|----------|------------|-----------|------------------|
| `running` | `executing` | Worker active | No | held |
| `paused` | `parked` | Durable approval waiting; provider quiescent | No | released via D37/D38 |
| `paused` | `executing` | Cancel/stop in progress while work may be live | No | held |
| `unknown` | `reconciling` | Provider outcome ambiguous | **No** | held/orphan-suspect |
| terminal status | `terminal` | Proven completion/failure/block/cancel | Yes | released only via D37 |

Pro shows the exact pair and the same human sentence. Neither mode may collapse the first four rows into a single “not running” state.

### 10.4 Needs your input and Pro attention queue

An `AttentionItem` contains:

- what is uncertain or blocked;
- affected project/Run/reservation;
- last proven observation;
- current `recoveryAction` and `sideEffects` level;
- safe next actions allowed by capability;
- whether capacity remains held;
- link to CommandRecord/event evidence.

`unknown/reconciling` remains visible until reconciled or explicitly force-released. Dismissing a UI notification does not resolve authority state.

Every item carries a server-derived disposition:

```text
needs-user-input | status-only | diagnostic
```

`needs-user-input` is valid only when the current principal has a currently advertised decision/recovery action, automation is not expected to resolve the condition, and authoritative refresh has supplied its CAS inputs. An approval additionally requires both approve and reject; a one-sided approval capability is not an actionable decision set. A pending approval addressed to another principal, `recoveryAction:"none"`, ordinary `refresh`, an active automatic reconcile window, or an informational capacity warning is `status-only` or `diagnostic`, not inbox work.

Simple groups current-principal approvals and `needs-user-input` AttentionItems under **Needs your input**. It shows what decision/action is required, whether work may still be live, and the safest next step. `status-only` conditions stay on the affected Task/status strip; `diagnostic` items stay in Pro Diagnostics. Pro exposes raw recoveryAction, sideEffects, reservation, capacity and CommandRecord/event evidence.

### 10.5 Verification and Receipt presentation

- Simple uses the closed states **Verified**, **Partially verified**, **Verification unavailable**, **Verification failed**, **Not yet verified**, and **Not applicable**; it never uses “Receipt” as the primary label.
- `verified` requires a terminal Run, a Receipt, a currently valid event manifest/root, `journalContinuity:"ok"`, terminal-consistent `providerOutcome`, `artifactIntegrity:"ok"`, `provenance:"ok"`, and successful current verification of every required result artifact.
- `partially-verified` requires a Receipt and no detected contradiction, but at least one required assurance/check is `unknown`, unavailable, retained without its blob, or outside the verifier’s current reach.
- `verification-unavailable` means the Run is terminal but the required Receipt/verifier/source is absent or inaccessible; absence is not success.
- `verification-failed` means a current check detected a digest/manifest/provenance mismatch or a Receipt provider outcome contradicts terminal Run truth. It is a security/integrity warning, not a rewrite of the immutable Receipt or Run status.
- A confirmed mismatch always outranks `in-progress`, missing, unknown, or unavailable checks. Provider expectation, observed provider outcome, and consistency check are separate: a Run expected to fail with an observed provider failure has consistency `ok`, not a failed check.
- `not-yet-verified` covers non-terminal/reconciling Runs and an explicitly in-progress terminal re-verification.
- `not-applicable` is emitted only by an authoritative closed lifecycle reason for which no Receipt/result verification is required; the browser never infers it from a missing Receipt or empty artifact list.
- Show a final Receipt only when one exists. While running/reconciling, label available material **progress evidence**, never “receipt pending success.”
- `WebVerificationPresentation` carries the state, stable reason code, checked-at time, Receipt identity when present, terminal/provider consistency, event-manifest result, required/current artifact results, assurance inputs, and source provenance.
- Pro displays every check plus the event manifest/root, commit bounds, artifact refs, buildInfo, provider outcome, integrity, provenance, and enforcement assurance.
- Re-verification may report an artifact as missing/unknown without mutating the immutable Receipt.
- Export downloads a stable versioned JSON artifact; printed/pretty view is
  derived. Before download, the browser re-reads every byte-budgeted Receipt
  manifest page and fails closed on identity drift, repeated cursors,
  missing/duplicate/reordered/out-of-range events or count mismatch. This is
  explicitly an export-consistency check; it never replaces the authoritative
  current journal, artifact, provider and provenance verification projection.

---

## §10A. Content design and UX writing

Content is part of the control surface, not decoration applied after components exist. A sentence can create the same safety failure as a wrong badge: it can falsely imply completion, hide possible live work, nudge an approval, or leave the user unable to recover. Beta.2 therefore treats content design, localization, accessibility, and visual design as one acceptance system.

### 10A.1 Normative voice

Taskflow speaks like a **calm, reliable colleague**. The phrase describes the reading experience only; the product does not pretend to be a person. The testable voice contract is:

> Calm, truthful, concrete, and action-oriented. Never anthropomorphic, blaming, falsely reassuring, or more certain than the authority permits.

Normative rules:

1. Lead with the user-visible result, not the storage, protocol, or provider mechanism.
2. Preserve uncertainty exactly. “Still checking whether work stopped” cannot become “Syncing,” “Cancelled,” or “Almost done.”
3. Each content block answers one question: what happened, what it affects, whether the user must act, or what happens next.
4. Helpfulness creates warmth. Do not use “Oops,” “Don’t worry,” “We feel,” “I’m trying,” jokes, celebration for unverified success, or a time promise without a measured bound.
5. Use one stable user term per concept. Simple says **Workspace**, **Task**, **Step**, **Needs your input**, **Result**, and **Verification details**. It does not rotate through synonyms for variety.
6. Use active voice, ordinary words, short sentences, and front-load the action or risk. Avoid double negatives and nested conditional clauses in primary copy.
7. Simple and Pro use the same semantic message and tone. Pro adds a separate technical disclosure; it does not replace human copy with status codes or log strings.
8. User-authored labels/output are quoted or visually separated and never adopted as Taskflow’s own instruction, verdict, or button label.
9. Taskflow does not use “I” or “we” as an agent persona. Product/legal notices that genuinely speak for the project use separately reviewed keys and never appear as execution-state copy.

### 10A.2 Information order and independent layers

Status, error, and decision content follows this order:

```text
user-visible outcome
  → practical impact or remaining risk
  → whether the user needs to act
  → next safe action
  → technical detail
```

The Task page preserves four independent layers:

1. **Task truth** — the RunStatus × RunStage-derived headline and detail.
2. **Observation truth** — connection, coverage, and authority strip from `projectObservationPresentation()`.
3. **Verification truth** — the six-state verification message and check provenance.
4. **Decision/action truth** — a question, consequences, deadline, and currently authorized actions.

No layer overwrites another. A disconnected stream does not rename a running Task; a completed Task does not imply Verified; an available approval does not imply that approval is recommended.

### 10A.3 Structured content contract

All authoritative or safety-relevant copy is selected by browser-safe deterministic projections at the fixed P17 v5 execution positions:

```ts
type WebContentMessage = {
  catalogVersion: "taskflow-content.v1";
  key: WebProjectedContentKey;
  args: WebContentArg[]; // closed, unique and canonically sorted for the key
};

projectTaskPresentation(input): WebTaskPresentation                    // server, serialized
projectDecisionPresentation(input): WebDecisionPresentation            // server, serialized
projectObservationPresentation(input): WebObservationPresentation      // browser, not serialized
projectControlErrorPresentation(input: WebFailurePresentationInput): WebFailurePresentation
                                                                    // browser, not serialized
```

The server Task/verification/decision projections select closed semantic keys and typed arguments. Browser observation/failure projections consume only their exact closed input; failure receives the complete `WebFailure` envelope plus closed surface/operation/capability/action context, never a naked `ControlError`. Non-authoritative UI labels come from the sole checked-in `packages/taskflow-web/src/content/static-keys.ts` source; the reference-screen manifest references its keys/digests and never generates them. A component may not invent one inline. The browser selects one complete locale catalog over the projected + static keysets and formats whole messages. Components may arrange messages but may not:

- concatenate translatable sentence fragments;
- depend on English or Chinese word order;
- interpolate raw backend error strings, stack traces, provider output, or user-authored text into an action label;
- replace a missing key with the raw key/error code;
- ask an LLM to explain or soften authoritative state;
- invent a page-specific synonym for an existing key.

Every key declares its allowed arguments, length/type bounds, surface class, tone, and technical-detail relationship. Build-time catalog validation rejects missing keys, unused/extra arguments, invalid plural/date/number formats, unsafe markup, or divergent decision semantics. The supported beta.2 catalogs are complete `en` and `zh-CN`; `en` is the default and primary five-user comprehension locale. `zh-CN` has the same catalog, visual, narrow, accessibility, and safety semantics plus two independent native-level linguistic reviews, but beta.2 does not claim an equal five-user `zh-CN` comprehension cohort. A memory-only Settings override wins; otherwise the browser selects the first exact supported canonical tag in `navigator.languages`, then applies the fixed primary-language map `en-* → en`, `zh-* → zh-CN`, then uses packaged default `en`. There is no per-message cross-language fallback in a shipped build. Unsupported locale input falls back to the packaged default without changing authority or persisting a preference.

Adding an optional technical-detail message at a P17 extension point may be minor-compatible. Removing a key, changing required arguments, changing a consequence/action meaning, or reusing a key for a different domain condition is breaking. Copy-only wording edits that preserve semantics still change the catalog digest, fixtures, screenshots, and affected comprehension evidence.

### 10A.4 Simple vocabulary and terminology guard

The following tokens must not appear in a Simple primary heading, primary explanation, button, accessible name, notification title, or empty-state action:

```text
RunStatus
RunStage
Receipt
CAS
commitSeq
watermark
reservation
reconcile
provider
ControlStore
BoundPlan
```

They may appear in **Technical details** or Pro after the human consequence remains visible. The terminology registry declares English token-boundary variants and exact CJK/localized equivalents. The lint checks rendered catalog output case-insensitively where the script has case, including accessibility strings; it does not use unsafe substring matching, ban identifiers from source code, or scan technical disclosures as Simple copy. New control-plane terms default to the same restriction until the registry explicitly classifies them.

### 10A.5 Content patterns

| Situation | Required shape | Example |
|-----------|----------------|---------|
| Ordinary status | What is happening. Whether action is needed. | **Taskflow is checking the test results. You do not need to do anything yet.** |
| Error | What did not finish. What remains safe. What the user can do. | **The task did not finish. Results already created are still available. Review the failure, or run it again later.** |
| Uncertainty | What is unconfirmed. What may still be happening. The conservative behavior until confirmation. | **Taskflow is checking whether the task is still running. Some work may continue; it will not be marked as cancelled until stopping is confirmed.** |
| Approval | The decision. Consequences of each answer. Deadline when real. | **Allow this task to publish these files? Allowing continues publication; not allowing stops this publication.** |
| Empty state | Why it is empty. What makes content appear. One real next step. | **No tasks yet. Tasks appear here after a workflow starts from the CLI or a supported host.** |
| Partial data | What could not be checked. What the visible total excludes. | **Two workspaces could not be checked. The totals below do not include them.** |
| Cursor expired | What became stale. What refresh does and does not do. | **This page is out of date. Refreshing loads the latest records and does not run the task again.** |

Primary errors never begin with “Unexpected error” or only an error code. `projectControlErrorPresentation()` maps the closed `ControlError.code`, `recoveryAction`, `sideEffects`, affected authority, and current domain state to a whole-message key. If no user action is safe, it says **You do not need to do anything right now** rather than offering a generic retry. The sanitized code, request/correlation id, exact authority, and raw diagnostic message remain copyable in Technical details.

### 10A.6 Decisions, labels, and dialogs

A decision surface is a direct question and answer:

- the title asks what is being allowed, rejected, stopped, or released;
- each choice label names the consequence, such as **Allow publishing** / **Do not allow publishing**;
- the body explains both consequences and a real deadline;
- approve/reject remain equal in semantic and visual weight, with no default;
- destructive confirmation names the Workspace, Task, affected work, and irreversible or uncertain outcome.

Generic decision labels—**OK**, **Confirm**, **Continue**, **Yes**, **No**, and **Cancel** when it means dismiss rather than cancel execution—are forbidden. **Close**, **Back**, or **Not now** are allowed only for non-decision dismissal and may not masquerade as rejection. Visible labels and accessible names must express the same answer and consequence.

### 10A.7 Tone matrix

| State | Required tone |
|-------|---------------|
| Running | Calm and brief; no artificial urgency |
| Waiting for the user | Specific and serious; decision and consequences explicit |
| Stopping | Conservative; possible live work remains explicit |
| Unknown/reconciling | Honest; no reassurance, guess, or fake terminal |
| Failed/blocked | Non-blaming; say what was preserved and the next safe step |
| Completed | Brief; celebrate only proven completion and keep verification separate |
| Verification limited/failed | State the limitation; do not use green success styling to conceal it |
| Dangerous action | Direct and specific; no humor, euphemism, or casual tone |

### 10A.8 Narrow screens, localization, and comprehension

At 320 CSS px and at 200% zoom, Task state, uncertainty, approval consequences, verification limits, and the primary/decision actions remain fully readable without ellipsis, hover-only disclosure, horizontal page scrolling, or clipped controls. Decision buttons may stack full-width; reading order and equal decision weight remain unchanged. A right pane becomes a full-height drawer and puts the heading, consequence, and actions before technical material.

The nine reference-screen families are approved only with:

1. the reachable-state content matrix and negative impossible-state fixtures;
2. exact `WebContentMessage` JSON plus field authority/provenance;
3. rendered `en` and `zh-CN` copy at desktop, 320 CSS px, and 200% zoom;
4. light/dark, keyboard, focus, and screen-reader reading order;
5. the §19.4 paraphrase questions and expected safety-critical facts.

For each tested state, participants explain in their own words: what happened, whether they need to act, what risk remains, and what the next action will do. The ordinary task threshold is 4/5, but safety facts have a stricter rule: any severity-1 misunderstanding blocks the release candidate regardless of aggregate score. After the fix, the affected task is rerun with five fresh, non-contaminated participants; the failed evidence remains retained.

### 10A.9 Alternatives rejected

| Alternative | Why beta.2 rejects it |
|-------------|------------------------|
| Component-local prose | The same state drifts across Home, list, detail, notification, and accessibility output; no authoritative golden matrix exists. |
| Server-rendered localized strings | It couples transport to one locale, weakens typed argument/compatibility checks, and makes a current-tab language switch require refetching authority. |
| Raw error/status text with a friendly wrapper | Technical strings still become the user’s primary explanation and can omit impact, remaining risk, or the next step. |
| LLM-generated explanation | Non-deterministic, untestable, vulnerable to agent-output influence, and capable of softening uncertainty or changing decision semantics. |
| Simple and Pro with separate copy systems | The modes can contradict each other and imply different truth; Pro should add evidence, not a second voice. |

---

## §11. Approval UX

### 11.1 Inbox

Simple names this route **Needs your input**. Each row starts with the human Workspace/Task, what is being requested, why it matters, and deadline. Aggregate rows remain references into project stores:

- project and Run identity;
- requested action/message;
- owner/audience;
- created/deadline;
- current RunStatus/Stage;
- stream/coverage/authority state and expected Run version.

Opening a row refreshes the authoritative request before actions appear.

### 11.2 Decision screen

Required context before deciding:

- Simple: the deterministic `WebDecisionPresentation` question, relevant safe result/evidence, consequence of each answer, real timeout/deadline when one exists, and an unbiased decision set. Choice labels answer the question with the specific operation—never generic **Confirm**, **Cancel**, **Yes**, or **No**. Approve/reject have equal visual/semantic weight and neither is preselected.
- Pro: exact approval message and allowed decisions, BoundPlan/Fragment hash, policy/capability provenance, expected Run version, audience, CAS/race state and dispatcher handoff.
- Both: relevant upstream output/artifacts subject to authz/redaction and a warning when another client may decide first.

Workflow-authored request text is visibly quoted as context; it cannot supply Taskflow’s question, consequence, or action labels. Approve/reject remain contextual Simple actions when both are authoritatively advertised because hiding a necessary decision behind Pro would make the default experience incomplete. A one-sided approval capability is `status-only` with no coerced decision control; Technical details explain the capability or policy gap. Edit and expert recovery controls remain Pro.

### 11.3 Race semantics

- Approve/reject/edit uses P15 CAS.
- First committed decision wins.
- Losing clients receive stale/race state and refresh.
- Approve commits `running/queued` plus a re-reservation and then awaits the normal dispatcher/provider path. It never writes `completed/terminal` or a Receipt merely because a human approved.
- Before parking, the scheduler stores a private, digest-verified continuation checkpoint bound to the Run, immutable BoundPlan, exact unconsumed approval node, settled Attempt identities and downstream interpolation outputs. It is secret, never Receipt-reachable and never sent to the browser.
- The resumed scheduler consumes exactly that approval as a providerless completed Attempt, retains the settled inventory, and dispatches only previously unsettled downstream phases. It never restarts the whole BoundPlan. A second approval creates a second checkpoint and parks again.
- Before taskflowd exposes UDS or WebGateway, it recovers an exact `running/queued` approve handoff from each durable prefix: project CAS only, coordinator binding, ApprovalRequest decision, or completed control CommandRecord. Every recovered suffix revalidates the journal, request, command, reservation, BoundPlan and checkpoint; the queued → executing CAS is the single dispatch claim.
- A restart after the dispatcher has committed `running/executing` is not blindly replayed because provider submission may already have side effects. Without a reconstructable provider submission checkpoint, the Run becomes `unknown/reconciling + needsOperator`, the committed reservation becomes orphan-suspect, and no Receipt is issued.
- Missing, corrupt or mismatched ApprovalRequest/BoundPlan/checkpoint/reservation evidence returns `TF_RECONCILE_REQUIRED`, keeps the command `accepted` when command settlement was not proven, marks the Run `unknown/reconciling + needsOperator`, holds the reservation as orphan-suspect and issues no Receipt.
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

Simple answers **Why did this run again?** with a short deterministic explanation of the first material cause and an optional “See all reasons.” Pro shows:

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

Replay is Pro-only in beta.2 and explicitly separated from live execution:

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

Simple shows policy only at the affected decision: “Blocked by workspace policy,” “Using a safer model,” or “Tool access was reduced,” plus **Why?** Pro shows the four layers independently:

```text
host ∩ user ∩ project ∩ invocation = effective authority
```

For each agent/model/tool/root/budget/provider capability, show:

- source layer;
- allowed/denied/substituted/attenuated result;
- canonical decision reason;
- authoritative layer provenance and the current principal’s effective capability.

Catalog availability must not be displayed as permission. Simple never exposes an empty top-level Policy page; the full standalone page is a Pro surface reached from contextual explanations or Pro navigation.

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
- Require the exact `Host: <hostNonce>.localhost:$PORT` on every request. Session exchange and every POST require the exact matching `Origin`; GET/HEAD validate it when present and require same-origin Fetch Metadata when present. Reject `localhost`, IP-literal Host values, alternative ports/hosts, forwarded-host overrides, and DNS-rebinding patterns.
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

- Exact Origin validation for session exchange and every POST plus the host-only SameSite cookie and per-session CSRF header/token for mutations; authenticated GET/HEAD require exact Host and reject a mismatching Origin when one is present.
- Content Security Policy: self only; no remote scripts, frames, fonts, or connections.
- `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, strict referrer policy.
- 30-minute idle and 8-hour absolute session TTL; explicit “revoke browser sessions.”
- Capability checks on every request, not only at page load.

### 14.4 Content safety

- Agent output renders as plain text/code by default.
- Optional Markdown renderer forbids raw HTML, scripts, iframes, event handlers, and automatic remote media loads.
- Artifact MIME type and disposition are enforced server-side.
- Artifact responses set canonical `Content-Type`, `Content-Length`, digest `ETag`, `X-Content-Type-Options: nosniff`, restrictive CSP, `Cache-Control: no-store`, and sanitized `Content-Disposition`; beta.2 rejects Range requests.
- No artifact byte is sent before integrity succeeds. WebGateway serves an already verified immutable content-addressed blob, or first copies the authorized source into a private `0600` size-bounded spool while hashing, verifies the complete digest/length, then sends that immutable snapshot and removes the spool.
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
| Runtime baseline | Compatibility floor Node ≥22.19; primary production/test Node 24 LTS; forward CI Node 26 | Keep existing 0.3 compatibility while testing the 2026 LTS and next-current line explicitly ([Node releases](https://nodejs.org/en/about/previous-releases)). |
| Local gateway | `node:http` + Node `ServerResponse`/Writable backpressure with explicit SSE framing | Keep the daemon adapter small; SSE is a wire format over HTTP, not a native `node:http` service or a reason to add Express/Fastify. |
| Routing | TanStack Router | Typed path/search state for project/Run/node/replay deep links. |
| Server state | TanStack Query | Snapshot cache, mutation state, and SSE-driven invalidation. |
| DAG | Taskflow-owned semantic SVG + synchronized HTML tree | Keeps the exact `style-src 'self'` CSP: third-party graph canvases position nodes with inline style attributes and therefore cannot be admitted without weakening P17. The beta.2 canvas is read-only, keyboard-selectable, and shares selection with the complete semantic tree. |
| Accessible interaction primitives | React Aria Components | Unstyled, composable dialog/popover/menu/tooltip/combobox/tabs behavior with Taskflow-owned visual tokens; Tailwind alone does not provide focus, keyboard, dismissal, or announcement semantics. |
| Styling | Tailwind CSS 4 + local tokens | Reuse current repo baseline; no runtime CSS-in-JS. |
| Icons | `lucide-react` | Reuse current repository dependency. |
| Formatting/lint | Biome 2 | Reuse website baseline. |
| Tests | Vitest + Testing Library + Playwright | Unit/component plus real browser/daemon acceptance. |

Version families are architectural choices; exact patches are pinned in `pnpm-lock.yaml` at scaffold time. Current official references: [React releases](https://react.dev/versions), [Vite 8.1](https://vite.dev/blog/announcing-vite8-1), and [TanStack Router](https://tanstack.com/router/latest/docs/framework/react).

Vite 8.1’s experimental bundled development mode is disabled by default. It may be enabled only after measured HMR/startup benefit, plugin-compatibility tests, and no difference in production output; it is not part of beta.2’s production architecture.

### 15.2 Product design system and reference direction

The reference is a product-quality bar, not a component-library dependency:

- OpenAI’s Codex app organizes long-running agent work as separate tasks/threads grouped by projects and emphasizes moving between them without losing context ([official Codex app introduction](https://openai.com/index/introducing-the-codex-app/)).
- ChatGPT Projects use dedicated spaces for ongoing work, while Canvas opens substantial work in a right-side surface rather than crowding the conversation ([Projects](https://openai.com/academy/projects/), [Canvas](https://help.openai.com/en/articles/9930697-using-canvas-in-chatgpt)).
- Claude Projects similarly organize focused workspaces, and Artifacts place substantial outputs in a dedicated side-by-side window ([Projects](https://support.anthropic.com/en/articles/9517075-what-are-projects), [Artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)).
- OpenAI’s public design guidance explicitly values clarity and a balance of technical precision with approachable warmth; Taskflow adopts that quality objective without using OpenAI Sans or protected brand assets ([OpenAI design guidelines](https://openai.com/brand/)).

The resulting Taskflow design language is:

1. **Task-first:** the user navigates Workspaces and Tasks, not storage/state-machine nouns.
2. **Content-first:** status, result and decision occupy the main reading flow; navigation and chrome stay quiet.
3. **Side-by-side when useful:** substantial results, artifacts, approval evidence and Pro inspectors open in a dedicated right pane.
4. **Neutral and warm:** near-neutral canvas/surfaces, ink-like text, muted borders, one Taskflow accent, semantic colors only when state requires them.
5. **Precise but approachable:** human sentences lead; exact ids, hashes and protocol detail remain nearby in disclosure.

#### Visual tokens

The initial local token contract is normative; changing it requires screenshot-matrix review:

| Token group | Contract |
|-------------|----------|
| Font | Local system sans stack; system monospace for code/ids. No remote or proprietary OpenAI/Anthropic font. |
| Type scale | metadata `12/16`, UI `14/20`, body `15/24`, section `20/28`, page title `28/34`; weights 400/500/600 only in product UI |
| Spacing | 4px base; allowed rhythm `4, 8, 12, 16, 24, 32, 48, 64` |
| Radius | 8px controls, 12px surfaces, 16px dialogs/right pane; pills only for compact status/filter chips |
| Borders | 1px low-contrast semantic border; prefer whitespace/dividers over boxed cards |
| Elevation | No shadow on normal content; one subtle overlay shadow for menus/dialogs/drawers |
| Main width | Reading column 680–760px; list/workspace maximum 1120px |
| Right pane | 40–52% of available main area, minimum 420px when docked; drawer below layout threshold |
| Controls | 36px compact, 40px normal; primary decision controls at least 44px high |
| Icons | 16/18px line icons; never substitute an unexplained icon for a critical action |

Light and dark themes use semantic tokens (`canvas`, `surface`, `surface-subtle`, `text`, `text-muted`, `border`, `accent`, `success`, `warning`, `danger`, `focus`) rather than raw colors inside feature components. Both themes meet WCAG 2.2 AA contrast. System theme is default; a manual override is non-secret view state and is not persisted outside the browser session in beta.2.

#### Composition constraints

- Simple Home has at most three content sections and three headline numbers; no chart or card grid above active work.
- No cards inside cards, gradient borders, glassmorphism, neon glow, ornamental blobs, dashboard gauge clusters, or color-coded wallpaper.
- One primary action per pane/dialog, except an approval **decision set**: approve and reject receive equal layout/semantic weight, no preselection, and no visual nudge toward approval. Destructive or expert actions never compete visually with the safe default.
- Use sentence case. Avoid all-caps labels except established short technical tokens inside Pro.
- Prefer a plain row, disclosure, inline notice, or right pane before introducing a modal.
- Status chips are compact annotations, not the primary explanation.
- Empty states explain what will appear here; they do not add illustrations merely to fill space.

#### Interaction and motion

- UI acknowledgement is immediate, but domain mutations remain non-optimistic and display **Submitting → Checking outcome → Committed/Needs attention**.
- Skeletons appear only when useful content takes longer than 250ms; preserve the last truthful snapshot during reconnect instead of replacing it with a spinner.
- Standard transitions last 120–180ms, use opacity/transform only, and preserve spatial causality. No looping decorative motion.
- `prefers-reduced-motion` removes non-essential transition movement.
- Focus moves into opened drawers/dialogs and returns to the invoker. Route/mode changes announce the new heading to assistive technology.
- Switching Simple/Pro keeps spatial context and scroll/selection; Pro chunks load behind stable placeholders without shifting the Task summary.

#### Design and content acceptance set

Before production component implementation, a coherent light/dark reference set, its reachable-state content matrix, **the exact P17 golden JSON fixture driving every screen**, and field/content provenance must be approved together for:

1. Simple Home: empty, normal, partial/disconnected.
2. Active Task with a substantial result in the right pane.
3. Needs-your-input decision.
4. Completed Task with verified and unavailable-verification variants.
5. Unknown/reconciling Task with possible live side effects.
6. Pro graph + node inspector.
7. Pro evidence/Receipt.
8. Settings with Simple/Pro and session controls.
9. Error and recovery: an ordinary failure with preserved results, incompatible protocol/build, expired cursor refresh, and lost/unknown command outcome.

Each of the nine families is rendered and reviewed at 1440×900, 1024×768, 320 CSS px, and 200% zoom in light/dark and both locales. Every visible field/action is annotated in the design handoff with its DTO path, authoritative/projection source, content key/arguments, technical-detail relationship, unavailable behavior, and expected comprehension answer. The product owner approves the screen, state-copy matrix, `en`/`zh-CN` render, fixture, narrow layout, and comprehension script as one review unit before feature component implementation. Approval is based on hierarchy, density, content, keyboard path, both themes, protocol provenance and state completeness—not resemblance from one polished hero screenshot. A design that needs a field or message absent from P17 goes back through P17/projection review; a component may not invent it locally.

The review unit is checked in rather than living in a design conversation:

```text
docs/internal/webui/reference-set-v1/manifest.json
docs/internal/webui/reference-set-v1/screens/<screen-id>.md
packages/taskflow-control/test/fixtures/web-v1/presentation/<fixture-id>.json
packages/taskflow-web/test/fixtures/content-v1/<locale>/<fixture-id>.json
```

The strict manifest binds screen id, route/mode/state discriminants, source and projected fixture hashes, every visible field/content key, authority/provenance, locale, theme, viewport/zoom, focus/reading order, unavailable behavior, and expected comprehension facts. References to a missing or hash-mismatched fixture fail CI.

### 15.3 Why not reuse the Next.js website runtime

- Console has no SEO, SSR, RSC, or public content-delivery requirement.
- A Next server would create another long-lived Node server beside taskflowd.
- Static assets served by the session-aware WebGateway keep one local origin and one process authority; public package bytes may load before exchange, while every dynamic API read requires the live session.
- Documentation website and operational console have different deployment/security boundaries.

Shared visual tokens/components may be extracted later; production runtimes remain separate.

### 15.4 Application shell and static asset delivery

P17 v5 freezes the byte-level delivery contract. The product-level requirements are:

- `/api/v1` and `/api/v1/**` are API space and **never** enter SPA fallback. Unknown API routes return the JSON `WebFailure` 404 contract.
- `/assets/<manifest-hash-name>` serves only exact entries in the packaged asset manifest. Missing assets, `.map` requests, directories, dot-segments, encoded separators, non-canonical encodings, and paths outside the canonical asset root return 404 without filesystem detail.
- Only GET/HEAD may serve the shell/static assets. A known path with the wrong method returns 405 plus exact `Allow`; unknown paths remain 404.
- `/` and syntactically valid routes from the compiled frontend route registry return `index.html` only when the request accepts HTML. Unknown/non-route paths do not receive a misleading shell. Deep-link path parameters pass the same SafeId validation as API identities.
- `index.html` uses `Cache-Control: no-store`; manifest-listed content-hashed assets use `Cache-Control: public, max-age=31536000, immutable` and exact MIME. All static responses use `X-Content-Type-Options: nosniff`; no directory listing or MIME sniffing exists.
- Production CSP is exactly remote-free and eval-free: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'; worker-src 'self'`. Responses also set `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, and a deny-by-default Permissions Policy for unused device capabilities.
- Production packages contain no source maps and no `sourceMappingURL`; a separately built local debug artifact may contain maps but is never published under normal package names.
- The asset manifest binds web build id, package version, protocol major/minor consumer range, entrypoint digest, and every asset digest. WebGateway validates it at startup and fails closed before opening a browser when daemon/schema/assets are incompatible.
- The unauthenticated shell and immutable assets are public code only. They contain no project/user names, ids, paths, registry data, Run data, launch token, nonce material, or per-listener configuration. Dynamic bootstrap/project data requires a live session. Exact Host checks still apply before serving shell/assets.

Canonical path containment is checked after one strict decode and normalization and again after filesystem resolution. These requirements are packaged-dist E2E gates, not Vite development-server assumptions.

### 15.5 State ownership

```text
URL/search params       → navigable local view state
TanStack Query cache    → disposable server projection cache
React component state  → ephemeral interaction state
ControlHost/stores      → all durable domain truth
```

`view=pro`, theme override, and the current-tab language override are non-secret view state. The language override remains in memory; it is not written to URL or storage in beta.2. No general client store is added initially. Add one only if a measured cross-route client-state problem cannot be represented by URL, query cache, or scoped component state.

### 15.6 Rendering strategy

- Route-level code splitting.
- Pro navigation, DAG, raw timeline, diagnostics and large artifact viewers lazy-loaded; none blocks Simple interactive readiness.
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
│   │   │   ├── home/
│   │   │   ├── tasks/
│   │   │   ├── workspaces/
│   │   │   ├── needs-input/
│   │   │   ├── results/
│   │   │   └── pro/
│   │   │       ├── overview/
│   │   │       ├── graph/
│   │   │       ├── timeline/
│   │   │       ├── evidence/
│   │   │       ├── replay/
│   │   │       ├── policy/
│   │   │       └── diagnostics/
│   │   ├── components/      # shell, right pane, disclosures, state/copy primitives
│   │   ├── content/
│   │   │   ├── en.ts         # complete taskflow-content.v1 catalog
│   │   │   ├── zh-CN.ts      # complete taskflow-content.v1 catalog
│   │   │   ├── static-keys.ts # approved non-wire navigation/section/action keys
│   │   │   └── terminology.ts # Simple/Pro term classes + locale lint variants
│   │   └── styles/          # semantic tokens + light/dark themes; no feature raw colors
│   ├── test/
│   └── dist/                # static assets + asset manifest
├── taskflow-control/
│   └── src/
│       ├── web-protocol.ts            # browser-safe TypeBox contracts; no node:* imports
│       ├── web-presentation-server.ts # pure Task/verification/decision; browser bundle forbidden
│       └── web-presentation-client.ts # live reducer + pure observation/failure; browser-only execution
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

- `taskflow-web` may import browser-safe protocol/type exports from `taskflow-control/web-protocol` and only reducer/observation/failure functions from `taskflow-control/web-presentation-client`; its bundle/import lint rejects `web-presentation-server`.
- WebGateway may import `web-presentation-server` and serializes Task/verification/decision results; it may not call the browser-local reducer/observation/failure projection.
- Both presentation modules may depend on TypeBox/browser-safe leaf types and pure helpers but must not import `node:*`, stores, providers, daemon, or runners. They cannot import each other’s producer implementation.
- Content catalogs are data-only browser modules. They may format typed message arguments but cannot import query state, authority logic, commands, an LLM client, or raw backend error text.
- WebGateway may call public ControlHost services; it must not reach into store implementation files.
- A CI import-lint guards both boundaries.
- Static assets are packaged reproducibly; no runtime CDN dependency.

### 16.2 Published artifacts

- `taskflow-web` ships immutable hashed assets and the strict P17 asset manifest; normal production packages contain no source maps.
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
| Cursor expired | Say that the page is out of date and that refresh will not rerun the Task; fetch checkpoint/bootstrap, replace projections, resubscribe. |
| Registry partial/lost | Mark aggregate coverage partial; project reopen rebuilds identity from store header. |
| Project moved/copied/worktree conflict | Show binding evidence and link to the separately authorized P3 CLI workflow; beta.2 offers no browser rebind/adopt/repair action. |
| Command HTTP response lost | Query `GET /commands/:commandId`; retry an identical body only while it remains in live memory. Show “outcome checking,” not failure. |
| `TF_STALE_VERSION` | Refresh exact object and require a new human decision. |
| Provider ambiguous | `unknown/reconciling`, capacity held, attention item; no fake terminal. |
| Artifact missing after retention | Receipt remains immutable; integrity displays `unknown`. |
| Browser reload during mutation | Recover the non-secret `op=commandId`, query the durable CommandRecord with live authz; absent record requires refresh + explicit resubmit. |

Primary errors use `projectControlErrorPresentation()` to state what failed, what remains safe, whether action is required, and the next safe step. `code`, `recoveryAction`, `sideEffects`, affected authority, and copyable correlation/command ids appear in Technical details/Pro. Raw backend messages and stack traces are never primary copy.

---

## §18. Accessibility, privacy, and performance budgets

### 18.1 Accessibility

- WCAG 2.2 AA target for hard-GA routes.
- Full keyboard operation for Simple navigation/Tasks/decisions/results and Pro lists/dialogs/graph/inspectors.
- Visible focus, reduced-motion support, semantic headings/landmarks, screen-reader live regions for command results.
- Status never communicated by color alone.
- Simple/Pro switching preserves focus context and announces the mode without resetting the Task.
- Destructive confirmations name the Workspace, Task, and consequence; Pro may add exact ids.
- At 320 CSS px and 200% zoom, state, uncertainty, verification limits, approval consequences, and primary/decision controls are not truncated, ellipsized, hover-gated, or moved after technical detail.
- Visible decision labels and accessible names communicate the same answer/consequence; screen-reader-only wording may add context but may not soften risk or hide uncertainty.
- Dialog, alert dialog, popover, menu, tooltip, combobox, tabs, disclosure, listbox, and focus-scope behavior uses React Aria Components ([official guide](https://react-aria.adobe.com/getting-started)) with Taskflow styling. A custom replacement requires an ADR plus the same keyboard/focus/dismissal/label/announcement/mobile-screen-reader matrix; Tailwind classes are not an accessibility implementation.
- The interaction matrix covers open/close trigger, tab order, focus trap/restore, Escape and outside-click policy, arrow/typeahead behavior, disabled/read-only semantics, nested overlays, route transition, command-pending state, reduced motion, 200% zoom, VoiceOver/Safari, VoiceOver/Chrome, NVDA/Firefox, and high-contrast mode where supported.

### 18.2 Privacy

- No analytics/telemetry in beta.2.
- No remote assets or automatic remote URL fetches from agent output.
- No service worker or offline persistence.
- Query cache lives in memory and is cleared on logout/session expiry.
- Simple/Pro and theme overrides are non-secret URL/in-memory view state; language override is memory-only. None creates a profile or domain record.
- Sensitive replay/command/session material never enters route/search state or browser persistence.
- Copy/export actions are explicit and respect redaction class.

### 18.3 Performance budgets and reproducibility

The canonical local benchmark profile is an Apple M2 Mac mini (8-core CPU, 16 GiB RAM, internal SSD) with power connected and no thermal throttling. It runs the current supported macOS patch, the exact Node 24 LTS patch pinned by CI, and the exact Playwright Chromium build in `pnpm-lock.yaml`. Every result records hardware model, logical cores, RAM, OS/build, Node/V8, browser build, commit, web/daemon build ids, and asset hashes; a materially slower supported platform is investigated separately rather than hidden by this baseline.

`scripts/bench-web.mjs` owns the reproducible procedure:

- generate the disposable `output/playwright/beta2-web-bench-fixture` from fixed seed `0x54465331`: 100 projects, 10,000 Run summaries, 200 active Runs, 50 approvals, 100 attention items, one 2,000-visible-node graph, and deterministic artifact/Receipt distributions;
- **cold** = fresh daemon/listener, new browser context, empty HTTP/query cache, first navigation after session exchange;
- **warm** = same process/browser context after one complete bootstrap/Home load, with immutable assets cached and the target query prefetched exactly once;
- use 30 independently started/prewarmed owners for the 30 measured cold samples; for repeatable warm-Home and event-visibility scenarios, discard three warmups before 30 measured samples; preload the Pro chunk and cached view before its 30 interaction samples, while retaining first-Pro useful time as a separate one-shot diagnostic; record the fixed scenario order in every report;
- compute p50/p95 with nearest-rank (`ceil(p × n)`) over raw samples; store every sample, not only aggregates;
- measure navigation and interaction latency with browser `performance.mark`; split event visibility into journal-publication→browser receipt and receipt→painted Run detail using the store's commit publication timestamp plus commitSeq-bound monotonic client marks; measure bundle size from packaged gzip bytes and CLS as the maximum standard five-second session window through `PerformanceObserver`;
- write machine-readable evidence to `artifacts/web-bench/<commit>/<profile>.json` and a human summary beside it. CI checks schema and regression thresholds; release evidence retains the raw file.

- Initial Simple shell JavaScript: ≤ 220 KiB gzip; Pro navigation, graph, raw timeline, diagnostics and large artifact viewers are separate lazy chunks.
- Cold Simple Home useful content: ≤ 2.0 s p95 on the canonical fixture/profile.
- Warm local Simple Home interactive: ≤ 1.2 s p95 with 100 projects / 10,000 Run summaries.
- Switching to an already-cached Pro view: ≤ 250 ms interaction response; first Pro chunk shows a stable skeleton within 100 ms and useful content ≤ 1.5 s p95 on the same local dataset.
- Committed event to visible state: ≤ 250 ms p95 on loopback while SSE is healthy.
- Run/event lists remain responsive at 10,000 rows through virtualization.
- Graph remains navigable at 2,000 visible nodes; larger inventories start collapsed/filtered and use worker layout.
- Opening/closing the right pane or switching mode does not reset main-pane scroll/selection and causes no layout shift above 0.1 CLS.
- No unbounded browser retention of event history; timeline pages/cursors are bounded.

Node 26 forward CI runs correctness, protocol, static-delivery, and smoke-performance suites; Node 22.19 remains a compatibility floor. The normative release budget is measured on Node 24 LTS. If a budget proves unrealistic, change it with raw evidence and a reviewed RFC update rather than silently changing fixtures, hardware, percentile math, or dropping the test.

The latest local report binds clean immutable commit
`33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2` and source digest
`sha256:1d270e9e8c755ea1373b1e0ca524e5b37394b0522ec64d970057a6b7ca85a282`.
It is a **non-canonical structural pass**, not release performance evidence:
MacBook Pro M3 Pro, Node 24.18.0, Chromium 149.0.7827.55, 30 samples,
552.3 ms cold-Home p95, 650.0 ms warm-Home p95, 29.8 ms cached-Pro p95,
149.1 ms event-to-painted-detail p95 (79.2 ms commit→receipt and 75.1 ms
receipt→paint diagnostic p95s), 12.6 ms list response, and 0.0690 maximum CLS
session window. Owner-ready and launch-to-useful p95s are retained separately
as 3.72 s and 4.41 s. The Simple shell is 209,114 gzip bytes. The schema-v4
report proves `git.dirty:false`, the exact primary Node version, AC power, no
recorded thermal/performance warning, and pre/post load averages of
4.77/5.79/5.65 and 7.40/6.52/5.96. Because this is not the canonical M2 Mac
mini profile, every latency result remains informational and the canonical
gate stays open.

---

## §19. Testing strategy

### 19.1 Contract tests

- TypeBox request/response validation for every browser endpoint and command.
- Browser-safe import lint (`node:*` forbidden transitively).
- Golden semantics shared across CLI/MCP/Web: same command → same ControlHost result/error.
- `projectTaskPresentation()` golden fixtures cover every namespaced headline/detail key, typed argument, parallel active-step cardinality, implementation grouping, exact/lower-bound/indeterminate progress, result source, all six verification states, primary action, and approval decision-set branch.
- Projection-position/import tests prove Task/verification/decision are produced server-side and serialized, observation/failure run only in the browser, and each consumes only the exact P17 input.
- `reduceWebLiveState()` covers every epoch transition, including valid stamp E → clean catch-up → E+1 → resync success with old E still denied, and disconnect/reset invalidation followed by catch-up without a second increment. `projectObservationPresentation()` covers resource/stamp match × stamp epoch × scope × stream × resync × coverage × authority without rewriting domain status. `projectDecisionPresentation()` and `projectControlErrorPresentation()` cover every closed decision/error/recovery branch and never accept a naked error or raw diagnostic prose as primary content.
- Verification fixtures prove `failed|cancelled` are provider outcomes rather than check states, matching expected failure/cancellation is consistent, and any confirmed mismatch outranks an in-progress check.
- Projection determinism/property tests permute input collection order and prove byte-identical canonical output; missing/contradictory presentation metadata degrades authority/progress instead of guessing.
- Reachable-state fixtures cover every safety-distinct RunStatus × RunStage × verification × observation × current-principal disposition combination. Negative fixtures reject impossible combinations instead of creating dead copy branches.
- Complete `en` and `zh-CN` catalog tests prove projected/static/combined keyset and argument parity, whole-message formatting, plural/date/number correctness, no fragment concatenation, no inline unregistered UI strings, no missing-key/raw-key fallback, and stable catalog digests. The static-key source is one-way: reference manifests may reference its digest/keys but cannot define them.
- Content lint rejects Simple primary/accessibility output containing §10A.4 internal terms, raw `ControlError.message`/stack text, generic decision labels, fake first-person emotion/intent, unsupported reassurance, or unbounded completion-time promises.
- Compatibility fixtures cover old-client/new-server additive presentation fields, new-client/old-server missing optional fields, and rejection of removed/changed required fields, enum/discriminant additions, and security/command/cursor unknown fields.
- RunStatus × RunStage full matrix.
- Cursor known-answer fixtures freeze canonical JSON bytes, encoded payload segment, ASCII MAC input, signature, and final cursor across supported Node versions; tamper/expiry/principal/query/sort/registry/compaction matrices invent no global sequence.
- Fragment/graph/timeline/Attempt/artifact/Receipt pages cover row and full-envelope byte boundaries, last-returned exclusive cursor, version binding, oversized-element failure, and exact concatenation of every page. An exact-boundary fixture proves a row plus its required `nextCursor` that brings the envelope exactly to budget is returned, becomes `after`, and its successor appears once on the next page. Every non-page endpoint enforces its complete JSON response budget without silent truncation.
- Auto and standalone cursor payloads carry their exact mode/revision plus canonical hashes of the full discriminated registry context; no fabricated standalone registry revision. Page and stream cursors round-trip below 8 KiB at the 200-project bound.
- SSE query cursor/`Last-Event-ID` equal, conflict, oversize, cross-kind and absent matrices; closed change/resource enums have no open-string branch.
- Approval success is `running/queued` with a held reservation and no Receipt until provider terminal truth.
- Cancel with missing/ambiguous provider proof is `unknown/reconciling`, holds capacity, and creates no Receipt.
- Lowering maxActiveRuns below occupancy rejects atomically; force-release compares the full reservation CAS and is idempotent.
- Static delivery tests cover API/fallback partition, deep links, route SafeIds, exact manifest assets, cache/MIME/header policy, canonical containment/traversal, source-map absence, unauthenticated-shell data scan, incompatible asset/daemon manifests, and absent/multiple/mixed/wildcard/quality-zero/malformed `Accept`.
- Registry drift tests prove all 29 P17 v5 endpoints are bijective across `WEB_ENDPOINTS`, handlers, generated client, and the generated RFC inventory block.
- HTTP defense tests cover header/request limits and timeouts, duplicate Host/Content-Length, CL/TE conflicts, unsupported Expect/Upgrade, 404 versus 405/Allow, keep-alive limits, slow body, stalled artifact consumer, and SSE timeout exemption.
- Artifact corruption tests prove the entire digest/length is verified against an immutable snapshot before response headers or any body byte.

### 19.2 Component tests

- Loading, empty, ready, disconnected, partial, unverified, forbidden, incompatible, error and recovery states for every Simple route and every Pro-only surface.
- Mode matrix: Simple is default, Pro is opt-in, direct Pro links preserve target, switching preserves route/selection/command outcome, and capability/action sets remain identical.
- Simple-language guard: internal-only terms do not appear in primary navigation/headlines/explanations/actions/accessible names; exact terms remain reachable in Technical details/Pro without replacing the human message.
- Light/dark screenshot matrix at 1440×900, 1024×768, 320 CSS px, and 200% zoom for every §15.2 acceptance state in both advertised locales.
- Visual lint checks semantic tokens, one-primary-action rule, nested-card ban, focus visibility and reduced motion.
- Keyboard/focus behavior and automated accessibility checks.
- Graph selection, dynamic fragment grouping, and large-graph collapse.
- The SVG graph emits no inline style/runtime stylesheet under the production CSP, exposes no topology mutation command, and the synchronized semantic tree completes the same navigation/inspection tasks.
- Approval and destructive confirmation content.
- Approve/reject decision sets form a direct question/answer, use consequence-specific labels, have equal semantic/layout weight, no default/preselection, and identical keyboard reachability.
- One-sided approval capability fixtures are `status-only`: no approve-only/reject-only decision control or Needs-your-input count.
- Golden screenshot and DOM assertions prove state, remaining risk, approval consequences, verification limits, and primary/decision actions are never ellipsized, clipped, reordered behind technical detail, or hover-only on narrow/zoomed layouts.
- Needs-your-input disposition fixtures exclude refresh-only, active automatic reconcile, `recoveryAction:none`, other-principal approval, and diagnostic-only attention.
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
8. switch Simple/Pro during live/reconnecting/command-pending states and prove resource/action truth is unchanged;
9. verify browser never writes store files directly;
10. serve every registered deep link from packaged assets while `/api/v1/**` and bad asset paths never fall through;
11. corrupt an artifact source before delivery and prove the browser receives no success headers/body bytes;
12. let every session expire and prove the listener closes; restart daemon and prove it does not reopen.

### 19.4 Novice and ordinary-engineer usability gate

Before beta.2 publish, at least five fresh representative primary-language `en` users who did not author the control-plane RFC complete the test from a fresh Simple session without documentation or facilitator hints:

The study is reproducible rather than an informal demo:

- `docs/internal/webui/usability-script-v1.md` freezes the moderator introduction, exact task wording, permitted neutral prompts, stop conditions, post-task comprehension questions, consent/privacy handling, and scoring rubric before recruitment.
- `packages/taskflow-web/test/fixtures/usability-v1` is reset for every participant and binds the same Workspace/Task names, live/approval/reconciling/verification states, results, timestamps relative to a fixed study clock, and available actions.
- Recruit at least two Taskflow-naive software engineers and three ordinary engineers who use developer tools but did not author or implement the 0.3 control plane; record prior Taskflow exposure without changing the score.
- Use the same supported desktop, viewport, theme default, browser build, and fresh browser profile. Timing starts when the route becomes useful and stops on the rubric-defined action/explanation; the moderator records wrong turns and confidence without helping.
- Store the anonymized score sheet, exact build/fixture hashes, timings, errors, observations, and disposition of every finding at `artifacts/web-usability/<release-candidate>/`. Do not store screen/audio recordings without separate consent.
- Material navigation, projection-copy, decision-layout, or verification-language changes invalidate affected tasks and require rerunning them with five fresh, non-learning-contaminated participants.
- For every safety-critical state, the moderator asks the participant to explain in their own words: **what happened, whether they need to act, what risk remains, and what the next action will do**. Recognizing or reading the visible label is not sufficient.

| Task | Pass condition |
|------|----------------|
| Find what needs attention | 4/5 reach the correct item within 30 seconds |
| Explain one active Task | 4/5 correctly state what is happening, whether they need to act, remaining risk, and the next step within 60 seconds |
| Understand an approval request | 4/5 correctly state the requested decision, both consequences, whether work is active, and the real deadline within 60 seconds |
| Make an offered approval decision | When approve/reject ships, 4/5 understand the consequence and complete it within 90 seconds |
| Cancel a Task | 4/5 explain that “Stopping” may not be terminal, that work may remain active, and what committed outcome they must wait for within 90 seconds |
| Find and assess a result | 4/5 locate output, distinguish task completion from verification, and explain the consequence of unavailable/failed verification within 60 seconds |
| Open exact technical evidence | 4/5 discover Pro/Technical details without being told where it is |

Any participant interpreting “Checking whether the task is still running” as confirmed failure/completion, missing that work may still be live, believing a Receipt automatically means Verified, believing Pro grants more permission, reading approve as the recommended choice, or misunderstanding what refresh/reject/cancel will do is a severity-1 UX failure regardless of aggregate task score. **One severity-1 finding blocks the entire release candidate.** The 4/5 thresholds apply to ordinary task completion and non-safety comprehension; safety-critical facts require zero severity-1 findings. After a fix, the affected task is rerun with five fresh participants who have not seen the prior version; prior failed records remain in the evidence bundle. Visual polish and successful clicks cannot compensate. Five users provide a qualitative release gate, not a statistical usability claim.

`zh-CN` ships only after full key/argument/semantic parity, the same light/dark/narrow/a11y matrix, and independent native-level review by one content/UX reviewer and one technical/safety reviewer. Beta.2 does not present those reviews as five-user comprehension evidence. If `zh-CN` or any later locale is promoted to an equal human-comprehension claim, it must run the same script with its own five fresh participants; bilingual participants are not reused across locale cohorts.

### 19.5 Adversarial matrices

- Two tabs approve/reject same request.
- Cancel versus approval race.
- Command committed but HTTP response lost.
- Cursor expiration during high event volume.
- Registry wipe and project reopen.
- Project copy/worktree identity conflict.
- Provider ambiguity and force-release.
- Simple/Pro switch during stale version, lost response, disconnected SSE and authorization revocation.
- Direct Pro URL opened in Simple; no target loss, fake 404, capability elevation or hidden unsafe API.
- Launch/session theft and replay, hostile `localhost`, cross-port cookie injection, exact Host/Origin, CSRF, DNS rebinding, malicious output, artifact path traversal.
- Slowloris headers/body, duplicate CL, CL/TE ambiguity, method confusion, encoded traversal, bad MIME, source-map probing, stale build manifest, and unauthenticated shell inspection.
- 100 projects × 10,000 Runs × partial mounts.

Mock-only success is not beta.2 acceptance.

---

## §20. Release and GA gates

### 20.1 Product commitment

- [ ] Every **Must ship** row in §2.1 and every matching surface in §7.4 works against real authority through the packaged CLI → daemon → WebGateway → browser path.
- [ ] Every new session opens the complete Simple task experience; Pro reveals the full implemented technical surface without changing route target, truth, authorization or command semantics.
- [ ] Home, Tasks, Needs your input, Workspaces, Task detail/result/verification and contextual cancel pass the §19.4 ordinary-engineer usability gate.
- [ ] Every §15.2 light/dark reference screen is approved together with its reachable-state content matrix, exact P17 v5 golden fixture, field-level authority/content provenance, `en`/`zh-CN` render, 320px/200%-zoom proof, and comprehension questions; screenshot/state matrices show consistent hierarchy, density, content, motion, keyboard/focus and responsive behavior—not one polished hero screen.
- [ ] Overview, Projects, aggregate Runs, Run detail, timeline, DAG/dynamic inventory, node/attempt detail, approval inspection, attention, evidence/artifacts, why-stale, replay, policy explanation, cancel, and reconnect/polling remain reachable through the Simple/Pro matrix and cover their applicable loading/empty/partial/unverified/disconnected/forbidden/incompatible/error states.
- [ ] The §7.5 source matrix has an implemented typed ControlHost read API and durable or deterministic source for every returned field; no fixture-only data, fabricated empty arrays, or browser-owned authority remains.
- [ ] P17 v5 codecs, handlers, fixed server/browser projection positions, exclusive live-state reducer, complete content catalogs, hostile-input/static-delivery tests, and golden fixtures agree on every Must-ship endpoint/state. `WEB_ENDPOINTS`, handlers, generated client, and generated RFC inventory are bijective; the checked-in TypeBox module has no undocumented route, content key, or missing required branch.
- [ ] Fragment/graph/timeline/Attempt/artifact/Receipt pagination and every non-page JSON response pass encoded-byte budgets, version-bound continuation, one-oversized-element, and concatenate-all-pages tests; no large DTO silently truncates.
- [ ] Capability discovery is closed and truthful: unimplemented commands are unadvertised and unreachable; per-resource actions are computed by current authority.
- [ ] Publish the local console in `0.3.0-beta.2`; do not relabel the whole product as 0.3.1 to avoid finishing its safety baseline.
- [ ] Keep project ControlStores authoritative and the browser disposable; no merged user-level Run ledger or Web-only state machine.
- [ ] Keep policy explanation read-only until a separate authoritative policy persistence ADR exists.
- [ ] Performance and usability gates produce raw, reproducible evidence under §18.3/§19.4 rather than screenshots or aggregate claims alone.
- [ ] Simple primary and accessibility content passes the terminology/error/decision lint; the `en` cohort meets ordinary 4/5 task thresholds with zero severity-1 safety misunderstandings, and any severity-1 fix is rerun with five fresh participants.

### 20.2 Hard 0.3.0 GA core

These capabilities must be complete—not hidden—before 0.3.0 GA:

The current control-host candidate closes the plain approve/reject path: a parked Run reloads its original immutable BoundPlan and private exact-continuation checkpoint, survives host restart, recovers all four pre-dispatch approve saga prefixes before daemon transport is exposed, never replays settled work, and reaches terminal/Receipt only through resumed provider execution. A post-dispatch restart with an unproven provider submission is conservatively `unknown/reconciling`, never replayed. Missing or corrupt continuation evidence still fails closed. `edit-approval` remains unadvertised because edited BoundPlan persistence, re-Link validation and its dispatcher handoff are not implemented. These local and packaged proofs advance the approval checkbox; they do not waive the remaining edited-plan, human-review, reviewed-tip compatibility or wire-freeze gates.

- [ ] `taskflow ui` explicitly launches/attaches the singleton; no listener before launch, public/LAN path, daemon-restart reopen, or silent standalone fallback.
- [ ] P17 session/Host/Origin/CSRF/cursor/SSE/artifact/static-shell/HTTP-defense/content contract and hostile-local-process matrix pass against packaged dist.
- [ ] Simple is the default and never hides uncertainty, possible live side effects, required input, verification limits or incompatibility; Pro preserves all hard-GA control/evidence surfaces in the same voice. `en` passes the five-user §19.4 gate; `zh-CN` passes full parity, visual/narrow/a11y, and two-reviewer linguistic QA. No equal human-comprehension claim is made without a separate fresh cohort.
- [ ] Overview accurately aggregates multiple project stores and independently preserves stream state, coverage, and authority; Simple translates their practical consequence without falsifying them.
- [ ] Project and Run routes always carry project identity; aggregate Run list, authoritative Run detail, timeline, read-only DAG/dynamic inventory, and semantic accessibility tree work.
- [ ] RunStatus × RunStage remains truthful, especially `paused/parked`, `paused/executing`, and `unknown/reconciling`.
- [ ] Approval inbox and approve/reject/edit use P15 CAS; original/edited BoundPlans survive parking, the dispatcher consumes the committed handoff, and provider outcome—not the decision—controls terminal/Receipt.
- [ ] Cancel is a durable idempotent command; terminal cancel requires quiescence proof, while ambiguous/missing provider knowledge holds capacity and surfaces attention.
- [ ] Read-only effective policy explanation shows provenance and deny/substitute/attenuate decisions without implying edit authority.
- [ ] Receipt/evidence never appears before true terminal outcome; verification uses the six-state derivation rather than Receipt presence; artifact reads require live authz + ledger reachability, verify an immutable snapshot before sending bytes, and never disclose SecretRefs.
- [ ] Stop/rollback of WebGateway changes no Run/store truth; browser reload and lost response recover through command query, not blind retry.

### 20.3 Capability-gated high-risk writes

Beta.2 may omit the controls below without violating §20.1. Before GA, §20.2 decides which capabilities must graduate; this table does not waive a Hard-GA requirement. A control is **entirely hidden** unless its backend advertises the live capability and its independent matrix is green; a disabled button, experimental query flag, or direct hidden API is not omission.

| Capability | Independent enablement gate |
|------------|-----------------------------|
| resume/recompute | Durable idempotency, re-admission, affected-set preview, cost caveat, restart/lost-response tests |
| manual reconcile | Bounded provider history, no fake terminal, unknown/needs-operator recovery tests |
| set maxActiveRuns | CoordinatorCommandRecord, expected value/epoch, atomic reject-below-occupancy, multiprocess tests |
| force-release | Full reservation state/revision/epoch/project/Run CAS, exact ack, idempotency, operator-overridden audit |
| re-run saved Program | Exact frozen CLI/MCP run contract; no web-only compiler path |

Policy editing is not in this table: it is out of scope, not a hidden capability.

### 20.4 Quality follow-through

- [x] Receipt JSON export and local export-consistency UX. The versioned export
  re-reads the complete paged manifest, fails closed on identity/continuity
  mismatch, serializes deterministic JSON, and is exercised against packaged
  Chromium, Firefox and WebKit. The UI states that this does not replace
  authoritative evidence verification.
- [ ] Large-graph performance target and full keyboard/tree parity. The
  React Aria graph listbox now provides single-tab-stop arrow navigation,
  selection state and inspector parity on Chromium, Firefox, WebKit and native
  Chrome. The non-canonical M3 Pro/Node 24 30-sample harness loads all 2,000
  nodes and passes its structural/budget plumbing, but the checkbox remains
  open because the canonical M2/Node 24 performance evidence is absent.
- [ ] Cross-browser matrix on supported current Chrome/Edge, Firefox, and
  Safari. Native Google Chrome 150.0.7871.184 now passes the complete packaged
  path. Native Safari 26.3 on macOS 26.3 passes a packaged read/keyboard smoke
  covering one-time exchange, Simple home/task, Simple → Pro, native
  accessibility-tree tab/list semantics, graph selection/inspector parity and
  Evidence/Receipt/artifact rendering. Native Edge, the full Safari mutation
  path, VoiceOver and the remaining manual matrix remain outstanding. The
  automated Firefox 151.0 and WebKit 26.5 lanes remain supporting evidence,
  not substitutes for those native-product lanes.
- [x] Why-stale and zero-token replay remain visibly distinct from live
  execution. The packaged browser selects the Replay surface independently,
  executes the Receipt-bound trace, renders the explicit simulation proof, and
  observes zero provider calls, zero durable writes and an unchanged project
  `nextCommitSeq` in Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5.
- [x] Visual/interaction regressions are gated by 149 real component renders
  bound to the exact source fixtures, projections, bilingual catalogs,
  light/dark themes, desktop/320px/200%-zoom matrix and screenshot hashes.
  `check:web-render-evidence` fails on missing or changed bytes, horizontal
  overflow, fixture drift, or recorded serious/critical axe failures. Human
  product/content approval remains a separate unchecked release gate.

Any attempt to weaken the hard GA core or promote a high-risk write without its gate is an explicit product/architecture re-decision, not a schedule interpretation.

---

## §21. Implementation order

```text
0. Freeze RFC v7 §2.1/§2.2/§7.4/§7.5/§10/§10A and provisional P17 v5 projection positions/inputs, content, verification, live-state reducer, response budgets/pagination, compatibility, HTTP and static-delivery semantics
1. Produce each §15.2 light/dark reference screen together with its reachable-state copy matrix, real P17 golden JSON fixture, field/content authority/provenance annotation, `en`/`zh-CN` render, narrow/zoom proof, and comprehension questions; approve the complete unit, not the picture alone
2. Bring browser-safe TypeBox producer/consumer schemas, sole endpoint registry + docs/client/router drift guard, fixed-position deterministic Task/observation/decision/error projections, display/presentation metadata, complete content catalogs, codecs, projection/status/content/compatibility fixtures, and hostile-input tests into exact P17 v5 conformance
3. Add the typed ControlHost read services and durable/reconstructable display/presentation metadata, BoundPlan, paged BoundFragment/graph/node/Attempt/timeline/artifact/Receipt, approval, why-stale, and replay sources required by §7.5
4. Implement taskflow ui + loopback WebGateway + session exchange/logout/revoke, exact HTTP defenses, Host/Origin, CSRF, application-shell/static delivery, CSP, asset manifest compatibility, verified artifact snapshot, SSE and listener lifetime
5. Build the design-token foundation, static React/Vite shell, typed routes, Simple default, Pro switching, bootstrap compatibility, closed capability discovery, and complete route-state framework
6. Implement Simple Home + Tasks + Needs your input + Workspaces + three-axis truth translation
7. Implement Simple Task detail + steps + result pane + verification + truthful durable cancel
8. Implement Pro Overview/Projects/Runs + Run detail/timeline/SSE + bounded polling
9. Implement Pro DAG/dynamic inventory/semantic tree/node/Attempt inspector
10. Implement Receipt/evidence/artifact + plain why-stale + Pro replay + contextual/Pro policy explanation
11. Add capability-gated approve/reject/edit, resume/recompute/preview, reconcile, maxActiveRuns, force-release, and saved-Program rerun only as their independent gates pass
12. Complete Simple/Pro content, localization, comprehension, visual, security, a11y, performance and adversarial matrices
13. Run packaged-dist real-daemon E2E for every Must-ship row and publish 0.3.0-beta.2
```

Feature implementation starts only after the joint reference screen/content matrix/golden fixture/provenance/narrow/comprehension unit, real contracts, catalogs, and sources for that slice exist. If a screen exposes a missing field, message, argument, or projection rule, P17/fixtures/catalogs change before the component. Browser-consumer requirements belong in P17 rather than being retroactively attributed to P1–P16. Wire freeze is a later gate after real handler/projection/content/codec/static-delivery and compatibility evidence, not an input assumption to protocol work.

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
- Request, session, security, command, action/CAS, cursor, error and SSE wire schemas are strict closed and fail on unknown fields/discriminants.
- Server presentation **producer** schemas are strict closed so handlers cannot leak accidental fields. Browser presentation **consumer** schemas preserve all required known fields and tolerate/ignore unknown properties only at P17-marked additive extension points.
- Adding an optional presentation field at a marked extension point is protocol-minor compatible only after old-client/new-server and new-client/old-server fixtures pass. Removing/changing a required field, changing semantics/defaults, or adding/changing an enum/discriminated-union branch is protocol-major unless P17 already defines an explicit safe unknown branch.
- The browser never uses an unknown presentation field for authority, action eligibility, verification, security, cursor continuation, or command construction.

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
Document: RFC v7
Product identity: Proposed — Simple local task workspace + opt-in Pro console, not authoring frontend
Experience model: Proposed — Simple default; Pro progressive disclosure over identical truth/authz/commands
Design quality: Proposed hard gate — OpenAI/Anthropic-class restraint with Taskflow identity, joint screen/content/fixture review, light/dark/narrow matrix and comprehension testing
Content voice: Proposed hard gate — calm, truthful, concrete and action-oriented; deterministic en/zh-CN catalogs; en five-user comprehension plus zh-CN independent linguistic QA; no anthropomorphic or raw-error primary copy
Browser transport: Proposed — on-demand loopback JSON/SSE
Frontend stack: Proposed — React 19.2 + Vite 8.1 static SPA + React Aria; Node 24 LTS primary, 22.19 floor, 26 forward CI
Authority model: Inherited/frozen from control-plane RFC v7.7+
Browser wire: P17 v5 is the provisional target; protocol remains web.v1 and is not wire-frozen
Executable schema: P17 v5 implementation candidate exists — 29-row WEB_ENDPOINTS, strict/additive TypeBox codecs, key-specific content-message argument tuples, fixed server/browser projections, generated handler/client adapters, complete projected/static en + zh-CN catalogs, locale/formatter/Simple-language guards, exact signed cursor codec/known-answer fixtures, and protocol/content/reference drift guards. P17 remains provisional until the complete §15 compatibility/adversarial matrix and reviewed-tip evidence are green.
Read model: §7.5 remains normative. Durable BoundPlan, ApprovalRequest, conservative node/Attempt metadata, and nineteen explicitly enumerated ControlStore/Coordinator read handlers back the current browser reads. Dynamic `expand` Runs now atomically journal content-addressed BoundFragment bodies, Run-scoped link/causation/commit provenance, projected descendants and Receipt identity; recovery and fragment/graph/timeline reads are executable. Provider evidence covers checkpointed running/completed work, collection failure, rejection without a handle, settled cancellation, authoritative ambiguous reconcile, checkpoint-write failure, recovered completion without a terminal Attempt checkpoint, and projection-loss recovery. Node enrichment reaches every closed provider outcome, while Receipt provenance is `ok` only with complete durable evidence and otherwise remains `unknown`. All 29 WebGateway route slots are composed from session/bootstrap, read, pure-analysis, artifact, replay, durable-command, and event services. The packaged default now advertises the independently proven `approve`, `reject`, and `cancel-run` commands. Approve binds the ApprovalRequest to a secret digest-verified continuation artifact and original BoundPlan, survives writer restart, consumes one exact approval boundary, preserves prior Attempts/outputs, dispatches only downstream work and keeps the private checkpoint outside Receipt/browser reachability. Daemon startup recovers the four durable `running/queued` saga prefixes before exposing transport; an interrupted `running/executing` provider boundary fails closed as unknown rather than replaying. Reject remains a terminal no-dispatch decision. Edit and recovery/capacity commands remain unadvertised unless their separate gates pass; handler presence alone is still not a capability.
Implementation: The React WebUI, loopback WebGateway, session/CSRF/static delivery, SSE plus bounded polling fallback, generated client, Simple/Pro projections, durable command recovery, Pro graph/timeline/evidence/replay/technical panels, and session revocation controls are executable. Packaged CLI → daemon → multi-project real browser E2E covers two independent nonce-host listeners, a live cancel, restart-safe contextual approval followed by downstream execution and an honest terminal Receipt, private-checkpoint non-reachability, terminal Receipt/artifact rendering, deterministic full-manifest Receipt JSON export with fail-closed client consistency checks, visibly separate why-stale and replay surfaces, browser-executed Receipt-bound replay with zero provider calls/zero durable writes/unchanged `nextCommitSeq`, SSE/polling-equivalent live and stopped Task presentation, every current GET polling query surface, localized route-specific document titles, React Aria task-tab/disclosure/alert-dialog and single-selection semantics with keyboard selection, graph-listbox arrow navigation with visual-inspector parity, modal focus/Escape/restore behavior and Simple → Pro focus restoration, the manifest-bound split production bundle, zero CSP/runtime-style failures, 320px layout and Chromium axe. The approval-enhanced packaged candidate passes Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 from the same source state, on the first attempt of each matrix lane; all three report zero application console/page errors, CSP violations and runtime-style findings, and all three download and parse the checked Receipt JSON file, execute the offline replay proof and pass graph-listbox keyboard parity. The installed native Google Chrome 150.0.7871.184 also passes the complete packaged path and Chromium axe checks through the explicit `chrome` channel. Native Safari 26.3 on macOS 26.3 separately passes a packaged read/keyboard smoke covering one-time exchange, Simple home/task, Simple → Pro, native accessibility-tree tab/list semantics, graph selection/inspector parity and Evidence/Receipt/artifact rendering. Automated engine coverage, native Chrome and this scoped Safari smoke do not replace native Edge, the full Safari mutation path, VoiceOver or the remaining assistive-technology review. All ten registered page surfaces pass executable empty/single/N+1/oversized/concatenation cases; recursive schema evidence covers every nested union branch; exact 100-MiB artifact transport, five-minute absolute-deadline logic, real SSE backpressure, combined cross-runtime cursor invalidation, canonical static-path/hostile-package, and singleton/control-header corpora pass. Project-local Run/approval recovery indexes, idempotent journal recovery including pre-index Run migration, unchanged-registry/header opens, startup snapshot prewarm, and commit-woken SSE invalidation keep aggregate reads fast without creating a user-level ledger or weakening disk authority. Stable dependency chunks keep the largest minified chunk at 191.20 kB; the production asset builder measures the modulepreloaded Simple shell at 209,114 gzip bytes (204.21 KiB) and fails above the 220-KiB budget. Clean immutable commit `33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2` has a schema-v4 M3 Pro/Node 24 deterministic 100-project/10,000-run/2,000-node 30-sample non-canonical structural pass with JSON and human evidence; the report records `git.dirty:false`, exact source digest, raw samples, exact Node version, AC power, no recorded thermal/performance warning and pre/post system load. The canonical M2/Node 24 raw 30-sample gate is still required. A real cross-build browser/gateway harness rejects identical asset or commit identities; distinct immutable candidates `83021958b61d65425847817f3b5d275bd048979a` and `33202a9c26e2d3b86d8d661a09b4c9ef5f9a56e2` pass both old-client/new-server and new-client/old-server with Web v1 bootstrap and zero application console/page errors. This closes the first local immutable-pair gap but must be rerun at reviewed tip. The current all-suite candidate passes 187/187 control tests, 35/35 daemon tests and 2287/2287 full unit tests, plus the packed-package smoke and packaged Chromium E2E in `pnpm verify:web-candidate`; the separate three-engine matrix and native-Chrome lane also pass. The nine-family reference set has 149 hash-bound en/zh-CN, light/dark, desktop/narrow/zoom renders and 36 automated serious/critical axe assessments, but stays draft-unapproved. Human product/content approval, five fresh English participant records, two native zh-CN reviews, edited-approval and separately gated recovery dispatch where required for GA, canonical performance evidence, reviewed-tip compatibility/candidate evidence, and a separate wire-freeze review remain mandatory.
```

---

*End RFC v7. Beta.2 makes the 0.3 control plane approachable by default and complete on demand—not another workflow language, another authority, another dense operations dashboard, or an AI persona that talks over control-plane truth.*
