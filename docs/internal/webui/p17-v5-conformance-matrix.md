# P17 v5 implementation conformance matrix

Status: immutable-candidate evidence ledger; **not Conforming and not wire-frozen**.

This document tracks the implementation candidate in the isolated
`codex/0.3.0-beta.2` worktree. P17 remains the normative target. A green row
here means the named local evidence passed; it does not turn unreviewed
candidate commits into a released protocol.

Legend:

- **PASS (local)** — executable evidence passed in this worktree.
- **PARTIAL** — an implementation exists, but P17 §15 requires more branches,
  adversarial cases, platforms, or reviewed-tip evidence.
- **EXTERNAL BLOCKER** — cannot be honestly produced by repository automation.

## Executable implementation

| Surface | Current evidence | State |
|---|---|---|
| Endpoint inventory and generation | `WEB_ENDPOINTS` is exactly 29 rows; generated route, handler and browser-client inventories are bijective; RFC/P17 drift guard has no difference | **PASS (local)** |
| Executable codecs | Every row owns TypeBox params/query/body/success schemas; producer DTOs are closed; committed vectors cover the 13 approved additive roots, all command/action/outcome/page-cursor/SSE branches, all 29 endpoint samples, every error code, and recursively validate 14,138 branches across 1,063 nested union occurrences. `scripts/test-web-packaged-compatibility.mjs` rejects identical asset or commit identities and cross-runs real browser assets plus gateway/control modules in both directions. Immutable candidates `d8df9c650b68e4c0854aaad03e6da3ce0dc3352f` and `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa` pass old-client/new-server and new-client/old-server with Web v1 bootstrap and zero console/page errors; the schema-v2 report is checked in at `artifacts/web-compat/d8df9c65-to-7e555c7d/report.json`. The evidence checker rejects a non-descendant evidence tip or production/benchmark source drift after the new build. | **PASS (local)** for the latest distinct immutable candidate pair; reviewed-tip rerun remains a freeze gate |
| Authority handlers | All 29 gateway route slots are composed from session/bootstrap, 19 read handlers, analysis, artifact, replay, command and event services. Approve/reject delegate to P15 ControlHost CAS; approve reloads the exact private checkpoint and original BoundPlan rather than introducing a Web-owned scheduler. Reject and expiration terminalize the matching durable approval NodeInstance as blocked while leaving downstream nodes pending, so browser step state cannot contradict Run authority. | **PASS (local)** for route/service and enabled approval authority coverage |
| Default capability truth | Packaged bootstrap advertises `approve`, `reject` and `cancel-run`; executable ControlHost, HTTP and packaged-browser evidence covers all three. Edit/recovery/capacity mutations remain unadvertised by default. | **PASS (local)** |
| Pro read surfaces | Graph, node detail, attempts, timeline, artifacts, Receipt, why-stale, replay and fragments use generated P17 client calls | **PASS (local)** |
| Durable command recovery | Command id/body are retained byte-identically in-tab; ambiguous response checks durable outcome first; reload never invents a request body | **PASS (local)** for client/service fixtures |
| Session operations | Current-session logout and listener-wide revocation are explicit, CSRF-protected and explain that execution state is unchanged | **PASS (local)** |

## P17 §15 verification ledger

