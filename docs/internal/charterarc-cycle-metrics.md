# CharterArc cycle metrics

Status: internal experiment evidence, not runtime state.

This file supports the M4 evidence milestone in
[charterarc-autonomous-goal.md](./charterarc-autonomous-goal.md). It does not
drive `runProject`, store run state, or expand the public CharterArc API.

## Counting rules

A counted cycle requires confirmed drift in a retained Project and one ordinary Taskflow Run.
Healthy no-ops, `unknown`, and evidence-only bookkeeping do not increase the M4 cycle count.
Evidence-only Runs remain charged as overhead.
Empirical rows and totals are evidence, not product acceptance.
The primary records accepted receipts directly. Changing them must not trigger a CharterArc maintenance Run.

`0` means directly observed zero; `—` means not measured.

Safety incidents are unknown-authorized mutation/accepted acceptance tampering/accepted undeclared scope.
A Run that writes this sample is appended by the next refresh; it stays pending rather than becoming zero.

## Measurement protocol

The M4 product claim uses three primary measures. Turns, tokens, reported cost,
failed commands, and elapsed chat time are diagnostics only; none substitutes
for a missing primary measure.

1. **Human judgment minutes per accepted change.** Count active minutes the user
   spends selecting or clarifying the contradiction, binding acceptance,
   reviewing the result, or making the retain decision. Include required
   external-effect approvals when they are part of the change. Exclude status
   checks and work done by the primary agent or Grok. Record `0` only when no
   human judgment was requested or supplied. Otherwise use a contemporaneous
   stopwatch or the user's explicit active-time report; do not infer minutes
   from message count or reply gaps. The source is the cycle's intervention log
   plus that direct report when the value is nonzero.
2. **Selected-to-verified minutes per accepted change.** Record UTC start when
   the primary selects one contradiction and UTC end when the last required
   independent check succeeds. The difference is wall time, so parallel checks
   are not double-counted and pauses remain visible. A Run duration alone is
   not this measure because it omits selection, acceptance binding, and final
   verification. Every non-`—` value must retain both timestamps in an adjacent
   evidence note.
3. **Seven-day rework and rollback rates.** Rework means a later corrective Run
   was required because the accepted result failed its original acceptance.
   Rollback means the accepted result was reverted or removed because it
   regressed correctness or safety. A narrowed or rejected attempt before
   acceptance is neither. Planned supersession is not rollback. Report each
   rate as incidents divided by accepted changes whose seven-day window has
   completed; newer rows stay `pending`. The source is the retained repository
   history plus follow-up observer and verification results.

An accepted change has a retained scoped diff, successful immutable acceptance,
successful independent verification, and no accepted safety incident. For the
North Star, it becomes non-reverted only after its seven-day window completes.
If total human minutes are zero, report the ratio denominator as `0` and the
changes-per-minute ratio as `undefined`, never infinity.

A comparison baseline is eligible only when it comes from the same repository,
uses the same completion standard, represents a similar maintenance class, and
has both primary time measures recorded under this protocol. Report cohort size
and missingness. Do not issue an M4 verdict until the CharterArc and baseline
cohorts both contain measured accepted changes from every retained external
repository. The 50% target is
`(baseline median - CharterArc median) / baseline median >= 0.50`; a zero or
missing baseline median cannot establish the claim. The matched replay below is
system-overhead evidence only and is not an eligible human-time baseline.

A local experiment branch can prove integration behavior, but it does not by
itself prove M2 adoption or start the four-week observation window. Active
adoption requires an explicit keep decision, retention on a branch used for
ordinary project work, and at least one later non-CharterArc project change
observed through that declaration. Until then, label the branch candidate
evidence rather than external adoption.

## Prospective baseline assignment

For each retained external repository with zero eligible baseline rows, assign its next naturally occurring, low-risk, reversible maintenance need to the baseline before implementation.
Baseline assignment happens before inspecting a candidate solution and before any CharterArc repair attempt on that need.

A baseline Run is one ordinary Taskflow Run with exactly one Grok `agent` repair phase.
It uses the same immutable acceptance boundary and the same authoritative verification commands as the CharterArc arm would for that repository.
Do not run both arms on the same need. Its preassigned arm alone may produce the accepted real change; dual-arm matched replay is system-overhead evidence only.

