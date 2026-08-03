# CharterArc foundation

Status: private implementation experiment, not GA.

## Decision

CharterArc starts from the released Taskflow runtime. It is a thin project loop,
not a replacement execution system:

```text
ProjectDefinition + observed reality → zero or one ordinary Taskflow Run → Outcome
```

Taskflow keeps all phase, DAG, gate, retry, approval, loop, host, and execution
semantics. CharterArc owns only the long-lived declaration and the decision to
attempt maintenance when current evidence confirms drift.

```mermaid
flowchart LR
  Project["ProjectDefinition<br/>desired · observe · maintain"]
  Observe["Observe reality"]
  Decide{"runProject"}
  Taskflow["Ordinary Taskflow"]
  Reobserve["Observe again"]
  Outcome["ProjectOutcome"]

  Project --> Observe --> Decide
  Decide -->|"satisfied or unknown"| Outcome
  Decide -->|"confirmed drift"| Taskflow --> Reobserve --> Outcome
```

The dependency direction is one-way:

```text
CharterArc → taskflow-core
Hosts      → CharterArc + taskflow-core
```

`taskflow-core` never imports CharterArc. CharterArc never imports a host SDK,
MCP server, daemon, or alternative scheduler.

## Minimal declaration

```ts
defineProject({
  desired: "main is releasable",
  observe: ({ cwd, signal }) => observeReality(cwd, signal),
  maintain,
});
```

`maintain` is an ordinary Taskflow value, including one compiled from `.tf.ts`.
Its existing `name` is the only project identity; a duplicate
`ProjectDefinition.name` had no independent routing or persistence semantics
and was deleted while the package was still private.
The runtime captures the observer function and a detached maintenance Taskflow
before observation. It also captures the Taskflow runtime binding so observe,
execute, and re-observe use the same project root. The observer returns only a
three-state result plus an optional human-readable summary:

- `satisfied`: the checked invariant currently holds;
- `drifted`: evidence is sufficient to authorize the declared maintenance Run;
- `unknown`: evidence is insufficient, so mutation is forbidden.

After a Run, CharterArc calls the same observer again. The final status
describes reality, while `run.ok` describes the attempt; neither is used as a
causal claim about the other.

Taskflow's own validation and execution semantics remain unchanged. In
particular, CharterArc does not promote Taskflow's advisory built-in verifier
findings into a stricter dialect. Callers that need a blocking policy can use
the existing Taskflow verifier seam.

## Evidence that changed the design

| Experiment | Observation | Resulting subtraction or boundary |
|---|---|---|
| README phase catalog | Reporting only one missing phase caused a wrong edit | Keep complete evidence in `summary`; add no planner or new data model |
| Real detached Taskflow worktree | A writer promised a repair without editing | Tighten the existing phase prompt and thinking level; keep a read-only gate |
| Fresh packed consumer | Development exports referenced unpublished source | Fix package exports; add no runtime factory |
| Real Hilo regression fixture | A failed command alone could not distinguish drift from infrastructure failure | Domain observer proves the fixed baseline and known sentinel; add no Git abstraction |
| All retained declarations | Each project bound one observer, and every top-level project name merely duplicated `maintain.name` | Keep the observer in `ProjectDefinition`; delete registry, fan-out, source plumbing, and the second identity |

The experiments also found no retained use for `changedPaths`, a one-field
snapshot wrapper, a second error string, output freezing, a model planner, or a
second scheduler. A named observer registry and its array aggregation were also
deleted.

## Self-dogfood protocol

The repository root is now a real CharterArc consumer:

```bash
pnpm run dogfood:charterarc
```

`charterarc.project.ts` is the current executable hypothesis, not a backlog or
knowledge ledger. Its finite observer runs fixed scoped typecheck and test
commands. A recognized TypeScript diagnostic or failing test is `drifted`;
missing tools, wrong repository identity, aborts, empty test runs, and
unclassified command failures are `unknown` and cannot authorize mutation. A
healthy project returns `satisfied` without starting an Agent.

