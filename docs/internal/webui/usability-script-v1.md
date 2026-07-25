# Taskflow Web Console usability script v1

Status: frozen executable study protocol; no participant result has been
recorded.

This is the RFC v7 §19.4 beta.2 release gate, not a design workshop. It tests
whether fresh users can complete the seven normative ordinary-engineer tasks
and explain safety consequences without first learning control-plane
vocabulary.

## Consent, privacy, and moderator introduction

Read this introduction exactly:

> We are evaluating Taskflow, not you. Please work as you normally would and
> say what you think is happening. You may stop at any time. We record task
> timings and your words, but not your name, employer, contact details, screen,
> voice, or credentials. If you are unsure, say so rather than guessing.

Screen or audio recording requires separate consent and is not part of this
protocol. The release evidence stores only opaque participant ids, the closed
cohort fields, task timing/scoring, participant words, wrong turns, errors, and
finding dispositions.

## Participants

Use five English-language participants who did not author or implement the
0.3 control plane or WebUI:

- at least two `taskflow-naive-software-engineer` participants;
- at least three `ordinary-developer-tool-user` participants;
- record prior Taskflow exposure as `none`, `used-released-version`, or
  `other-no-control-plane`;
- a contributor who read P17, authored a fixture, implemented the WebUI, or
  participated in an earlier failed run of the same task does not count as
  fresh.

Two separate native Simplified-Chinese reviewers cover the `zh-CN` gate: one
`content-ux` reviewer and one `technical-safety` reviewer. They are not counted
as the five-user English cohort.

## Frozen candidate and environment

Use the exact build, fixture, content, and screenshot hashes in
`reference-set-v1/manifest.json` and `reference-set-v1/render-evidence.json`.
Every participant and reviewer record must bind the same immutable build
commit and both file digests.

Run before the first session and whenever material changes:

```bash
pnpm check:web-reference-fixtures
pnpm check:web-render-evidence
pnpm check:web-usability-materials
pnpm test:e2e-web-console
node scripts/build-web-reference-review.mjs
```

Use the same supported desktop, native browser build, viewport, 100% zoom,
default light theme, input method, and fresh browser profile for all five
English participants. Record exact environment values. Timing starts when the
route becomes useful and stops at the task-specific action or complete spoken
explanation.

The facilitator may use the live packaged WebUI for navigation and mutation
tasks and the hash-bound renders for unsafe or expensive states. Every task
record names `live-packaged` or `fixture-render`. A fixture render is never
described as a real ControlStore outcome.

## Native packaged review holds

Build once. The `initial` stage supplies the Home, Needs your input, active,
completed, approval, Settings, and Pro Evidence material:

```bash
review_root="$(mktemp -d)"
TASKFLOW_WEB_E2E_TRACE=1 \
TASKFLOW_WEB_MANUAL_REVIEW_MS=900000 \
TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD=1 \
TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR="$review_root/initial-release" \
node packages/taskflow-cli/test/e2e-web-console.mts
```

The harness prints one `[manual-review]` JSON record to stderr containing a
single-use launch capability. Open it immediately in the participant's fresh
browser profile. Never copy the capability into a result, screenshot, issue,
or chat transcript. Create the configured release directory after completing
the initial-stage tasks.

Run the separately isolated `cancel` stage for the normative cancel task:

```bash
cancel_root="$(mktemp -d)"
TASKFLOW_WEB_E2E_TRACE=1 \
TASKFLOW_WEB_MANUAL_REVIEW_MS=180000 \
TASKFLOW_WEB_MANUAL_REVIEW_STAGE=cancel \
TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD=1 \
TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR="$cancel_root/release" \
node packages/taskflow-cli/test/e2e-web-console.mts
```

The cancel hold must not exceed 180 seconds. It keeps a real script task and
its timeout alive with cleanup margin. If the participant does not stop it,
the harness cleanup cancels it so no script process survives.

After each hold:

1. create the configured release directory;
2. wait for the harness to exit;
3. verify its loopback listener is closed;
4. close every Taskflow tab;
5. run `taskflow ui --stop`;
6. discard the fresh browser profile and isolated stores.

## Moderator behavior

Read prompts exactly. Do not name a control, page, color, route, technical
term, or expected result. The only permitted neutral prompts are:

- “Please continue.”
- “What are you thinking now?”
- “What on the screen led you to that answer?”
- “Please explain that in your own words.”

Do not count a lucky click or reading a label aloud as comprehension. Record
the participant's words, elapsed seconds, wrong turns, confidence, errors, and
every moderator intervention. Stop the task if the participant could affect a
non-isolated project, exposes a credential or launch capability, becomes
uncomfortable, or asks to stop.

## Normative tasks

### `find-attention` — 30 seconds

Start on a fresh Simple Home containing normal activity and a pending approval.

Prompt:

> Find the task that needs something from you.

Stop timing when the participant opens the correct item.

Pass: reaches the correct current-principal attention item within 30 seconds
without opening a merely active or recently completed Task.

After timing, show `simple-home-partial-disconnected` and ask:

> Can you trust these totals as complete? What would refreshing do?

The participant must say that some Workspaces are missing and refresh checks
latest state without rerunning work.

