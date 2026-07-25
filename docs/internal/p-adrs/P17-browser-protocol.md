# P17: Browser protocol, capabilities, and aggregate cursors

> Status: **Provisional** (v5; 0.3.0-beta.2 target contract; wire freeze not declared)
> Document version: **v5**
> Protocol identifier: `web.v1`
> Normative parents: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7+ and [rfc-0.3.0-beta.2-web-console.md](../rfc-0.3.0-beta.2-web-console.md) v7
> Target executable schema: [`packages/taskflow-control/src/web-protocol.ts`](../../../packages/taskflow-control/src/web-protocol.ts)
> Target server projection: `packages/taskflow-control/src/web-presentation-server.ts`
> Target browser projection: `packages/taskflow-control/src/web-presentation-client.ts`

## Decision

P1–P16 define control-plane authority, persistence, and state-machine semantics. They do **not** define an HTTP/browser protocol. P17 exclusively owns:

- browser endpoint inventory and DTO names;
- session exchange, logout, emergency revocation, Host/Origin, and CSRF;
- closed feature/command discovery and per-resource actions;
- HTTP envelopes, limits, statuses, pagination, and error mapping;
- aggregate page cursors and SSE resume cursors;
- SSE framing, heartbeat, backpressure, and reset;
- artifact authorization, redaction, MIME, and delivery;
- deterministic Task, observation, decision, error, and verification presentation;
- versioned complete content catalogs, locale negotiation, and content compatibility;
- application-shell/static delivery and low-level HTTP defenses;
- the distinction between durable domain commands, ephemeral session operations, and pure analysis.

The browser is a replaceable projection client. P17 creates no new Run, Command, Approval, Receipt, policy, project, or coordinator authority.

This document is the **v5 target**. The checked-in implementation now has the
29-row `WEB_ENDPOINTS` registry, strict-producer/additive-consumer TypeBox
codecs, fixed server/browser projection modules, generated handler/client
adapters, key-specific `WebContentMessage` codecs, and complete checked-in
projected/static `en` + `zh-CN` catalogs with deterministic formatting and
Simple-language guards. The loopback WebGateway implements all 29 registered
route slots through session/bootstrap, authoritative read, pure-analysis,
artifact, replay, durable-command, and event services. Its default capability
set advertises only commands whose complete dispatch path exists
(`approve`, `reject`, and `cancel-run`); edit and recovery/capacity commands
remain unadvertised rather than claiming unavailable dispatch paths.

Executable evidence now includes signed page/stream cursor vectors and
full-envelope continuation fixtures; session, CSRF, Host/Origin, static
delivery, SSE and bounded polling fallback tests; a packaged CLI → daemon →
WebGateway → real browser path over multiple mounted ControlStores; durable
cancel, approval recovery and lost-response handling; Receipt/artifact
rendering; four scoped native Safari mutation smokes; and 149 hash-bound
reference renders covering nine screen families, two locales, two themes,
narrow/zoom conditions, and 36 serious/critical accessibility assessments.
The reference set remains **draft/unapproved**, and the required
five-participant English comprehension study plus independent native
Simplified-Chinese review have not occurred. Canonical performance, native
Edge/assistive-technology, reviewed-tip and separate freeze-review evidence
also remain absent. Therefore the module is an executable implementation
candidate, not canonical frozen wire authority; neither document nor code may
claim full conformance, wire freeze, or released WebUI.

## 1. Conformance states and compatibility

The browser protocol uses three distinct states:

| State | Meaning |
|-------|---------|
| **Target** | P17 specifies the required shape/behavior, but implementation evidence is incomplete. |
| **Conforming** | TypeBox schema, handler, codec round-trip, golden fixture, and negative tests agree for that endpoint/branch. |
| **Wire-frozen** | Every Must-ship v5 surface is conforming and additive/minor versus breaking/major behavior has compatibility fixtures. |

`web.v1` remains the protocol identifier because no P17 target has yet been released as a frozen incompatible wire. The P17 document revision and the browser protocol major are separate. If a previously released frozen shape is changed incompatibly, the protocol becomes `web.v2`; editing this ADR is not a substitute.

The schema module is browser-safe and may import only TypeBox plus browser-safe control wire definitions. It must not import `node:*`, stores, providers, daemon implementations, or executable control-plane logic.

## 2. Common wire rules

### 2.1 Base protocol

- Base path: `/api/v1`.
- JSON response media type: `application/json; charset=utf-8`; canonical JSON
  POST request media type: exactly `application/json`.
- Request/response character encoding: UTF-8.
- Browser timestamps: Unix milliseconds.
- Project `commitSeq`: non-negative project-local integer; never a global sequence.
- Request, security, session, cursor, command, action/CAS, replay override, recompute-preview, error, content-message, and SSE producer schemas are strict closed; unknown properties and unknown discriminants fail validation.
- Every server presentation **producer** schema is strict closed, preventing accidental field leakage. Every browser presentation **consumer** schema requires all known required fields but permits unknown properties only at explicit additive extension points marked in the TypeBox metadata as `x-web-additive:true`; the consumer ignores those fields and never uses them for authority, actions, verification, security, cursors, or command construction.
- Adding an optional presentation property at a marked extension point is minor-compatible only after old-client/new-server and new-client/old-server fixtures pass. Removing/changing a required field, changing a default or meaning, or adding/changing an enum/discriminated-union branch is breaking and requires a new protocol major unless this document already defines an explicit safe unknown branch.

The v5 additive extension points are exactly the top level of `WebOverviewView`, `WebProjectSummary`, `WebProjectDetail`, `WebRunSummary`, `WebRunDetail`, `WebTaskPresentationSummary`, `WebTaskPresentation`, `WebNodeDetail`, `WebApprovalSummary`, `WebApprovalDetail`, `WebAttentionItem`, `WebReceiptView`, and `WebPolicyExplanation`. Page/success envelopes and nested `WebContentMessage`, `WebSourceObservation`, `WebVerificationPresentation`, `WebDecisionPresentation`, `WebDecisionSet`, `WebFailurePresentation`, `availableActions`, identity/version, state/status/stage, error, cursor, SSE, artifact-security, and command objects remain strict consumers. Adding a new extension point is itself a reviewed compatibility change.

Every JSON success is:

```ts
type WebSuccess<T> = {
  ok: true;
  requestId: string;
  schemaVersion: "web.v1";
  data: T;
};
```

Every JSON protocol/transport failure is:

```ts
type WebFailure = {
  ok: false;
  requestId: string;
  schemaVersion: "web.v1";
  error: ControlError;
};
```

`requestId` is a new non-secret SafeId for each HTTP request. It is diagnostic correlation only and never an idempotency key.

### 2.2 Identifiers and limits

Every path-capable identifier uses the core SafeId contract: 1–128 characters, first character alphanumeric, remaining characters `[A-Za-z0-9._-]`; `..`, `/`, `\`, NUL, control characters, percent-decoded separators, and non-canonical percent encodings are rejected before routing and again at the host/store boundary.

| Item | v5 limit |
|------|----------|
| Request target | 16 KiB |
| JSON request body | 1 MiB decoded |
| Ordinary JSON success/failure body | 2 MiB UTF-8, including the complete envelope |
| Authoritative `WebRunDetail` body | 4 MiB UTF-8 |
| Graph page body | 8 MiB UTF-8 |
| Pure-analysis body | 4 MiB UTF-8 |
| Any JSON body | 8 MiB absolute |
| One page element after canonical JSON encoding | 64 KiB |
| Page/stream cursor | 8 KiB |
| Page limit | default 50; maximum 200 |
| Graph page | default 500 nodes; maximum 2,000 nodes and 4,000 in-page/boundary edges |
| Filter text | 256 Unicode scalar values after NFC normalization |
| SSE JSON frame | 64 KiB UTF-8 |
| Inline artifact | 5 MiB |
| Any browser artifact download | 100 MiB |
| Live browser sessions per listener | 8 |
| Concurrent non-SSE requests per session | 16 |
| Concurrent pure-analysis requests per session | 2 |

Response limits count the UTF-8 bytes of the complete encoded `WebSuccess`/`WebFailure`, not only `data`. Page endpoints are bounded by both row count and the endpoint byte budget. Limits are integers from 1 through the endpoint maximum. The producer appends the next canonically ordered element only when the complete resulting envelope remains less than or equal to the byte budget; exact equality is allowed. The measured candidate envelope includes the encoded `nextCursor` when another element would remain after that candidate, and omits it only when the candidate exhausts the result set. If another matching element remains, `nextCursor.after` is the complete keyset tuple of the **last element actually returned**, never the first omitted element. A continuation returns only elements that strictly succeed `after` under the bound total ordering/direction. Returning fewer than the requested limit is therefore valid only when the byte budget or end-of-page is reached; `nextCursor` disambiguates them. A non-empty result set must fit at least one bounded element plus its required continuation metadata; producing an empty page with a continuation because no element fits is a conformance failure and returns sanitized 500/`TF_DURABILITY_FAILED`, preventing a non-advancing cursor loop.

Every string/preview and page element has schema bounds; large payloads become authorized `ArtifactRef`s. Every array embedded in a non-page DTO has an explicit schema maximum no greater than 200 unless this P-ADR names an endpoint-specific higher maximum. If it is a summary rather than one of the explicitly named `WebRunDetail` bootstrap previews in §5.2, it also carries the total and an explicit summary/truncation flag and never claims completeness. A `WebRunDetail` bootstrap preview never claims completeness at any returned length; clients recover the complete collection only through its listed continuation endpoint. Semantically complete collections that can exceed the bound require a listed continuation endpoint. If one supposedly bounded element still exceeds 64 KiB or a non-page response exceeds its budget, the handler sends no partial JSON and returns sanitized 500/`TF_DURABILITY_FAILED`; this is a conformance failure, not permission to truncate silently.

Oversized input is rejected before full buffering where the runtime permits. No endpoint accepts a filesystem path, ControlStore path, arbitrary URL, principal id, authority directory, provider credential, or SecretRef value.

### 2.3 Source observation versus per-tab live state

Every aggregate page and detail view whose source may be unavailable carries only server-observable source truth:

```ts
type WebSourceObservation = {
  coverage: "complete" | "partial";
  authority: "verified" | "unverified";
  observedAt: number;
  registryContext:
    | {
        mode: "auto";
        registryRevision: string;
        visibleMounts: WebVisibleMount[];
      }
    | {
        mode: "standalone";
        registryRevision: "standalone";
        visibleMounts: [WebVisibleMount];
      };
  watermarks: WebProjectWatermark[];
};
```

`visibleMounts` is deterministically ordered by project/domain identity and each watermark binds the same identity. Standalone has no registry and therefore uses the literal sentinel `"standalone"` plus exactly one visible mount; handlers/cursors must not fabricate a registry revision.

Each browser tab separately owns:

```ts
type WebLiveState = {
  streamState: "connected" | "catching-up" | "disconnected";
  lastFrameAt?: number;
  resyncState: "idle" | "required" | "refreshing" | "failed";
  invalidationEpoch: number; // non-negative safe integer; starts at 0
};

type WebAuthoritativeResourceIdentity =
  | { type: "project"; projectId: string; controlDomainId: string }
  | { type: "run"; projectId: string; controlDomainId: string; runId: string }
  | { type: "approval"; projectId: string; controlDomainId: string;
      runId: string; approvalRequestId: string }
  | { type: "reservation"; reservationId: string };