This adds the following constraint to the active project goal:

> Each iteration turns one real unmet case into a retained acceptance test and
> uses the root ProjectDefinition's observe → ordinary Taskflow → re-observe
> path for the repair. No proven drift means no modification.

The primary agent now acts under the delegated decision contract in
[`charterarc-autonomous-goal.md`](./charterarc-autonomous-goal.md): it selects
the next real problem, binds acceptance, and retains or rejects the result.
CharterArc only executes the declared attempt. Each iteration may run at most one existing
Taskflow; it must not add a Goal/Rule/Outcome/Knowledge store, planner,
scheduler, daemon, registry, second IR, phase kind, or self-only runtime API.
When a slice becomes satisfied, its durable invariant belongs in an ordinary
regression test; the rolling declaration is replaced for the next slice rather
than accumulating historical rules.

All self-dogfood model phases are bound to the existing Grok Build runner.
There is no fallback to Codex, Claude, OpenCode, or Pi. A healthy observation
still invokes no model. The checked-in `.grok/sandbox.toml` defines a
workspace-write profile for repair and a read-only profile for review; the
dogfood command selects them by default. Operator-provided
`PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE` and
`PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE` values still override those
defaults. A drifted run fails closed when Grok or the selected custom profile
is unavailable.

The bootstrap first returned `satisfied` with no Run. The next retained
acceptance test then exposed a real false-green: a nested Node test inherited
`NODE_TEST_CONTEXT` and exited successfully without executing its fixture.
CharterArc observed `drifted`, ran one ordinary repair → review Taskflow, removed
that inherited marker only for the child check, and re-observed `satisfied`.
The regression remains in the normal CharterArc suite. This is the first actual
self-modification; it required no self-only runtime path.

A second adversarial review found that inherited `NODE_OPTIONS=--test-only`
could still filter the suite and that a review gate's BLOCK could be hidden by
an independently satisfied post-observation. Three failing acceptance tests
were added first. A second ordinary Taskflow removed the inherited filter,
rejected zero-test success, and made the dogfood command require both observed
reality and a non-failed Run. It again completed as
`drifted → one Run → satisfied`; the following healthy run was a no-op.

After self-evolution was locked to Grok, the first live Grok cycle exposed that
the otherwise-safe runner could not start without operator-global sandbox
setup. Grok's project-local custom profiles closed that bootstrap gap without
adding a CharterArc option or host dependency. A failing acceptance test then
drove one Grok repair → Grok review Run to default the two profile names while
preserving explicit operator overrides.

That live Run exposed a second concrete side effect: `pnpm run` inside Grok's
workspace sandbox selected a project-local pnpm store, rebuilt `node_modules`,
and wrote roughly 707 MB into the worktree. The generated store was moved to
Trash and the normal global-store links were restored. A retained acceptance
test now forbids package-manager commands in both maintenance prompts; repair
and review execute the same direct Node/TypeScript commands as the observer.
The Grok-only repair → review Run returned to `satisfied` with 30 acceptance
tests, and future healthy checks remain zero-model no-ops.

The next live Grok Run exposed a smaller observability loss: current Grok
terminal events reported tokens, turns, and USD cost, but the Taskflow runner
discarded them and CharterArc had no way to expose the ordinary Run's totals.
Failure-first tests retained both boundaries. The Grok parser now records
well-formed spend, and `ProjectOutcome.run` passes through Taskflow's aggregated
usage plus its accounting mode. A live
`runProject → Taskflow → grokSubagentRunner` smoke produced nonzero token and
USD evidence. Because older or incomplete Grok events can still omit spend,
the runner remains `unavailable` for budget admission: a zero or absent field
is unknown, never proof of a free Run.

