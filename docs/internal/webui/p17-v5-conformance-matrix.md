# P17 v5 implementation conformance matrix

Status: candidate evidence ledger; **the current source is rerendered and has
current packaged Chromium evidence, but is not Conforming and is not
wire-frozen**.

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
| Executable codecs | Every row owns TypeBox params/query/body/success schemas; producer DTOs are closed; committed vectors cover the 13 approved additive roots, all command/action/outcome/page-cursor/SSE branches, all 29 endpoint samples, every error code, and recursively validate 39,707 branches across 2,225 nested union occurrences. `scripts/test-web-packaged-compatibility.mjs` rejects identical asset or commit identities, waits for a successful bootstrap response, and cross-runs real browser assets plus gateway/control modules in both directions. Historical build `aa34369a5958ce34bbdad3eab973434a001d0738` and current build `4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2` pass old-client/new-server and new-client/old-server with Web v1 bootstrap and zero console/page errors; the schema-v2 report is checked in at `artifacts/web-compat/aa34369a-to-4c2b83c0/report.json`. The evidence checker rejects a non-descendant evidence tip or production/benchmark source drift after the new build. | **PASS (local)** for current codecs and current-source packaged compatibility; reviewed-tip rerun remains a freeze gate |
| Authority handlers | All 29 gateway route slots are composed from session/bootstrap, 19 read handlers, analysis, artifact, replay, command and event services. Approve/reject delegate to P15 ControlHost CAS; approve reloads the exact private checkpoint and original BoundPlan rather than introducing a Web-owned scheduler. Reject and expiration terminalize the matching durable approval NodeInstance as blocked while leaving downstream nodes pending, so browser step state cannot contradict Run authority. A claimed command whose exact home authority is currently unmounted fails as a typed durability/recovery error rather than “not found” or cross-project fallback. | **PASS (local)** for route/service and enabled approval authority coverage |
| Default capability truth | Packaged bootstrap advertises `approve`, `reject` and `cancel-run`; executable ControlHost, HTTP and packaged-browser evidence covers all three. Edit/recovery/capacity mutations remain unadvertised by default. | **PASS (local)** |
| Pro read surfaces | Graph, node detail, attempts, timeline, artifacts, Receipt, why-stale, replay and fragments use generated P17 client calls | **PASS (local)** |
| Durable command recovery | Command id/body are retained byte-identically in-tab; ambiguous response checks durable outcome first; reload never invents a request body. The coordinator atomically claims each listener-global Web command id with one authority, principal, and the same canonical request-hash helpers consumed by ControlHost/Coordinator authority; parity vectors plus sequential and simultaneous cross-project collision tests prove one unambiguous winner. | **PASS (local)** for client/service/authority fixtures |
| Session operations | Current-session logout and listener-wide revocation are explicit, CSRF-protected and explain that execution state is unchanged. Launch exchange is a fragment-stripping in-memory single flight: development StrictMode effect replay performs one exchange and cannot reuse the single-use capability. | **PASS (local)** |

## P17 §15 verification ledger