type WebAuthorityRefreshStamp = {
  resource: WebAuthoritativeResourceIdentity;
  invalidationEpoch: number;
  requestId: string;
  observedAt: number;
};
```

`WebLiveState` and `WebAuthorityRefreshStamp` are browser-local, not wire DTOs returned by ordinary JSON handlers. A refresh stamp is created only when that exact authoritative-detail request succeeds with `authority:"verified"`; it is stored beside the returned detail and its `availableActions`, never globally reused for another resource.

The browser freezes one pure reducer:

```text
event                         precondition                      transition
initial                       —                                 disconnected / required / epoch 0
stream-connected              any                               connected; resync unchanged
stream-catching-up            not catching-up + resync idle    catching-up; required; epoch + 1
stream-catching-up            catching-up or resync != idle    catching-up; required; no epoch change
stream-disconnected           prior state != disconnected      disconnected; resync required; epoch + 1
stream-disconnected           prior state == disconnected      no epoch change
reset-required                any                               catching-up; resync required; epoch + 1
principal/capability changed  any                               resync required; epoch + 1
resync-started                required|failed                   resync refreshing
resync-succeeded              refreshing                        resync idle
resync-failed                 refreshing                        resync failed
```

`reduceWebLiveState(previous, event)` is the only transition function. The normal clean state for `stream-catching-up` is `streamState:"connected"` plus `resyncState:"idle"`; any other not-yet-catching-up `idle` combination is conservatively treated as the same new invalidation. The first transition from that state invalidates existing resource stamps by incrementing the epoch. A catch-up notification received while already catching up, or while the same disconnect/reset/principal invalidation is still `required|refreshing|failed`, does not increment again. `resync-succeeded` changes only resync state; it never repairs a stamp from an earlier epoch. Epoch overflow fails closed by discarding tab state and reloading the session; implementations may not wrap it. Reconnection or checkpoint success does not retroactively refresh a resource detail.

The browser-safe pure projection consumes:

```ts
type WebObservationPresentationInput = {
  sourceObservation: WebSourceObservation;
  liveState: WebLiveState;
  scope:
    | { kind: "aggregate" }
    | {
        kind: "authoritative-detail";
        resource: WebAuthoritativeResourceIdentity;
        refreshStamp?: WebAuthorityRefreshStamp;
      };
};
```

`projectObservationPresentation(input)` produces:

```ts
type WebObservationPresentation = {
  projectionVersion: "observation-presentation.v1";
  message: WebContentMessage;
  severity: "neutral" | "warning";
  stateSensitiveActionsAllowed: boolean;
  source: {
    scope: "aggregate" | "authoritative-detail";
    invalidationEpoch: number;
    authorityRefreshEpoch?: number;
    streamState: WebLiveState["streamState"];
    resyncState: WebLiveState["resyncState"];
    coverage: WebSourceObservation["coverage"];
    authority: WebSourceObservation["authority"];
    observedAt: number;
  };
};
```

`message.key` is exactly `observation.live-updates-paused | observation.source-coverage-partial | observation.source-authority-unverified | observation.source-ready`. Source-authority failure takes display priority over partial coverage, which takes priority over disconnected/catching-up, while the `source` object preserves every axis.

`stateSensitiveActionsAllowed` is true iff all are true:

1. `scope.kind === "authoritative-detail"`;
2. `sourceObservation.authority === "verified"`;
3. `liveState.resyncState === "idle"`;
4. `refreshStamp` exists and its resource is byte-identical under P6 canonical JSON to `scope.resource`;
5. `refreshStamp.invalidationEpoch === liveState.invalidationEpoch`.

Aggregate projections never authorize mutation. A disconnect/reset/principal change or first clean-state entry into catch-up increments the epoch and immediately invalidates every earlier stamp even if it still says `authority:"verified"`. A later verified refresh stamps only its exact resource at the current epoch. Stream connectivity alone neither authorizes nor permanently forbids a CAS-protected action; server-side live authorization/CAS remains mandatory at submit. The projection never rewrites `WebTaskPresentation` or domain status. Reducer and projection goldens cover every transition plus scope × stream × resync × coverage × authority × stamp-age/resource-match combinations. Required sequences include: valid stamp at epoch E → clean catch-up → E+1 → resync success → old E stamp still denied; and disconnect/reset → required at E+1 → catch-up notification → no second increment.

## 3. Closed feature and action discovery

### 3.1 Feature identifiers

`WebFeatureId` is a closed enum:

```text
overview
project-detail
run-detail
run-timeline
run-graph
node-detail
approval-detail
attention
artifacts
why-stale
replay
policy-explanation
sse
polling-fallback
recompute-preview
approval-decision
edit-approval
resume-run
recompute-run
reconcile-run
set-max-active-runs
force-release
rerun-saved-program
```

### 3.2 Command identifiers

`WebCommandKind` is the closed durable domain-command union:

```text
approve
reject
edit-approval
cancel-run
resume-run
recompute-run
reconcile-run
set-max-active-runs
force-release
```

`cancel-run` is a Must-ship command. Other branches may remain unadvertised under the RFC v7 capability gates. `rerun-saved-program` is a feature id but not a P17 v5 command shape: it remains unadvertised until an additive P17 revision binds the already-frozen CLI/MCP run contract without creating a browser compiler.

### 3.3 Global support versus resource authorization

`WebBootstrapView` contains sorted, unique `supportedFeatures: WebFeatureId[]` and `supportedCommands: WebCommandKind[]`. These describe code implemented by this packaged backend, not authorization for one resource.

RFC v7 Simple/Pro is client-side progressive disclosure, not protocol negotiation. It is not a feature id, principal claim, authorization input, command field, store record, or alternate DTO. `WebBootstrapView.mode` continues to mean control mode (`auto | standalone`), never UI mode. A handler must return identical authorized resource truth regardless of whether the caller will render Simple or Pro.

Authoritative resource DTOs contain `availableActions: WebAvailableAction[]`:

```ts
type WebAvailableAction =
  | {
      kind: WebCommandKind;
      state: "available";
      requestBase: WebActionRequestBase;
      confirmation: "none" | "confirm" | "type-ack";
      acknowledgement?: string;
    }
  | {
      kind: WebCommandKind;
      state: "unavailable";
      reason: ControlError; // sanitized; no secret/policy internals
    };