A later subtraction trial exposed a more important dogfood failure. The first
Grok repair changed the new acceptance test back to the old required
`ProjectDefinition.name`, and its reviewer passed the title/behavior
contradiction. The first response configured `packages/charterarc/test` as a
relative sandbox `read_only` directory. A later live probe proved that setting
did not stop an absolute-path Grok edit, so it is no longer treated as a safety
boundary. The running parent now hashes acceptance plus the governing Project,
launcher, sandbox, Goal, and metrics files before and after the bounded Run and
forces reported `ok: false` on any change. This detects and rejects tampering;
it does not claim to prevent the write. With primary verification enforcing
that boundary, exact type and runtime tests rejected both a required and an
optional compatibility alias. Grok then removed the duplicate identity from
the definition, declarations, and `runProject`; the ordinary Taskflow's
`maintain.name` now supplies the existing identity.

This was not a one-shot autonomy success. Four Grok-only Runs all reported
`satisfied`, but source-level review rejected or narrowed the first three:
test rewrite, optional alias, then a direct-`runProject` key-stripping bypass.
The fourth closed the exact type and runtime contract. Grok reported 64 turns,
314,663 input tokens, 35,568 output tokens, 2,106,240 cache-read tokens, and
$1.474606 across those four attempts. Those are observed values, not a
complete-accounting guarantee. The result is evidence for a narrower claim:
CharterArc can make controlled attempts cheaply enough to inspect, but it does
not replace the acceptance boundary or product judgment.

The two retained consumers then exposed one more repeated seam: both declared
the same `args.charterarc` schema even though `runProject` always supplies that
runtime argument and existing Taskflow interpolation already accepts it. One
Grok-only Run removed both declarations without changing Taskflow or
CharterArc. The phase-docs repair test still proves `{args.charterarc}` reaches
the ordinary flow, including under the self-flow's strict interpolation mode.
Grok reported 12 turns and $0.3346944 for this subtraction.

## External adoption probe: cli-lab

The first independent consumer used the real `cli-lab` monorepo rather than a
fixture. Its active main worktree contained unrelated in-progress changes, so
the probe used an isolated worktree at the current committed HEAD and did not
touch that WIP. The project declaration reused the repository's authoritative
`uv run cli-lab doctor` and `smoke all` commands.

The clean checkout produced two distinct observations:

1. `doctor` passed, while `smoke all` failed because `mcp-cli` dependencies
   were not installed. CharterArc returned `unknown` and started no model;
   dependency, service, and authentication failures were not treated as source
   mutation authority.
2. After installing the existing frozen `mcp-cli` lockfile, the same declaration
   returned `satisfied`, again with no model Run.

The consumer ran against locally packed `charterarc`, `taskflow-core`, and
`taskflow-hosts` artifacts, so the default package path—not workspace source
resolution—was exercised. A focused classifier test retains the rule that
only tracked registry/package diagnostics can authorize repair; mixed
environment failures remain `unknown`.

The initial probe was not retained at that point. It is now deliberately kept
on `codex/charterarc-cli-lab-consumer` at commit `88371ea`. Before retention,
the acceptance directory was configured as Grok `read_only`—a setting later
shown not to enforce the intended relative path—the review gate lost shell
authority, and one confirmed adoption drift required the runner to fail closed
when an attempted Taskflow Run failed or blocked. One Grok-only Run
reached `drifted -> satisfied`, reported 12 turns and $0.2094324, and changed
only the runner's exit check. Independent verification passed 5/5 consumer
tests, `uv run cli-lab doctor`, and all eight registered CLI smoke commands; the
next invocation returned `satisfied` with no Run.

The retained branch still uses local private packages and is not portable to a
fresh clone. This is local adoption evidence, not a package-delivery or GA claim.

## Private packed-consumer gate

The external probe also exposed a narrower release-engineering gap: its local
tarballs worked, but the repository's packed-consumer gate covered only the
nine public Taskflow packages. A retained private-package check now builds,
packs, installs, and executes `charterarc` with its packed `taskflow-core`
dependency in a clean npm consumer. It exercises both the zero-Run satisfied
path and a confirmed-drift ordinary Taskflow Run. CharterArc remains private
and stays outside `RELEASE_PACKAGE_NAMES`; this adds evidence without creating
a public compatibility promise.