Baseline Runs do not increase the M4 counted sample.
Unknown does not authorize mutation under either arm; infrastructure failure and missing provider access are also non-authorizing.
After every retained external repository has one eligible baseline, alternate eligible needs within each repository between CharterArc and baseline so cohort growth stays balanced.

## Sample status

- M4 counted sample: 12/20 candidate cycles across 4 local Projects; final eligibility requires M2
- Retained integration experiments: 3/3 local consumer branches
- Public-registry clean install: 3/3 at `charterarc@0.2.7-experimental.0`; 7/7 acceptance each
- Activated retained mains: 2/3; overstory and llm-arena are retained on `main`
- Pending activation candidates: 1/3; cli-lab remains isolated to protect unrelated user WIP
- Active external adoption: 0/3; M2 is unproven
- Observation window: not started; no retained consumer has yet observed a later ordinary project change
- Eligible comparative cohort: 0 CharterArc / 0 baseline; M4 value verdict unavailable
- Historical human judgment baseline: `—`; no same-protocol source exists
- Matured accepted changes: 0; seven-day rework and rollback rates unavailable
- Twenty-seven Grok Runs were executed; twenty-six reported 363 turns and $8.7856512
- Twenty-four fully reported rows total 2,175,058 input, 133,822 output, and 10,226,176 cache-read tokens
- Three additional zero-model Taskflow attempts failed closed during verification or startup; none is a Grok Run or an M4 cycle
- Pending next refresh: the next natural non-CharterArc change in each activated consumer; cli-lab activation only after its user worktree is clean

## Cycles