| §15 evidence family | Evidence now | State / remaining proof |
|---|---|---|
| 29 endpoint/schema/route/client/docs equality | `web-presentation.test.ts`, `check:web-protocol-docs` | **PASS (local)** |
| Request/success/error/union codec round trips | `web-compatibility.test.ts` freezes 13 additive roots; 9 command requests, 9 action request bases, 18 available/unavailable actions, 5 outcomes, 10 page cursors, 4 SSE frames, 29 endpoint samples, every `ControlError` code, and every recursively reachable nested union branch. The real packaged pair report binds two distinct stamped commits and manifests and passes both old/new directions. | **PASS (local)** for executable vectors plus the first immutable packaged pair; final reviewed-tip evidence remains separate |
| Server/browser projection and import boundary | Projection goldens, producer/consumer tests, browser-safe import guard | **PASS (local)** for committed 14-state fixture set |
| Task/verification/decision/failure state space | Executable schema accepts exactly 13 reachable RunStatus/RunStage pairs and rejects all other 50 pairs plus every inverse stopping flag; property tests cover all 92 reachable Task × verification × authority × decision-disposition interactions, 8 decision classes, every verification reason/check/outcome, and the 720 failure action-gate combinations | **PASS (local)** for the factorized closed projection state space |
| Refresh epoch/resource stamp reducer | 96 state/event reducer transitions, disconnect/reset/principal de-duplication, epoch overflow, and 816 observation gate/message combinations; packaged browser proves identical live-task and stopped-task projection over SSE and polling | **PASS (local)** |
| Content catalogs and Simple vocabulary | 149 projected + 188 static = 337 exact bilingual keys; whole-message formatter and static-copy lint. Attention explanations are structured catalog messages; Simple does not render raw attention kind/disposition/recovery or store vocabulary. | **PASS (local)** |
| Reference fixture binding | Nine families / 14 states; source, projection, file and catalog digests | **PASS (local)** |
| Real rendered reference evidence | 144 matrix renders + 5 supplemental renders, all hash-bound; no document horizontal overflow | **PASS (local)** |
| Automated accessibility evidence | 36 representative `en`/`zh-CN`, desktop/320px renders assessed; zero serious/critical axe violations recorded | **PARTIAL** — human accessibility/product review is not replaced by axe |
| Cursor authenticity and binding | Known-answer vector, tamper, cross-kind, size, TTL, clock rollback and page authorization/snapshot binding; one event-cursor matrix covers handler restart, query, principal authorization, listener identity, key rotation, visible mounts and compaction, and runs in the pinned Node matrix | **PASS (local)** for the frozen cursor binding and invalidation contract |
| Pagination continuity and byte budgets | Endpoint-owned metadata enumerates all 10 paged surfaces. Each executable request maximum equals its response-array maximum; every surface passes empty/exact-byte, single, N/N+1 full-envelope, last-returned-key continuation, concatenate-all-pages, oversized-element and strict response-schema cases; real projects/runs/graph/timeline/attempt/artifact/Receipt page tests also pass | **PASS (local)** for the registered pagination contract |
| Lost command response/idempotency | Command service restart/query/idempotency tests; browser recovery fixtures; packaged live cancel and approval. Approve marks the durable command decision independently from Run execution, reloads the original BoundPlan and digest-verified continuation after writer restart, preserves settled Attempts/outputs, consumes one approval boundary, and issues a Receipt only after downstream completion. Startup fixtures recover project-only, coordinator-bound, approval-decided and command-settled `running/queued` prefixes exactly once; an interrupted `running/executing` provider boundary fails closed as unknown without replay. Missing/corrupt checkpoints remain accepted+unknown with no Receipt. | **PASS (local)** for every command advertised by the packaged default; optional edit/recovery/capacity commands retain separate gates |
| Launch/session/Host/Origin/CSRF | One-time launch, expiry, capacity consumption, session bounds, hostile Host/DNS-rebinding/cross-port cases, duplicate Host, wrong Origin/Fetch Metadata, exact JSON media type, CSRF, CORS/OPTIONS and logout/revocation; one browser context exchanges independent launch capabilities on two nonce-host listeners and proves cookie/token isolation; raw tests reject duplicates for every singleton security header plus obs-fold, NUL values and invalid names | **PASS (local)** for the frozen loopback session and request-header contract |
| Low-level HTTP limits | Explicit Node limits plus raw-socket duplicate CL, CL/TE ambiguity, malformed chunk/transfer coding, 64-header application cap with a cross-version parser sentinel, header-byte overflow, malformed parser input, Expect, Upgrade, 404/405/Allow, static HEAD, application-owned slow-body timeout/408/close, 30-second handler deadline, real client-disconnect cancellation and bounded keep-alive connection rotation; the same 62-test subset passes on pinned Node 22.19.0, 24.18.0 and 26.5.0 | **PASS (local)** for the frozen HTTP limits and lifecycle contract |
| SSE | Signed checkpoint/resume, conflicting cursor rejection, CR/LF/NUL line-injection rejection before headers, frame schema/budget, heartbeat, four-stream cap, explicit 256-frame/1-MiB queue overflow → one reset → close, handler restart, compaction reset, session revocation, real absolute-session socket expiry, and a paused real TCP consumer that proves bounded overflow/capacity release; packaged browser tests prove SSE/polling-equivalent live and stopped Task detail and real three-second polling refetch for every current GET query surface | **PASS (local)** for the frozen SSE and polling-fallback contract |
| Artifact and Receipt export delivery | Current Receipt reachability, pre-header content-addressed artifact snapshot digest/length, source-tamper rejection, all redaction classes, full inline MIME allowlist and denied MIME downgrade, exact 5-MiB inline/100-MiB download boundaries, bidi/traversal/control-safe disposition, sensitive acknowledgement, Range rejection, 64 KiB backpressure writes, 30-second no-progress abort, real transport abort, exact 100-MiB loopback transport with byte/digest equality, and exact production five-minute deadline. Receipt JSON export re-reads all byte-budgeted manifest pages, rejects identity drift, cursor loops, missing/duplicate/reordered/out-of-range events and count mismatch, serializes a versioned deterministic document, and downloads that exact file in Chromium, Firefox and WebKit. | **PASS (local)** for artifact transport and Receipt export consistency; export checking does not replace authoritative journal/artifact verification |
| Static application delivery | Signed manifest, mixed-build/keyset rejection, unsorted/unknown/tampered/source-map package rejection, exact route registry, cache/MIME/CSP/HEAD and absent/multiple/wildcard/quality-zero/malformed `Accept`; one-decode canonical path corpus covers encoded separators/dot segments, double encodings, malformed/overlong UTF-8, controls/bidi, Unicode normalization and case; packaged-filesystem corpus covers root/manifest/entrypoint/leaf/parent symlinks, directories, escaping paths, duplicate assets/routes/catalog paths, unlisted files and map probes; the browser E2E loads the manifest-bound multi-chunk production build under the exact CSP | **PASS (local)** for the frozen static-delivery contract |
| Authority/provenance | Real ControlStore/Coordinator read-service tests and the multi-project packaged path; a real `expand` Run atomically journals the immutable BoundFragment body, Run-scoped link/causation/commit provenance, dynamic NodeInstances and Receipt hash, then proves directory-loss recovery plus detail/fragment/graph/timeline handlers. Provider evidence covers checkpointed `running` and `completed`, failed collection, rejection without a handle, settled cancellation, authoritative ambiguous reconcile, checkpoint-write failure, completion recovered without a terminal Attempt checkpoint, and projection-loss recovery. Approval evidence covers restart, all four pre-dispatch saga prefixes, post-dispatch ambiguity, repeated-recovery idempotency, multiple boundaries, providerless approval Attempts, pre-boundary non-replay, corrupt-artifact fail-closed behavior, secret artifact inspection and non-Receipt/browser reachability. Node enrichment reaches all five closed outcomes; Receipt provenance reaches both `ok` and conservative `unknown`. | **PASS (local)** for the implemented provider, approval and provenance contract |
| Performance and large-data behavior | The production builder enforces the 220-KiB-gzip Simple-shell ceiling; CSP-compatible task segmentation and graph paging are exercised by `scripts/bench-web.mjs` over the deterministic 100-project/10,000-run/2,000-node fixture. Immutable commit `7e555c7d7f39109ee89a502f0d818cc34f1ce7fa`, source digest `sha256:97076ba3daf5d08a405515cb89132f610a9b4fd04f7307d3b04d6e5123dc3e1c`, has a checked-in schema-v4 Node 24.18.0/M3 Pro 30-sample clean-source `structural-pass`: 209,410-byte Simple shell; cold Home p95 1,137.5 ms; warm Home p95 918.5 ms; cached Pro p95 50.3 ms; committed event→painted detail p95 178.1 ms (commit→receipt 78.3 ms, receipt→paint 105.3 ms diagnostics); 6.7-ms list response; CLS 0.0805; all 10,000 task rows and 2,000 graph nodes; zero CSP/runtime-style findings. JSON and human summaries retain owner-ready and launch-to-useful p95 at 8.779 s and 9.772 s rather than hiding startup. The report verifies `git.dirty:false`, exact primary Node version, AC power and no recorded thermal/performance warning, but also records high pre-run load 9.75/8.42/7.44. | **PARTIAL** — the immutable 30-sample implementation/methodology is green locally, but the high-load M3 Pro run is non-canonical and informational; the required unloaded canonical M2/Node 24 run and percentile sign-off remain absent |
| Packaged browser path | Built packages → CLI → daemon → multi-project WebGateway → browser; independent cross-port listeners, SSE, live/stopped polling projection equivalence, every current GET polling query surface, live cancel, restart-safe contextual approval, downstream execution and Receipt, private-checkpoint non-reachability, Receipt/artifact plus deterministic JSON export, zero-write/zero-provider replay, Pro graph/timeline/evidence, React Aria tabs/disclosure/alert-dialog/listbox and single-selection relations, Simple → Pro focus restoration, keyboard selection, graph arrow-navigation/inspector parity, modal focus containment/Escape/trigger restoration, settings switch semantics, current-session logout isolation, listener-wide revoke-all invalidation of an independent peer session, 320px and Chromium axe | **PASS (local)** for the representative complete path on Chromium, Firefox, WebKit and native Chrome; native Safari separately covers read/keyboard plus allow, reject, cancel, current-session, revoke-all and peer-invalidation smokes, while assistive-technology matrices remain |
| Packaged browser engines | The approval-enhanced packaged candidate passes Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 from the same source state, each on its first matrix attempt with zero application console/page errors, CSP violations, runtime style insertions, final inline styles or runtime style elements. All three pass Receipt export, zero-write/zero-provider replay, graph-listbox keyboard parity, current-session logout and listener-wide peer-session revocation. Firefox records six explicitly classified EventSource navigation-interruption diagnostics; they are transport diagnostics, not application console failures. Native Google Chrome 150.0.7871.184 passes the same complete packaged path and Chromium axe checks. Native Safari 26.3 on macOS 26.3 has independently recorded packaged read/keyboard and four scoped mutation smokes: allow/revoke-all and reject/current-session on immutable `d8df9c65`, cancel on `794c85f8`, and peer invalidation on final source `7e555c7d`. Cancel proves the live node settles as stopped instead of remaining active. Peer invalidation proves a Safari target transitions to the localized session-ended screen after an independent authenticated P17 client revokes all sessions; it does not claim an unlocked Safari private-window actor. Every passing hold verifies listener close. | **PARTIAL** — Playwright's three-engine matrix, native Chrome and the scoped native Safari smokes pass locally; Edge, VoiceOver and the remaining assistive-technology/manual matrices remain |
| Native browser and assistive-technology review | A frozen ten-task protocol and checked no-evidence result template cover native Safari/Chrome + VoiceOver, Edge + Narrator, Firefox + NVDA, and Edge forced colors. The native Safari AX smoke is separately scoped and cannot populate a VoiceOver lane. | **EXTERNAL BLOCKER** — all five native/AT lanes remain `not-run` |
| Five fresh English participants | Frozen nine-task protocol, checked participant/summary templates, native-browser review hold and 149-render local gallery exist | **EXTERNAL BLOCKER** — zero participant records |
| Native Simplified-Chinese content review | Complete key parity/render matrix and a checked per-reviewer template covering all 337 keys, nine screen families and 149 renders exist | **EXTERNAL BLOCKER** — zero of two reviewer attestations |
| Human reference approval | All render bytes/hashes, nine screen specifications, a 149-card local gallery and a checked no-evidence approval template are ready | **EXTERNAL BLOCKER** — manifest remains `draft-unapproved` |