The dogfood required three Grok-only attempts and exposed why source-shaped
acceptance is insufficient:

1. Grok added the smoke, root command, and CI wiring. The live smoke passed, but
   running pnpm against the repository from its sandbox created a 763 MB local
   store.
2. Grok moved the store path under a temporary root and all 35 source-level
   checks passed. The actual command then disproved the fix: pnpm 11 rejected
   `--store-dir` in that position and tried to relink the repository install.
3. Grok moved packing into a disposable copied workspace and supplied the
   temporary store through pnpm's environment. The real
   `pnpm run test:pack-charterarc` then passed without creating `.pnpm-store`
   or changing the repository install graph.

The three Runs reported 48 turns, 253,499 input tokens, 30,258 output tokens,
1,944,960 cache-read tokens, and $1.272034. The first implementation also left
a later 57 MB partial store while being disproved; both generated stores were
moved to Trash, and the repository install was rebuilt offline from the normal
global pnpm store. The lesson is retained in executable isolation rather than
another CharterArc concept: a Grok PASS and green static contract are proposals;
the consumer command is the authority for package usability.

## External adoption probe: overstory

The second independent consumer used a clean worktree of the real `overstory`
monorepo and its existing `npm run verify` contract. The repository required a
normal build before the Pi workspace could resolve the core package; the first
Grok repair completed the entrypoint, but the review correctly blocked the
unbuilt checkout instead of claiming adoption success. After the authoritative
build and verify commands passed, a second cycle exposed that a successful
healthy no-op was silent. Grok added the complete JSON `ProjectOutcome` output,
but the outer acceptance process reached its own 120-second deadline while the
old review gate was still running, so that interrupted review was not counted
as a PASS.

A later real invocation observed the default 30-second project deadline return
`unknown` under load. Acceptance then required an explicit 120-second observer
deadline. One bounded Grok repair -> review Taskflow returned
`drifted -> satisfied`, `run.ok: true`, 12 turns, and $0.2848728. Independent
checks then passed all 274 core tests, 28 Pi tests, and 4 consumer tests; the
next project invocation returned `satisfied` with no Run.

This is retained local evidence, not portable adoption. The private CharterArc
package is installed from local tarballs, so a fresh clone cannot reproduce the
consumer until there is a deliberate package-delivery decision. The branch is
therefore evidence for M2, not a public compatibility or GA claim.

## External adoption probe: llm-arena

A third independent consumer used a clean worktree of the real `llm-arena`
repository rather than another fixture. The declaration bound the project's
existing verification contract and the same private packed-consumer path used by
overstory. Drift was real source and adoption debt, not environment noise.

Closing that debt took three bounded Grok-only Runs. Across those Runs Grok
reported 45 turns and $0.8414336. Independent checks then passed the consumer's
own suite; the next project invocation returned `satisfied` with no Run.

At that point the probe was the second retained external branch (with overstory).
Those branches copy a short Grok bootstrap each.
Extracting that bootstrap into a shared helper or CLI would add a `taskflow-hosts` dependency
to CharterArc's public surface and does not reduce the consumer-specific `observe` judgment
that still belongs in each project's declaration. Keep the framework unchanged until
package delivery makes those branches portable or a third retained consumer proves the
duplication cost is worse than a deliberate seam.

## Review capability correction

The self-consumer, cli-lab probe, and overstory probe all repeated one semantic
mistake: their review gate requested `bash` to rerun checks. The Grok runner
correctly treats any shell as mutating, so those nominal reviews selected the
workspace-write profile rather than the read-only profile. Mechanical checks
already run in the repair phase and again in the post-run observer / primary
audit; the model review does not need a shell.

