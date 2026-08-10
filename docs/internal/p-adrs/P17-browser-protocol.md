# P17: Browser protocol and aggregate cursors

> Status: **Accepted** (0.3.0-beta.2 browser wire-freeze gate)
> Normative parents: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7 and [rfc-0.3.0-beta.2-web-console.md](../rfc-0.3.0-beta.2-web-console.md) v2
> Canonical schema module: [`packages/taskflow-control/src/web-protocol.ts`](../../../packages/taskflow-control/src/web-protocol.ts)

## Boundary

P1–P16 define control-plane authority and storage semantics. They do **not** define an HTTP/browser protocol. P17 is the sole authority for browser DTO names, HTTP envelopes, pagination, aggregate cursors, session exchange, command dispatch/query, SSE frames, and artifact delivery.

The schema module is browser-safe and may import only browser-safe TypeBox/control wire definitions. It must not import `node:*`, stores, providers, daemon implementations, or executable control-plane logic.

## Version and common HTTP envelope

- Base path: `/api/v1`.
- Browser protocol major: `1`; schema version: `web.v1`.
- JSON media type: `application/json; charset=utf-8`.
- Success: `{ ok: true, requestId, schemaVersion: "web.v1", data }`.
- Failure: `{ ok: false, requestId, schemaVersion: "web.v1", error: ControlError }`.
- Security and command schemas are closed (`additionalProperties: false`) and reject unknown fields.
- Timestamps in browser JSON are Unix milliseconds. `commitSeq` remains a non-negative, project-local integer.

## Endpoint contract

