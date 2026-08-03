import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	defineProject,
	type ObservationResult,
} from "charterarc";
import type { Taskflow } from "taskflow-core";

const MAX_EVIDENCE_CHARS = 4_000;
const TYPECHECK_ARGS = [
	"node_modules/typescript/bin/tsc",
	"--noEmit",
	"-p",
	"packages/charterarc/tsconfig.check.json",
] as const;
const TEST_ARGS = [
	"--conditions=development",
	"--experimental-strip-types",
	"--test-reporter=tap",
	"--test",
	"packages/charterarc/test/*.test.ts",
] as const;

interface CheckResult {
	readonly error: Error | null;
	readonly stdout: string;
	readonly stderr: string;
}

function runNode(
	cwd: string,
	args: readonly string[],
	signal: AbortSignal,
): Promise<CheckResult> {
	return new Promise((resolve) => {
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		delete env.NODE_OPTIONS;
		execFile(
			process.execPath,
			[...args],
			{
				cwd,
				encoding: "utf8",
				env,
				maxBuffer: 2 * 1024 * 1024,
				signal,
			},
			(error, stdout, stderr) => {
				resolve({
					error,
					stdout,
					stderr,
				});
			},
		);
	});
}

function boundedEvidence(result: CheckResult): string {
	const output = [
		result.stdout,
		result.stderr,
		result.error?.message ?? "",
	]
		.filter(Boolean)
		.join("\n")
		.trim();
	return output.length <= MAX_EVIDENCE_CHARS
		? output
		: `…${output.slice(-(MAX_EVIDENCE_CHARS - 1))}`;
}

function exitCode(error: Error | null): number | undefined {
	if (error === null || !("code" in error)) return undefined;
	return typeof error.code === "number" ? error.code : undefined;
}

function classifyFailure(
	kind: "typecheck" | "tests",
	result: CheckResult,
): ObservationResult {
	const evidence = boundedEvidence(result);
	const sentinel =
		kind === "typecheck"
			? /(?:^|\n)[^\n]*error TS\d{4}:/m
			: /(?:^|\n)# fail [1-9]\d*(?:\n|$)/m;
	const infrastructureFailure =
		/Cannot find module|MODULE_NOT_FOUND|ERR_CHILD_PROCESS|ENOENT/i.test(evidence);
	if (
		exitCode(result.error) !== undefined &&
		!infrastructureFailure &&
		sentinel.test(evidence)
	) {
		return {
			status: "drifted",
			target: { desired: kind },
			facts: { check: kind, exitCode: exitCode(result.error) },
			summary: `${kind} found a checked contract failure:\n${evidence}`,
		};
	}
	return {
		status: "unknown",
		facts: { check: kind, exitCode: exitCode(result.error) },
		summary: `${kind} failed without a trusted contract failure:\n${evidence}`,
	};
}

async function packageName(cwd: string, relativePath: string): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(join(cwd, relativePath), "utf8"));
		if (typeof value !== "object" || value === null || !("name" in value)) return undefined;
		return typeof value.name === "string" ? value.name : undefined;
	} catch {
		return undefined;
	}
}

async function observeSelf({
	cwd,
	signal,
}: {
	readonly cwd: string;
	readonly signal: AbortSignal;
}): Promise<ObservationResult> {
	const [rootName, charterArcName] = await Promise.all([
		packageName(cwd, "package.json"),
		packageName(cwd, "packages/charterarc/package.json"),
	]);
	if (rootName !== "pi-taskflow-monorepo" || charterArcName !== "charterarc") {
		return {
			status: "unknown",
			facts: { repositoryIdentity: "mismatch" },
			summary: "self-dogfood cwd is not the checked Taskflow/CharterArc repository",
		};
	}

	signal.throwIfAborted();
	const typecheck = await runNode(cwd, TYPECHECK_ARGS, signal);
	signal.throwIfAborted();
	if (typecheck.error !== null) return classifyFailure("typecheck", typecheck);

	const tests = await runNode(cwd, TEST_ARGS, signal);
	signal.throwIfAborted();
	if (tests.error !== null) return classifyFailure("tests", tests);
	return /(?:^|\n)# tests [1-9]\d*(?:\n|$)/m.test(tests.stdout)
		? { status: "satisfied", facts: { typecheck: "passed", tests: "passed" } }
		: {
				status: "unknown",
				facts: { typecheck: "passed", tests: "not-observed" },
				summary: `tests completed without executing an acceptance test:\n${boundedEvidence(tests)}`,
			};
}

