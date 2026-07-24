# Taskflow Web Console cognitive usability study v1

Status: executable study protocol; no participant result has been recorded.

This is a beta.2 release gate, not a design workshop. The study asks whether a
fresh user can correctly explain Taskflow state and consequences without first
learning the control-plane vocabulary.

## Participants

- Five English-speaking participants who have not worked on this RFC or WebUI.
- Participants should be ordinary software engineers or coding-tool users; no
  Taskflow internals knowledge is required.
- Two native Simplified Chinese reviewers separately review every projected and
  static message for meaning, naturalness, and narrow-screen readability.
- A contributor who has read P17, authored a fixture, or implemented the WebUI
  does not count as a fresh participant.

## Frozen material

Use the exact build, fixture, content, and screenshot hashes in
`reference-set-v1/manifest.json` and `reference-set-v1/render-evidence.json`.
Run these checks before a session:

```bash
pnpm check:web-reference-fixtures
pnpm check:web-render-evidence
pnpm test:e2e-web-console
```

The facilitator may use the live packaged WebUI for navigation tasks and the
hash-bound renders for states that are unsafe or expensive to reproduce. The
record must identify `live-packaged` or `fixture-render` for every task. A
fixture render is never described as a real ControlStore outcome.

For a native-browser session against the same fresh isolated ControlStores as
the packaged E2E, build once and start the opt-in manual-review hold:

```bash
pnpm build
TASKFLOW_WEB_E2E_TRACE=1 \
TASKFLOW_WEB_MANUAL_REVIEW_MS=900000 \
node packages/taskflow-cli/test/e2e-web-console.mts
```

The default `initial` stage prints one `[manual-review]` JSON record to stderr
containing a single-use launch capability. Open it immediately in the
participant's fresh browser profile. The hold occurs before the automated
scenario mutates any Run.

Native-browser mutation checks may instead select `cancel` or `sessions`:

```bash
review_root="$(mktemp -d)"
TASKFLOW_WEB_E2E_TRACE=1 \
TASKFLOW_WEB_MANUAL_REVIEW_MS=180000 \
TASKFLOW_WEB_MANUAL_REVIEW_STAGE=cancel \
TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD=1 \
TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR="$review_root/release" \
node packages/taskflow-cli/test/e2e-web-console.mts
```

The `cancel` stage holds after a real script task is running, keeps both the
task and its phase timeout alive for the configured hold plus cleanup margins,
and exposes one fresh launch capability. Its hold must not exceed 180 seconds:
that leaves 60 seconds of task margin and 60 seconds of cleanup margin within
the DSL's 300-second script timeout ceiling. The `sessions` stage exposes two
independently minted capabilities; exchange them in separate browser cookie
jars, such as a normal window and a private window. After the native review,
create the configured release directory. With `EXIT_AFTER_HOLD=1`, the harness
then closes its isolated listener without running later automated mutations.
If the reviewer did not stop the staged task, harness cleanup cancels it before
exiting so no script process survives the review.

Every launch capability is secret and ephemeral: never copy it into a result
record, screenshot, issue, or chat transcript. After the harness exits, verify
that its loopback listener is closed.

Reset between participants:

1. Close every Taskflow browser tab used by the previous participant.
2. Run `taskflow ui --stop`.
3. Start a fresh browser profile with no preserved locale, zoom, theme, or
   session state.
4. Verify the reference evidence hashes again if any source file changed.
5. Record the build commit, manifest digest, locale, viewport, zoom, input
   method, and assistive technology before showing the first task.

## Facilitator rules

- Read prompts exactly. Do not name a control, page, color, or technical term.
- Do not explain RunStatus, Receipt, provider, reconciliation, or ControlStore.
- After the participant acts or answers, ask: “What on the screen led you to
  that answer?”
- Do not count a lucky click as comprehension.
- Record the participant’s words, not a cleaned-up paraphrase.
- Stop a task if the participant could trigger an unsafe action or becomes
  uncomfortable.

## Tasks

### 1. Home orientation

Show Simple Home with normal activity.

Prompt: “Tell me what is happening now and whether Taskflow needs anything from
you.”

Pass: identifies active work and required input, without treating recent
completed work as active.

### 2. Partial and disconnected observation

Show `simple-home-partial-disconnected`.

Prompt: “Can you trust these totals as complete? What would refreshing do?”

Pass: says some workspaces are missing, does not claim the tasks changed, and
understands refresh does not rerun work.

### 3. Active task

Show `active-task-result`.

Prompt: “What is this task doing? Do you need to act now? Is the visible result
final?”

Pass: identifies the active step, says no action is currently required, and
does not treat the preserved preview as a verified final result.

### 4. Decision consequence

Show `needs-input-decision`.

Prompt: “Explain what each choice will cause. Which choice does Taskflow
recommend?”

Pass: correctly states both consequences and says neither choice is
recommended or preselected.

### 5. Completion versus verification

Show `completed-verified`, then
`completed-verification-unavailable`.

Prompt: “What stayed the same, and what changed between these screens?”

Pass: task completion stayed the same; evidence confidence changed. The
participant does not describe verification-unavailable as verified success.

### 6. Unknown execution

Show `unknown-reconciling`.

Prompt: “Is this task stopped? Would you run it again now?”

Pass: says it may still be running and would wait for confirmation before
repeating it.

### 7. Pro evidence

Open Pro Evidence.

Prompt: “Which information is the saved execution record, which information is
a current check, and how would you get the artifact?”

Pass: distinguishes the immutable Receipt from current verification, finds the
artifact download, and does not assume the first event page is the complete
manifest.

### 8. Lost command response

Show `error-command-outcome-unknown`.

Prompt: “Did the action fail? What would you do next, and why?”

Pass: does not assert failure or success, checks the durable outcome first, and
understands that retry means the exact saved request rather than a second
action.

### 9. Settings and session safety

Open Settings.

Prompt: “Change only how the UI is presented. Then explain what ‘End all
sessions’ would and would not change.”

Pass: changes Simple/Pro, locale, or theme without believing execution changed;
understands browser access ends while tasks retain their current state.

## Scoring

Each task receives:

- `2` — correct state, impact, required action, and consequence in the
  participant’s own words;
- `1` — partly correct, but one material omission or facilitator-neutral
  clarification was needed;
- `0` — wrong, unsafe, contradictory, or dependent on facilitator instruction.

The primary gate is stricter than the aggregate score:

- For every safety-critical task (2, 4, 5, 6, 8, 9), at least 4 of 5 fresh
  participants must score `2`.
- At least 4 of 5 must independently find every primary action used in tasks
  4, 7, 8, and 9.
- No participant may interpret unknown/reconciling as safely stopped or
  verification-unavailable as verified success.
- Both native Chinese reviewers must approve every safety-critical message.

If a gate fails, record the exact misunderstanding, change the smallest
responsible projection/copy/layout rule, regenerate the full reference
evidence, and run a new study with fresh participants for the affected tasks.
Do not overwrite the failed record.

## Result recording

Copy
`packages/taskflow-web/test/fixtures/usability-v1/session-result.template.json`
once per participant. Use opaque participant ids; do not record names, email
addresses, employer, or other direct identifiers.

After five sessions, create a study summary from
`study-summary.template.json`. An empty template or facilitator dry run is not
release evidence.