```

`WebActionRequestBase` is a closed union paired one-to-one with `WebCommandKind`; it omits only `commandId` and fields explicitly classified as user input. An available `requestBase` carries the current resource identity, expected version/revision/epoch, and other server-derived CAS fields. The browser adds a fresh `commandId` plus allowed user input such as rejection reason or selected phase ids. It must not reconstruct authority or CAS data from a stale aggregate row.

An unsupported command is absent from both global support and resource actions. A globally supported but resource-ineligible command may appear unavailable only with a safe typed reason. Directly posting an unadvertised or unavailable command returns `TF_FEATURE_REQUIRED` or the current authorization/state error; hidden UI is never the security boundary.

## 4. Complete endpoint inventory

All path parameters are decoded once, validated as exact schema fields, and passed as typed identity—not concatenated into a caller-selected path.

After conformance, the exported browser-safe `WEB_ENDPOINTS` registry in `web-protocol.ts` is the sole executable endpoint source. It binds method, typed route tokens, request schema, success schema, operation class, response budget, and capability. The router and generated browser client consume that registry rather than maintaining route copies. The table below is generated between checked markers from the same registry by `scripts/check-web-protocol-docs.mjs`; CI fails unless registry, handlers, client, and this inventory are bijective. While P17 remains provisional, this table is the target the executable registry must converge to—manual edits do not make incomplete handlers conforming.

<!-- BEGIN GENERATED: P17-WEB-ENDPOINTS -->
| Method/path | Request schema | Success `data` | Operation class |
|-------------|----------------|----------------|-----------------|
| `POST /api/v1/session/exchange` | `WebSessionExchangeRequest` | `WebSessionView` | Ephemeral security |
| `POST /api/v1/session/logout` | `WebCsrfRequest` | `WebSessionRevocationView` | Ephemeral security |
| `POST /api/v1/sessions/revoke-all` | `WebCsrfRequest` | `WebSessionRevocationView` | Ephemeral security |
| `GET /api/v1/bootstrap` | none | `WebBootstrapView` | Live host read |
| `GET /api/v1/overview` | none | `WebOverviewView` | Derived aggregate read |
| `GET /api/v1/projects` | `WebPageRequest` query | `WebPage<WebProjectSummary>` | Registry + verified headers |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId` | `WebProjectParams` | `WebProjectDetail` | Home-project read |
| `GET /api/v1/coordinator` | none | `WebCoordinatorSummary` | Coordinator read |
| `GET /api/v1/coordinator/reservations/:reservationId` | `WebReservationParams` | `WebReservationDetail` | Coordinator read |
| `GET /api/v1/runs` | `WebRunListQuery` | `WebPage<WebRunSummary>` | Derived aggregate read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId` | `WebProjectRunParams` | `WebRunDetail` | Home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/fragments` | `WebFragmentListQuery` | `WebPage<WebBoundFragmentSummary>` | Bounded home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/graph` | `WebGraphQuery` | `WebRunGraphView` | Bounded home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/timeline` | `WebTimelineQuery` | `WebPage<WebTimelineEvent>` | Home-project journal read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId` | `WebNodeParams` | `WebNodeDetail` | Home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/nodes/:nodeInstanceId/attempts` | `WebAttemptListQuery` | `WebPage<WebAttemptSummary>` | Bounded home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/artifacts` | `WebArtifactListQuery` | `WebPage<WebArtifactRef>` | Bounded home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/receipt` | `WebReceiptQuery` | `WebReceiptView` | Bounded home-project read |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/why-stale` | `WebWhyStaleQuery` | `WebWhyStaleView` | Pure analysis |
| `POST /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/replay` | `WebReplayRequest` | `WebReplayResult` | Pure analysis |
| `POST /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/recompute-preview` | `WebRecomputePreviewRequest` | `WebRecomputePreview` | Pure analysis, capability-gated |
| `GET /api/v1/approvals` | `WebApprovalListQuery` | `WebPage<WebApprovalSummary>` | Derived refs + home refresh |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId/approvals/:approvalRequestId` | `WebApprovalParams` | `WebApprovalDetail` | Home-project read |
| `GET /api/v1/attention` | `WebAttentionQuery` | `WebPage<WebAttentionItem>` | Derived aggregate read |
| `GET /api/v1/policy/explanation` | `WebPolicyExplanationQuery` | `WebPolicyExplanation` | Current read-only evaluation |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/artifacts/:digest` | `WebArtifactParams` | `bytes` | Authorized artifact read |
| `GET /api/v1/events` | `WebEventStreamQuery` | `text/event-stream` | Resumable observation |
| `POST /api/v1/commands` | `WebCommandRequest` | `WebCommandOutcome` | Durable domain mutation |
| `GET /api/v1/commands/:commandId` | `WebCommandParams` | `WebCommandOutcome` | Live-reauthorized recovery read |
<!-- END GENERATED: P17-WEB-ENDPOINTS -->

There is no generic RPC endpoint, arbitrary resource path, arbitrary policy write, raw journal query, provider passthrough, project rebind/adopt, or browser store-repair endpoint.

## 5. Required view contracts

The TypeBox module must express these as closed schemas. Domain subobjects may embed the corresponding frozen P1–P16 wire schemas, but may not replace a required group with `unknown`, an unbounded record, or summary text.

### 5.1 Bootstrap and overview

`WebBootstrapView` requires:

- `schemaVersion`, compatible protocol major/minor range, and build info;
- `contentCatalogVersion:"taskflow-content.v1"`, `defaultLocale:"en"`, exact `supportedLocales:["en","zh-CN"]`, and the asset-manifest projected/static/combined content keyset SHA-256 values;
- listener id, `mode:"auto"|"standalone"`, principal display, session expiry/idle expiry;
- the exact discriminated registry context from `WebSourceObservation`;
- sorted unique `supportedFeatures` and `supportedCommands`;
- `pollingMinIntervalMs`, an integer from 3,000 through 60,000 milliseconds;
- top-level `WebSourceObservation`;
- an explicit incompatible response path; version mismatch never falls through to a partially working UI.

`WebOverviewView` requires:

- `sourceObservation`;
- coordinator capacity `{maxActiveRuns, occupied, available, fencingEpoch}`;
- counts by canonical RunStatus and RunStage, with `needsOperator`;
- separate current-principal `needs-user-input`, status-only attention, diagnostic attention, and pending-approval counts;
- Receipt-derived token/cost totals with time range/currency/methodology labels,
  represented as the closed `measured | unavailable` union so absent durable
  usage fields can never be serialized as measured zero;
- incremental reuse estimates with methodology and unavailable reason;
- project health counts plus per-project warnings sufficient to explain partial coverage.

Overview is derived per request/checkpoint. It is never persisted as a user-level Run ledger.

### 5.2 Project and Run

`WebProjectSummary` and `WebProjectDetail` require a sanitized, non-empty `displayName`. `WebRunSummary` requires `workspaceDisplayName`, `displayTitle`, and canonical `presentation:WebTaskPresentationSummary`; `WebRunDetail` requires the same names plus full `presentation:WebTaskPresentation`. A display value comes from persisted project/Program display metadata or a deterministic sanitized source-name/short-id fallback. It is stable across reload, is never generated by an LLM from agent output, and never replaces exact identity fields.

`WebProjectDetail` requires:

- `{projectId, controlDomainId}`, display root/name without exposing an unrestricted filesystem path;
- registry revision, binding state, mount/open state, verified ControlStore header/version and project watermark;
- store/identity/conflict warnings;
- effective policy summary and provenance links;
- `runCount` plus at most 20 explicitly summary-only recent `WebRunSummary` rows; complete Runs use the aggregate Run endpoint filtered to this project;
- `sourceObservation` and `availableActions`.

`WebRunDetail` requires:

- canonical `run:WebRunSummary`, repeating the stable workspace/title, identity, current Run version/timestamps, separate RunStatus/RunStage, needs-operator state, BoundPlan/BoundFragment/Receipt identity, presentation summary, and source observation needed to render the header without inventing state;
- stable top-level `workspaceDisplayName`/`displayTitle` plus bounded, reloadable `boundPlan:WebBoundPlanProvenance`;
- `boundFragments`, a creation-ordered bootstrap preview of at most 200 hash/parent/origin/commit provenance rows. It deliberately carries no completeness claim; the fragment endpoint is authoritative for the complete Run-scoped list and its richer link/causation/count summary;
- `nodes` (at most 2,000), `edges` (at most 4,000), and `attempts` (at most 200) as bootstrap previews. They never claim a complete graph or Attempt history; complete graph inventory, boundary edges and totals come only from `WebRunGraphView`, while complete Attempt history comes from each node's attempts endpoint;
- `timeline:WebPage<WebTimelineEvent>` using default 50/maximum 200 and preserving its continuation cursor;
- `artifacts`, the first at most 50 rows produced by the Run artifact query. The client treats it as a bootstrap preview at every length and uses the artifact continuation endpoint for completeness;
- optional bounded `receipt:WebReceiptDetail` containing immutable identity, BoundPlan/BoundFragment relation, commit range, assurance, build info, and at most 200 event/artifact references. Complete verification and event-manifest evidence comes from `WebReceiptView`;
- explicit `whyStale` availability and `replay` availability; unavailable durable evidence is represented as unavailable rather than fabricated;
- canonical full `presentation`, `sourceObservation`, and server-computed `availableActions`.

The 2,000-node/4,000-edge limits are the sole `WebRunDetail` embedded-array exceptions to the ordinary 200-item maximum. Empty bootstrap previews or an absent Receipt are valid only when domain truth says they are empty/absent. WebGateway may not substitute empty collections because a read service is missing. Consumers must not infer completeness from a short bootstrap preview.

`WebGraphQuery` is closed and contains `cursor`, `limit` (default 500, maximum 2,000), optional status/phase-kind/origin/text filters, and an optional scope of whole Run, one BoundFragment, or one dynamic parent. Ordering is the canonical stable node-instance identity, never layout position.

`WebRunGraphView` requires the query/filter echo, Run identity/version, total and matched node/edge counts, a bounded node array, all edges whose endpoints are both in the chunk, boundary edges naming the included and omitted endpoint identities, `nextCursor`, and source observation. Following every cursor without changing query/version must recover every matched node and edge exactly once; the client may collapse/filter presentation but the protocol may not silently truncate the graph.

`WebNodeDetail` requires Run identity/version, node identity and definition/instance provenance, dependency identities, status, `attemptCount`, the first `WebPage<WebAttemptSummary>` using default 50/maximum 200, current provider/job-handle/outcome observation, optional start/end timing, safe input/output artifact references, bounded cache explanation, linked fragment/child identities, relevant timeline event ids, `sourceObservation`, and actions when any are valid. Complete Attempt history is recovered only through the bound attempts continuation endpoint.

`WebTimelineEvent` requires project-local `commitSeq`, timestamp, event kind/version, resource identity, causation/correlation ids when present, safe summary, typed/redacted details, and compaction provenance. It never claims cross-project order.

### 5.3 Deterministic Task presentation and verification

Projection placement is normative; “pure” does not mean “either side may run it”:

| Projection | Producer / execution position | Serialized output | Closed input | Version |
|------------|-------------------------------|-------------------|--------------|---------|
| Task + verification | ControlHost/WebGateway server adapter | `WebRunSummary.presentation` / `WebRunDetail.presentation` | sanitized authoritative Run graph, presentation index, result, Receipt/checks, observation, current-principal disposition/actions | `task-presentation.v1` |
| Decision | ControlHost/WebGateway server adapter | `WebApprovalDetail.decisionPresentation` and Task `decisionSet` | authoritative approval/command state, operation class, CAS/actions, principal disposition | `decision-presentation.v1` |
| Observation | Browser only | **Never serialized** | serialized `WebSourceObservation` + tab-local `WebLiveState` + exact detail refresh stamp | `observation-presentation.v1` |
| Failure | Browser only | **Never serialized** | complete `WebFailure` envelope + closed route/operation/action context | `failure-presentation.v1` |
| Catalog rendering | Browser only | rendered text only; never returned to the server | one complete validated locale catalog + typed content message | `taskflow-content.v1` |

Task, verification, and decision outputs are locale-neutral semantic messages. The server never localizes. Observation and failure are browser projections because stream/refresh epoch and transport-route context are browser-local; the browser may not recompute Task/verification/decision truth. `web-presentation-server.ts` exports only Task/verification/decision producers and is forbidden from the browser bundle; `web-presentation-client.ts` exports only the live-state reducer plus observation/failure producers and cannot import server producer implementations. Both have browser-safe import guards, exact input schemas, deterministic golden fixtures, and explicit versions. Moving a projection across this boundary or changing a closed input/output meaning is a reviewed wire change.

`projectTaskPresentation(input)` is a browser-safe, pure, deterministic projection exported beside the TypeBox schemas. It accepts one exact sanitized source snapshot containing Run/BoundPlan/BoundFragment/node/Attempt, ControlHost-computed `resolvedFinalOutput` with core source attribution, Receipt/current verification, `WebSourceObservation`, current-principal decision disposition, and server-computed `availableActions`. It performs no I/O, provider/model call, store read, localization choice, wall-clock read, or mutation and does not import the core runtime/store graph. `observedAt` is injected. Canonical input ordering and output bounds are part of the fixture.

Every bound node source requires presentation metadata:

```ts
type WebNodePresentationSource = {
  authoredPhaseId: string;
  groupId: string;
  role: "step" | "implementation";
  ordinal: number;
  label: string;
};
```

The compiler/binder emits or exactly reconstructs this metadata as a `BoundPresentationIndex` sidecar keyed by `{boundPlanHash|boundFragmentHash, compilerVersion, presentationProjectionVersion}`. The sidecar is rebuildable, is not Run/command authority, and is excluded from `executionSemanticHash` and immutable BoundPlan/BoundFragment content hashes; a UI-only label change cannot invalidate execution/cache. User-authored semantic phases are `step`. Desugared plumbing, loop/map/tournament bookkeeping, fragment-link helpers, and provider-handoff nodes are `implementation` and group beneath the nearest authored semantic ancestor. The browser never classifies by phase-name heuristics. Missing, duplicated, or contradictory metadata sets source authority to `unverified`, returns `progress.semantics:"indeterminate"`, and emits a typed projection warning.

All safety-relevant presentation text uses the strict closed content reference:

```ts
type WebContentMessage = {
  catalogVersion: "taskflow-content.v1";
  key: WebProjectedContentKey;
  args: WebContentArg[];
};
```

`args` is unique and canonically sorted by `name`. String and string-array values are NFC-normalized plain text bounded to 512 Unicode scalar values per item and 20 items per array; counts are non-negative safe integers; timestamps are Unix milliseconds and formatted by the selected locale. A key may consume only its registry-declared arguments. User-authored text is always a separately typed `quotedContext`/result value and is never accepted as a content key, Taskflow verdict, question, consequence, or action label.

The closed Task presentation contract is:

```ts
type WebTaskPresentation = {
  projectionVersion: "task-presentation.v1";
  source: {
    runVersion: number;
    boundPlanHash: string;
    observedAt: number;
    sourceObservation: WebSourceObservation;
  };
  headline: WebContentMessage;
  detail: WebContentMessage;
  activeStepCount: number;
  activeSteps: WebPresentedStep[];
  stepGroupCount: number;
  stepGroups: WebPresentedStepGroup[];
  progress: WebTaskProgress;
  result: WebTaskResultPresentation;
  verification: WebVerificationPresentation;
  primaryAction: WebPresentationAction;
  decisionSet?: WebDecisionSet;
  decisionProvenance: WebTaskDecisionProvenance;
  warnings: WebPresentationWarning[];
};
```

`summarizeTaskPresentation(full)` returns the closed `WebTaskPresentationSummary` carried by aggregate rows: the same source Run version, `headline`/`detail` content messages, at most three ordered active-step labels plus `activeStepCount`, progress, verification state/reason, and presentation navigation action. It contains no complete step groups, output preview, Receipt/check matrix, or command `availableActions`. The summary must equal the corresponding fields of a full projection for the same Run version. It may be cached as a rebuildable Run-index projection keyed by projection version + Run version + BoundPlan hash; it is never authority.

The Task headline keys are exactly:

```text
task.working
task.working-multiple
task.waiting-to-start
task.needs-input
task.stopping
task.checking-execution
task.could-not-continue
task.failed
task.cancelled
task.completed
```

The Task detail keys are exactly:

```text
task.working.one.detail
task.working.many.detail
task.waiting.generic.detail
task.waiting.capacity.detail
task.waiting.policy.detail
task.approval-required.detail
task.stopping.confirmation.detail
task.reconciling.ambiguous.detail
task.blocked.reason.detail
task.failed.terminal.detail
task.cancelled.quiescent.detail
task.completed.verification.detail
```

`WebContentArg` is a closed `{name,value}` union whose names are exactly:

```text
activeStepLabel | activeStepCount | activeStepLabels | completedStepCount |
workspaceCount | omittedWorkspaceCount | capacityReason | deadline |
blockingReason | recoveryLabel | verificationReason | preservedResultCount |
taskDisplayTitle | workspaceDisplayName
```

The reason-valued arguments use closed enums, never backend prose:

```text
WebCapacityReasonCode =
  capacity-full | waiting-for-reservation | coordinator-unavailable

WebBlockingReasonCode =
  policy-denied | dependency-failed | approval-expired |
  provider-failed | verification-required | unknown

recoveryLabel = the closed core RecoveryAction
verificationReason = the closed WebVerificationReasonCode
```

The key registry fixes each argument’s value kind and permitted keys. Select/plural branches live inside each whole catalog message; interpolated display values render as text and may not supply markup or grammatical fragments. Unknown keys/arguments, missing required arguments, extra arguments, wrong value kinds, and unknown reason codes fail producer validation/fixtures rather than falling back to generated prose or displaying a raw key.

The value kinds are fixed:

| Argument names | Value kind |
|----------------|------------|
| `activeStepCount`, `completedStepCount`, `workspaceCount`, `omittedWorkspaceCount`, `preservedResultCount` | non-negative safe integer |
| `deadline` | Unix-millisecond safe integer |
| `activeStepLabels` | 0–20 sanitized strings; Task headline/detail templates consume at most the first two |
| `capacityReason`, `blockingReason`, `recoveryLabel`, `verificationReason` | the corresponding closed enum above |
| every other declared argument | one sanitized string from persisted display metadata |

`activeSteps` still carries up to 20 structured references and Pro supplies complete paged inventory. The at-most-two `activeStepLabels` content argument prevents summary/detail copy from diverging while avoiding an unreadable sentence.

Workflow-authored approval messages, arbitrary error text, and agent output are not `WebContentArg` values. They remain separately typed quoted context, result content, or Technical details.

`WebTaskDecisionProvenance` contains the exact Run status/stage/version inputs, `needsOperator`, side-effect class, active-step source node/group ids, final-result source id/kind, verification Receipt/check identity when present, and primary-action source (`decision-disposition | source-observation | result | error | none`). It contains no agent-generated rationale. This makes every headline/message/progress/result/action choice explainable in Pro and assertable in fixtures.

`activeStepCount` counts every visible group currently executing plus the immediate waiting/blocking frontier when nothing executes. `activeSteps` contains the first 20, sorted by presentation ordinal then stable node identity; truncation is `activeStepCount > activeSteps.length`. Singular copy is legal only when `activeStepCount===1`. `stepGroupCount` counts all presented groups and `stepGroups` contains the first 200 in the same stable order; the Pro graph/timeline supplies complete paged detail. `WebPresentedStepGroup` names its stable group, bounded member-node references, state, dynamic/static origin, member count, and whether helper nodes/references were collapsed; helper failures still affect group state and are never hidden from technical detail.

`WebTaskProgress` is the closed union:

```ts
type WebTaskProgress =
  | { semantics: "exact"; completed: number; total: number; inventorySealed: true }
  | { semantics: "lower-bound"; completed: number; inventorySealed: false }
  | { semantics: "indeterminate"; reason:
        "source-unverified" | "inventory-missing" | "presentation-metadata-invalid" };
```

Progress counts presented groups, not Attempts/helper nodes. `exact` is legal only when source authority is verified and no loop/map/expand/flow/fragment path can create another presented group. `completed <= total`; percentage is rendered only for `exact`. `lower-bound` never carries a total or percentage.

`WebTaskResultPresentation.kind` is exactly `text | json | artifact | error | none`. It carries the exact ControlHost-supplied `resolvedFinalOutput` source identity and a safe bounded preview/reference; multiple final artifacts remain in canonical source order. The projection does not summarize, rank, rewrite, or independently reselect output.

`WebPresentationAction.kind` is exactly `open-required-input | refresh-authority | open-result | open-error-details | none`. Selection priority is that order. It is navigation/presentation only; durable action eligibility remains `availableActions`. `WebDecisionSet` exists only for a current-principal pending decision and embeds the exact `WebDecisionPresentation`; its approve/reject choices remain in stable order with equal semantic weight and no default/preselection.

Verification is independent of Run status copy and Receipt presence:

```ts
type WebVerificationState =
  | "verified"
  | "partially-verified"
  | "verification-unavailable"
  | "verification-failed"
  | "not-yet-verified"
  | "not-applicable";