function maintenanceFlow(name: string, focus: string): Taskflow {
	return {
		name,
		strictInterpolation: true,
		phases: [
			{
				id: "repair",
				type: "agent",
				agent: "executor-fast",
				tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
				thinking: "low",
				timeout: 300_000,
				task:
					`Repair the checked CharterArc ${focus} contract failure:\n\n` +
					"{args.charterarc.snapshot.summary}\n\n" +
					"Make the smallest causal implementation change. Preserve unrelated work. " +
					"Edit only packages/charterarc/src, packages/charterarc/README.md, or " +
					"examples/charterarc-phase-docs.ts when the checked evidence directly " +
					"requires it. Do not edit charterarc.project.ts, scripts, package metadata, " +
					"docs/internal, or any other path. " +
					"packages/charterarc/test is immutable acceptance: do not edit, delete, rename, " +
					"or weaken anything under it. Do not preserve removed fields as optional values " +
					"or compatibility aliases: CharterArc is pre-stable and the acceptance test is the " +
					"exact API. Public surface may grow only when immutable acceptance requires the " +
					"current Project / optional Module / Flow vertical slice. Do not add a second " +
					"control plane or Taskflow execution primitive, install dependencies, stage, " +
					"commit, or push. Before " +
					"reporting the on-disk result, run both direct checks (no package manager):\n" +
					"node node_modules/typescript/bin/tsc --noEmit -p packages/charterarc/tsconfig.check.json\n" +
					"node --conditions=development --experimental-strip-types --test-reporter=tap --test 'packages/charterarc/test/*.test.ts'",
			},
			{
				id: "review",
				type: "gate",
				agent: "reviewer",
				tools: ["read", "grep", "find", "ls"],
				timeout: 300_000,
				dependsOn: ["repair"],
				final: true,
				task:
					"Review the CharterArc self-maintenance result without editing files.\n\n" +
					`Selected contract: ${focus}\n\n` +
					"Original evidence:\n{args.charterarc.snapshot.summary}\n\n" +
					"Repair report:\n{steps.repair.output}\n\n" +
					"Do not re-run checks yourself. The post-run observer and primary agent re-run " +
					"the authoritative checks after this review. Inspect the repair report and " +
					"visible diff only.\n" +
					"BLOCK if any changed path is outside packages/charterarc/src, " +
					"packages/charterarc/README.md, and examples/charterarc-phase-docs.ts, or " +
					"if a docs/example change was not directly required by acceptance. " +
					"BLOCK if anything under packages/charterarc/test changed, the " +
					"change weakens acceptance or touches unrelated work, " +
					"keeps a removed field or compatibility alias, " +
					"expands the authoring surface beyond Project, optional Module, and ordinary " +
					"Taskflow values without immutable acceptance, adds model planning before the " +
					"deterministic selection slice requires it, or adds a scheduler, daemon, registry, " +
					"ledger, second IR, or phase. " +
					"BLOCK if experimental distribution can set latest, enter the stable multi-package " +
					"release, or publish without exact-artifact preflight and provenance verification. " +
					"BLOCK if any factual or quantitative claim is unsupported by the visible evidence; " +
					"mark it unmeasured instead of inferring. " +
					"End with VERDICT: PASS or VERDICT: BLOCK.",
			},
		],
	};
}

const maintain = {
	typecheck: maintenanceFlow("maintain-charterarc-types", "typecheck"),
	tests: maintenanceFlow("maintain-charterarc-tests", "acceptance-test"),
} as const;

export default defineProject({
	desired: {
		typecheck: "CharterArc and its retained declarations typecheck without emit.",
		tests: "Every immutable CharterArc acceptance test passes.",
	},
	observe: observeSelf,
	maintain,
});