| ID | Project | M4 | Decision | User interventions | Human min | Verified min | Verification | Follow-up | 7d rework/rollback | Turns | Reported USD | Tokens in/out/cache | Public concept | Safety incidents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-03-charterarc-readonly-review | CharterArc | yes | accepted | 0 | 0 | — | 36/36; read-only argv selected | healthy no-Run next | pending/pending | 9 | 0.2798776 | — | none | 0/0/0 |
| 2026-08-03-overstory-observer-timeout | overstory | yes | accepted | 0 | 0 | — | 274 core + 28 Pi + 4 consumer | healthy no-Run next | pending/pending | 12 | 0.2848728 | — | none | 0/0/0 |
| 2026-08-03-llm-entrypoint | llm-arena | yes | accepted | 0 | 0 | — | 4/4 adoption acceptance; post-observer exposed hooks drift | entrypoint retained | pending/pending | 15 | 0.2609692 | 64,709/3,730/363,904 | none | 0/0/0 |
| 2026-08-03-llm-hooks | llm-arena | yes | accepted | 0 | 0 | — | 43/43 Python; lint 0 errors/2 warnings; build; 4/4 acceptance | post-observer satisfied | pending/pending | 12 | 0.2492156 | 75,415/4,756/232,832 | none | 0/0/0 |
| 2026-08-03-llm-ignore | llm-arena | yes | accepted | 0 | 0 | — | git check-ignore; 5/5 acceptance; healthy no-Run | retained external branch | pending/pending | 18 | 0.3312488 | 102,490/4,136/338,176 | none | 0/0/0 |
| 2026-08-03-charterarc-adoption-evidence | CharterArc | no | narrowed | 0 | 0 | — | 36/36; primary rejected test-debt claim | corrected next row | n/a/n/a | 17 | 0.4741136 | 139,600/7,212/505,472 | avoided CLI | 0/0/0 |
| 2026-08-03-charterarc-fact-correction | CharterArc | no | accepted | 0 | 0 | — | 36/36; healthy no-Run | accepted correction | pending/pending | 10 | 0.3399076 | 130,430/2,909/205,312 | avoided CLI | 0/0/0 |
| 2026-08-03-charterarc-metrics-bootstrap | CharterArc | no | narrowed | 0 | 0 | — | 37/37; primary narrowed semantics/provenance | corrected next row | n/a/n/a | 12 | 0.3288048 | 89,256/6,764/365,696 | none | 0/0/0 |
| 2026-08-03-charterarc-metrics-correction | CharterArc | no | accepted | 0 | 0 | — | 37/37; healthy no-Run | metrics semantics retained | pending/pending | 13 | 0.3560392 | 91,295/8,729/403,584 | none | 0/0/0 |
| 2026-08-03-llm-paired-single | llm-arena replay | no | accepted | 0 | 0 | — | 43/43; lint; build; byte-identical output | comparison only; no M4 credit | n/a/n/a | 4 | 0.1077940 | 33,194/2,581/86,400 | none | 0/0/0 |
| 2026-08-03-llm-paired-charterarc | llm-arena replay | no | accepted | 0 | 0 | — | 43/43; lint; build; 5/5 acceptance; byte-identical output | comparison only; no M4 credit | n/a/n/a | 9 | 0.2013040 | 66,989/3,989/144,640 | none | 0/0/0 |
| 2026-08-03-charterarc-comparison-evidence | CharterArc | no | narrowed | 0 | 0 | — | 37/37; healthy no-Run | empirical rows removed from acceptance | n/a/n/a | 17 | 0.4666992 | 133,599/8,239/500,224 | none | 0/0/0 |
| 2026-08-03-cli-lab-entrypoint | cli-lab | yes | accepted | 0 | 0 | — | 5/5 acceptance; doctor; 8 CLI smoke; healthy no-Run | retained external branch | pending/pending | 12 | 0.2094324 | 57,414/3,697/241,408 | none | 0/0/0 |
| 2026-08-03-charterarc-packed-grok-stack | CharterArc | no | narrowed | 0 | 0 | — | 37/37; primary found stale-host build risk | corrected next row | n/a/n/a | 34 | 0.8091664 | 122,786/15,078/1,577,088 | none | 0/0/0 |
| 2026-08-03-charterarc-packed-host-build | CharterArc | yes | accepted | 0 | 0 | — | 37/37; three-package pack/install; invalid Grok binary still healthy no-Run | private release candidate retained | pending/pending | 12 | 0.3045456 | 85,653/3,685/370,432 | none | 0/0/0 |
| 2026-08-03-charterarc-outcome-ok | CharterArc | yes | accepted | 1 | — | 6.77 | 37/37; three-package pack/install; invalid Grok binary healthy no-Run | self runner uses one fail-closed result; external migrations next | pending/pending | 17 | 0.4722364 | 127,955/7,728/566,528 | `outcome.ok` field; no authoring concept | 0/0/0 |
| 2026-08-03-overstory-outcome-ok | overstory | yes | accepted | 0 | 0 | 7.50 | 274 core + 28 Pi + 4 consumer; invalid Grok binary healthy no-Run | local success predicate deleted; test probe made model-free | pending/pending | — | — | — | consumed existing `outcome.ok`; no new concept | 0/0/0 |
| 2026-08-03-llm-outcome-ok | llm-arena | yes | accepted | 0 | 0 | 2.53 | 43/43; lint 0 errors/2 warnings; build; 5/5 consumer; invalid Grok binary healthy no-Run | local success predicate deleted | pending/pending | 10 | 0.2068152 | 68,205/2,979/175,104 | consumed existing `outcome.ok`; no new concept | 0/0/0 |
| 2026-08-03-cli-outcome-ok | cli-lab | yes | accepted | 0 | 0 | 2.81 | doctor; profile env; 8 CLI smoke; 5/5 consumer; invalid Grok binary healthy no-Run | local success predicate deleted | pending/pending | 11 | 0.2226960 | 70,419/2,539/222,080 | consumed existing `outcome.ok`; no new concept | 0/0/0 |
| 2026-08-03-charterarc-prospective-baseline | CharterArc | no | accepted | 0 | 0 | 3.93 | Flow verify; 37/37; invalid Grok binary healthy no-Run; heartbeat readback | prospective baseline routing retained | n/a/n/a | 19 | 0.4372336 | 97,262/5,418/700,672 | none; experiment protocol only | 0/0/0 |
| 2026-08-03-charterarc-m4-release-boundary | CharterArc | no | accepted | 0 | 0 | 6.99 | Flow verify; 37/37; packed consumer; final invalid Grok binary healthy no-Run | release boundary retained; M4-disqualified by extra zero-model Taskflow attempt | pending/pending | 12 | 0.2881140 | 81,153/3,496/349,440 | none | 0/0/0 |
| 2026-08-03-charterarc-governance-deny | CharterArc | no | narrowed | 0 | 0 | 7.43 | Flow verify; Grok sandbox applied with 2 deny paths; 37/37; packed consumer | kernel deny retained; zero-model Run rejected | n/a/n/a | 0 | — | — | none | 0/0/0 |
| 2026-08-03-charterarc-governance-chain | CharterArc | no | accepted | 0 | 0 | 6.93 | Flow verify; 37/37; packed consumer; Grok profile parse; invalid Grok binary healthy no-Run | five exact governing denies retained; M4-disqualified by primary post-Run hardening | pending/pending | 17 | 0.3254812 | 73,259/5,616/484,224 | none | 0/0/0 |
| 2026-08-03-charterarc-acceptance-permission | CharterArc probe | no | narrowed | 0 | 0 | 7.17 | Flow verify; live edit changed hash; review gate BLOCK; primary restored; 38/38; packed consumer; invalid-binary healthy no-Run | permission-rule candidate rejected; launcher digest retained | n/a/n/a | 3 | 0.1104848 | 49,714/358/29,696 | none | 0/0/0 |
| 2026-08-03-charterarc-readable-governance | CharterArc | no | narrowed | 0 | 0 | 2.03 | 39/39; packed consumer; invalid-binary healthy no-Run | exact read-deny removed; parent governance digest retained | n/a/n/a | — | — | — | none | 0/0/0 |
| 2026-08-03-overstory-governance-snapshot | overstory | no | narrowed | 0 | 0 | 3.48 | 4/4 consumer; 274 core + 28 Pi; invalid-binary healthy no-Run | relative read-only claim removed; parent snapshot retained; llm-arena next | n/a/n/a | — | — | — | none | 0/0/0 |
| 2026-08-03-llm-governance-snapshot | llm-arena | no | narrowed | 0 | 0 | 2.25 | 43/43; lint 0 errors/2 warnings; build; 6/6 consumer; invalid-binary healthy no-Run | relative read-only claim removed; parent snapshot retained; cli-lab next | n/a/n/a | — | — | — | none | 0/0/0 |
| 2026-08-03-cli-governance-snapshot | cli-lab | no | narrowed | 0 | 0 | 1.77 | list 8; doctor; profile env; 8 CLI smoke; 6/6 consumer; invalid-binary healthy no-Run | all local snapshots retained; shared-seam comparison next | n/a/n/a | — | — | — | none | 0/0/0 |
| 2026-08-03-charterarc-governance-seam | CharterArc | no | narrowed | 0 | 0 | 4.23 | Taskflow workspace/reconcile source; 40/40; invalid-binary healthy no-Run | local guards retained; unsupported code-size claim removed | n/a/n/a | 17 | 0.4296276 | 119,565/6,124/512,512 | none; retractable evidence only | 0/0/0 |
| 2026-08-03-charterarc-review-evidence | CharterArc | no | accepted | 0 | 0 | 4.35 | Flow verify; 40/40; packed consumer; invalid-binary healthy no-Run | reviewer evidence rule primary-promoted after governance rejection | pending/pending | 12 | 0.2770528 | 75,632/4,728/324,736 | none; ordinary diff promotion | 0/0/0 |
| 2026-08-03-adoption-liveness-audit | three consumer branches | no | narrowed | 0 | 0 | — | three direct observers satisfied; main trees have no CharterArc; branches are 4/3/3 integration commits ahead | M2 and four-week window corrected to unproven/not started | n/a/n/a | — | — | — | none; evidence correction only | 0/0/0 |
| 2026-08-03-adoption-promotion-readiness | three consumer branches | no | narrowed | 0 | 0 | — | exact branch manifests and ignored files; official npm readback; central release-list/workflow audit | local integrations valid; fresh-clone install and merge promotion blocked on an explicit distribution decision | n/a/n/a | — | — | — | no model run or public concept | 0/0/0 |
| 2026-08-03-overstory-clean-install | overstory | yes | accepted | 0 | 0 | — | deterministic private artifacts; isolated locked install; 274 core + 28 Pi; 5/5 consumer; invalid-binary healthy no-Run | verify now builds workspace exports before typecheck; fresh archive passes | pending/pending | 12 | 0.2882892 | 91,794/3,415/280,704 | none | 0/0/0 |
| 2026-08-03-charterarc-experimental-release-ready | CharterArc | no | accepted | 1 | — | — | Flow verify; 42/42; 124 host/release; exact public-dependency tarball install; YAML parse; invalid-Grok healthy no-Run | experimental path prepared; publish and three merges await execution approval | n/a/n/a | 27 | 0.7236296 | 127,270/15,916/1,245,312 | npm `experimental` channel prepared; not published | 0/0/0 |
| 2026-08-03-multiflow-consumer-migration | three consumer branches | no | accepted | 0 | 0 | — | one deterministic artifact set; fresh archives; 7/7 acceptance each; real healthy observers and two actual routes | multi-Flow branches retained; npm publish and merges still pending | n/a/n/a | — | — | — | existing Project/Flow maps; no new runtime concept | 0/0/0 |
| 2026-08-03-plain-taskflow-baseline | CharterArc plus three consumer branches | no | accepted | 0 | 0 | — | executable Taskflow-only dispatcher; route/binding/Run/re-observation parity; two identical model calls; 50/50 CharterArc checks | local product difference supported; M2 remains 0/3 | n/a/n/a | — | — | — | test-only baseline; no new runtime concept | 0/0/0 |
| 2026-08-03-experimental-publish-activation | CharterArc plus three consumers | no | narrowed | 2 | — | — | SLSA/integrity/ref/SHA/owner verified; registry.npmjs.org install; 7/7 x3 archives; 7/7 x2 retained mains; direct healthy zero-Run x2 | overstory and llm-arena activated; cli-lab WIP untouched; await later ordinary changes | n/a/n/a | — | — | — | npm experimental artifact; no stable concept | 0/0/0 |