```

Every verification check uses exactly:

```ts
type WebVerificationCheckState =
  | "ok"
  | "not-applicable"
  | "unknown"
  | "unavailable"
  | "mismatch"
  | "in-progress";
```

Provider expectation, observed provider outcome, and consistency are separate fields:

```ts
type WebProviderConsistency = {
  expected:
    | { kind: "exact"; outcome: "completed" | "failed" | "cancelled" }
    | { kind: "not-admitted"; evidenceRef: string };
  observed?: "completed" | "failed" | "cancelled";
  check: WebVerificationCheckState;
  sourceEventRefs: string[];
};
```

`expected` is computed by ControlHost from the durable terminal cause and provider-admission/event history; the browser never infers it from RunStatus alone. `kind:"not-admitted"` is legal only with durable evidence that no provider was admitted. For an exact expectation, matching observed outcome produces `check:"ok"` even when the expected outcome is `failed` or `cancelled`; a different terminal outcome produces `check:"mismatch"`. Missing/unreachable evidence produces `unknown|unavailable`, and an active verifier produces `in-progress`. For `not-admitted`, proven absence produces `not-applicable`; any observed provider outcome produces `mismatch`. `failed` and `cancelled` are provider outcomes, never check states.

`WebVerificationPresentation` requires state, a closed reason code, `checkedAt`, Receipt identity when present, `providerConsistency:WebProviderConsistency`, event-manifest/root result, assurance inputs, required/current artifact check counts plus a bounded first page, and source provenance. Every non-provider check also uses `WebVerificationCheckState`; complete artifact rows continue through the Run artifact endpoint.

`WebVerificationReasonCode` is exactly:

```text
all-required-checks-ok
required-check-unknown
artifact-retained-without-blob
receipt-missing
verifier-unavailable
no-required-check-completed
manifest-mismatch
artifact-digest-mismatch
provenance-mismatch
provider-outcome-mismatch
run-non-terminal
verification-in-progress
lifecycle-not-applicable
```

Derivation order is normative and security-monotone:

1. **Any confirmed `mismatch` wins**, including manifest, digest, provenance, provider consistency, or an observed provider outcome when `expected.kind:"not-admitted"` → `verification-failed`. An unrelated `in-progress`, missing Receipt, or unavailable verifier cannot hide a confirmed contradiction.
2. Otherwise, a non-terminal Run—including `unknown/reconciling`—or any required check explicitly `in-progress` → `not-yet-verified`.
3. Otherwise, an authoritative closed lifecycle rule saying no Receipt/result verification is required → `not-applicable`; missing Receipt or empty artifacts never implies it.
4. Otherwise, terminal with no required Receipt/verifier/source, or with zero required checks able to complete → `verification-unavailable`.
5. Otherwise, Receipt present, at least one required check `ok|not-applicable`, and at least one `unknown|unavailable` → `partially-verified`.
6. `verified` only when Receipt exists; event manifest/root is currently `ok`; `journalContinuity` and `provenance` are `ok`; `providerConsistency.check` is `ok|not-applicable`; `artifactIntegrity` is `ok`; and every required result artifact currently verifies `ok|not-applicable`.

Current verification results do not mutate the immutable Receipt or Run status. Fixtures include `mismatch + in-progress`, matching failed/cancelled outcomes, not-admitted with and without contradictory observations, and every unavailable/unknown branch.

The same golden source fixture must produce byte-identical canonical `WebTaskPresentation`, and its summary must drive Home/lists/Needs your input/notifications while detail consumes the full form. Input collection permutations are property-tested. A component-specific alternate projection is non-conforming.

### 5.3.1 Content key registries and catalogs

`WebProjectedContentKey` is the closed wire/projection union of:

1. every Task headline/detail key listed in §5.3;
2. the four `observation.*` keys in §2.3;
3. the verification keys below;
4. the closed decision, error, recovery, risk, empty-state, and system keys below.

Verification label/detail keys are exactly:

```text
verification.verified
verification.verified.detail
verification.partially-verified
verification.partially-verified.detail
verification.unavailable
verification.unavailable.detail
verification.failed
verification.failed.detail
verification.not-yet-verified
verification.not-yet-verified.detail
verification.not-applicable
verification.not-applicable.detail
```

`WebVerificationPresentation` carries both `label:WebContentMessage` and `detail:WebContentMessage`; the selected pair must match the derived state/reason. A component may not choose friendlier wording from Receipt presence or visual context.

Non-authoritative navigation, section, tab, dismissal, and formatting labels use the checked-in `packages/taskflow-web/src/content/static-keys.ts` registry as their sole source. The RFC v7 §15.2 reference manifest may only reference registered keys and bind their registry/catalog digests; it never generates or expands the registry. A component may consume a static key only after it appears in that source with allowed arguments, Simple/Pro surface class, and both locale values. `WebStaticContentKey` is not emitted by the server, accepted in a request, or used for state/action decisions.

The packaged catalog keyset is `WebProjectedContentKey ∪ WebStaticContentKey`. This keeps every visible string localized and reviewed without turning a new static tab label into a browser wire change. Safety-relevant copy must use `WebContentMessage`; it cannot be downgraded to a static key.

The supported beta.2 locales are the closed union `en | zh-CN`; default and primary comprehension locale is `en`. A current-tab memory-only Settings override wins. Otherwise the browser canonicalizes `navigator.languages` with `Intl.getCanonicalLocales`, selects the first exact supported tag, then applies only the fixed primary-language map `en-* → en`, `zh-* → zh-CN`, and otherwise selects `en`. There is no arbitrary locale guess, per-key fallback across languages, URL language parameter, browser storage, or server-side `Accept-Language` variation in beta.2. Unsupported input does not change authority. One complete catalog renders the whole page. Both catalogs:

- contain exactly the complete projected + static keyset;
- declare the exact allowed argument set and value kind for every key;
- contain whole messages, not concatenated fragments;
- use locale-aware plural, date/time, and number formatting;
- contain no raw HTML, executable markup, remote reference, or formatter code with side effects;
- render user values as text and preserve the same decision, consequence, risk, and next action.
- carry the terminology registry’s English token-boundary and exact CJK forbidden variants used by the Simple content lint.

Missing/extra keys, an invalid argument declaration, a formatter failure, or a catalog/keyset digest mismatch fails build/startup. Runtime never displays a raw key, error code, the other locale, or an English fragment as fallback. Static non-authoritative labels use the same catalog and validation even when no server projection is needed.

Locale release evidence is intentionally asymmetric and must not be overstated. `en` requires the five fresh-participant comprehension gate in RFC v7 §19.4. `zh-CN` requires complete semantic/key/argument parity, all visual/narrow/a11y matrices, and independent native-level linguistic review by one content/UX reviewer and one technical/safety reviewer; neither review alone substitutes for user comprehension. Beta.2 therefore makes no equal five-user comprehension claim for `zh-CN`. Promoting another locale to that claim requires its own fresh five-person cohort, with no bilingual participant reused across locale cohorts.

### 5.3.2 Decision presentation

The pure `projectDecisionPresentation(input)` consumes the current authoritative approval/command context plus one closed:

```text
WebDecisionOperationClass =
  publish-files | change-files | use-network | run-tool |
  spend-budget | continue-task | apply-edit | generic-action
```

If durable approval metadata cannot classify the operation, it uses `generic-action`; it never infers intent from agent prose. For every class `X`, the key registry contains exactly:

```text
decision.X.question
decision.X.impact
decision.X.allow-label
decision.X.do-not-allow-label
decision.X.allow-consequence
decision.X.do-not-allow-consequence
```

The generic labels render the explicit answers **Allow this action** and **Do not allow this action** in English and their semantic equivalents in other catalogs; they never degrade to OK/Confirm/Continue/Yes/No/Cancel. The output is:

```ts
type WebDecisionPresentation = {
  projectionVersion: "decision-presentation.v1";
  operationClass: WebDecisionOperationClass;
  question: WebContentMessage;
  impact: WebContentMessage;
  deadline?: number;
  quotedContext?: string;
  choices: [
    {
      kind: "approve";
      label: WebContentMessage;
      consequence: WebContentMessage;
      semanticWeight: "equal";
    },
    {
      kind: "reject";
      label: WebContentMessage;
      consequence: WebContentMessage;
      semanticWeight: "equal";
    },
  ];
  noDefault: true;
  source: WebDecisionProvenance;
};
```

The tuple order is stable but does not create a recommendation; layout, keyboard order, default focus, color, and accessible naming preserve equal weight. Workflow-authored approval text is `quotedContext`, never Taskflow’s question, consequence, or label. A deadline is present only when the authoritative request has one.

An actionable `WebDecisionSet` is emitted only when the current authoritative detail advertises both `approve` and `reject` with valid CAS inputs. If only one branch is supported or authorized, the item is `status-only`, no one-sided decision control is rendered, and Technical details explain the capability or policy gap. Beta.2 does not create a coerced “approve-only” or “reject-only” approval screen.

### 5.3.3 Error, recovery, partial, and empty presentation

The failure projection has one exact input; callers may not pass a naked `ControlError` or invent page-specific context:

```ts
type WebFailurePresentationContext = {
  surface:
    | "bootstrap"
    | "aggregate-list"
    | "authoritative-detail"
    | "command-submit"
    | "command-recovery"
    | "artifact"
    | "analysis"
    | "session";
  operation: WebCommandKind | "none";
  resourceState:
    | { kind: "none" }
    | { kind: "run"; status: RunStatus; stage: RunStage; runVersion: number }
    | { kind: "approval"; status: ApprovalStatus; approvalVersion: number;
        runVersion: number }
    | { kind: "reservation"; state: ReservationState; revision: number;
        coordinatorEpoch: number }
    | { kind: "command"; commandId: string;
        outcome: "pending" | "completed" | "failed" | "rejected" | "not-found" };
  sourceAuthority: "verified" | "unverified";
  commandBodyState:
    | "not-applicable"
    | "present-in-current-tab-memory"
    | "unavailable";
  supportedFeatures: WebFeatureId[];
  supportedCommands: WebCommandKind[];
  availableActions: WebAvailableAction[];
};