Overstory now retains a consumer test proving its review argv selects the
custom read-only profile, denies mutators, and disables subagents. CharterArc
then dogfooded the same correction: a new failing acceptance test required the
self-review gate to drop `bash` and the duplicate commands. One Grok-only
repair -> review Run changed only `charterarc.project.ts`, returned
`drifted -> satisfied`, 9 turns, and $0.2798776. The next self invocation was a
zero-model no-op, and direct argv evidence selected `charterarc-self-review`.
The transition review still used the old write-capable profile because the
running DAG was captured before repair; its diff and 35 tests were audited
independently, and subsequent reviews are now fail-closed read-only.

Multiple consumers now repeat the Grok bootstrap, and three retained external
branches exist locally, but none is portable while CharterArc is private. The
third branch did not change the causal seam: each consumer still needs its own
`observe` judgment, while the repeated runner remains short. Do not add a host
factory, CLI, or third public runtime function. Reconsider that seam only after
package delivery makes retained consumers reproducible on a fresh clone or
measured runner maintenance exceeds the cost of a deliberate seam; until then
the duplication is cheaper than a new abstraction.

## Adoption burden and private release candidate

After the second external governance migration, the three retained consumer
trees contain 1,134 checked-in CharterArc lines: 659 in Project declarations,
238 in consumer acceptance, 164 in host runners, 45 in local package manifests,
and 28 in Grok sandboxes. Declarations plus acceptance are 897/1,134 lines
(79.1%); runners alone are 164/1,134 (14.5%), and all
runner/package/sandbox plumbing together is 237/1,134 (20.9%). A runner helper
would optimize the smaller part while leaving the domain-specific `observe`
classification—the part that safely separates `drifted` from `unknown`—inside
every project. The helper/CLI route remains rejected.

The shared blocker is package delivery instead: all three branches keep local
dependencies untracked, while `charterarc` remains private and outside
`RELEASE_PACKAGE_NAMES`. The existing private packed-consumer smoke covered only
`taskflow-core + charterarc` with a mock runtime, even though every retained
consumer injects `taskflow-hosts/grok`.

One Grok-only self-maintenance Run added the real three-package install and a
healthy Grok bootstrap, then reported 34 turns and $0.8091664. The primary
narrowed that result after the read-only reviewer exposed a dirty-worktree false
green: the standalone command packed `taskflow-hosts` without rebuilding it. A
second bounded Run added the missing build filter, reported 12 turns and
$0.3045456, and was accepted. Independent verification passed 37/37, rebuilt
all three packages, installed their tarballs in a fresh consumer, and still
passed with `PI_TASKFLOW_GROK_BIN` pointing to a nonexistent binary—direct
evidence that the healthy path made no model call. No repository-local pnpm
store remained.

This is a private release candidate, not a release. `charterarc` is still
`private: true`, remains outside the nine-package release list, and adds no
runtime function or host dependency. The already published `taskflow-core` and
`taskflow-hosts` 0.2.6 packages satisfy its current dependency boundary; making
CharterArc public is a separate compatibility and publication decision.

## Fail-closed outcome subtraction

The retained self runner plus all three external runners repeated the same
success rule: observed reality had to be `satisfied`, and any attempted
Taskflow Run also had to be successful. This duplication was not cosmetic. An
earlier cli-lab adoption cycle had already shown that checking only observed
reality could hide a failed or blocked maintenance attempt.

The primary bound the behavior matrix in the acceptance directory first. A
later live probe showed that the directory's relative `read_only` setting was
not an enforcement boundary, so the evidence rests on independent diff and
acceptance verification rather than that setting. The self Project then observed seven missing-property
TypeScript diagnostics, executed one ordinary Grok repair -> read-only review
Taskflow, and re-observed `satisfied`. The accepted result adds one required
`ProjectOutcome.ok` boolean while preserving `status` as a statement about
reality. `ok` is true only when the latest observation is satisfied and any
attempted Run succeeded. The self runner deleted its local helper and now exits
directly on that one fail-closed result.