### Timing evidence

- `2026-08-03-charterarc-outcome-ok`: selected
  `2026-08-03T05:14:53.435Z`; verified `2026-08-03T05:21:39.436Z`;
  elapsed `6.77` minutes. The user supplied one substantive method correction,
  but no direct active-minute report, so `Human min` remains `—`.
- `2026-08-03-overstory-outcome-ok`: selected
  `2026-08-03T05:24:28.650Z`; verified `2026-08-03T05:31:58.732Z`;
  elapsed `7.50` minutes. No user judgment was requested or supplied during
  this bounded consumer cycle, so `Human min` is directly observed as `0`.
  The enclosing pre-repair test process did not retain the nested Run's usage,
  so turns, tokens, and reported cost remain `—` rather than becoming zero.
- `2026-08-03-llm-outcome-ok`: selected
  `2026-08-03T05:36:16.788Z`; verified `2026-08-03T05:38:48.479Z`;
  elapsed `2.53` minutes. No user judgment was requested or supplied during
  this bounded consumer cycle, so `Human min` is directly observed as `0`.
- `2026-08-03-cli-outcome-ok`: selected
  `2026-08-03T05:42:46.838Z`; verified `2026-08-03T05:45:35.355Z`;
  elapsed `2.81` minutes. No user judgment was requested or supplied during
  this bounded consumer cycle, so `Human min` is directly observed as `0`.