type WebFailurePresentationInput = {
  failure: WebFailure;
  context: WebFailurePresentationContext;
};
```

`projectControlErrorPresentation(input:WebFailurePresentationInput)` consumes the complete closed failure envelope plus that context and returns:

```ts
type WebFailurePresentation = {
  projectionVersion: "failure-presentation.v1";
  headline: WebContentMessage;
  detail: WebContentMessage;
  risk: WebContentMessage;
  nextAction: WebContentMessage;
  actionKind: "refresh" | "retry-same-command" | "retry-new-command" |
    "open-reconcile" | "contact-operator" | "none";
  technical: {
    code: TfErrorCode;
    sanitizedMessage: string;
    requestId: string; // exactly input.failure.requestId
    commandId?: string;
  };
};
```

The code and sanitized diagnostic come from `input.failure.error`; `requestId` comes only from `input.failure.requestId`. `commandId` may be disclosed only when the closed error/operation branch carries or binds it. `retry-same-command` additionally requires `commandBodyState:"present-in-current-tab-memory"` and an advertised action; reload/recovery always yields `unavailable` because command bodies are never persisted. The context cannot supply alternative failure facts.

For every current `TfErrorCode` `X`, the registry contains exactly `error.X.headline` and `error.X.detail`. The remaining closed families are:

```text
recovery.retry-same-command
recovery.retry-new-command
recovery.refresh
recovery.reconcile
recovery.operator
recovery.none
risk.none
risk.possible-live-side-effects
risk.unknown-side-effects
empty.home.no-tasks
empty.tasks.no-results
empty.needs-input.none
empty.workspaces.none
system.cursor-expired
system.cursor-expired.refresh
system.partial-workspaces
system.no-action-required
```

The projection maps `recoveryAction` one-to-one to the recovery family and `sideEffects` one-to-one to the risk family. `actionKind` is additionally intersected with current capability and resource authorization: a recovery message may explain an action that must be performed by an authorized operator/CLI, but the WebUI returns no callable action unless it is currently advertised. Context may choose a more specific closed `error.X.detail`, but cannot suppress `possible|unknown` side effects, turn a stale decision into automatic retry, turn absent command-body recovery into a retry, or turn `none` into a button. `ControlError.message`, stack text, ids, and codes exist only under `technical`; no primary surface or accessible name may render them directly.

Cursor expiry uses `system.cursor-expired` plus `system.cursor-expired.refresh`, explicitly stating that refresh loads records and does not run the Task again. Partial aggregate presentation uses `system.partial-workspaces` with `omittedWorkspaceCount`; missing sources never render as zero. Empty-state keys explain what causes content to appear and expose at most one action that is currently real.

### 5.3.4 Content compatibility

The server emits semantic keys/typed arguments; the packaged browser renders them. Therefore:

- adding/changing a `WebProjectedContentKey`, its allowed arguments, its state/decision mapping, or its consequence is a closed-enum/semantic wire change and requires a protocol major once frozen;
- adding a `WebStaticContentKey` is an asset/UI change rather than a wire change, but it must enter the checked-in static registry, both complete catalogs, asset manifest, screenshots/accessibility snapshots, and the affected screen approval in the same build;
- adding an optional Pro technical-detail message at an already marked additive extension point may be protocol-minor only when old/new fixtures prove the core human message is unchanged;
- wording-only catalog edits that preserve key semantics do not change the protocol major, but do change the catalog/asset digest and invalidate affected screenshots, golden copy, accessibility snapshots, and comprehension evidence;
- Simple and Pro must render the same primary `WebContentMessage`; Pro may add `technical`, never replace the primary message with it;
- catalogs are packaged assets bound to the compatible daemon/UI build. A mixed keyset/catalog build fails before the listener opens.

The reachable safety matrix is factorized by Task state/stage, verification, observation, and current-principal decision disposition. Golden fixtures cover every reachable safety-distinct combination and every key/argument branch; negative fixtures reject impossible combinations such as terminal `completed` with `RunStage:"executing"` or a decision set without current-principal authority. Blind Cartesian duplication is not required, but every factor interaction that can change outcome, risk, required action, or consequence is.

### 5.4 Approval, attention, evidence, and policy

`WebApprovalDetail` requires:

- full project/domain/Run/approval identity and current `runVersion`;
- P15 status, version, audience, expiry, decision race state, and requested operation;
- durable closed decision operation class when recorded, otherwise explicit `generic-action`; never an inference from approval prose;
- original BoundPlan hash plus any content-addressed edit reference;
- upstream evidence/artifact refs and safe policy explanation;
- dispatcher handoff state distinct from provider outcome;
- deterministic `WebDecisionPresentation` when the current principal may decide, with the authored message retained only as quoted context;
- `sourceObservation` and `availableActions`.

`WebAttentionItem` requires stable kind/id, project/domain/Run or reservation identity where applicable, severity, first/last observed timestamps, a closed `WebContentMessage` explanation, side-effect uncertainty, recovery action, `disposition:"needs-user-input"|"status-only"|"diagnostic"`, source observation, authoritative-detail link, and current `availableActions`. It is a derived queue, not a mutation authority. Simple formats the explanation through the bilingual catalog and never renders the raw `kind`, `disposition`, recovery enum, or authority vocabulary as user guidance; those closed values remain available in Pro diagnostics.

`needs-user-input` requires a current-principal advertised decision/recovery action, authoritative CAS inputs, and no active automatic recovery expected to settle the condition. An approval additionally requires the complete two-sided `approve` + `reject` decision set from §5.3.2. Another principal’s approval, a one-sided approval capability, `recoveryAction:"none"`, ordinary refresh, an active automatic reconcile window, or informational capacity/store health is `status-only` or `diagnostic`.

`WebReceiptView` contains the bounded immutable `WebReceiptDetail` core (identity, BoundPlan/BoundFragment relation, commit range, assurance, build info, and bounded event/artifact references), full `WebVerificationPresentation`, `artifactCount`, and the bounded event-manifest page selected by `WebReceiptQuery` using default 100/maximum 200; an empty cursor selects its first page. Artifact rows continue through the Run artifact endpoint. Following stable cursors under one Run/Receipt version recovers the complete semantic evidence exactly once. A summary card alone is not a conforming Receipt surface, one response is never required to contain an unbounded manifest, and Receipt presence alone never produces `verified`.

`WebPolicyExplanation` contains every evaluated host/user/project/invocation layer, provenance, deny/substitute/attenuate decision, final effective capabilities, unavailable/unknown inputs, and source observation. It has no write action.

### 5.5 Why-stale, replay, and recompute preview

`WebWhyStaleQuery` identifies one or more phase/node ids with a bounded maximum of 200. `WebWhyStaleView` returns, per target, recorded fingerprint, current fingerprint when observable, changed components, reuse decision, provenance, and an explicit unavailable reason. It never executes a provider or mutates cache state.

The embedded `WebRunDetail.whyStale` is a closed availability union. The
`available` branch carries `stale` plus bounded reasons; the `unavailable`
branch carries an explicit reason and an empty reasons array. Missing durable
fingerprint evidence must never be projected as `stale:false`.

`WebReplayRequest` is a closed schema containing a trace/event artifact selector and bounded typed overrides supported by core `replayRun`; arbitrary code, filesystem paths, provider/model selection, and command fields are forbidden. `WebReplayResult` returns source trace identity/hash, overrides hash, decision/result fold, warnings/unreplayable branches, and proof counters `{providerCalls:0,durableWrites:0}`.

`WebRecomputePreviewRequest` contains current project/domain/Run identity, expected Run version, and non-empty unique phase ids. `WebRecomputePreview` returns requested and transitively affected phase/node ids, cache invalidation/reuse explanation, re-admission requirement, cost/token estimate when knowable, and explicit uncertainty. Preview creates no command and never implies recompute was accepted.

## 6. Pagination, filtering, and aggregate ordering

- Empty cursor starts a new snapshot. `nextCursor` is absent when exhausted.
- `WebRunListQuery` is closed: project ids, status, stage, `needsOperator`, provider, bounded normalized text, created-time bounds, sort, direction, limit, cursor.
- Allowed Run sort keys: `createdAt`, `updatedAt`, `status`; default `updatedAt desc`.
- Status rank: `running=0, paused=1, blocked=2, unknown=3, failed=4, cancelled=5, completed=6`.
- Ordering is total and deterministic: requested key, then `projectId`, `controlDomainId`, `runId`, all in requested direction. Arrival order, locale, and enum declaration order are forbidden tie-breakers.
- Approval, attention, project, and timeline pages define their own closed filters and total keyset tuple in TypeBox; no page uses offset pagination.
- Graph pages bind project/domain/Run identity, current Run version, normalized scope/filters, and the canonical node keyset. Boundary edges make omitted endpoints explicit.
- `WebFragmentListQuery` is closed with cursor and limit (default 50, maximum 200); it binds Run version and orders by fragment creation commit then stable fragment hash.
- `WebAttemptListQuery` is closed with cursor and limit (default 50, maximum 200); it binds Run version/node identity and orders by non-negative attempt ordinal then stable attempt id.
- `WebArtifactListQuery` is closed with cursor, limit (default 50, maximum 200), optional role/integrity filters, and binds Run/Receipt version; ordering is canonical role, digest, then artifact id.
- `WebReceiptQuery` is closed with cursor and limit (default 100, maximum 200), binds exact Run/Receipt version, and orders event-manifest entries by project-local commit sequence then stable event id.
- Every Run detail first page is produced by the same query codec and order as its continuation endpoint. Concatenating first plus continuation pages yields exactly the same collection as starting at an empty cursor; duplicate, skipped, version-mixed, or silently truncated elements are non-conforming.
- Aggregate page envelopes carry the complete cross-project `sourceObservation` once. A Run row and its nested presentation carry the verified observation scoped to that row’s one project/domain; repeating the complete mount/watermark vector in every row is forbidden. Row scope may authorize only that exact resource and never upgrades incomplete envelope coverage.
- A cursor binds principal authorization context, normalized query, sort, the exact auto/standalone registry-context discriminant, visible mount set, and per-project watermarks. Changing any bound input starts a new snapshot.

## 7. Exact cursor encoding and lifecycle

The browser treats cursors as opaque. Both cursor kinds use this exact byte algorithm:

```text
payloadBytes    = UTF8(P6-canonical-JSON(payload))
payloadSegment  = base64url-no-pad(payloadBytes)
macInput        = ASCII(payloadSegment)
signatureBytes  = HMAC-SHA-256(listenerCursorKey, macInput)
cursor          = payloadSegment + "." + base64url-no-pad(signatureBytes)
```

- The MAC input is the ASCII bytes of the encoded `payloadSegment`, **not** raw canonical-JSON bytes and not decoded base64url bytes.
- `listenerCursorKey` is 256 random bits generated when the loopback listener starts, held only in memory, never written to disk or exposed.
- Signature comparison is constant-time after exact length validation.
- Restart rotates the key and invalidates all old cursors.
- Cursor length above 8 KiB is rejected before decoding.
- Normalized-query and authorization-context hashes are lowercase SHA-256 hex over P6 canonical JSON.
- Page cursor lifetime is 10 minutes from `issuedAt`.
- Stream cursor lifetime is the lesser of one hour and the browser session’s absolute expiry. Each checkpoint refreshes the cursor.
- A cursor with `issuedAt` later than the listener's monotonic wall-clock floor is invalid; `now >= expiresAt` is expired. Clock rollback cannot extend an issued cursor beyond its encoded `expiresAt`.
- Committed known-answer fixtures freeze key bytes, canonical payload JSON, payload segment, MAC-input hex, signature, and final cursor across Node 22.19/24/26; an implementation that produces a different byte at any stage is non-conforming.

`WebPageCursorPayload` requires version/kind, a closed `collection` discriminant, listener id, issued/expiry, principal hash, normalized query hash, stable sort, exclusive keyset `after` equal to the last element returned by the preceding page, `registryMode`, `registryRevision`, `registryContextHash`, `visibleMountsHash`, `projectWatermarksHash`, and any resource version binding required by a detail collection such as `{runId,runVersion}`. The three hashes are lowercase SHA-256 over the P6-canonical exact `registryContext`, ordered visible mounts, and ordered per-project `{projectId,controlDomainId,nextCommitSeq,minAvailableCommitSeq}` vector respectively. They preserve the complete semantic snapshot binding without copying an unbounded mount/watermark vector into every opaque token. The next page starts strictly after the encoded keyset under the encoded sort direction. The collection discriminant closes the sort and keyset shape as follows:

| collection | sort / direction | complete `after` keyset |
|---|---|---|
| `projects` | `project-id` / asc | `{projectId,controlDomainId}` |
| `runs` | requested `createdAt` / `updatedAt` / `status` and requested direction | `{sortValue,projectId,controlDomainId,runId}` |
| `fragments` | `created-commit` / asc | `{createdAtCommitSeq,boundFragmentHash}` |
| `graph` | `node-instance-id` / asc | `{nodeInstanceId}` |
| `timeline` | `commit-seq` / asc | `{commitSeq,eventId}` |
| `attempts` | `attempt-ordinal` / asc | `{attemptOrdinal,attemptId}` |
| `artifacts` | `role-digest-artifact` / asc | `{role,digest,artifactId}` |
| `receipt-manifest` | `commit-seq` / asc | `{commitSeq,eventId}` |
| `approvals` | `created-at` / desc | `{createdAt,projectId,controlDomainId,runId,approvalRequestId}` |
| `attention` | `observed-at` / desc | `{observedAt,attentionId}` |

No endpoint may reuse another collection’s cursor variant, omit a tie-breaker, or infer a missing keyset field from mutable current state.

`WebStreamCursorPayload` requires listener/principal, `registryMode`, `registryRevision`, `registryContextHash`, `visibleMountsHash`, `projectIdentityHash`, and `projectPositions`. `projectIdentityHash` is SHA-256 over the P6-canonical ordered selected-project identity vector of `{projectId,controlDomainId}`. `projectPositions` is the same-length ordered array of `nextCommitSeq` values, with at most 200 entries. On decode, the server recomputes the registry/mount/identity hashes from current authority, pairs each saved position with that current ordered identity, and validates it against the project’s current `[minAvailableCommitSeq,nextCommitSeq]` interval. Thus the token remains self-contained and resumable without embedding repeated project ids or trusting mutable ordering. It carries no query, sort, page keyset, or stale compaction floor.

Continuation verifies MAC, payload schema, kind, protocol/listener, expiry, principal, query/sort where applicable, canonical registry and visible-mount hashes, page snapshot watermark hash or stream project-identity/position vector, and current compaction floor. Auto requires a real current registry revision. Standalone requires the literal `"standalone"` sentinel and exactly one matching mount. Any failure that represents an old but once-valid checkpoint returns `TF_CURSOR_EXPIRED` with `recoveryAction:"refresh"`. Malformed/tampered/cross-kind/mode-invalid cursors return `TF_INVALID_ARGUMENT` without revealing which check failed. A stream/page cursor is never accepted in the other endpoint. Executable fixtures must prove both cursor kinds remain below the 8 KiB cap and round-trip correctly at the 200-project bound.

These vectors are checkpoints, not global causal clocks. SSE arrival order and timestamps never become a global commit order.

## 8. HTTP status and error mapping

JSON errors use `WebFailure`; artifact/SSE requests return the same JSON envelope when failure occurs before streaming headers.

| HTTP | Required use |
|------|--------------|
| `200` | Successful reads, analysis, session operations, command submit/query including semantic `WebCommandOutcome` branches |
| `400` | Malformed path/query/JSON, schema violation, invalid SafeId/cursor encoding |
| `401` | Missing, expired, or revoked browser session |
| `403` | Origin/CSRF failure, current authorization denial, artifact redaction denial |
| `404` | Authorized resource not found; unauthorized existence is not disclosed |
| `405` | Known route with unsupported method; response includes the exact `Allow` set |
| `406` | A known SPA route does not negotiate `text/html` under §13.1 |
| `408` | A non-stream request body did not complete within its fixed deadline |
| `409` | CAS/stale version, idempotency conflict, feature/state/capacity conflict before a command outcome exists |
| `410` | Authentic but expired/restart/registry/compaction-invalid cursor |
| `413` | Request target/body/frame or requested artifact exceeds v5 limit |
| `415` | Unsupported request media type |
| `416` | Any Range request in beta.2 (`TF_INVALID_ARGUMENT` with a sanitized range-unsupported message) |
| `417` | Unsupported `Expect` header; the listener never accepts an implicit `100-continue` body |
| `421` | Host header is not the exact launch host/port |
| `426` | Browser/daemon protocol major is incompatible |
| `429` | Session, stream, request-concurrency, or analysis-concurrency limit |
| `431` | Header bytes/count exceed the listener limits |
| `500` | Sanitized unexpected implementation failure |
| `503` | Required current authority is temporarily unavailable and no truthful partial response applies |

Once `POST /commands` has accepted a syntactically valid, supported request into command processing, durable semantic results use HTTP 200 with the closed `WebCommandOutcome`: `pending | completed | failed | rejected | not-found`. `failed`/`rejected` carry `ControlError`; `pending`/`completed` do not; `not-found` carries no fake request hash or commit range. This preserves lost-response recovery without conflating command history with HTTP transport.

### 8.1 Low-level HTTP defense contract

`node:http` supplies primitives, not policy. WebGateway fixes the following values on Node 22.19, 24 LTS, and 26 CI:

| Control | Value / behavior |
|---------|------------------|
| Total request-header bytes | 16 KiB maximum |
| Header count | 64 application-visible maximum; `server.maxHeadersCount = 65` keeps one sentinel header visible because Node 24 otherwise truncates `rawHeaders` before the request callback; WebGateway rejects `>64` with 431 |
| Header completion | `server.headersTimeout = 10_000` ms |
| Non-stream request/body completion | `server.requestTimeout = 30_000` ms plus an application-owned 30,000 ms body deadline; timeout returns 408 and closes the connection |
| Idle keep-alive | `server.keepAliveTimeout = 5_000` ms; 1,000 ms buffer where supported |
| Requests per socket | `server.maxRequestsPerSocket = 100` |
| JSON/analysis response deadline | 30 seconds unless a stricter endpoint budget applies |
| Artifact delivery | five-minute absolute response limit and abort after 30 seconds without writable progress |
| SSE | request timeout ends after validated headers/subscription; heartbeat, queue, drain, session expiry, and listener shutdown provide its lifetime bounds |

Listener construction may tighten the application-owned body deadline for a
stricter local policy or deterministic testing, but it rejects any value above
30,000 ms. This is not a negotiable browser capability and cannot weaken the
wire contract.

The raw request target is checked against 16 KiB before route decoding. Multiple Host fields fail 421. Duplicate Content-Length, any Content-Length plus Transfer-Encoding, unsupported transfer codings, obsolete line folding, control characters, malformed chunking, `Expect`, and HTTP Upgrade are rejected before the handler consumes a body. JSON POST requires exactly `Content-Type: application/json`; parameters and alternate JSON media types fail 415. Requests with bodies but no valid framing fail 400.

A registered path with the wrong method returns 405 with a deterministic `Allow`; unknown paths return 404. OPTIONS is not an automatic CORS route. HEAD is supported only by the static contract in §13; artifact, analysis, stream, and command endpoints keep the exact §4 methods. Error responses close the socket when framing ambiguity makes reuse unsafe.

Parser-level `clientError` failures that occur before a valid request/Host exists return only a minimal 400 or 431 with `Connection: close` and no reflected input; they are the sole exception to the JSON `WebFailure` envelope. Tests set every value explicitly; inheriting a changing Node default is non-conforming. See the official [`node:http` server controls](https://nodejs.org/api/http.html).

## 9. Session and request security

### 9.1 Launch exchange

`taskflow ui` binds only `127.0.0.1`, selects a port, generates a 128-bit nonce as 26 lowercase Base32 characters, and uses:

```text
http://<nonce>.localhost:<port>/#launch=<43-char-capability>
```

The capability is exactly 32 random bytes encoded as 43-character unpadded base64url. The SPA reads it from the fragment, immediately removes the fragment with `history.replaceState`, and sends it once in the closed JSON `WebSessionExchangeRequest`. Fragments are never sent in HTTP requests. The capability is single-use, expires after 60 seconds, is stored only as a keyed hash server-side, and is invalidated atomically when an exchange presents the matching capability, even if later session creation fails. Non-matching guesses cannot consume it.

Successful exchange returns `WebSessionView` including the memory-only CSRF token and sets:

```text
Set-Cookie: tf_web_<listener-suffix>=<opaque-session>;
            HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