Independent verification passed 37/37 CharterArc checks, rebuilt and installed
`taskflow-core + taskflow-hosts + charterarc` as packed artifacts, and exercised
both healthy and drift paths. With `PI_TASKFLOW_GROK_BIN` set to a nonexistent
binary, the healthy self invocation still returned `satisfied`, `ok: true`, and
no `run`. The Run reported 17 turns, 127,955 input tokens, 7,728 output tokens,
566,528 cache-read tokens, and $0.4722364. No new authoring field, function,
phase, host, or control plane was added.

The next consumer evidence is migration, not another framework abstraction:
each retained external runner should consume the packed `outcome.ok` contract
through its own CharterArc cycle and delete its local two-part predicate.

### First external subtraction: overstory

The overstory Project then observed its retained runner reconstructing the same
two-part success rule. Its one Grok repair and read-only review Run changed only
`.charterarc/run.mjs`: two local lines became `if (!outcome.ok)`. The Project
declaration and immutable acceptance were updated by the primary first, so the
model could neither weaken the rule nor replace it with another helper.

Independent verification passed 274 core tests, 28 Pi tests, and all four
consumer acceptance tests. A direct invocation with `PI_TASKFLOW_GROK_BIN`
pointing to a nonexistent executable returned `satisfied`, `ok: true`, and no
`run`. This is the intended net-complexity result: CharterArc added one public
result field once, while the first external consumer deleted its private
semantic copy and added no authoring concept.

The initial drift proof also exposed a test-authority mistake. The test called
the real root entrypoint while the repository was drifted, so the proof command
itself triggered the one maintenance Run and its pre-repair assertion left the
enclosing suite red. The primary did not trigger another maintenance Run. After
independent verification, the healthy-entrypoint probe was pinned to a missing
Grok binary. It can still prove the zero-Run path, but a future acceptance test
can no longer silently acquire live model authority. The nested process did not
retain its usage JSON, so that Run's turns, tokens, and cost remain unknown.

### Second external subtraction: llm-arena

The llm-arena Project independently observed the same duplicated success rule.
The primary bound a static contract that required direct `outcome.ok` use and
rejected any `runOk`, `status + run`, or alternate-host fallback. Taskflow's
zero-token verifier accepted the existing two-phase Flow with only its
intentional terminal-gate warning. One Grok repair plus read-only review Run
then changed only `.charterarc/run.mjs`, replacing the local reconstruction
with `if (!outcome.ok)`.

The Run re-observed `satisfied`, reported 10 turns, 68,205 input tokens, 2,979
output tokens, 175,104 cache-read tokens, and $0.2068152. The primary separately
verified 43/43 Python adversarial cases, Web lint with zero errors and the two
pre-existing warnings, the production build, and all five consumer acceptance
tests. With the Grok binary forced to a nonexistent path, the real entrypoint
still returned `satisfied`, `ok: true`, and no `run`.

Two independent external consumers have now deleted their private copy of the
same semantic rule while adding no authoring concept. This supports retaining
`ProjectOutcome.ok`; it does not justify a migration helper, a new Project
field, or publication.

### Third external subtraction: cli-lab

The cli-lab Project observed the last retained external copy of the old success
predicate. Before authorizing mutation, the primary verified the clean consumer
worktree and separated it from the canonical main worktree's unrelated user
changes. The current repository baseline listed eight registered CLIs, passed
`cli-lab doctor`, resolved the default profile, and passed every registered CLI
smoke. Missing optional credentials remained environment facts, never drift.

The primary then bound direct `outcome.ok` acceptance and rejected any local
`runOk`, `status + run`, or alternate-host reconstruction. Taskflow's zero-token
verifier accepted the unchanged repair-to-read-only-review Flow with only its
intentional terminal-gate warning. One Grok Run changed only
`.charterarc/run.mjs` to `if (!outcome.ok) process.exitCode = 1`, re-observed
`satisfied`, and reported 11 turns, 70,419 input tokens, 2,539 output tokens,
222,080 cache-read tokens, and $0.2226960.