## Latest local verification

The following commands exited 0 on 2026-07-24:

```text
pnpm verify:web-candidate  # exact tip 0ed4230547a983ba1235a06c1afa040d821ea510
pnpm check:web-protocol-docs
pnpm check:web-cursor-vector
pnpm check:web-reference-fixtures
pnpm check:web-content
pnpm check:web-render-evidence
pnpm check:web-usability-materials
pnpm typecheck
pnpm test:web
pnpm test:cli
pnpm test:control
pnpm test:daemon
pnpm test:web-node-matrix
pnpm test:web-browser-matrix
npx --yes node@24.18.0 scripts/test-web-packaged-compatibility.mjs --old-root <d8df9c65-build> --new-root <7e555c7d-build> --output artifacts/web-compat/d8df9c65-to-7e555c7d/report.json
pnpm test
pnpm test:pack
node packages/taskflow-cli/test/e2e-web-console.mts
npx --yes node@24.18.0 scripts/bench-web.mjs
git diff --check
```

`pnpm verify:web-candidate` is the single reproducible aggregate gate for the
protocol/content/evidence checks, typecheck, full unit suite, packed-package
smoke, build and packaged browser E2E. `git diff --check` remains a separate
working-tree check.

Observed counts:

- control tests: 190/190;
- daemon tests: 35/35;
- full unit suite: 2296/2296;
- pinned Node matrix: 62/62 on each of 22.19.0, 24.18.0 and 26.5.0;
- packaged smoke: 12 packages, 27 explicit imports, 68 wildcard exports and
  package bins;