| §15 evidence family | Evidence now | State / remaining proof |
|---|---|---|
| 29 endpoint/schema/route/client/docs equality | `web-presentation.test.ts`, `check:web-protocol-docs` | **PASS (local)** |
| Request/success/error/union codec round trips | `web-compatibility.test.ts` freezes 13 additive roots; 9 command requests, 9 action request bases, 18 available/unavailable actions, 5 outcomes, 10 page cursors, 4 SSE frames, 29 endpoint samples, every `ControlError` code, and every recursively reachable nested union branch. The real packaged pair report binds two distinct stamped commits and manifests and passes both old/new directions. | **PASS (local)** for executable vectors plus the first immutable packaged pair; final reviewed-tip evidence remains separate |
| Server/browser projection and import boundary | Projection goldens, producer/consumer tests, browser-safe import guard | **PASS (local)** for committed 14-state fixture set |
| Task/verification/decision/failure state space | Executable schema accepts exactly 13 reachable RunStatus/RunStage pairs and rejects all other 50 pairs plus every inverse stopping flag; property tests cover all 92 reachable Task × verification × authority × decision-disposition interactions, 8 decision classes, every verification reason/check/outcome, and the 720 failure action-gate combinations | **PASS (local)** for the factorized closed projection state space |
| Refresh epoch/resource stamp reducer | 96 state/event reducer transitions, disconnect/reset/principal de-duplication, epoch overflow, and 816 observation gate/message combinations. Exact response-object generation stamps, aborted authoritative-detail requests and disabled structural sharing prevent a late pre-invalidation response from acquiring current authority; resync refetch failures remain failures. The current packaged Chromium, Firefox, WebKit and native Chrome matrix proves identical live-task and stopped-task projection over SSE and polling. | **PASS (local)** for reducer/client fixtures and current packaged matrix |
| Content catalogs and Simple vocabulary | 168 projected + 188 static = 356 exact bilingual keys; whole-message formatter and static-copy lint. Attention, artifact disclosure, and timeline explanations are structured catalog messages; Simple does not render raw attention kind/disposition/recovery or store vocabulary. | **PASS (local)** |
| Reference fixture binding | Nine families / 14 states; source, projection, file and catalog digests | **PASS (local)** |
| Real rendered reference evidence | Render evidence v2 binds 144 matrix renders + 5 supplemental renders to tracked-clean implementation source `6f18a4eff57f1774328808cdfea22e58178555e4`, Web build `sha256:853edc81c345c5a06e105110c4f3cb0fabcfc79f0e73912f05fa636b56da624e`, and asset manifest `sha256:154fe609eb6bea194e6b241e1b3f7394ffcecbed7cf70352faf44b9eef08a9e6`. It rejects relevant source drift and requires downstream review records to name that exact candidate. All 149 screenshot bytes are retained under `artifacts/web-reference/6f18a4eff57f/`. | **PASS (local)** for exact-source rendering and automated checks; human product/content approval remains open |
| Automated accessibility evidence | 36 representative `en`/`zh-CN`, desktop/320px renders assessed; zero serious/critical axe violations recorded | **PARTIAL** — human accessibility/product review is not replaced by axe |
| Cursor authenticity and binding | Known-answer vector, tamper, cross-kind, size, TTL, clock rollback and page authorization/snapshot binding; one event-cursor matrix covers handler restart, query, principal authorization, listener identity, key rotation, visible mounts and compaction, and runs in the pinned Node matrix | **PASS (local)** for the frozen cursor binding and invalidation contract |
| Pagination continuity and byte budgets | Endpoint-owned metadata enumerates all 10 paged surfaces. Each executable request maximum equals its response-array maximum; every surface passes empty/exact-byte, single, N/N+1 full-envelope, last-returned-key continuation, concatenate-all-pages, oversized-element and strict response-schema cases. A 205-event durable Receipt proves its core remains bounded to a 200-id preview while exact count/digest and all three event pages concatenate without loss. Real projects/runs/graph/timeline/attempt/artifact/Receipt page tests also pass. | **PASS (local)** for the registered pagination contract |
| Lost command response/idempotency | Command service restart/query/idempotency tests; browser recovery fixtures; packaged live cancel and approval. Approve marks the durable command decision independently from Run execution, reloads the original BoundPlan and digest-verified continuation after writer restart, preserves settled Attempts/outputs, consumes one approval boundary, and issues a Receipt only after downstream completion. Startup fixtures recover project-only, coordinator-bound, approval-decided and command-settled `running/queued` prefixes exactly once; an interrupted `running/executing` provider boundary fails closed as unknown without replay. Missing/corrupt checkpoints remain accepted+unknown with no Receipt. | **PASS (local)** for every command advertised by the packaged default; optional edit/recovery/capacity commands retain separate gates |
| Launch/session/Host/Origin/CSRF | One-time launch, pre-I/O fragment removal, StrictMode/remount single-flight exchange, expiry, capacity consumption, session bounds, hostile Host/DNS-rebinding/cross-port cases, duplicate Host, wrong Origin/Fetch Metadata, exact JSON media type, CSRF, CORS/OPTIONS and logout/revocation; one browser context exchanges independent launch capabilities on two nonce-host listeners and proves cookie/token isolation; raw tests reject duplicates for every singleton security header plus obs-fold, NUL values and invalid names | **PASS (local)** for the frozen loopback session and request-header contract |
| Low-level HTTP limits | Explicit Node limits plus raw-socket duplicate CL, CL/TE ambiguity, malformed chunk/transfer coding, 64-header application cap with a cross-version parser sentinel, header-byte overflow, malformed parser input, Expect, Upgrade, 404/405/Allow, static HEAD, application-owned slow-body timeout/408/close, 30-second handler deadline, real client-disconnect cancellation and bounded keep-alive connection rotation; the same 63-test subset passes on pinned Node 22.19.0, 24.18.0 and 26.5.0 | **PASS (local)** for the frozen HTTP limits and lifecycle contract |
| SSE | Signed checkpoint/resume, conflicting cursor rejection, CR/LF/NUL line-injection rejection before headers, frame schema/budget, heartbeat, four-stream cap, explicit 256-frame/1-MiB queue overflow → one reset → close, handler restart, compaction reset, session revocation, real absolute-session socket expiry, and a paused real TCP consumer that proves bounded overflow/capacity release; packaged browser tests prove SSE/polling-equivalent live and stopped Task detail and real three-second polling refetch for every current GET query surface | **PASS (local)** for the frozen SSE and polling-fallback contract |
| Artifact and Receipt export delivery | Current Receipt reachability, pre-header content-addressed artifact snapshot digest/length, source-tamper rejection, all redaction classes, projected direct/acknowledgement/blocked disclosure, explicit sensitive acknowledgement header, secret-action absence, success redaction header, listener-wide pessimistic 100-MiB in-flight byte permit, direct `Uint8Array` hashing without a second full-body copy, MIME/sanitized filename/disposition policy, Range rejection, backpressure/abort/deadline controls, and prior exact 100-MiB transport evidence. Receipt JSON export re-reads all byte-budgeted manifest pages and rejects identity, preview, count, digest, ordering, commit-range, cursor-loop or non-progress drift before deterministic export. Every current packaged browser lane proves that declining the sensitive dialog sends no acknowledgement or download and confirming sends the exact acknowledgement and succeeds; the reference renderer proves the secret-blocked UI has no download action. | **PASS (local)** for schema/transport/gateway fixtures and current packaged UI interaction |
| Static application delivery | Signed manifest, mixed-build/keyset rejection, unsorted/unknown/tampered/source-map package rejection, exact route registry, cache/MIME/CSP/HEAD and absent/multiple/wildcard/quality-zero/malformed `Accept`; one-decode canonical path corpus covers encoded separators/dot segments, double encodings, malformed/overlong UTF-8, controls/bidi, Unicode normalization and case; packaged-filesystem corpus covers root/manifest/entrypoint/leaf/parent symlinks, directories, escaping paths, duplicate assets/routes/catalog paths, unlisted files and map probes; the browser E2E loads the manifest-bound multi-chunk production build under the exact CSP | **PASS (local)** for the frozen static-delivery contract |
| Authority/provenance | Real ControlStore/Coordinator read-service tests and the multi-project packaged path; a real `expand` Run atomically journals the immutable BoundFragment body and Run-scoped link/causation/commit provenance, then executes each descendant through its real provider, persists the dynamic NodeInstance/Attempt identity, blocks parent success/Receipt on descendant failure, survives a later approval restart without replay or duplicate linking, and proves directory-loss recovery plus detail/fragment/graph/timeline handlers. Provider evidence covers checkpointed `running` and `completed`, owning-provider routing, AbortSignal cancellation that settles only after the host runner exits, failed collection, rejection without a handle, authoritative ambiguous reconcile, checkpoint-write failure, completion recovered without a terminal Attempt checkpoint, and projection-loss recovery. Standalone read caching probes the exact current project watermark even without a registry resolver. Approval evidence covers restart, all four pre-dispatch saga prefixes, post-dispatch ambiguity, repeated-recovery idempotency, multiple boundaries, providerless approval Attempts, pre-boundary non-replay, corrupt-artifact fail-closed behavior, secret artifact inspection and non-Receipt/browser reachability. Node enrichment reaches all five closed outcomes; Receipt provenance reaches both `ok` and conservative `unknown`. | **PASS (local)** for the implemented provider, approval and provenance contract |
| Performance and large-data behavior | The production builder enforces the 220-KiB-gzip Simple-shell ceiling; CSP-compatible task segmentation and graph paging are exercised by `scripts/bench-web.mjs` over the deterministic 100-project/10,000-run/2,000-node fixture. Current immutable build `4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2`, source digest `sha256:6ca56cddda7ff711b41e16c23d8c1970d0fcfc1fb9c6d3b5110181843f2b0182`, has a checked-in schema-v4 Node 24.18.0/M3 Pro 30-sample clean-source `structural-pass`: 211,426-byte Simple shell; cold Home p95 628.1 ms; warm Home p95 558.8 ms; cached Pro p95 26.5 ms; committed event→painted detail p95 160.0 ms (commit→Receipt 73.4 ms, Receipt→paint 102.4 ms diagnostics); 23.6-ms list response; CLS 0.0690; all 10,000 task rows and 2,000 graph nodes; zero CSP/runtime-style findings. JSON and human summaries retain owner-ready and launch-to-useful p95 at 5.550 s and 6.409 s rather than hiding startup. The report verifies `git.dirty:false`, exact primary Node version, AC power and no recorded thermal/performance warning, while also disclosing elevated host load. | **PARTIAL** — structural, bundle, CSP and layout checks pass and the non-canonical event→visible observation is below the nominal 250-ms budget, but this remains a non-canonical M3 Pro run. The required unloaded canonical M2/Node 24 run and percentile sign-off remain absent |
| Packaged browser path | Built packages → CLI → daemon → multi-project WebGateway → browser; independent cross-port listeners, SSE, live/stopped polling projection equivalence, every current GET polling query surface, live cancel, restart-safe contextual approval, downstream execution and Receipt, private-checkpoint non-reachability, Receipt/artifact plus deterministic JSON export, sensitive artifact decline/acknowledged download, zero-write/zero-provider replay, Pro graph/timeline/evidence, React Aria tabs/disclosure/alert-dialog/listbox and single-selection relations, Simple → Pro focus restoration, keyboard selection, graph arrow-navigation/inspector parity, modal focus containment/Escape/trigger restoration, settings switch semantics, current-session logout isolation, listener-wide revoke-all invalidation of an independent peer session, 320px and Chromium axe | **PASS (local)** for the current immutable source/build across Chromium, Firefox, WebKit and native Chrome |
| Packaged browser engines | Current immutable packaged/evidence build `4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2` passes Chromium 149.0.7827.55, Firefox 151.0, WebKit 26.5 and native Chrome 150.0.7871.184 from byte-identical production assets, each on its first attempt with zero application console/page errors, CSP violations, runtime style insertions, final inline styles or horizontal overflow. The schema-v4 report binds the exact two-file executable browser harness. All four lanes pass Receipt export, zero-write/zero-provider replay, graph-listbox keyboard parity, current-session logout, listener-wide peer-session revocation and the sensitive-artifact decline/acknowledgement contract. Firefox records six explicitly classified EventSource navigation-interruption diagnostics; they are transport diagnostics, not application console failures. Chromium and native Chrome pass the same axe checks. Native Safari 26.3 evidence is being refreshed against the same current-source commit before the candidate checker can pass. | **PARTIAL** — the current exact-source Playwright three-engine matrix and native Chrome pass; current-source Safari refresh, Edge, VoiceOver and the remaining assistive-technology/manual matrices remain |
| Native browser and assistive-technology review | A frozen ten-task protocol and checked no-evidence result template cover native Safari/Chrome + VoiceOver, Edge + Narrator, Firefox + NVDA, and Edge forced colors. Every lane now records its independent reviewer plus a decision and observed spoken/focus behavior for each task; a null checkbox alone cannot become evidence. The native Safari AX smoke is separately scoped and cannot populate a VoiceOver lane. | **EXTERNAL BLOCKER** — all five native/AT lanes remain `not-run` |
| Five fresh English participants | The exact seven RFC §19.4 tasks, 30/60/90-second limits, permitted neutral prompts, consent/privacy text, two isolated native-browser holds, eight closed severity-1 classes, participant/summary templates and 149-render gallery are frozen. `verify-web-human-evidence.mjs` recomputes the 4/5 task/action gates, rejects any severity-1 finding, binds every record digest and has a generated passing/negative self-test. | **EXTERNAL BLOCKER** — zero participant records |
| Native Simplified-Chinese content review | Complete key parity and checked reviewer materials cover 168 projected + 188 static = 356 keys. The verifier requires one independent native `content-ux` and one `technical-safety` approval bound to exact render candidate `6f18a4ef` and its catalog/render hashes. | **EXTERNAL BLOCKER** — both reviewer attestations remain absent |
| Human reference approval | Nine screen specifications, the exact-source 149-render gallery, and checked no-evidence approval materials exist. The verifier binds product-owner review to exact v2 render candidate `6f18a4ef` rather than accepting an ancestor. | **EXTERNAL BLOCKER** — manifest remains `draft-unapproved` and no product-owner approval exists |