Independent verification passed doctor, default-profile resolution, all eight
CLI smokes, and all five consumer acceptance tests. With the Grok binary forced
to a nonexistent path, the real entrypoint still returned `satisfied`,
`ok: true`, and no `run`. All three retained external consumers have now
deleted their private success rule while adding no authoring concept. This is
strong cross-project evidence for retaining the one result field, but it does
not establish the four-week or comparative-value claim required for release.

## First external governance migration: overstory

The self-consumer's governance correction exposed the same false safety claim
in all three retained external branches: each sandbox listed relative
`read_only` paths even though the live probe had already shown that this does
not prevent absolute-path edits. Overstory was migrated first, without a Grok
Run. Its parent launcher now snapshots the sandbox, launcher, and acceptance
tree before and after `runProject` and forces the reported result to `ok: false`
when they differ. Its observer treats a missing guard or a reintroduced
relative `read_only` declaration as `unknown`, so governance drift cannot grant
model mutation authority.

The first acceptance invocation exposed one brittle local coupling: the
observer still searched the launcher source for `outcome`, while the guarded
launcher now prints the final `reported` value. That started one ordinary
Taskflow attempt, which failed before any Grok call or mutation because the
binary was deliberately invalid. The primary corrected the observer and did
not invoke Taskflow again. Independent verification passed all four consumer
acceptance tests, the 274 core tests and 28 Pi tests behind `npm run verify`,
and a direct invalid-binary healthy invocation returned `satisfied`, `ok: true`,
and no `run`.

This migration removes an unenforced prevention claim and retains a narrower
post-Run detector; it does not make CharterArc a security boundary. It also
adds 45 net lines to the overstory launcher. That cost is real evidence against
pretending the current consumer bootstrap is already minimal. Do not extract a
public helper after one migration: apply the same correction to another
retained consumer, then compare the repeated burden with the helper surface it
would replace.

## Second external governance migration: llm-arena

llm-arena repeated the same contradiction. The primary first changed its
observer so a missing parent guard or relative `read_only` declaration is
`unknown`; the red acceptance invocation therefore exited before Taskflow and
could not call Grok. The parent launcher then gained the same pre/post snapshot
over its sandbox, launcher, and acceptance tree, while the unenforced relative
setting was removed.

Independent verification passed 43/43 Python adversarial cases, Web lint with
only the two pre-existing warnings, the production build, all six consumer
acceptance tests, and a direct invalid-binary healthy invocation returning
`satisfied`, `ok: true`, and no `run`. No Taskflow or Grok Run occurred, no
product source changed, and no public concept was added.

The second migration again added 45 net lines to the launcher. Repetition has
now crossed the minimum evidence threshold for evaluating a shared seam, but it
does not prove that a helper would be smaller: a helper must also receive file
scope, preserve independent acceptance authority, and avoid pulling Grok host
policy into CharterArc. Migrate cli-lab once under the same local contract,
then compare the exact removable duplication with the central API and tests it
would require. If the helper does not reduce the total judgment surface, reject
it and keep the explicit launchers.

## Next evidence

Migrate the same truthful governance boundary to cli-lab without a model Run
unless confirmed product drift requires one. Then make an evidence-based
retain-or-extract decision about the repeated launcher guard before returning
to naturally occurring maintenance; do not invent unrelated migrations.
Publishing the prepared CharterArc package is the next irreversible adoption
boundary and requires explicit approval; do not use a helper or new public
concept as a substitute. Add a public concept only when multiple retained
consumers cannot remain simple with `ProjectDefinition + Taskflow`.

Until then, goals, knowledge ledgers, daemons, registries, ProjectIR, new phase
kinds, and generic repository adapters stay outside the kernel.
