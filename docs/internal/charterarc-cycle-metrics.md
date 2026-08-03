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

## Sample status

- M4 counted sample: 9/20 cycles across 4 retained Projects
- Independent external adoption: 3/3 retained repositories
- Observation window: 0/28 completed days (started 2026-08-03)
- Eligible comparative cohort: 0 CharterArc / 0 baseline; M4 value verdict unavailable
- Historical human judgment baseline: `—`; no same-protocol source exists
- Matured accepted changes: 0; seven-day rework and rollback rates unavailable
- Seventeen Grok Runs were executed; sixteen reported 223 turns and $5.4762272
- Fourteen fully reported rows total 1,320,785 input, 83,233 output, and 5,901,696 cache-read tokens
- Pending next refresh: none

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

Two rows currently have both selected-at and verified-at timestamps under the
protocol above. Two earlier Runs have direct
execution-duration evidence, but backfilling those partial durations would
understate selected-to-verified time. Historical human minutes remain `—`
unless the directly observed no-intervention condition supports `0`.