## Latest local verification

The current evidence chain separates the reference-render source from the
newer packaged/matrix/benchmark source:

- exact-source reference-render build:
  `6f18a4eff57f1774328808cdfea22e58178555e4`;
- current tracked-clean packaged/matrix/benchmark source:
  `4c2b83c09e0b222cbee5959bb5eb53b1e8c862c2`.

The previous evidence tip passed `pnpm verify:web-candidate`. The exact current
source has separately passed the protocol/control regressions, typecheck, full
build, pinned Node matrix, packaged four-browser matrix, compatibility pair and
30-sample benchmark. The final aggregate candidate command remains pending
until all current-source native Safari records and their ledger hashes have
been refreshed:

```text
pnpm verify:web-candidate
pnpm test:control
pnpm test:daemon
git diff --check
```

The following evidence producers also exited 0 against the exact immutable
render/matrix build or its bound implementation source:

```text
pnpm test:web-node-matrix
pnpm test:web-browser-matrix-native
npx --yes node@24.18.0 scripts/bench-web.mjs --reuse-fixture
TASKFLOW_WEB_REFERENCE_OUTPUT_ROOT=artifacts/web-reference/6f18a4eff57f pnpm render:web-reference
```

The schema-v2 compatibility report additionally cross-ran historical
`aa34369a` and current build `4c2b83c0` under Node 24.18.0. The candidate
checker explicitly classifies the older native Safari records as
historical-only and requires every current-source Safari record to bind the
same source digest, manifest and Web build. The retained 30-sample benchmark
rerun is `structural-pass` and discloses its non-canonical machine plus elevated
host load.