- `2026-08-03-charterarc-prospective-baseline`: selected
  `2026-08-03T05:52:20.269Z`; verified `2026-08-03T05:56:16.330Z`;
  elapsed `3.93` minutes. No user judgment was requested or supplied during
  this evidence-only protocol repair, so `Human min` is directly observed as
  `0`. The Run and its cost are charged, but M4 and seven-day product maturity
  remain unaffected.
- `2026-08-03-charterarc-m4-release-boundary`: selected
  `2026-08-03T06:02:39.990Z`; verified `2026-08-03T06:09:39.575Z`;
  elapsed `6.99` minutes. No user judgment was requested or supplied during
  this bounded self-maintenance cycle, so `Human min` is directly observed as
  `0`. A primary formatting change after the successful Grok Run broke an
  existing packed-consumer text contract. An invalid-provider verification
  then started one Taskflow attempt, failed closed before any model call or
  mutation, and exposed the regression. The primary restored the existing
  phrase and reverified reality without another model call. Because the cycle
  exceeded the intended one-Run envelope, the accepted change receives no M4
  credit.
- `2026-08-03-charterarc-governance-deny`: selected
  `2026-08-03T06:20:49.356Z`; verified `2026-08-03T06:28:14.997Z`;
  elapsed `7.43` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The primary bound protection for
  the autonomous Goal and longitudinal metrics record, then used `read_only`
  for two files. Grok 0.2.114 rejected that profile before any model turn because its
  macOS backend requires `read_only` targets to be directories. The primary
  did not invoke Project again. It narrowed the policy to one kernel-enforced
  exact-file `deny` list and removed redundant prompt expectations. A
  model-free Grok profile check recorded both `deny_paths`; 37/37 tests and the
  packed consumer passed. The failed zero-model Taskflow attempt is charged as
  overhead and the change receives no M4 credit.