```

The cookie has no `Domain`; its name suffix is eight lowercase hex characters derived from the listener id. `Secure` is omitted only because beta.2 is plain HTTP on loopback. The opaque session and CSRF token each contain at least 256 random bits. Browser code keeps the CSRF token in memory only.

Authenticated `GET /bootstrap` returns the current session's same CSRF token so
a same-origin hard reload can restore mutation capability without browser
storage or a second launch capability. This is a read of ephemeral session
state, not token rotation or a domain mutation. Exact Host, session cookie,
same-origin Fetch Metadata, no-CORS, and response-read same-origin policy are
all required before the token is returned; the browser again keeps it only in
memory.

Session idle expiry is 30 minutes and absolute expiry is 8 hours. Authenticated activity may extend idle expiry but never absolute expiry. The listener exits after the final session and launch capability have expired, subject to a maximum 30-second drain, or immediately after explicit `taskflow ui --stop`.

The listener permits at most eight live sessions. Each session permits 16 concurrent non-SSE requests, of which at most two may be pure analysis; excess requests return 429 with integer `Retry-After: 1`. These are concurrency bounds, not a global request-rate quota.

### 9.2 Host, Origin, and CSRF

- Every request requires the parsed canonical authority to equal `<nonce>.localhost:<port>` exactly; IP literals, other localhost names, suffix/prefix matches, multiple Host headers, userinfo, malformed ports, and DNS-rebinding names fail with 421.
- Every POST except session exchange—including replay and recompute preview—requires exact `Origin: http://<nonce>.localhost:<port>`, `Sec-Fetch-Site: same-origin` when present, session cookie, and `X-Taskflow-CSRF` equal to the current token.
- `POST /session/exchange` has no session/CSRF yet but still requires exact Host/Origin and a JSON media type.
- GET endpoints do not mutate domain or session state. They require the session and exact Host; an explicitly present Origin must match, and `Sec-Fetch-Site` must be `same-origin` when present.
- CORS is disabled: no `Access-Control-Allow-Origin`, credentials, or wildcard response headers; OPTIONS does not become a cross-origin API.
- Session ids, launch capability, CSRF token, request/authorization hashes, replay overrides, and command bodies are never accepted in URLs or persisted to browser storage.

`POST /session/logout` revokes the current session and expires its cookie. `POST /sessions/revoke-all` revokes every session under the listener, expires the caller cookie, and closes SSE streams. Neither operation writes a ControlStore journal or changes execution truth.

Because browser `EventSource` does not expose the HTTP status of a failed reconnect, an unexpected stream close starts one deduplicated authenticated `GET /bootstrap` session probe immediately, independent of route queries and the bounded polling cadence. A locally initiated logout or revoke-all request already in flight suppresses that generic probe until its response settles, so the successful response can preserve its exact requested scope. Outside a successful local revocation response, only an authoritative `401` from the probe or another authenticated JSON request moves the tab to the conservative current-session-ended state; a `401` never proves the broader requested scope. Network failure, timeout, or another status keeps the tab in disconnected/recovery presentation and must not be guessed as revocation.

## 10. Commands and pure analysis

`WebCommandRequest` is a closed discriminated union:

| Kind | Required fields beyond `commandId` |
|------|------------------------------------|
| `approve` | project/domain/Run ids, `expectedRunVersion`, `approvalRequestId` |
| `reject` | same approval identity plus bounded optional reason |
| `edit-approval` | same approval identity, `editKind`, content-addressed edit artifact digest |
| `cancel-run` | project/domain/Run ids, `expectedRunVersion`, bounded optional reason |
| `resume-run` | project/domain/Run ids, `expectedRunVersion` |
| `recompute-run` | project/domain/Run ids, `expectedRunVersion`, non-empty unique phase ids |
| `reconcile-run` | project/domain/Run ids, `expectedRunVersion` |
| `set-max-active-runs` | value, expected current value, expected coordinator epoch |
| `force-release` | reservation id, observed state, revision, coordinator epoch, project/domain/Run binding, exact P16 acknowledgement |

No `payload:unknown` branch exists. Same `commandId` + same canonical request hash is idempotent; a different hash is `TF_IDEMPOTENCY_CONFLICT`; a different principal is `TF_CROSS_PRINCIPAL_COMMAND`. `GET /commands/:commandId` performs live re-authorization before disclosure.

`approve` is advertised for a resource only when its home authority has a current P15 ApprovalRequest, exact Run CAS inputs, the original immutable BoundPlan, and a private digest-verified continuation checkpoint for the unconsumed approval node. The checkpoint contains settled Attempt/output state, is never a P17 DTO or browser artifact, and is not Receipt-reachable. The resumed scheduler consumes only that approval and must not replay prior phases. Missing or mismatched continuation evidence removes the available action or fails closed with `TF_RECONCILE_REQUIRED`; it never degrades to whole-plan rerun.

The daemon settles durable pre-dispatch approve handoffs before exposing UDS or WebGateway. A `running/queued` handoff is resumed only when the project journal, ApprovalRequest, CommandRecord, coordinator reservation, original BoundPlan and private checkpoint agree exactly. A restart after `running/executing` is not blindly replayed: absent a reconstructable provider submission checkpoint, it becomes `unknown/reconciling + needsOperator`, retains ambiguous capacity, and produces no Receipt.

`edit-approval` remains unadvertised until content-addressed edit validation, durable edited BoundPlan reload, and dispatcher handoff exist. Approve/edit success means only the committed P15 transition and handoff; it never manufactures provider completion or a Receipt.

On reload or lost response, query the command id first. If no authoritative record exists, refresh the target and require explicit resubmission. The browser never replays a recovered command body from storage.

Why-stale, replay, and recompute preview are bounded pure analysis. They use no command id, provider, journal append, Run version transition, cache mutation, reservation, or Receipt. Handler tests inject counters and fail if provider or durable-write paths are touched.

## 11. SSE framing, resume, and backpressure

Successful stream headers are:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Content-Encoding: identity
```

The server first writes `retry: 3000` and a blank line. Every protocol event is exactly:

```text
id: <opaque-stream-cursor>
event: taskflow
data: <one-line compact JSON matching WebStreamFrame>

```

JSON escaping keeps embedded newlines out of the SSE line. `id` contains no CR/LF/NUL. The closed wire enums are:

```text
WebChangeKind = created | updated | deleted | invalidated
WebChangeResourceType =
  overview | project | coordinator | reservation | run | graph | timeline |
  node | approval | attention | policy | artifact | command