### `explain-active-task` — 60 seconds

Open the live active Task.

Prompt:

> Explain what is happening, whether you need to act, what risk remains, and
> what should happen next.

Stop timing after the complete explanation.

Pass: identifies the active work, says no action is currently required, does
not treat a visible preview as a verified final result, and completes the
explanation within 60 seconds.

### `understand-approval` — 60 seconds

Open the pending approval without selecting an answer.

Prompt:

> Explain the decision Taskflow is asking for, what each choice will do,
> whether work is active now, and when a decision is due.

Stop timing after the complete explanation.

Pass: correctly states both consequences, parked/no-active-worker state, and
the real deadline or absence of one within 60 seconds. The participant must
not describe either choice as recommended or preselected.

### `make-approval-decision` — 90 seconds

The facilitator supplies the study instruction “Allow publication” or “Do not
allow publication” according to the participant record's preassigned
`decisionVariant`; alternate variants across the cohort.

Prompt:

> Make the stated decision and tell me what you expect Taskflow to do next.

Stop timing when the durable outcome is visible and the participant has
explained it.

Pass: selects the instructed choice, understands its consequence, and reaches
the committed outcome within 90 seconds. A successful click with the wrong
consequence model does not pass.

### `cancel-task` — 90 seconds

Use the isolated `cancel` hold. Open “Stop a live verification.”

Prompt:

> Stop this task. Explain what “Stopping” proves, what may still be happening,
> and what outcome you must wait for.

Stop timing when the participant has submitted the action and completed the
explanation.

Pass: completes within 90 seconds and says that “Stopping” is not terminal,
work may still be active, and only a committed terminal outcome proves it
stopped.

Then show `unknown-reconciling` and ask:

> Is this task finished or stopped? Would you run it again now?

The participant must say the outcome is unconfirmed, work may still be live,
and they would not repeat it until authority is confirmed.

### `find-assess-result` — 60 seconds

Start from the completed Task list. Show `completed-verified`, then
`completed-verification-unavailable`.

Prompt:

> Find the result. Explain what stayed the same, what changed, and what the
> verification message lets you conclude.

Stop timing after the complete explanation.

Pass: locates the output within 60 seconds, keeps Task completion separate
from verification, and does not describe verification-unavailable as verified
success. A visible Receipt does not by itself prove verification.

### `open-technical-evidence` — no time limit

Return to Simple Task detail.

Prompt:

> Find the exact technical evidence without changing what this task is
> allowed to do. Tell me which information is the saved execution record,
> which is a current check, and how you would get the artifact.

Pass: discovers Pro/Technical details without being told where it is,
distinguishes immutable Receipt evidence from current verification, finds the
artifact action, and does not believe Pro grants more permission or that the
first event page is the complete manifest.

## Severity-1 classification

Record a closed severity-1 finding when any participant:

- `unknown-treated-as-terminal` — calls checking/reconciling confirmed
  completion, failure, cancellation, or safe stoppage;
- `possible-live-work-missed` — misses that work may still be live;
- `receipt-treated-as-verified` — treats Receipt presence as verification;
- `pro-treated-as-permission` — believes Pro grants more authority;
- `approval-treated-as-recommended` — believes approve or reject is
  recommended/preselected;
- `approval-consequence-misunderstood` — misunderstands approve/reject impact;
- `refresh-consequence-misunderstood` — believes refresh reruns or changes
  Task execution;
- `cancel-consequence-misunderstood` — treats Stopping as terminal or expects
  cancellation without a committed outcome.

One severity-1 finding blocks the entire candidate regardless of task totals.
Retain the failed record and finding disposition. After a fix, rerun the
affected task with five fresh participants who have not seen the prior
version.

## Scoring and release gate

Each task receives:

- `2` — completed within its time limit when one exists, with correct state,
  impact, required action, risk, and consequence in the participant's words;
- `1` — correct direction but late, materially incomplete, or dependent on a
  permitted neutral clarification;
- `0` — wrong, unsafe, contradictory, incomplete, or dependent on a hint.

Release requires:

- exactly five fresh English participant records bound to one candidate;
- score `2` from at least four of five participants for every normative task;
- at least four of five independently find/complete each primary action in
  `find-attention`, `make-approval-decision`, `cancel-task`,
  `find-assess-result`, and `open-technical-evidence`;
- zero severity-1 findings;
- one approved `content-ux` and one approved `technical-safety` native
  Simplified-Chinese review;
- an approved, hash-bound reference-screen review.

Visual polish, aggregate scores, facilitator explanations, or successful
clicks cannot compensate for a failed condition.

## Result recording and verification

Copy
`packages/taskflow-web/test/fixtures/usability-v1/session-result.template.json`
once per participant. Never edit a completed record; create a superseding
record and retain the original.

After five sessions and both Chinese reviews, complete
`study-summary.template.json` from the immutable source records. Validate the
complete evidence directory:

```bash
node scripts/verify-web-human-evidence.mjs \
  --evidence-dir artifacts/web-usability/<release-candidate>
```

An empty template, facilitator dry run, gallery inspection, or verifier run
without completed human attestations is not release evidence.