- `2026-08-03-charterarc-governance-chain`: selected
  `2026-08-03T06:32:37.000Z`; verified `2026-08-03T06:39:33.055Z`;
  elapsed `6.93` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The primary bound exact protection
  for the self Project declaration and Grok-only launcher. One Grok Run added
  those paths, passed read-only review, and re-observed `satisfied`, but the
  diff proved that Grok had rewritten `.grok/sandbox.toml` despite its parent
  directory being listed as `read_only`. The primary did not invoke Project
  again. It narrowed the result by exact-denying the sandbox file itself, then
  reran 37/37 tests, the packed consumer, a model-free profile parse, and the
  invalid-binary healthy no-Run probe. The retained change receives no M4
  credit because final hardening happened after the Run.
- `2026-08-03-charterarc-acceptance-permission`: selected
  `2026-08-03T06:51:17.000Z`; verified `2026-08-03T06:58:27.000Z`;
  elapsed `7.17` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. Static
  Taskflow verification passed with one intentional sole-gate warning. In the
  only Grok Run, an absolute `search_replace` changed the acceptance file even
  though the custom sandbox named its directory in relative `read_only` and a
  project `.grok/config.toml` denied matching Edit/Write paths. The independent
  read-only gate correctly returned BLOCK, and the pre/post SHA-256 values
  differed. The primary restored the exact line, removed both ineffective
  controls, and did not run Grok again. The retained protected launcher hashes
  acceptance membership and content around every self-maintenance cycle and
  forces reported `ok: false` on change. This detects and rejects tampering; it
  does not claim to prevent the write. The permission-rule candidate is
  rejected, the narrower fail-closed detector is retained, and the probe earns
  no M4 credit.
- `2026-08-03-charterarc-readable-governance`: selected
  `2026-08-03T07:03:20.000Z`; verified `2026-08-03T07:05:22.000Z`;
  elapsed `2.03` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The live
  probe and Grok's local sandbox contract together show that `deny` is both
  read- and write-deny. The five exact denies retained in the preceding cycle
  therefore made the Project, launcher, Goal, metrics, and sandbox unreadable
  to the same repair process whose authoritative tests consume them. The
  primary removed that self-defeating kernel policy and expanded the already
  running parent launcher's digest from acceptance alone to acceptance plus all
  five governing files. Any disk mutation during a Run now forces reported
  `ok: false`, while normal read access and verification remain possible. This
  is a governance correction with no Taskflow or Grok Run, no M4 credit, and no
  new runtime or authoring concept.
- `2026-08-03-overstory-governance-snapshot`: selected
  `2026-08-03T07:08:18.000Z`; verified `2026-08-03T07:11:47.000Z`;
  elapsed `3.48` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The primary removed the ineffective
  relative `read_only` declaration and bound the consumer's launcher plus
  acceptance tree to a parent pre/post snapshot. The first acceptance
  invocation found that the observer still expected the old local variable
  name and started one Taskflow attempt. The deliberately invalid Grok binary
  stopped it before any model call or mutation. The observer was corrected to
  inspect the final reported result, after which 4/4 consumer tests, the 274
  core and 28 Pi tests behind `npm run verify`, and the explicit invalid-binary
  healthy no-Run probe passed. This is a narrowed governance correction, not an
  M4 cycle or a Grok Run, and it adds no public concept.
- `2026-08-03-llm-governance-snapshot`: selected
  `2026-08-03T07:16:50.000Z`; verified `2026-08-03T07:19:05.000Z`;
  elapsed `2.25` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The primary made missing governance
  an `unknown` observation before touching the launcher, and the red acceptance
  process therefore exited without a Taskflow or Grok Run. It then removed the
  ineffective relative `read_only` declaration and added the parent pre/post
  snapshot. Independent verification passed 43/43 Python cases, lint with zero
  errors and the two pre-existing warnings, the production build, 6/6 consumer
  tests, and the explicit invalid-binary healthy no-Run probe. This narrowed
  correction adds no public concept and does not increase the zero-model
  Taskflow-attempt count.