```

The closed `WebStreamFrame` union is:

- `checkpoint`: complete `WebSourceObservation`;
- `change`: closed resource type/identity, closed change kind, optional project-local commit sequence;
- `heartbeat`: server time only;
- `reset-required`: `TF_CURSOR_EXPIRED` with `recoveryAction:"refresh"` for an invalidated checkpoint or queue-overflow gap.

No `string`, catch-all object, or server-emitted `unknown` branch exists. A future enum/discriminant addition is protocol-major under §2.1 unless an earlier protocol version already defined a safe compatibility branch. A consumer may normalize an unrecognized frame to a tab-local “unknown → full resync” state before discarding it, but may not treat its payload as data or action authority.

The server emits a heartbeat after 15 seconds without another frame. A session may hold at most four concurrent streams. Each stream has a queue cap of 256 frames **or** 1 MiB encoded bytes, whichever comes first. On overflow the server drops queued change frames, attempts one `reset-required`, and closes. It never silently skips and continues.

Each frame is at most 64 KiB. Larger domain changes become a small invalidation frame; full data is refetched through JSON. SSE compression is disabled.

`WebEventStreamQuery.cursor` and the `Last-Event-ID` request header each accept at most one 8 KiB opaque stream cursor. No value means a fresh checkpoint. If both are present they must be byte-identical or the request fails 400/`TF_INVALID_ARGUMENT`; after equality validation, `Last-Event-ID` is the canonical resume input. An initial or resumed subscription validates the stream cursor before headers. Page cursors are rejected. Restart, expiry, registry-context/mount change, authorization change, or compaction past a watermark triggers reset/refetch; the server never fabricates missing journal history. This matches native EventSource reconnection behavior while retaining an explicit initial query cursor ([HTML SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)).

Polling fallback uses the same authorized GET DTOs and page/checkpoint rules at `WebBootstrapView.pollingMinIntervalMs`, whose closed range is 3,000–60,000 milliseconds. The browser waits at least that long between poll starts, never overlaps polls, keeps the stream presentation degraded, and stops polling as soon as SSE reconnects. A successful first polling refresh may complete the current resync, but only exact authoritative-detail responses create new current-epoch resource stamps. Polling does not introduce a second event model.

## 12. Artifact delivery

Artifact access requires all of:

1. live session and exact Host;
2. current authorization to the project/Run evidence;
3. exact project/domain authority;
4. ledger reachability from the Run/Receipt/approved evidence reference;
5. complete digest and length verification against an immutable snapshot **before** response headers/body;
6. redaction and byte-limit policy.

`WebArtifactRef.redactionClass` is closed:

| Class | Browser behavior |
|-------|------------------|
| `public` | May inline if MIME/size allow; may download |
| `project` | Same as public after current project authorization |
| `sensitive` | Never inline; explicit user download with `X-Taskflow-Sensitive-Ack: download` |
| `secret` | Never served; metadata remains redacted |

Inline allowlist:

```text
text/plain; charset=utf-8
application/json; charset=utf-8
image/png
image/jpeg
image/gif
image/webp
```

SVG, HTML, XHTML, JavaScript, XML, and PDF are never inline in beta.2. Authorized non-secret types may download as attachment; unrecognized types use `application/octet-stream`. Inline is capped at 5 MiB and all browser downloads at 100 MiB. `Range` is unsupported and returns 416.

Before a success response, WebGateway either opens an immutable content-addressed blob whose digest/size was verified at ingest and rechecks it before disclosure, or copies the authorized source into a listener-private temporary spool created with exclusive `0600` permissions. The spool path is server-generated under a canonical private runtime directory. The gateway enforces the 100 MiB limit while copying, hashes all bytes, verifies exact digest/length, rewinds the now-immutable snapshot, and only then sends success headers/body. Mismatch or source mutation deletes the spool and returns a JSON failure because headers have not been sent. The spool is deleted on finish, abort, error, and startup cleanup.

Successful responses set canonical `Content-Type`, exact `Content-Length`, digest `ETag`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; sandbox`, and sanitized ASCII `Content-Disposition`. Filename metadata is advisory, stripped of separators/control/bidi characters, length-bounded, and never used as a filesystem path.

Artifact bytes, SecretRefs, arbitrary paths, spool paths, and sensitive acknowledgements never enter URLs, logs, telemetry, or browser persistent storage. Backpressure/transport failure may truncate a response but can never expose bytes that failed integrity verification.

## 13. Application shell and static asset delivery

Static delivery shares the exact launch origin but is a separate route class from `/api/v1`.

### 13.1 Route partition and fallback

Routing order is fixed:

1. `/api/v1` and `/api/v1/**` always enter the API router. Unknown API paths return JSON 404 and never `index.html`.
2. `/assets/<manifest-name>` and explicit root assets such as `/favicon.ico` resolve only through the packaged asset manifest. A miss is 404; no directory or filesystem fallback exists.
3. `/` and a path matching the compiled frontend route registry may return the SPA shell for GET/HEAD only when the exact algorithm below allows `text/html`.
4. Every other path is 404. A known path with a wrong method is 405 plus exact `Allow`.

For a known SPA route, absent `Accept` permits the shell. Otherwise the listener combines all `Accept` field values as a comma-separated list, parses media ranges case-insensitively, and accepts only syntactically valid RFC media ranges with `q` absent (meaning `1`) or decimal `0..1` with at most three fractional digits. Invalid syntax returns JSON 400. For `text/html`, select the most specific matching range (`text/html` over `text/*` over `*/*`) and, within that specificity, the highest quality. A more-specific `q=0` exclusion overrides a less-specific wildcard allowance. The shell is returned only when the winning quality is greater than zero. Thus absent `Accept` and `*/*;q>0` allow; `application/json` alone, `text/html;q=0`, or `text/html;q=0,*/*;q=1` do not and return JSON 406 without `index.html`. Multiple field lines and mixed ranges use the same deterministic parser; no substring search is conforming.

The route registry contains only the RFC v7 paths and validates every dynamic segment with SafeId before returning a shell. Raw request target is length-checked, split from query/fragment, percent-decoded exactly once, and rejected for non-canonical encoding, encoded separators, literal backslashes, dot segments, NUL/control/bidi path characters, or invalid UTF-8. Filesystem resolution then performs canonical containment beneath the immutable packaged asset root. Symlinks, directory listings, and caller-selected absolute paths are forbidden.

### 13.2 Cache, MIME, and security headers

| Resource | Content/cache contract |
|----------|------------------------|
| `index.html` | `Content-Type: text/html; charset=utf-8`; `Cache-Control: no-store` |
| Manifest-listed hashed JS | `text/javascript; charset=utf-8`; `public, max-age=31536000, immutable` |
| Manifest-listed hashed CSS | `text/css; charset=utf-8`; same immutable cache |
| Manifest-listed JSON | `application/json; charset=utf-8`; same immutable cache |
| Manifest-listed raster/font/icon assets | Exact allowlisted MIME from manifest; same immutable cache |

`WebStaticMediaType` is exactly `text/javascript; charset=utf-8 | text/css; charset=utf-8 | application/json; charset=utf-8 | application/manifest+json; charset=utf-8 | image/svg+xml | image/png | image/jpeg | image/gif | image/webp | image/x-icon | font/woff2`. Packaged SVG is trusted build input; the artifact endpoint still never inlines agent-supplied SVG.

HEAD returns the same status/headers and no body. Every response has exact `Content-Length`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: same-origin`. HTML additionally returns exactly:

```text
Content-Security-Policy:
  default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' blob: data:; font-src 'self'; connect-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'none';
  form-action 'none'; manifest-src 'self'; worker-src 'self'
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy:
  accelerometer=(), autoplay=(), camera=(),
  display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(),
  gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(),
  picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(),
  serial=(), usb=(), web-share=(), xr-spatial-tracking=()
