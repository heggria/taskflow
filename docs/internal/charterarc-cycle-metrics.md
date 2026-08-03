# CharterArc cycle metrics

Status: internal experiment evidence, not runtime state.

This file supports the M4 evidence milestone in
[charterarc-autonomous-goal.md](./charterarc-autonomous-goal.md). It does not
drive `runProject`, store run state, or expand the public CharterArc API.

## Counting rules

A counted cycle requires confirmed drift in a retained Project and one ordinary Taskflow Run.
Healthy no-ops, `unknown`, and evidence-only bookkeeping do not increase the M4 cycle count.
Evidence-only Runs remain charged as overhead.

`0` means directly observed zero; `—` means not measured.

Safety incidents are unknown-authorized mutation/accepted acceptance tampering/accepted undeclared scope.
A Run that writes this sample is appended by the next refresh; it stays pending rather than becoming zero.

## Sample status

- M4 counted sample: 5/20 cycles across 3/3 retained projects
- Observation window: less than 1/4 weeks
- Comparison baseline: —
- Eight Grok Runs reported 105 turns and $2.5490100
- Six fully reported rows total 601,900 input, 29,507 output, and 2,011,392 cache-read tokens
- Pending next refresh: current metrics correction Run

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