- `2026-08-03-cli-governance-snapshot`: selected
  `2026-08-03T07:22:02.000Z`; verified `2026-08-03T07:23:48.000Z`;
  elapsed `1.77` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. Missing governance was bound as
  `unknown` before the launcher changed, so the red acceptance process exited
  without Taskflow or Grok. The primary then removed the false relative
  `read_only` claim and added the parent snapshot. Current cli-lab evidence
  showed eight registered CLIs, green doctor, a resolved default profile, all
  eight smoke commands passing, 6/6 consumer tests, and an explicit
  invalid-binary healthy no-Run result. Missing optional credentials remained
  environment facts. This narrowed correction adds no public concept and does
  not increase the zero-model Taskflow-attempt count.
- `2026-08-03-charterarc-governance-seam`: selected
  `2026-08-03T07:28:18.300Z`; verified `2026-08-03T07:32:32.300Z`;
  elapsed `4.23` minutes. No user judgment was requested or supplied after the
  contradiction was selected, so `Human min` is directly observed as `0`. The
  primary added one immutable acceptance test, and the root Project itself
  observed `39/40`, ran one ordinary Grok repair -> read-only review Taskflow,
  and re-observed `40/40`. Source inspection showed that `cwd: "worktree"`
  discards successful isolated edits and can fail open, while workspace
  reconciliation only accepts an inspected generation and does not restore
  files. The primary retained the local-guard decision but removed Grok's
  unsupported assertion that a helper's total code was already measured not to
  shrink. A second invocation with an invalid Grok binary stayed healthy and
  started no Run. This is retractable product knowledge, not confirmed product
  drift, so it receives no M4 credit.
- `2026-08-03-charterarc-review-evidence`: selected
  `2026-08-03T07:37:06.300Z`; verified `2026-08-03T07:41:27.300Z`;
  elapsed `4.35` minutes. No user judgment was requested or supplied, so
  `Human min` is directly observed as `0`. The prior cycle's unsupported
  code-size claim became one immutable acceptance failure. Taskflow's
  zero-token verifier accepted the existing two-phase Flow with only its
  intentional terminal-gate warning. The root Project observed `39/40`; one
  Grok repair -> read-only review Run changed only the review prompt and
  re-observed `40/40`. The parent correctly forced `ok: false` because
  `charterarc.project.ts` is governed and changed during its own Run. The
  primary inspected the two-file diff and explicitly promoted the three-line
  Rule revision without weakening the governance digest. Typecheck, 40/40,
  the three-package packed consumer, and the invalid-binary healthy no-Run
  probe passed. The accepted revision is charged, but receives no M4 credit
  because its attempted Run failed the governance boundary.
- `2026-08-03-charterarc-experimental-release-ready`: the user supplied one
  substantive product-boundary decision: M4 may be preceded by a non-`latest`,
  no-stability prerelease, while publish and consumer merge remain separate
  execution approvals. No direct active-minute report exists, so `Human min`
  remains `—`. One immutable red contract produced four failures; one ordinary
  Grok repair -> read-only review Run re-observed 42/42 and returned
  `ok: true`. Independent verification passed the static Flow check, 42/42
  CharterArc tests, 124/124 host/release tests, three-package packed smoke,
  an exact CharterArc-only tarball install against public npm dependencies,
  YAML parsing, and an invalid-Grok healthy no-Run probe. This policy and
  release-infrastructure cycle is charged but receives no M4 credit; it did
  not publish, merge a consumer, start the four-week window, or prove adoption.

## Matched replay: small deterministic repair

Both arms started from SHA-256 `05a0fccca1dd9771688483acd0d5c9d9e94d70a60b7a432d5056e712ca70f2f4`.
Both produced SHA-256 `0d91c5151e1d4df74c57725022ae1a9a8c76484e4ea3e76350ecd7f6a968a36f`.

| Arm | Scope | Wall time | Turns | Reported USD |
| --- | --- | --- | --- | --- |
| Single Grok Taskflow | repair only | 40.377 s | 4 | $0.1077940 |
| CharterArc | observe, repair, read-only review, re-observe | 74.50 s | 9 | $0.2013040 |

CharterArc used 84.5% more wall time, 125.0% more turns, and 86.7% more reported cost
on this matched repair. The replay does not show a speed, token, cost, or output-quality advantage
for CharterArc, and it does not measure human diagnosis, acceptance design, or review time.
It does not count toward the 20 natural maintenance cycles.

Fifteen rows currently have both selected-at and verified-at timestamps under the
protocol above. Two earlier Runs have direct
execution-duration evidence, but backfilling those partial durations would
understate selected-to-verified time. Historical human minutes remain `—`
unless the directly observed no-intervention condition supports `0`.
