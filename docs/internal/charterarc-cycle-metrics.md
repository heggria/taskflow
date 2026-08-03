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

## Sample status

- M4 counted sample: 7/20 cycles across 4 retained Projects
- Independent external adoption: 3/3 retained repositories
- Observation window: less than 1/4 weeks
- Comparison baseline: one matched replay; human judgment baseline still `—`
- Fifteen Grok Runs reported 206 turns and $5.0039908
- Thirteen fully reported rows total 1,192,830 input, 75,505 output, and 5,335,168 cache-read tokens
- Pending next refresh: none

## Cycles

| ID | Project | M4 | Decision | User interventions | Human min | Verified min | Verification | Follow-up | Turns | Reported USD | Tokens in/out/cache | Public concept | Safety incidents |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-03-charterarc-readonly-review | CharterArc | yes | accepted | 0 | 0 | — | 36/36; read-only argv selected | healthy no-Run next | 9 | 0.2798776 | — | none | 0/0/0 |
| 2026-08-03-overstory-observer-timeout | overstory | yes | accepted | 0 | 0 | — | 274 core + 28 Pi + 4 consumer | healthy no-Run next | 12 | 0.2848728 | — | none | 0/0/0 |
| 2026-08-03-llm-entrypoint | llm-arena | yes | accepted | 0 | 0 | — | 4/4 adoption acceptance; post-observer exposed hooks drift | entrypoint retained | 15 | 0.2609692 | 64,709/3,730/363,904 | none | 0/0/0 |
| 2026-08-03-llm-hooks | llm-arena | yes | accepted | 0 | 0 | — | 43/43 Python; lint 0 errors/2 warnings; build; 4/4 acceptance | post-observer satisfied | 12 | 0.2492156 | 75,415/4,756/232,832 | none | 0/0/0 |
| 2026-08-03-llm-ignore | llm-arena | yes | accepted | 0 | 0 | — | git check-ignore; 5/5 acceptance; healthy no-Run | retained external branch | 18 | 0.3312488 | 102,490/4,136/338,176 | none | 0/0/0 |
| 2026-08-03-charterarc-adoption-evidence | CharterArc | no | narrowed | 0 | 0 | — | 36/36; primary rejected test-debt claim | reworked next row | 17 | 0.4741136 | 139,600/7,212/505,472 | avoided CLI | 0/0/0 |
| 2026-08-03-charterarc-fact-correction | CharterArc | no | accepted | 0 | 0 | — | 36/36; healthy no-Run | accepted correction | 10 | 0.3399076 | 130,430/2,909/205,312 | avoided CLI | 0/0/0 |
| 2026-08-03-charterarc-metrics-bootstrap | CharterArc | no | narrowed | 0 | 0 | — | 37/37; primary narrowed semantics/provenance | reworked by current refresh | 12 | 0.3288048 | 89,256/6,764/365,696 | none | 0/0/0 |
| 2026-08-03-charterarc-metrics-correction | CharterArc | no | accepted | 0 | 0 | — | 37/37; healthy no-Run | metrics semantics retained | 13 | 0.3560392 | 91,295/8,729/403,584 | none | 0/0/0 |
| 2026-08-03-llm-paired-single | llm-arena replay | no | accepted | 0 | 0 | — | 43/43; lint; build; byte-identical output | comparison only; no M4 credit | 4 | 0.1077940 | 33,194/2,581/86,400 | none | 0/0/0 |
| 2026-08-03-llm-paired-charterarc | llm-arena replay | no | accepted | 0 | 0 | — | 43/43; lint; build; 5/5 acceptance; byte-identical output | comparison only; no M4 credit | 9 | 0.2013040 | 66,989/3,989/144,640 | none | 0/0/0 |
| 2026-08-03-charterarc-comparison-evidence | CharterArc | no | narrowed | 0 | 0 | — | 37/37; healthy no-Run | empirical rows removed from acceptance | 17 | 0.4666992 | 133,599/8,239/500,224 | none | 0/0/0 |
| 2026-08-03-cli-lab-entrypoint | cli-lab | yes | accepted | 0 | 0 | — | 5/5 acceptance; doctor; 8 CLI smoke; healthy no-Run | retained external branch | 12 | 0.2094324 | 57,414/3,697/241,408 | none | 0/0/0 |
| 2026-08-03-charterarc-packed-grok-stack | CharterArc | no | narrowed | 0 | 0 | — | 37/37; primary found stale-host build risk | reworked next row | 34 | 0.8091664 | 122,786/15,078/1,577,088 | none | 0/0/0 |
| 2026-08-03-charterarc-packed-host-build | CharterArc | yes | accepted | 0 | 0 | — | 37/37; three-package pack/install; invalid Grok binary still healthy no-Run | private release candidate retained | 12 | 0.3045456 | 85,653/3,685/370,432 | none | 0/0/0 |

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