```

Wrapping above is documentation formatting; every header value is serialized as one line without obsolete folding. The production build contains no inline script/style requiring a nonce, no `eval`/Wasm-eval allowance, no remote origin, and no service worker. Production packages exclude `.map` files and `sourceMappingURL`. A separately named, local-only debug artifact may contain source maps but the normal WebGateway never serves it.

### 13.3 Build/asset compatibility manifest

The package-integrity-covered asset manifest is strict and requires:

```ts
type WebAssetManifest = {
  manifestVersion: "taskflow-web-assets.v1";
  packageVersion: string;
  webBuildId: string;
  protocolConsumer: { major: 1; minMinor: number; maxMinor: number };
  entrypoint: { path: string; sha256: string };
  assets: {
    path: string;
    sha256: string;
    size: number;
    mediaType: WebStaticMediaType;
  }[];
  routeRegistry: {
    version: "taskflow-web-routes.v1";
    patterns: WebStaticRoutePattern[];
    sha256: string;
  };
  contentCatalogs: {
    version: "taskflow-content.v1";
    defaultLocale: "en";
    supportedLocales: ["en", "zh-CN"];
    projectedKeysetSha256: string;
    staticKeysetSha256: string;
    keysetSha256: string;
    catalogs: [
      { locale: "en"; path: string; sha256: string; size: number },
      { locale: "zh-CN"; path: string; sha256: string; size: number },
    ];
  };
};
```

`WebStaticRoutePattern` is a closed route-token array generated from the same typed route source as the SPA; it permits literal segments and SafeId placeholders, not regex or arbitrary globs. Paths are unique, normalized, content-hashed names; asset rows and route patterns are sorted canonically. WebGateway validates manifest schema, daemon/package build compatibility, protocol range, route-registry hash/content, canonical containment, file size, and SHA-256 before opening the listener. A mismatch fails closed with CLI upgrade/reinstall guidance; it never serves a mixed shell/API release. Immutable asset bytes may be verified once at startup and pinned by an open descriptor or verified again before each response.

Every catalog path is also an exact manifest-listed immutable asset. Build validation expands the §5.3 projected key families, loads the sole checked-in static-key source at `packages/taskflow-web/src/content/static-keys.ts`, canonicalizes both key/argument registries, verifies both locales have the identical projected/static/combined keyset hashes, and hashes the complete rendered catalog artifact. The reference manifest binds those hashes but cannot define keys. WebGateway rejects a missing catalog, locale/order mismatch, any keyset mismatch, or catalog asset digest/size mismatch before opening the listener.

### 13.4 Unauthenticated shell boundary

Exact Host validation applies before any static response. The shell/assets may load before session exchange only because they are identical public package bytes. They contain no project/principal display name, ids, paths, registry revision, Run/Approval/Receipt data, launch capability, session/CSRF value, host nonce, port, or per-listener configuration. The launch fragment remains browser-owned until the authenticated exchange; all dynamic bootstrap/resource data requires a live session.

Packaged-dist tests scan HTML/JS/CSS/manifest bytes and network traffic for forbidden dynamic values, remote origins, source maps, and undocumented routes. Vite HMR/dev proxy behavior is explicitly non-conforming production evidence.

## 14. Authoritative source requirements

Every DTO field must trace to the RFC v7 §7.5 matrix:

- registry locates project authority but cannot replace a verified ControlStore header;
- display names come from persisted display metadata or the specified deterministic fallback, never inferred from output;
- Run/Command/Approval/Receipt state comes from the home Project ControlStore;
- coordinator capacity/reservations come from UserCoordinatorStore;
- BoundPlan/BoundFragment/node/Attempt/timeline data is durably reloadable or deterministically projected from durable project records;
- `BoundPresentationIndex` is a rebuildable sidecar from versioned compiler/binder output, excluded from execution/content hashes, and the deterministic Task/observation/decision/error projection family is the only source of safety-relevant Simple content selection;
- `taskflow-content.v1` catalogs translate those semantic messages as whole text in `en`/`zh-CN`; catalogs never decide state, authority, risk, or actions, and component-local copy cannot replace them;
- overview/attention are derived and always carry coverage/authority;
- verification is derived from terminal truth, immutable Receipt assurance/manifest, current verifier results, and exact artifact checks—not Receipt presence;
- capabilities/actions are recomputed from current build support, principal, policy, provider, state, and CAS version;
- replay/why-stale are pure core read services;
- artifact bytes are authorized by ledger reachability and completely verified into an immutable snapshot before delivery.

Browser cache, SSE frame, aggregate index, provider response, fixture, or WebGateway memory cannot manufacture verified domain state. A required source that does not yet exist is a conformance blocker, not permission to return a plausible empty value.

## 15. Required verification evidence

P17 v5 cannot be wire-frozen without:

- TypeBox validation and encode/decode round-trip for every request, response, error, command branch, action branch, cursor payload, and SSE frame;
- all 29 `WEB_ENDPOINTS`, router handlers, generated client methods, and generated §4 documentation rows pass the registry/docs drift guard bijectively;
- golden JSON fixtures for every union branch and every RFC v7 presentation/verification/content state, plus old/new compatibility tests distinguishing additive/minor from breaking/major changes;
- byte-identical `projectTaskPresentation()` golden/property tests covering parallel active steps, grouping, progress semantics, result selection, six verification states, primary action, decision sets, input-order permutation, and invalid presentation metadata;
- `reduceWebLiveState()` transition/epoch goldens include clean catch-up invalidation and disconnect/reset catch-up de-duplication; `projectObservationPresentation()` goldens cover all resource × stamp-epoch × scope × stream × resync × coverage × authority combinations without changing domain status; `projectDecisionPresentation()` and `projectControlErrorPresentation()` cover every closed operation/error/recovery/risk branch;
- projection-position/import tests prove only the server serializes Task/verification/decision, only the browser derives observation/failure, and every projection consumes the exact §5.3 closed input;
- verification goldens cover the exact check-state union, expected failed/cancelled outcomes, `not-admitted`, and the security-monotone `mismatch`-before-`in-progress` priority;
- decision fixtures prove two-sided approve/reject equality and force one-sided approval capability to `status-only` with no decision control;
- reachable-state fixtures cover every safety-distinct RunStatus × RunStage × verification × observation × decision-disposition interaction, while negative fixtures reject impossible/contradictory combinations;
- complete `en`/`zh-CN` projected/static/combined keyset, argument and digest parity; locale-aware plural/date/number formatting; whole-message/no-fragment tests; inline unregistered static-string lint; missing-key fail-closed tests; and mixed catalog/daemon startup rejection;
- strict `docs/internal/webui/reference-set-v1/manifest.json` validation binding each screen/state to exact source/presentation/content fixture hashes, fields, authority/provenance, locale/theme/viewport/zoom, focus order, unavailable behavior, and comprehension facts;
- Simple primary and accessibility content lint rejects the RFC v7 §10A.4 internal vocabulary, raw `ControlError.message`/stack output, generic decision labels, anthropomorphic emotion/intent, unsupported reassurance, and unbounded time promises;
- DOM/screenshot/accessibility fixtures prove state, risk, verification limits, decisions, and primary actions remain complete at 320 CSS px and 200% zoom without ellipsis, clipping, hover-only disclosure, or technical-detail reordering;
- browser-safe import guard;
- cursor known-answer byte vectors plus tamper, cross-kind, length, expiry, restart, query, principal, auto/standalone registry context, mount-set, and compaction tests;
- every JSON endpoint passes full-envelope byte-budget tests; fragment, graph, timeline, Attempt, artifact, and Receipt pages pass row + encoded-byte boundary, one-oversized-element, version-binding, and concatenate-all-pages exactness tests. A committed exact-boundary fixture makes element N plus the required `nextCursor` bring the full envelope to exactly the budget, proves N is returned, binds `after` to N, and proves N+1 appears exactly once on the next page;
- command lost-response, reload, restart, idempotency, cross-principal, stale-version, and live-reauthorization tests;
- launch-token single-use/expiry tests and hostile `localhost`, duplicate/malformed Host, DNS rebinding, cross-port cookie, Origin, CSRF, CORS, and revoke-all tests;
- header/count/timeout, slow-body, duplicate CL, CL/TE, Expect/Upgrade, 404/405/Allow, keep-alive, artifact-stall, and SSE-lifetime tests on Node 22.19/24/26;
- SSE line-injection, closed-enum, query-cursor/`Last-Event-ID` equality/conflict/limit, max-frame, heartbeat, four-stream, queue-overflow/reset, reconnect, compaction, restart, and polling-equivalence tests;
- artifact authorization, reachability, pre-header immutable-snapshot digest/length, redaction class, MIME, disposition, bidi/traversal, size, Range, source mutation, spool cleanup, and transport-abort tests;
- static API/fallback partition, route SafeId, exact asset manifest, cache/MIME/header, canonical containment, traversal, source-map absence, unauthenticated-shell data scan, incompatible-build, and exact absent/multiple/wildcard/quality-zero/malformed `Accept` tests;
- handler/source tests proving every RFC v7 §7.5 field comes from current authority rather than browser cache or fixtures;
- a versioned five-fresh-participant `en` comprehension record proving at least 4/5 complete each ordinary task, plus zero severity-1 safety misunderstandings; any severity-1 finding blocks the candidate and the affected task is rerun after the fix with five fresh participants;
- complete `zh-CN` parity plus independent native-level content/UX and technical/safety linguistic reviews; this is not represented as an equal five-user comprehension cohort;
- packaged-dist CLI → daemon → WebGateway → real browser E2E for every RFC v7 Must-ship row.

## 16. Freeze condition and current delta

P17 v5 remains **Provisional / not wire-frozen** until every Must-ship endpoint/state is conforming and all §15 evidence is green.

The non-normative
[`webui/p17-v5-conformance-matrix.md`](../webui/p17-v5-conformance-matrix.md)
records the current immutable-candidate evidence and keeps every
partial/external gate visible; it cannot weaken this section.

The executable implementation candidate now includes:

- all 29 endpoint definitions in the sole `WEB_ENDPOINTS` registry, typed route
  tokens, request/success schemas, operation classes, capabilities, response
  budgets, generated handler/client adapters, and the generated RFC inventory
  drift guard;
- closed feature/command/action discovery, the initial bounded endpoint DTO
  family, strict producer schemas, and tolerant consumers only at the declared
  additive presentation points;
- fixed server Task/verification/decision projections and browser-only
  live-state/observation/failure projections, including an executable 13-pair
  reachable Run state union, contradictory-state rejection, 92
  safety-distinct Task factor interactions, all verification/decision/failure
  branches, the catch-up epoch, and mismatch-first verification fixtures;
- complete projected/static `en` + `zh-CN` catalogs and content-key/argument/
  forbidden-terminology drift checks;
- exact P6-canonical HMAC cursor encoding, collection-specific keysets, TTL and
  authorization/snapshot binding, committed byte vector, and full-envelope
  exact-boundary continuation fixtures;
- committed compatibility vectors for all 13 approved additive presentation
  roots, every command/action/outcome/page-cursor/SSE branch, all 29 endpoint
  codec samples, every closed `ControlError` code, and all 14,138 branches
  recursively found across 1,063 nested union occurrences; these distinguish
  an ignored top-level additive field from required-field and nested-authority
  breaking changes;
- a real packaged cross-build harness that rejects identical asset manifests
  or stamped commits. Immutable candidates
  `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa` and
  `aa34369a5958ce34bbdad3eab973434a001d0738` pass both
  old-client/new-server and new-client/old-server with Web v1 bootstrap and
  zero application console/page errors; the checked-in schema-v2 report
  contains immutable build identities and no local absolute paths. The
  evidence checker rejects a non-descendant evidence tip or any production/
  benchmark source drift after the new immutable build;
- durable/recoverable BoundPlans plus conservative node/Attempt metadata and
  nineteen explicitly enumerated ControlStore/Coordinator read handlers;
- all 29 registered WebGateway route slots, composed from session/bootstrap,
  read, pure-analysis, artifact, replay, durable-command, and event services,
  with a default capability declaration that exposes the independently proven
  `approve`, `reject`, and `cancel-run` paths. Approve is present only for an
  exact P15 continuation; taskflowd recovers all four durable
  pre-dispatch approve prefixes before opening UDS/WebGateway and fails a
  post-dispatch ambiguous restart closed without replay or Receipt;
- loopback session exchange and revocation, Host/Origin/CSRF defenses,
  asset-manifest-bound static delivery, SSE catch-up/reset and bounded polling
  fallback, raw-socket framing/parser/Expect/Upgrade/header-count rejection,
  four-stream enforcement, explicit 256-frame/1-MiB SSE queue overflow reset,
  heartbeat/restart/compaction reset fixtures, absolute-session stream expiry,
  SSE line-injection rejection, hostile static-package/Accept fixtures, a
  30-second application-owned request-body/handler deadline with real
  slow-body 408/close evidence, immediate client-disconnect cancellation,
  bounded keep-alive rotation, exact 5-MiB/100-MiB artifact policy boundaries,
  a paused real TCP SSE consumer proving one-reset overflow and capacity
  release, exact 100-MiB artifact transport, the production five-minute
  absolute artifact deadline plus shortened same-path timer evidence, and
  bounded artifact writes with both no-progress and real-transport abort
  evidence;
- exact one-decode static-path validation plus hostile encoded-path and
  packaged-filesystem corpora covering malformed/double encodings,
  separators/dot segments, invalid UTF-8, control/bidi/normalization cases,
  symlink components, non-files, escaping/duplicate manifest entries,
  unlisted files, and source-map probes;
- all ten registered paged surfaces carry endpoint-owned collection/path/limit
  metadata and pass empty, single, exact N/N+1 full-envelope,
  concatenate-all-pages, one-oversized-element, and strict response-schema
  cases;
- a pinned Node 22.19.0/24.18.0/26.5.0 protocol/gateway matrix (62 tests per
  runtime), including the cross-version 65-header parser sentinel required to
  enforce the 64-header application maximum without silent truncation and the
  combined event-cursor restart/query/authorization/listener/key/mount/
  compaction matrix. The checked report binds clean source candidate
  `aa34369a5958ce34bbdad3eab973434a001d0738`;
- a packaged CLI → daemon → WebGateway → real browser E2E using multiple
  project stores, two independent nonce-host listeners in one browser context,
  a live cancellable provider process, SSE and polling fallback with
  byte-equivalent live/stopped Task presentation, three-second refetch evidence
  for every current GET query surface, Receipt/artifact evidence, deterministic
  full-manifest Receipt JSON export with fail-closed client consistency checks,
  and visibly separate why-stale/offline-replay surfaces. The browser executes
  replay from the Receipt-bound `replay-trace`, observes zero provider calls and
  zero durable writes, and proves the project `nextCommitSeq` is unchanged. The
  same path also covers a manifest-bound split production bundle whose asset
  builder enforces the
  220-KiB-gzip Simple-shell ceiling, React Aria task-tab/disclosure/alert-dialog
  and single-selection semantics with keyboard selection, plus a React Aria
  graph listbox whose arrow-key selection updates the same node inspector as
  the visual DAG, modal
  focus/Escape/restore behavior and Simple → Pro focus restoration, zero
  inline/runtime styles, 320 CSS-pixel layout, and Chromium axe checks. The
  approval-enhanced `aa34369a` path passes Chromium 149.0.7827.55, Firefox 151.0 and
  WebKit 26.5 from the same source state on the first attempt of every matrix
  lane; all three have zero application console/page errors, CSP violations
  and runtime-style findings, and all three pass the Receipt export and
  zero-write/zero-provider replay checks and graph-listbox keyboard parity. The
  same packaged path separately
  passes the installed native Google Chrome 150.0.7871.184 through Playwright's
  `chrome` channel, including zero Chromium axe findings. Native Safari 26.3
  has separately scoped packaged read/keyboard/AX plus four mutation smokes;
  approval/cancel observations are ancestral, while peer invalidation was
  rerun against the current session-revocation source.
  Allow reaches completed 3/3 with honest partial verification and applies
  listener-wide revocation. Reject reaches both choices through native Tab
  focus, persists the approval node as blocked with downstream pending, and
  applies current-session logout. Cancel settles both Run and the formerly
  active node as stopped, retains unavailable verification, and invents no
  result. Independent peer invalidation makes a native Safari target render
  the deterministic localized session-ended screen rather than a generic page
  failure after a separate authenticated P17 client revokes all sessions. The
  latter was rerun on evidence tip `e19dfd45` with the byte-identical
  `aa34369a` candidate source and does not claim an unlocked Safari
  private-window actor. Every passing hold verifies listener close; Edge and
  assistive-technology review remain separate;
- a nine-family, 14-state reference manifest with exact source/projection/file
  and catalog hashes plus 149 hash-bound rendered screenshots. The required
  desktop/narrow/zoom, `en`/`zh-CN`, and light/dark matrix is present, and 36
  representative renders have zero recorded serious/critical axe violations.
  Human product/content approval and comprehension evidence remain absent, so
  the manifest deliberately stays `draft-unapproved`.

At minimum, conformance work must still add or verify:

- repeat the now-green real packaged old-client/new-server plus
  new-client/old-server harness at the final reviewed tip. The latest local
  immutable pair is checked in as evidence, but it does not substitute for
  reviewed-tip verification;
- native Edge, assistive-technology and human review of the
  approval-enhanced decision path. Native Safari has ancestral scoped allow,
  reject, cancel, current-session and listener-wide revocation execution
  evidence plus a current-source peer-invalidation rerun, but the peer actor
  was an independent P17 HTTP session rather than a second unlocked Safari
  cookie jar. The exact checkpoint
  dispatcher, HTTP approve/reject path, packaged Chromium/Firefox/WebKit
  decision flow, four-prefix startup recovery, settled-work non-replay, and
  post-dispatch ambiguity fail-closed fixtures are executable; automated or
  AX-driven browser smokes do not satisfy the remaining assistive-technology
  and human gates;
- the raw 30-sample canonical M2/Node 24 latency/CLS report. The deterministic
  100-project/10,000-run/2,000-node packaged harness, project-local rebuildable
  read indexes, startup snapshot prewarm, commit-woken SSE invalidation,
  browser receipt/paint marks, standard CLS session-window measurement, and
  JSON plus human summaries are implemented. Clean immutable commit
  `aa34369a5958ce34bbdad3eab973434a001d0738` has a checked-in M3 Pro/
  Node 24 30-sample structural pass. Its event-to-visible p95 is 344.6 ms,
  above the 250-ms canonical budget, but the non-canonical report correctly
  records it as informational rather than passed. Load also rose during the
  run. It remains informational;
- human approval of the 149 reference renders, the five-fresh-participant
  English comprehension record, and both native Simplified-Chinese content
  reviews using the frozen study protocol and hash-bound evidence;
- a reviewed commit with the complete full build/packed package/browser
  candidate gate rerun at that exact tip, followed by a
  separate P17 conformance and wire-freeze review.

Completing only TypeBox names is insufficient: handlers and authoritative read services must round-trip the same shapes. Conversely, implementation must not quietly extend the protocol without first revising P17 and its fixtures.

---

*End P17 v5. It is a provisional but complete implementation target: the remaining uncertainty is whether implementation and human comprehension conform, not what a browser handler, component, translator, or LLM is supposed to invent.*