- reference renders: 149 total, 36 axe-assessed;
- immutable compatibility: two distinct stamped commits and asset manifests,
  both old-client/new-server and new-client/old-server pass with zero
  application console/page errors;
- packaged browser: the approval-enhanced source state passes Chromium
  149.0.7827.55, Firefox 151.0 and WebKit 26.5 on the first attempt of each
  matrix lane, with zero application console/page errors, CSP violations,
  runtime style insertions, final inline style attributes or runtime style
  elements. Firefox records six classified EventSource navigation-interruption
  diagnostics and no application error. Chromium axe reports zero violations
  on Home and Pro Task, and every engine proves that the 320 CSS-pixel viewport
  has no horizontal overflow. Every engine also downloads and parses the
  deterministic Receipt JSON export after the client-side exact-manifest
  consistency check, executes zero-write/zero-provider replay and proves that
  arrow-key graph-listbox selection updates the visual node inspector. Each
  engine also commits current-session logout without revoking another session,
  then commits listener-wide revocation and observes an independent peer
  session lose authorization. Native Google Chrome 150.0.7871.184 passes the
  same complete path and axe checks. Native Safari 26.3 on macOS 26.3 passes
  the separately scoped read/keyboard, allow/revoke-all,
  reject/current-session, cancel and peer-invalidation smokes recorded in
  `native-safari-smoke-v1.json` and the four mutation records. All explicitly
  exclude VoiceOver and automated console/CSP evidence. The peer-invalidation
  record uses native Safari as the revoked target and an independent P17 HTTP
  session as the mutation actor; it does not claim a two-Safari-cookie-jar
  usability pass.

The production WebUI build is successful without a chunk-size warning. Stable
TypeBox, React runtime, TanStack, React Aria and icon dependency boundaries
reduce the largest minified chunk to 191.20 kB and the entry chunk to 155.96
kB. The production asset builder measures the modulepreloaded Simple shell at
209,410 gzip bytes (204.50 KiB) and fails above the RFC's 220-KiB budget; the
Pro panel remains a separate lazy chunk. The packaged browser E2E loads this
exact manifest-bound split build rather than a Vite development server.

## Freeze decision

The implementation is ready for targeted human review and continued
adversarial/compatibility hardening. It is **not** ready for a P17 wire-freeze
claim because the external comprehension/content gates, canonical 30-sample
performance evidence, native Edge/AT review, reviewed-tip
evidence, and the remaining PARTIAL §15 matrices above are not complete.
Capability-gated writes that are absent and unadvertised do not block beta.2
by themselves.