Observed counts:

- control tests: 203/203;
- daemon tests: 36/36;
- full unit suite: 2324/2324;
- pinned Node matrix: 63/63 on each of 22.19.0, 24.18.0 and 26.5.0;
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
  same complete path and axe checks. Every current lane also proves sensitive
  artifact disclosure, zero request/acknowledgement on decline, and the exact
  acknowledgement plus successful download on confirm. Native Safari 26.3
  additionally passes current-source Simple/Pro read, graph keyboard,
  evidence, approval Allow/Reject, cancel, current-session logout and
  listener-wide revoke-all scoped paths, including a normal/private
  two-cookie-jar peer invalidation under one listener. Those records do not
  claim VoiceOver, console/CSP/axe automation or human approval.

The production WebUI build is successful without a chunk-size warning. Stable
TypeBox, React runtime, TanStack, React Aria and icon dependency boundaries
reduce the largest minified chunk to 191.20 kB and the entry chunk to 163.93
kB. The production asset builder measures the modulepreloaded Simple shell at
211,426 gzip bytes (206.47 KiB) and fails above the RFC's 220-KiB budget; the
Pro panel remains a separate lazy chunk. The packaged browser E2E loads this
exact manifest-bound split build rather than a Vite development server.

## Freeze decision

The implementation is ready for targeted human review and continued
adversarial/compatibility hardening. It is **not** ready for a P17 wire-freeze
claim because the external comprehension/content gates, canonical 30-sample
performance evidence, native Edge/AT review, reviewed-tip
evidence, and the remaining PARTIAL §15 matrices above are not complete.
The current non-canonical M3 Pro run measures event-to-visible p95 at
160.0 ms, below the nominal 250-ms target, but it is still not presented as a
release performance pass because the canonical machine and unloaded-run
conditions are absent.
Capability-gated writes that are absent and unadvertised do not block beta.2
by themselves.