| Method/path | Request schema | Success `data` | Authority/authentication |
|-------------|----------------|----------------|--------------------------|
| `POST /api/v1/session/exchange` | `WebSessionExchangeRequest` | `WebSessionView` | Single-use launch capability; no existing session |
| `GET /api/v1/bootstrap` | none | `WebBootstrapView` | Live browser session |
| `GET /api/v1/projects` | `WebPageRequest` query | `WebPage<WebProjectSummary>` | Live session; registry plus verified project header |
| `GET /api/v1/runs` | `WebRunListQuery` query | `WebPage<WebRunSummary>` | Live session; aggregate projection only |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/runs/:runId` | `WebProjectRunParams` | `WebRunDetail` | Live session plus home-store authorization |
| `GET /api/v1/approvals` | page query | `WebPage<WebApprovalSummary>` | Live session; each actionable row home-store refreshed |
| `GET /api/v1/attention` | page query | `WebPage<WebAttentionItem>` | Live session; derived, non-authoritative queue |
| `GET /api/v1/policy/explanation` | optional `projectId` | `WebPolicyExplanation` | Live session; read-only in beta.2 |
| `POST /api/v1/commands` | `WebCommandRequest` | `WebCommandOutcome` | Live session, exact Origin, CSRF, live authorization |
| `GET /api/v1/commands/:commandId` | path id | `WebCommandOutcome` | Live re-authorization; durable command record lookup |
| `GET /api/v1/events` | `WebEventStreamQuery` | `text/event-stream` of `WebStreamFrame` | Live session; resumable observation only |
| `GET /api/v1/projects/:projectId/domains/:controlDomainId/artifacts/:digest` | `WebArtifactParams` | bytes | Live authz, home ledger reachability, redaction policy |

No endpoint accepts a filesystem path, ControlStore path, arbitrary URL, principal id, or caller-selected authority location.

The launch capability is 32 random bytes encoded as 43-character unpadded base64url. The host nonce is 128 random bits encoded as 26 lowercase Base32 characters. Both encodings are exact schema constraints, not prose-only entropy suggestions.

## Pagination, filtering, and ordering

- Default page limit is `50`; maximum is `200`.
- Empty cursor starts a new snapshot. `nextCursor` is absent when exhausted.
- Run filters are the closed `WebRunListQuery`: project ids, status, stage, `needsOperator`, provider, bounded text query, created-time bounds, sort key, and direction.
- Allowed Run sort keys are `createdAt`, `updatedAt`, and `status`; default is `updatedAt desc`.
- Server ordering is total and deterministic: requested key, then `projectId`, `controlDomainId`, `runId`, all in the requested direction. A page never relies on arrival order.
- Cursor is bound to principal, query, sort, registry revision, and per-project watermarks. Changing any filter/sort starts a new cursor.

## Aggregate cursor algorithm

The browser sees an opaque, authenticated encoding of `WebAggregateCursorPayload`; it may not parse or construct one.

1. On first page/checkpoint, the server snapshots the caller-visible registry revision and the ordered set of mounted project identities.
2. For every project, it records `{projectId, controlDomainId, nextCommitSeq, minAvailableCommitSeq}`.
3. It hashes the normalized query and principal authorization context, records the stable sort, `issuedAt`, and bounded `expiresAt`, then signs/MACs the payload with an ephemeral daemon secret.
4. On continuation, the server verifies signature, protocol version, expiry, principal hash, normalized query hash, and sort.
5. Registry revision or visible mount-set change invalidates the cursor. If a requested project watermark is below its current `minAvailableCommitSeq`, compaction invalidates the cursor.
6. Invalidation returns `TF_CURSOR_EXPIRED` with `recoveryAction: refresh`; the client discards the aggregate snapshot, obtains a new checkpoint, and resubscribes.

This vector is a pagination/resume checkpoint, not a global causal clock. SSE delivery order and cross-project timestamp order never become global commit order.

## Commands and recovery

`WebCommandRequest` is a closed discriminated union. Beta.2 includes approve, reject, edit-approval, cancel-run, resume-run, recompute-run, reconcile-run, set-max-active-runs, and force-release. Policy mutation is absent because P1 defines evaluation but no authoritative policy persistence/command store.

- `commandId` is generated before submit and retained as a non-secret operation id in URL search state (`op=`) or in-memory state. Command bodies, replay overrides, launch tokens, CSRF tokens, and request hashes never enter URLs.
- Same `commandId` + same request hash is idempotent; a different hash is `TF_IDEMPOTENCY_CONFLICT`; a different principal is `TF_CROSS_PRINCIPAL_COMMAND`.
- `GET /commands/:commandId` performs live re-authorization before disclosing the durable outcome.
- On reload or lost HTTP response, query the command id first. If no authoritative record exists, refetch the target state and require explicit resubmission; never blindly replay a body recovered from browser storage.
- Browser projection caches and server pending indexes are convenience only. They cannot manufacture a completed outcome.

`set-max-active-runs` uses expected current value and coordinator epoch. Lowering below current capacity occupancy is rejected atomically; the accepted value always preserves the P16 capacity invariant.

`force-release` requires reservation id, observed state, reservation revision, coordinator fencing epoch, bound project id, bound Run id, and the exact acknowledgement string in the schema. The coordinator compares all fields under its mutation lock and applies normal command idempotency before release.

## SSE

Every SSE message has `id` equal to its opaque cursor and a JSON `data` value matching one branch of `WebStreamFrame`:

- `checkpoint`: registry revision plus all visible project watermarks;
- `change`: resource identity and optional project-local commit sequence;
- `heartbeat`: liveness only, no authority claim;
- `reset-required`: typed error, normally `TF_CURSOR_EXPIRED`.

SSE frames invalidate or patch projections. They are not journal records, do not authorize mutations, and cannot trigger command side effects.

## Artifact response

Artifact access requires a live session, current authorization, exact project authority, ledger reachability, digest verification, and redaction policy. The response sets canonical `Content-Type`, `Content-Length`, `ETag` to the digest, `X-Content-Type-Options: nosniff`, restrictive `Content-Security-Policy`, `Cache-Control: no-store`, and sanitized `Content-Disposition`. SecretRef values and arbitrary filesystem paths are never accepted or returned. Range requests are disabled in beta.2 unless separately specified and tested.

## Observation truth

Freshness is not one enum. Every aggregate response reports three independent axes:

- `streamState`: `connected | catching-up | disconnected`;
- `coverage`: `complete | partial`;
- `authority`: `verified | unverified`.

Only a successful live refresh from the home authority may enable a mutation. “Connected” does not imply complete coverage or verified authority.

## Verification gates

- TypeBox validation for every request, response, command branch, and SSE frame.
- Browser-safe import guard.
- Cursor tamper/expiry/query/principal/registry/compaction tests.
- Lost-response/reload/restart command-query tests.
- Cross-port cookie injection, hostile `localhost`, DNS-rebinding Host/Origin, CSRF, and launch-token replay tests.
- Artifact authz/reachability/digest/MIME/disposition/traversal tests.

## Status

Accepted as the beta.2 browser wire baseline. Product scope remains subject to the Web Console RFC; any wire change requires a P17 revision plus schema and compatibility tests.
