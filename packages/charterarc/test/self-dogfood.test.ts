import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import project from "../../../charterarc.project.ts";
import {
	configureDogfoodGrokSandbox,
	dogfoodAcceptanceDigest,
	dogfoodGovernanceDigest,
} from "../../../scripts/dogfood-charterarc.mts";
import { runProject } from "../src/index.ts";
import { buildGrokArgs } from "taskflow-hosts/grok";

test("self-dogfood project: uses one ordinary Taskflow", () => {
	assert.equal(project.maintain.name, "maintain-charterarc");
	assert.equal(project.maintain.args, undefined);
	assert.equal(project.maintain.strictInterpolation, true);
	assert.deepEqual(
		project.maintain.phases.map((phase) => [phase.id, phase.type]),
		[
			["repair", "agent"],
			["review", "gate"],
		],
	);
	assert.equal(project.maintain.phases[1]?.final, true);
});

test("self-dogfood project: repair checks directly and review is actually read-only", () => {
	const directChecks = [
		"node node_modules/typescript/bin/tsc --noEmit -p packages/charterarc/tsconfig.check.json",
		"node --conditions=development --experimental-strip-types --test-reporter=tap --test 'packages/charterarc/test/*.test.ts'",
	];
	for (const phase of project.maintain.phases) {
		const task = phase.task;
		if (typeof task !== "string") {
			assert.fail(`phase ${phase.id} is missing a string task`);
		}
		assert.doesNotMatch(task, /\b(?:pnpm|npm|yarn|bun)\b/);
	}

	const repair = project.maintain.phases.find((phase) => phase.id === "repair");
	const review = project.maintain.phases.find((phase) => phase.id === "review");
	assert.ok(repair);
	assert.ok(review);
	const repairTask = repair.task;
	const reviewTask = review.task;
	if (typeof repairTask !== "string" || typeof reviewTask !== "string") {
		assert.fail("repair and review must both declare string tasks");
	}
	for (const command of directChecks) {
		assert.match(
			repairTask,
			new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.doesNotMatch(
			reviewTask,
			new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}
	assert.equal(review.tools?.includes("bash"), false);
	assert.match(reviewTask, /post-run observer.*primary agent.*authoritative checks/is);

	const args = buildGrokArgs({
		systemPrompt: "",
		task: reviewTask,
		tools: review.tools,
		mutatingSandboxProfile: "charterarc-self-write",
		readOnlySandboxProfile: "charterarc-self-review",
	});
	assert.equal(args[args.indexOf("--sandbox") + 1], "charterarc-self-review");
	assert.ok(args.includes("--disallowed-tools"));
	assert.ok(args.includes("--no-subagents"));
});

test("self-dogfood project: Grok cannot report success after moving governance", async () => {
	const repair = project.maintain.phases.find((phase) => phase.id === "repair")?.task;
	const review = project.maintain.phases.find((phase) => phase.id === "review")?.task;
	assert.equal(typeof repair, "string");
	assert.equal(typeof review, "string");
	assert.match(repair ?? "", /packages\/charterarc\/test is immutable acceptance/);
	assert.match(repair ?? "", /Do not preserve removed fields as optional/);
	assert.match(review ?? "", /BLOCK if .*packages\/charterarc\/test changed/);
	assert.match(review ?? "", /compatibility alias/);

	const sandbox = await readFile(
		path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../.grok/sandbox.toml"),
		"utf8",
	);
	const launcher = await readFile(
		path.resolve(
			path.dirname(new URL(import.meta.url).pathname),
			"../../../scripts/dogfood-charterarc.mts",
		),
		"utf8",
	);
	assert.doesNotMatch(sandbox, /^(?:read_only|deny)\s*=/m);
	for (const governed of [
		".grok/sandbox.toml",
		"charterarc.project.ts",
		"scripts/dogfood-charterarc.mts",
		"docs/internal/charterarc-autonomous-goal.md",
		"docs/internal/charterarc-cycle-metrics.md",
	]) {
		assert.match(launcher, new RegExp(governed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(launcher, /governanceBefore = dogfoodGovernanceDigest\(cwd\)/);
	assert.match(launcher, /governanceUnchanged = governanceBefore === governanceAfter/);
	assert.match(launcher, /ok: false,[\s\S]*governanceUnchanged: false/);
});

test("self-dogfood runner: acceptance digest covers content and membership", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-digest-"));
	try {
		const acceptance = path.join(cwd, "packages/charterarc/test");
		await mkdir(acceptance, { recursive: true });
		await writeFile(path.join(acceptance, "one.test.ts"), "one");
		const first = dogfoodAcceptanceDigest(cwd);
		await writeFile(path.join(acceptance, "one.test.ts"), "two");
		const changed = dogfoodAcceptanceDigest(cwd);
		await writeFile(path.join(acceptance, "two.test.ts"), "three");
		const added = dogfoodAcceptanceDigest(cwd);
		assert.notEqual(changed, first);
		assert.notEqual(added, changed);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood runner: governance digest covers the protected control files", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-governance-digest-"));
	try {
		const governed = [
			".grok/sandbox.toml",
			"charterarc.project.ts",
			"scripts/dogfood-charterarc.mts",
			"docs/internal/charterarc-autonomous-goal.md",
			"docs/internal/charterarc-cycle-metrics.md",
			"packages/charterarc/test/acceptance.test.ts",
		];
		for (const relative of governed) {
			const file = path.join(cwd, relative);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, relative);
		}
		const first = dogfoodGovernanceDigest(cwd);
		await writeFile(path.join(cwd, "charterarc.project.ts"), "changed");
		assert.notEqual(dogfoodGovernanceDigest(cwd), first);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

async function fixtureRepo(tsc: string): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-self-"));
	await mkdir(path.join(cwd, "packages/charterarc/test"), { recursive: true });
	await mkdir(path.join(cwd, "node_modules/typescript/bin"), { recursive: true });
	await writeFile(path.join(cwd, "package.json"), '{"name":"pi-taskflow-monorepo"}');
	await writeFile(
		path.join(cwd, "packages/charterarc/package.json"),
		'{"name":"charterarc"}',
	);
	await writeFile(path.join(cwd, "node_modules/typescript/bin/tsc"), tsc);
	return cwd;
}

test("self-dogfood project: wrong repository identity is unknown and cannot run", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "charterarc-self-"));
	try {
		let tasks = 0;
		const outcome = await runProject(project, {
			taskflow: {
				cwd,
				agents: [],
				async runTask() {
					tasks += 1;
					throw new Error("unknown evidence must not run maintenance");
				},
			},
		});

		assert.equal(outcome.status, "unknown");
		assert.match(outcome.before.summary ?? "", /not the checked Taskflow\/CharterArc repository/);
		assert.equal(tasks, 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood project: a TypeScript diagnostic is confirmed drift", async () => {
	const cwd = await fixtureRepo(
		'process.stderr.write("fixture.ts(1,1): error TS9999: checked failure\\n");process.exit(2);',
	);
	try {
		const result = await project.observe({
			cwd,
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "drifted");
		assert.match(result.summary ?? "", /error TS9999/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood project: a failing acceptance test is confirmed drift", async () => {
	const cwd = await fixtureRepo("process.exit(0);");
	try {
		await writeFile(
			path.join(cwd, "packages/charterarc/test/contract.test.ts"),
			'import { test } from "node:test";test("fixture",()=>{throw new Error("checked failure")});',
		);
		const result = await project.observe({
			cwd,
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "drifted");
		assert.match(result.summary ?? "", /# fail 1/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood project: inherited Node test filters cannot create a false green", async () => {
	const cwd = await fixtureRepo("process.exit(0);");
	const previousNodeOptions = process.env.NODE_OPTIONS;
	try {
		await writeFile(
			path.join(cwd, "packages/charterarc/test/contract.test.ts"),
			'import { test } from "node:test";test("fixture",()=>{throw new Error("checked failure")});',
		);
		process.env.NODE_OPTIONS = "--test-only";
		const result = await project.observe({
			cwd,
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "drifted");
	} finally {
		if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = previousNodeOptions;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood project: an empty acceptance suite is not satisfied", async () => {
	const cwd = await fixtureRepo("process.exit(0);");
	try {
		const result = await project.observe({
			cwd,
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "unknown");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood project: an unclassified command failure is unknown", async () => {
	const cwd = await fixtureRepo(
		'process.stderr.write("opaque tool failure\\n");process.exit(2);',
	);
	try {
		const result = await project.observe({
			cwd,
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "unknown");
		assert.match(result.summary ?? "", /without a trusted contract failure/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("self-dogfood runner: combines ProjectOutcome with primary-owned governance", async () => {
	const source = await readFile(
		path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../scripts/dogfood-charterarc.mts"),
		"utf8",
	);
	assert.match(source, /governanceUnchanged\s*\?\s*outcome/);
	assert.match(source, /if\s*\(\s*!reported\.ok\s*\)/);
	assert.doesNotMatch(source, /dogfoodSucceeded|outcome\.run\?\.ok/);
});

test("self-dogfood runner: binds every model phase to Grok Build only", async () => {
	const source = await readFile(
		path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../scripts/dogfood-charterarc.mts"),
		"utf8",
	);
	assert.match(source, /from "taskflow-hosts\/grok"/);
	assert.match(source, /runTask: grokSubagentRunner\.runTask/);
	assert.doesNotMatch(source, /(?:codex|claude|opencode|pi)SubagentRunner/);
});

test("adoption evidence: records llm-arena without promoting bootstrap into a CLI", async () => {
	const evidence = await readFile(
		path.resolve(
			path.dirname(new URL(import.meta.url).pathname),
			"../../../docs/internal/charterarc-refactor.md",
		),
		"utf8",
	);
	assert.match(evidence, /## External adoption probe: llm-arena/);
	assert.match(evidence, /three bounded Grok-only Runs/);
	assert.match(evidence, /45 turns/);
	assert.match(evidence, /\$0\.8414336/);
	assert.match(evidence, /Drift was real source and adoption debt/);
	assert.doesNotMatch(evidence, /Drift was real source and test debt/);
	assert.match(evidence, /three retained external\s+branches/);
	assert.match(evidence, /codex\/charterarc-cli-lab-consumer/);
	assert.match(evidence, /5\/5 consumer\s+tests/);
	assert.match(evidence, /does not reduce the consumer-specific `observe` judgment/);
	assert.match(evidence, /would add a `taskflow-hosts` dependency/);
	assert.doesNotMatch(evidence, /only one external branch is\s+locally retained/);
});

test("longitudinal evidence: measures M4 without turning evidence into runtime state", async () => {
	const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const [goal, metrics, readme] = await Promise.all([
		readFile(path.join(root, "docs/internal/charterarc-autonomous-goal.md"), "utf8"),
		readFile(path.join(root, "docs/internal/charterarc-cycle-metrics.md"), "utf8").catch(() => ""),
		readFile(path.join(root, "packages/charterarc/README.md"), "utf8"),
	]);
	assert.match(goal, /\[cycle metrics\]\(\.\/charterarc-cycle-metrics\.md\)/);
	assert.match(goal, /At least three independent, real repositories choose to keep a Project/);
	assert.match(metrics, /Status: internal experiment evidence, not runtime state\./);
	assert.match(
		metrics,
		/A counted cycle requires confirmed drift in a retained Project and one ordinary Taskflow Run\./,
	);
	assert.match(
		metrics,
		/Healthy no-ops, `unknown`, and evidence-only bookkeeping do not increase the M4 cycle count\./,
	);
	assert.match(metrics, /Evidence-only Runs remain charged as overhead\./);
	assert.match(metrics, /`0` means directly observed zero; `—` means not measured\./);
	assert.match(
		metrics,
		/Safety incidents are unknown-authorized mutation\/accepted acceptance tampering\/accepted undeclared scope\./,
	);
	assert.match(
		metrics,
		/A Run that writes this sample is appended by the next refresh; it stays pending rather than becoming zero\./,
	);
	assert.doesNotMatch(`${goal}\n${metrics}`, /\bledger\b/i);

	const header = metrics
		.split("\n")
		.find((line) => line.startsWith("| ID |"))
		?.split("|")
		.slice(1, -1)
		.map((field) => field.trim());
	assert.deepEqual(header, [
		"ID",
		"Project",
		"M4",
		"Decision",
		"User interventions",
		"Human min",
		"Verified min",
		"Verification",
		"Follow-up",
		"7d rework/rollback",
		"Turns",
		"Reported USD",
		"Tokens in/out/cache",
		"Public concept",
		"Safety incidents",
	]);

	assert.match(metrics, /Empirical rows and totals are evidence, not product acceptance\./);
	assert.match(metrics, /Changing them must not trigger a CharterArc maintenance Run\./);
	assert.match(metrics, /do not infer minutes\s+from message count or reply gaps\./);
	assert.match(metrics, /A Run duration alone is\s+not this measure/);
	assert.match(metrics, /a zero or\s+missing baseline median cannot establish the claim\./);
	assert.match(metrics, /## Prospective baseline assignment/);
	assert.match(
		metrics,
		/For each retained external repository with zero eligible baseline rows, assign its next naturally occurring, low-risk, reversible maintenance need to the baseline before implementation\./,
	);
	assert.match(metrics, /Baseline assignment happens before inspecting a candidate solution/);
	assert.match(
		metrics,
		/one ordinary Taskflow Run with exactly one Grok `agent` repair phase/,
	);
	assert.match(metrics, /same immutable acceptance[\s\S]*authoritative verification/);
	assert.match(metrics, /Do not run both arms[\s\S]*accepted real change/);
	assert.match(metrics, /Baseline Runs do not increase the M4 counted sample/);
	assert.match(metrics, /Unknown[\s\S]*does not authorize mutation/i);
	assert.match(
		metrics,
		/After every retained external repository has one eligible baseline, alternate eligible needs within each repository/,
	);
	assert.match(
		readme,
		/remains private until M4\s+comparative evidence supports an explicit release decision/,
	);
});

test("self-dogfood runner: defaults to checked-in fail-closed Grok sandboxes", async () => {
	const env: NodeJS.ProcessEnv = {};
	configureDogfoodGrokSandbox(env);
	assert.equal(
		env.PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE,
		"charterarc-self-write",
	);
	assert.equal(
		env.PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE,
		"charterarc-self-review",
	);

	const custom: NodeJS.ProcessEnv = {
		PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE: "operator-write",
		PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE: "operator-review",
	};
	configureDogfoodGrokSandbox(custom);
	assert.equal(custom.PI_TASKFLOW_GROK_MUTATING_SANDBOX_PROFILE, "operator-write");
	assert.equal(custom.PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE, "operator-review");

	const sandbox = await readFile(
		path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../.grok/sandbox.toml"),
		"utf8",
	);
	assert.match(sandbox, /\[profiles\.charterarc-self-write\][\s\S]*extends = "workspace"/);
	assert.doesNotMatch(sandbox, /^(?:read_only|deny)\s*=/m);
	assert.match(sandbox, /\[profiles\.charterarc-self-review\][\s\S]*extends = "read-only"/);
	assert.match(sandbox, /\[shell_environment_policy\][\s\S]*inherit = "core"/);
});
