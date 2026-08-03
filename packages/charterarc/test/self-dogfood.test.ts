import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import project from "../../../charterarc.project.ts";
import {
	configureDogfoodGrokSandbox,
	dogfoodSucceeded,
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

test("self-dogfood project: Grok cannot move the acceptance boundary", async () => {
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
	assert.match(
		sandbox,
		/read_only = \["\.grok", "packages\/charterarc\/test"\]/,
	);
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

test("self-dogfood runner: a blocked maintenance Run cannot exit successfully", () => {
	assert.equal(dogfoodSucceeded({
		status: "satisfied",
		before: { status: "drifted" },
		run: { ok: false },
		after: { status: "satisfied" },
	}), false);
	assert.equal(dogfoodSucceeded({
		status: "satisfied",
		before: { status: "satisfied" },
	}), true);
	assert.equal(dogfoodSucceeded({
		status: "satisfied",
		before: { status: "drifted" },
		run: { ok: true },
		after: { status: "satisfied" },
	}), true);
	assert.equal(dogfoodSucceeded({
		status: "unknown",
		before: { status: "unknown" },
	}), false);
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
	assert.match(evidence, /two retained external branches/);
	assert.match(evidence, /does not reduce the consumer-specific `observe` judgment/);
	assert.match(evidence, /would add a `taskflow-hosts` dependency/);
	assert.doesNotMatch(evidence, /only one external branch is\s+locally retained/);
});

test("longitudinal evidence: measures M4 without turning evidence into runtime state", async () => {
	const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
	const [goal, metrics] = await Promise.all([
		readFile(path.join(root, "docs/internal/charterarc-autonomous-goal.md"), "utf8"),
		readFile(path.join(root, "docs/internal/charterarc-cycle-metrics.md"), "utf8").catch(() => ""),
	]);
	assert.match(goal, /\[cycle metrics\]\(\.\/charterarc-cycle-metrics\.md\)/);
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
		"Turns",
		"Reported USD",
		"Tokens in/out/cache",
		"Public concept",
		"Safety incidents",
	]);

	const expectedRows = [
		["2026-08-03-charterarc-readonly-review", "CharterArc", "yes", "accepted", "9", "0.2798776", "—", "36/36; read-only argv selected", "healthy no-Run next", "none"],
		["2026-08-03-overstory-observer-timeout", "overstory", "yes", "accepted", "12", "0.2848728", "—", "274 core + 28 Pi + 4 consumer", "healthy no-Run next", "none"],
		["2026-08-03-llm-entrypoint", "llm-arena", "yes", "accepted", "15", "0.2609692", "64,709/3,730/363,904", "4/4 adoption acceptance; post-observer exposed hooks drift", "entrypoint retained", "none"],
		["2026-08-03-llm-hooks", "llm-arena", "yes", "accepted", "12", "0.2492156", "75,415/4,756/232,832", "43/43 Python; lint 0 errors/2 warnings; build; 4/4 acceptance", "post-observer satisfied", "none"],
		["2026-08-03-llm-ignore", "llm-arena", "yes", "accepted", "18", "0.3312488", "102,490/4,136/338,176", "git check-ignore; 5/5 acceptance; healthy no-Run", "retained external branch", "none"],
		["2026-08-03-charterarc-adoption-evidence", "CharterArc", "no", "narrowed", "17", "0.4741136", "139,600/7,212/505,472", "36/36; primary rejected test-debt claim", "reworked next row", "avoided CLI"],
		["2026-08-03-charterarc-fact-correction", "CharterArc", "no", "accepted", "10", "0.3399076", "130,430/2,909/205,312", "36/36; healthy no-Run", "accepted correction", "avoided CLI"],
		["2026-08-03-charterarc-metrics-bootstrap", "CharterArc", "no", "narrowed", "12", "0.3288048", "89,256/6,764/365,696", "37/37; primary narrowed semantics/provenance", "reworked by current refresh", "none"],
		["2026-08-03-charterarc-metrics-correction", "CharterArc", "no", "accepted", "13", "0.3560392", "91,295/8,729/403,584", "37/37; healthy no-Run", "metrics semantics retained", "none"],
		["2026-08-03-llm-paired-single", "llm-arena replay", "no", "accepted", "4", "0.1077940", "33,194/2,581/86,400", "43/43; lint; build; byte-identical output", "comparison only; no M4 credit", "none"],
		["2026-08-03-llm-paired-charterarc", "llm-arena replay", "no", "accepted", "9", "0.2013040", "66,989/3,989/144,640", "43/43; lint; build; 5/5 acceptance; byte-identical output", "comparison only; no M4 credit", "none"],
	] as const;
	for (const [id, projectName, countForM4, decision, turns, cost, tokens, verification, followUp, publicConcept] of expectedRows) {
		const fields = metrics
			.split("\n")
			.find((line) => line.startsWith(`| ${id} |`))
			?.split("|")
			.slice(1, -1)
			.map((field) => field.trim());
		assert.ok(fields, `missing metrics row ${id}`);
		assert.equal(fields[0], id);
		assert.equal(fields[1], projectName);
		assert.equal(fields[2], countForM4);
		assert.equal(fields[3], decision);
		assert.equal(fields[4], "0");
		assert.equal(fields[5], "0");
		assert.equal(fields[6], "—");
		assert.equal(fields[7], verification);
		assert.equal(fields[8], followUp);
		assert.equal(fields[9], turns);
		assert.equal(fields[10], cost);
		assert.equal(fields[11], tokens);
		assert.equal(fields[12], publicConcept);
		assert.equal(fields[13], "0/0/0");
	}

	assert.match(metrics, /M4 counted sample: 5\/20 cycles across 3\/3 retained projects/);
	assert.match(metrics, /Observation window: less than 1\/4 weeks/);
	assert.match(metrics, /Comparison baseline: one matched replay; human judgment baseline still `—`/);
	assert.match(metrics, /Eleven Grok Runs reported 131 turns and \$3\.2141472/);
	assert.match(
		metrics,
		/Nine fully reported rows total 793,378 input, 44,806 output, and 2,646,016 cache-read tokens/,
	);
	assert.match(metrics, /Pending next refresh: current comparison-evidence recording Run/);
	assert.match(metrics, /## Matched replay: small deterministic repair/);
	assert.match(metrics, /Both arms started from SHA-256 `05a0fccca1dd9771688483acd0d5c9d9e94d70a60b7a432d5056e712ca70f2f4`/);
	assert.match(metrics, /Both produced SHA-256 `0d91c5151e1d4df74c57725022ae1a9a8c76484e4ea3e76350ecd7f6a968a36f`/);
	assert.match(metrics, /\| Single Grok Taskflow \| repair only \| 40\.377 s \| 4 \| \$0\.1077940 \|/);
	assert.match(metrics, /\| CharterArc \| observe, repair, read-only review, re-observe \| 74\.50 s \| 9 \| \$0\.2013040 \|/);
	assert.match(metrics, /84\.5% more wall time, 125\.0% more turns, and 86\.7% more reported cost/);
	assert.match(metrics, /does not show a speed, token, cost, or output-quality advantage/);
	assert.match(metrics, /human diagnosis, acceptance design, or review time/);
	assert.match(metrics, /does not count toward the 20 natural maintenance cycles/);
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
	assert.match(
		sandbox,
		/\[profiles\.charterarc-self-write\][\s\S]*read_only = \["\.grok", "packages\/charterarc\/test"\]/,
	);
	assert.match(sandbox, /\[profiles\.charterarc-self-review\][\s\S]*extends = "read-only"/);
	assert.match(sandbox, /\[shell_environment_policy\][\s\S]*inherit = "core"/);
});
