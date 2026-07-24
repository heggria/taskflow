import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import {
	CONTROL_STORE_SCHEMA_VERSION,
	inspectProjectControlStore,
	linkProgram,
	openProjectControlStore,
	projectApprovalsDir,
	projectApprovalRecoveryIndexPath,
	projectArtifactBlobsDir,
	projectArtifactMetadataDir,
	projectBoundPlansDir,
	projectCommandsDir,
	projectControlRoot,
	projectHeaderPath,
	projectJournalDir,
	projectProjectionsDir,
	projectReceiptsDir,
	projectRunIndexPath,
	registryPath,
	userControlRoot,
} from "../packages/taskflow-control/dist/index.js";
import { WEB_PRIMARY_NODE_VERSION } from "./web-runtime-versions.mjs";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const cliBin = path.join(
	repositoryRoot,
	"packages/taskflow-cli/dist/bin.js",
);
const fixtureRoot = path.join(
	repositoryRoot,
	"output/playwright/beta2-web-bench-fixture",
);
const PERF_SEED = 0x54465331;
const PROJECT_COUNT = 100;
const RUNS_PER_PROJECT = 100;
const RUN_COUNT = PROJECT_COUNT * RUNS_PER_PROJECT;
const GRAPH_NODE_COUNT = 2_000;
const BASE_TIME = 1_800_000_000_000;

const argv = new Set(process.argv.slice(2));
const smoke = argv.has("--smoke");
const regenerate = !argv.has("--reuse-fixture");
const fixtureOnly = argv.has("--fixture-only");
const samplesArg = process.argv.find((value) =>
	value.startsWith("--samples="),
);
const samples = samplesArg
	? Number(samplesArg.slice("--samples=".length))
	: smoke
		? 1
		: 30;
const warmups = smoke ? 0 : 3;
if (!Number.isInteger(samples) || samples < 1 || samples > 100) {
	throw new TypeError("--samples must be an integer in [1, 100]");
}

function sha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonical(value) {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonical(value[key])}`,
		)
		.join(",")}}`;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${canonical(value)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function safeIndex(value, width = 3) {
	return String(value).padStart(width, "0");
}

function createPlans() {
	const small = linkProgram({
		program: {
			name: "Performance workflow",
			phases: [
				{
					id: "phase-main",
					type: "script",
					run: "printf perf",
					final: true,
				},
			],
		},
	});
	assert.equal(small.ok, true);
	if (!small.ok) throw new Error(small.errors.join("; "));

	const phases = Array.from(
		{ length: GRAPH_NODE_COUNT },
		(_, index) => ({
			id: `phase-${safeIndex(index, 4)}`,
			type: "script",
			run: "printf perf",
			...(index === 0
				? {}
				: {
						dependsOn: [
							`phase-${safeIndex(index - 1, 4)}`,
						],
					}),
			...(index === GRAPH_NODE_COUNT - 1
				? { final: true }
				: {}),
		}),
	);
	const graph = linkProgram({
		program: {
			name: "2,000-step performance workflow",
			phases,
		},
	});
	assert.equal(graph.ok, true);
	if (!graph.ok) throw new Error(graph.errors.join("; "));
	return {
		small: { ...small.boundPlan, createdAt: BASE_TIME },
		graph: { ...graph.boundPlan, createdAt: BASE_TIME },
	};
}

function projectPaths(projectRoot) {
	return [
		projectControlRoot(projectRoot),
		projectJournalDir(projectRoot),
		projectProjectionsDir(projectRoot),
		projectBoundPlansDir(projectRoot),
		projectCommandsDir(projectRoot),
		projectReceiptsDir(projectRoot),
		projectApprovalsDir(projectRoot),
		projectArtifactMetadataDir(projectRoot),
		projectArtifactBlobsDir(projectRoot),
	];
}

function planFile(projectRoot, plan) {
	return path.join(
		projectBoundPlansDir(projectRoot),
		`${plan.boundPlanHash.replace(":", "-")}.json`,
	);
}

function runState(projectIndex, runIndex) {
	if (runIndex === 0) {
		if (projectIndex < 50) {
			return { status: "paused", stage: "parked" };
		}
		return { status: "running", stage: "executing" };
	}
	if (runIndex === 1) {
		if (projectIndex >= 50) {
			return { status: "unknown", stage: "reconciling" };
		}
		return { status: "running", stage: "executing" };
	}
	return { status: "completed", stage: "terminal" };
}

function singleNode(status) {
	return [
		{
			nodeInstanceId: "phase-main",
			phaseId: "phase-main",
			phaseType: "script",
			origin: "bound-plan",
			status:
				status === "completed"
					? "completed"
					: status === "unknown"
						? "running"
						: status === "paused"
							? "waiting"
							: "running",
			attemptCount: status === "paused" ? 0 : 1,
			ordinal: 0,
			displayLabel: "Performance step",
		},
	];
}

function graphNodes() {
	return Array.from(
		{ length: GRAPH_NODE_COUNT },
		(_, index) => ({
			nodeInstanceId: `phase-${safeIndex(index, 4)}`,
			phaseId: `phase-${safeIndex(index, 4)}`,
			phaseType: "script",
			origin: "bound-plan",
			status: "completed",
			attemptCount: 1,
			ordinal: index,
			displayLabel: `Performance step ${index + 1}`,
		}),
	);
}

function generateFixture() {
	const buildRoot = fs.mkdtempSync(
		path.join(path.dirname(fixtureRoot), ".web-bench-build-"),
	);
	const finalHome = path.join(fixtureRoot, "home");
	const buildHome = path.join(buildRoot, "home");
	const plans = createPlans();
	const entries = [];
	let activeRuns = 0;
	let approvalCount = 0;
	let attentionCount = 0;
	let receiptCount = 0;
	let artifactCount = 0;

	try {
		for (
			let projectIndex = 0;
			projectIndex < PROJECT_COUNT;
			projectIndex += 1
		) {
			const projectName = `project-${safeIndex(projectIndex)}`;
			const projectRoot = path.join(buildRoot, "projects", projectName);
			const finalProjectRoot = path.join(
				fixtureRoot,
				"projects",
				projectName,
			);
			for (const dir of projectPaths(projectRoot)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			const projectId = `proj-perf-${safeIndex(projectIndex)}`;
			const controlDomainId = `dom-perf-${safeIndex(projectIndex)}`;
			const observedAt = BASE_TIME + projectIndex * 1_000_000;
			const header = {
				schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
				projectId,
				controlDomainId,
				directoryBinding: { path: finalProjectRoot },
				createdAt: observedAt,
				updatedAt: observedAt + RUNS_PER_PROJECT,
			};
			writeJson(projectHeaderPath(projectRoot), header);
			const plan =
				projectIndex === 0 ? plans.graph : plans.small;
			writeJson(planFile(projectRoot, plan), plan);
			const journalEvents = [];
			const projectRuns = [];

			for (
				let runIndex = 0;
				runIndex < RUNS_PER_PROJECT;
				runIndex += 1
			) {
				const runId =
					`run-perf-${safeIndex(projectIndex)}-${safeIndex(runIndex)}`;
				const state = runState(projectIndex, runIndex);
				const isActive = [
					"running",
					"paused",
					"blocked",
					"unknown",
				].includes(state.status);
				if (isActive) activeRuns += 1;
				const approvalRequestId =
					projectIndex < 50 && runIndex === 0
						? `apr-perf-${safeIndex(projectIndex)}`
						: undefined;
				if (approvalRequestId) {
					approvalCount += 1;
					attentionCount += 1;
				}
				if (state.status === "unknown") {
					attentionCount += 1;
				}
				const createdAt =
					observedAt + runIndex * 1_000;
				const hasReceipt =
					runIndex >= 2 && (runIndex - 2) % 10 === 0;
				const receiptId = hasReceipt
					? `rcpt-perf-${safeIndex(projectIndex)}-${safeIndex(runIndex)}`
					: undefined;
				const artifactId = hasReceipt
					? `art-perf-${safeIndex(projectIndex)}-${safeIndex(runIndex)}`
					: undefined;
				const run = {
					runId,
					projectId,
					controlDomainId,
					status: state.status,
					stage: state.stage,
					boundPlanHash: plan.boundPlanHash,
					needsOperator: false,
					createdAt,
					updatedAt:
						BASE_TIME +
						RUN_COUNT * 1_000 -
						(projectIndex * RUNS_PER_PROJECT + runIndex) *
							1_000,
					runVersion: 1,
					lastCommitSeq: runIndex + 1,
					nodes:
						projectIndex === 0 && runIndex === 2
							? graphNodes()
							: singleNode(state.status),
					...(approvalRequestId
						? { approvalRequestId }
						: {}),
					...(receiptId
						? {
								receiptId,
								finalOutput: `Result ${projectIndex}/${runIndex}`,
							}
						: {}),
				};
				writeJson(
					path.join(
						projectProjectionsDir(projectRoot),
						`run-${runId}.json`,
					),
					run,
				);
				projectRuns.push(run);
				journalEvents.push({
					eventId:
						`evt-perf-${safeIndex(projectIndex)}-${safeIndex(runIndex)}`,
					schemaVersion: 1,
					controlDomainId,
					streamId: runId,
					streamSeq: 1,
					commitSeq: runIndex + 1,
					projectId,
					recordedAt: createdAt,
					payload: {
						type: "RunReceived",
						runId,
						boundPlanHash:
							plan.boundPlanHash,
					},
				});

				if (approvalRequestId) {
					const approval = {
						approvalRequestId,
						version: 1,
						runId,
						projectId,
						controlDomainId,
						status: "pending",
						allowedDecisions: [
							"approve",
							"reject",
						],
						createdAt,
						expectedRunVersion: 1,
					};
					writeJson(
						path.join(
							projectApprovalsDir(projectRoot),
							`${approvalRequestId}.json`,
						),
						approval,
					);
					writeJson(
						path.join(
							projectApprovalsDir(projectRoot),
							`by-run-${runId}.json`,
						),
						{ approvalRequestId },
					);
				}

				if (receiptId && artifactId) {
					const bytes = Buffer.from(
						`Result ${projectIndex}/${runIndex}\n`,
						"utf8",
					);
					const digest = sha256(bytes);
					const digestHex = digest.slice("sha256:".length);
					fs.writeFileSync(
						path.join(
							projectArtifactBlobsDir(projectRoot),
							digestHex,
						),
						bytes,
					);
					writeJson(
						path.join(
							projectArtifactMetadataDir(projectRoot),
							`${artifactId}.json`,
						),
						{
							artifactId,
							projectId,
							controlDomainId,
							digest,
							size: bytes.byteLength,
							mediaType:
								"text/plain; charset=utf-8",
							role: "final-output",
							storageClass: "control-store",
							redactionClass: "project",
							runId,
							receiptId,
							fileName: `${runId}.txt`,
							createdAt,
						},
					);
					writeJson(
						path.join(
							projectReceiptsDir(projectRoot),
							`${receiptId}.json`,
						),
						{
							receiptId,
							controlDomainId,
							projectId,
							runId,
							boundPlanHash: plan.boundPlanHash,
							eventManifest: [],
							startCommitSeq: runIndex + 1,
							endCommitSeq: runIndex + 1,
							artifactRefs: [artifactId],
							assurance: {
								journalContinuity: "ok",
								providerOutcome: "ok",
								artifactIntegrity: "ok",
								provenance: "ok",
							},
							buildInfo: {
								packageVersion: "0.3.0-beta.2",
								controlSchemaVersion:
									CONTROL_STORE_SCHEMA_VERSION,
							},
							issuedAt: createdAt,
						},
					);
					writeJson(
						path.join(
							projectReceiptsDir(projectRoot),
							`by-run-${runId}.json`,
						),
						{ receiptId },
					);
					receiptCount += 1;
					artifactCount += 1;
				}
			}
			writeJson(
				path.join(
					projectJournalDir(projectRoot),
					"000000000001-000000000100.json",
				),
				{
					commitSeqStart: 1,
					commitSeqEnd: RUNS_PER_PROJECT,
					events: journalEvents,
					recordedAt:
						observedAt + RUNS_PER_PROJECT,
				},
			);
			writeJson(
				path.join(projectControlRoot(projectRoot), "commit-seq.json"),
				{ next: RUNS_PER_PROJECT + 1 },
			);
			writeJson(projectRunIndexPath(projectRoot), {
				schemaVersion: 1,
				throughCommitSeq: RUNS_PER_PROJECT,
				projectionCount: projectRuns.length,
				runs: projectRuns.sort(
					(left, right) =>
						right.updatedAt - left.updatedAt ||
						left.runId.localeCompare(
							right.runId,
							"en",
						),
				),
			});
			writeJson(
				projectApprovalRecoveryIndexPath(projectRoot),
				{
					schemaVersion: 1,
					throughCommitSeq: RUNS_PER_PROJECT,
					runIds: [],
				},
			);
			writeJson(
				path.join(projectControlRoot(projectRoot), "compaction.json"),
				{
					minAvailableCommitSeq: 1,
					maxCommitSeq: RUNS_PER_PROJECT,
					updatedAt: observedAt + RUNS_PER_PROJECT,
				},
			);
			entries.push({
				projectId,
				controlDomainId,
				storePath: finalProjectRoot,
				projectRoot: finalProjectRoot,
				directoryBinding: { path: finalProjectRoot },
				mountState: "mounted",
				registeredAt: observedAt,
				updatedAt: observedAt + RUNS_PER_PROJECT,
				summary: {
					openRuns: 2,
					lastRunAt: observedAt + RUNS_PER_PROJECT,
				},
			});
		}

		assert.equal(activeRuns, 200);
		assert.equal(approvalCount, 50);
		assert.equal(attentionCount, 100);
		assert.equal(receiptCount, 1_000);
		assert.equal(artifactCount, 1_000);
		fs.mkdirSync(userControlRoot({ TASKFLOW_HOME: buildHome }), {
			recursive: true,
		});
		writeJson(registryPath({ TASKFLOW_HOME: buildHome }), {
			schemaVersion: 1,
			revision: "reg-perf-v1",
			entries,
		});
		writeJson(path.join(buildRoot, "fixture.json"), {
			schemaVersion: 2,
			seed: PERF_SEED,
			projects: PROJECT_COUNT,
			runs: RUN_COUNT,
			activeRuns,
			approvals: approvalCount,
			attentionItems: attentionCount,
			graphNodes: GRAPH_NODE_COUNT,
			receipts: receiptCount,
			artifacts: artifactCount,
		});
		if (fs.existsSync(fixtureRoot)) {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
		fs.renameSync(buildRoot, fixtureRoot);
	} catch (error) {
		fs.rmSync(buildRoot, { recursive: true, force: true });
		throw error;
	}
	return validateFixture();
}

function validateFixture() {
	const fixture = JSON.parse(
		fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8"),
	);
	assert.equal(fixture.schemaVersion, 2);
	assert.equal(fixture.seed, PERF_SEED);
	assert.equal(fixture.projects, PROJECT_COUNT);
	assert.equal(fixture.runs, RUN_COUNT);
	assert.equal(fixture.activeRuns, 200);
	assert.equal(fixture.approvals, 50);
	assert.equal(fixture.attentionItems, 100);
	assert.equal(fixture.graphNodes, GRAPH_NODE_COUNT);
	let runs = 0;
	let approvals = 0;
	let artifacts = 0;
	let receipts = 0;
	for (
		let projectIndex = 0;
		projectIndex < PROJECT_COUNT;
		projectIndex += 1
	) {
		const projectRoot = path.join(
			fixtureRoot,
			"projects",
			`project-${safeIndex(projectIndex)}`,
		);
		const result = inspectProjectControlStore(projectRoot, {
			projectId: `proj-perf-${safeIndex(projectIndex)}`,
			controlDomainId: `dom-perf-${safeIndex(projectIndex)}`,
		});
		assert.equal(
			result.ok,
			true,
			`invalid benchmark store ${projectIndex}: ${JSON.stringify(result)}`,
		);
		if (!result.ok) continue;
		runs += result.snapshot.runs.length;
		approvals += result.snapshot.approvals.length;
		artifacts += result.snapshot.artifacts.length;
		receipts += result.snapshot.receipts.length;
	}
	assert.deepEqual(
		{ runs, approvals, artifacts, receipts },
		{
			runs: RUN_COUNT,
			approvals: 50,
			artifacts: 1_000,
			receipts: 1_000,
		},
	);
	return fixture;
}

function runCli(args, env) {
	const result = spawnSync(process.execPath, [cliBin, ...args], {
		cwd: repositoryRoot,
		env,
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(
		result.status,
		0,
		`taskflow ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
	);
	return JSON.parse(result.stdout);
}

async function startUiOwner(projectRoot, env) {
	const child = spawn(
		process.execPath,
		[cliBin, "ui", "--no-open", "--project", projectRoot],
		{
			cwd: repositoryRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const result = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new Error(
					`benchmark UI did not start\n${stdout}\n${stderr}`,
				),
			);
		}, 120_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			try {
				const parsed = JSON.parse(stdout);
				clearTimeout(timer);
				resolve(parsed);
			} catch {
				// Pretty JSON is incomplete until the final chunk.
			}
		});
		child.once("exit", (code) => {
			if (!stdout.trim()) {
				clearTimeout(timer);
				reject(
					new Error(
						`benchmark UI exited ${code}\n${stderr}`,
					),
				);
			}
		});
	});
	return {
		child,
		result,
		diagnostics: () => ({
			exitCode: child.exitCode,
			signalCode: child.signalCode,
			stdout,
			stderr,
		}),
	};
}

async function stopUi(owner, env) {
	if (owner.child.exitCode !== null || owner.child.signalCode !== null) {
		throw new Error(
			`benchmark UI owner exited before stop\n${JSON.stringify(owner.diagnostics(), null, 2)}`,
		);
	}
	let stopped;
	try {
		stopped = runCli(["ui", "--stop"], env);
	} catch (error) {
		throw new Error(
			`benchmark UI stop failed\n${JSON.stringify(owner.diagnostics(), null, 2)}`,
			{ cause: error },
		);
	}
	assert.equal(stopped.action, "stop");
	if (owner.child.exitCode === null) {
		await Promise.race([
			once(owner.child, "exit"),
			new Promise((_, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"benchmark UI did not stop",
							),
						),
					20_000,
				);
				timer.unref();
			}),
		]);
	}
}

function nearestRank(values, percentile) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function aggregates(values) {
	return {
		count: values.length,
		p50: nearestRank(values, 0.5),
		p95: nearestRank(values, 0.95),
		min: Math.min(...values),
		max: Math.max(...values),
	};
}

function thresholdCheck({
	actual,
	maximum,
	unit,
	applicable = true,
}) {
	return {
		status: applicable
			? actual <= maximum
				? "pass"
				: "fail"
			: "informational",
		applicable,
		actual,
		maximum,
		unit,
	};
}

function booleanCheck({ passed, evidence }) {
	return {
		status: passed ? "pass" : "fail",
		applicable: true,
		passed,
		evidence,
	};
}

function formatMetric(value) {
	return typeof value === "number"
		? Number.isInteger(value)
			? String(value)
			: value.toFixed(2)
		: "—";
}

function humanSummary(report, jsonFileName) {
	const aggregateRows = Object.entries(
		report.aggregates,
	).map(
		([name, value]) =>
			`| ${name} | ${value.count} | ${formatMetric(value.p50)} | ${formatMetric(value.p95)} | ${formatMetric(value.min)} | ${formatMetric(value.max)} |`,
	);
	const checkRows = Object.entries(report.checks).map(
		([name, check]) =>
			`| ${name} | ${check.status} | ${formatMetric("actual" in check ? check.actual : undefined)} | ${formatMetric("maximum" in check ? check.maximum : undefined)} | ${"unit" in check ? check.unit : "boolean"} | ${check.applicable ? "yes" : "no"} |`,
	);
	return [
		`# Taskflow Web benchmark — ${report.profile}`,
		"",
		`- Status: **${report.status}**`,
		`- Measured: ${report.measuredAt}`,
		`- Source: \`${report.git.commit}\` (${report.git.dirty ? "dirty working tree" : "clean"})`,
		`- Source digest: \`${report.git.sourceDigest}\``,
		`- Environment: ${report.environment.modelName ?? "unknown model"} / ${report.environment.chip ?? "unknown chip"} / Node ${report.environment.node} / ${report.environment.browser}`,
		`- Runtime preconditions: expected Node ${report.environment.expectedNode}; version match ${report.environment.nodeVersionMatches ? "yes" : "no"}; power ${report.environment.powerSource ?? "unknown"}; no thermal/performance warning ${report.environment.noThermalWarning === true && report.environment.noPerformanceWarning === true ? "yes" : "unknown or no"}; load average before ${report.environment.loadAverageBefore.map(formatMetric).join("/")} and after ${report.environment.loadAverageAfter.map(formatMetric).join("/")}`,
		`- Canonical release profile: ${report.environment.canonicalProfile ? "yes" : "no; latency checks are informational"}`,
		`- Machine-readable evidence: [${jsonFileName}](./${jsonFileName})`,
		"",
		"## Aggregates",
		"",
		"| Metric | n | p50 | p95 | min | max |",
		"|---|---:|---:|---:|---:|---:|",
		...aggregateRows,
		"",
		"## Checks",
		"",
		"| Check | Status | Actual | Maximum | Unit | Applicable |",
		"|---|---|---:|---:|---|---|",
		...checkRows,
		"",
		"Raw samples, fixture identity, asset hashes, procedure, and CSP evidence are retained in the JSON report.",
		"",
	].join("\n");
}

function gitOutput(args) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function sourceDigest() {
	const files = [
		...fs.globSync("packages/taskflow-{web,control,daemon,cli}/src/**/*", {
			cwd: repositoryRoot,
		}),
		...fs.globSync("packages/taskflow-web/scripts/**/*", {
			cwd: repositoryRoot,
		}),
		"scripts/bench-web.mjs",
		"package.json",
		"pnpm-lock.yaml",
	].sort();
	const hash = createHash("sha256");
	for (const relative of files) {
		const absolute = path.join(repositoryRoot, relative);
		if (!fs.statSync(absolute).isFile()) continue;
		hash.update(relative);
		hash.update("\0");
		hash.update(fs.readFileSync(absolute));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

function assetEvidence() {
	const appRoot = path.join(
		repositoryRoot,
		"packages/taskflow-web/dist/app",
	);
	const manifestBytes = fs.readFileSync(
		path.join(appRoot, "taskflow-web-assets.json"),
	);
	const manifest = JSON.parse(manifestBytes);
	const html = fs.readFileSync(
		path.join(appRoot, manifest.entrypoint.path),
		"utf8",
	);
	const initialPaths = [
		...html.matchAll(
			/<(?:script|link)\b[^>]*\b(?:src|href)="\/([^"]+\.js)"/gu,
		),
	].map((match) => match[1]);
	const simpleShellJsGzipBytes = initialPaths.reduce(
		(total, relative) =>
			total +
			gzipSync(fs.readFileSync(path.join(appRoot, relative)))
				.byteLength,
		0,
	);
	return {
		webBuildId: manifest.webBuildId,
		manifestSha256: sha256(manifestBytes),
		assetHashes: manifest.assets.map((asset) => ({
			path: asset.path,
			sha256: asset.sha256,
			size: asset.size,
		})),
		initialJavaScript: initialPaths,
		simpleShellJsGzipBytes,
		simpleShellJsBudgetBytes: 220 * 1024,
	};
}

function hardwareEvidence(browserVersion) {
	const systemProfiler =
		process.platform === "darwin" &&
		fs.existsSync("/usr/sbin/system_profiler")
			? "/usr/sbin/system_profiler"
			: "system_profiler";
	const hardware = spawnSync(
		systemProfiler,
		["SPHardwareDataType", "-json"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	let modelName;
	let chip;
	if (hardware.status === 0) {
		try {
			const parsed = JSON.parse(hardware.stdout);
			const row = parsed.SPHardwareDataType?.[0];
			modelName = row?.machine_name;
			chip = row?.chip_type;
		} catch {
			// Preserve undefined rather than guessing hardware identity.
		}
	}
	const power = spawnSync(
		process.platform === "darwin" && fs.existsSync("/usr/bin/pmset")
			? "/usr/bin/pmset"
			: "pmset",
		["-g", "batt"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	const thermal = spawnSync(
		process.platform === "darwin" && fs.existsSync("/usr/bin/pmset")
			? "/usr/bin/pmset"
			: "pmset",
		["-g", "therm"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	const powerSource =
		power.status === 0
			? /Now drawing from '([^']+)'/u.exec(power.stdout)?.[1]
			: undefined;
	const noThermalWarning =
		thermal.status === 0
			? thermal.stdout.includes(
					"No thermal warning level has been recorded",
				)
			: undefined;
	const noPerformanceWarning =
		thermal.status === 0
			? thermal.stdout.includes(
					"No performance warning level has been recorded",
				)
			: undefined;
	const nodeVersionMatches =
		process.version === `v${WEB_PRIMARY_NODE_VERSION}`;
	const canonicalProfile =
		typeof modelName === "string" &&
		modelName.includes("Mac mini") &&
		typeof chip === "string" &&
		chip.includes("Apple M2") &&
		os.totalmem() >= 15 * 1024 ** 3 &&
		os.totalmem() <= 17 * 1024 ** 3 &&
		nodeVersionMatches &&
		powerSource === "AC Power" &&
		noThermalWarning === true &&
		noPerformanceWarning === true;
	return {
		modelName,
		chip,
		logicalCores: os.cpus().length,
		ramBytes: os.totalmem(),
		os: `${os.platform()} ${os.release()}`,
		node: process.version,
		expectedNode: `v${WEB_PRIMARY_NODE_VERSION}`,
		nodeVersionMatches,
		v8: process.versions.v8,
		browser: `Chromium ${browserVersion}`,
		powerSource,
		noThermalWarning,
		noPerformanceWarning,
		loadAverage: os.loadavg(),
		canonicalProfile,
	};
}

async function installObservers(page) {
	await page.addInitScript(() => {
		const state = {
			cls: 0,
			clsSessionValue: 0,
			clsSessionStartedAt: undefined,
			clsLastShiftAt: undefined,
			cspViolations: [],
		};
		window.__taskflowBench = state;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (entry.hadRecentInput) continue;
				if (
					state.clsSessionStartedAt === undefined ||
					state.clsLastShiftAt === undefined ||
					entry.startTime -
							state.clsLastShiftAt >
						1_000 ||
					entry.startTime -
							state.clsSessionStartedAt >
						5_000
				) {
					state.clsSessionStartedAt =
						entry.startTime;
					state.clsSessionValue =
						entry.value;
				} else {
					state.clsSessionValue +=
						entry.value;
				}
				state.clsLastShiftAt =
					entry.startTime;
				state.cls = Math.max(
					state.cls,
					state.clsSessionValue,
				);
			}
		}).observe({ type: "layout-shift", buffered: true });
		document.addEventListener("securitypolicyviolation", (event) => {
			state.cspViolations.push({
				effectiveDirective: event.effectiveDirective,
				blockedURI: event.blockedURI,
			});
		});
	});
}

async function waitForUsefulHome(page) {
	await page.locator(".page-header h1").waitFor({
		state: "visible",
		timeout: 120_000,
	});
	await Promise.race([
		page
			.locator(".task-row")
			.first()
			.waitFor({
				state: "visible",
				timeout: 120_000,
			}),
		page
			.locator(".error-panel")
			.first()
			.waitFor({
				state: "visible",
				timeout: 120_000,
			})
			.then(async () => {
				throw new Error(
					`Home query failed: ${await page.locator(".error-panel").first().innerText()}`,
				);
			}),
	]);
}

async function browserMark(page, name) {
	return page.evaluate((markName) => {
		performance.mark(markName);
		const marks =
			performance.getEntriesByName(markName);
		const mark = marks.at(-1);
		if (!mark) {
			throw new Error(
				`browser performance mark ${markName} is missing`,
			);
		}
		return mark.startTime;
	}, name);
}

async function measureColdHome(browser, projectRoot, env) {
	const launchStartedAt = performance.now();
	const owner = await startUiOwner(projectRoot, env);
	const ownerReadyMs = performance.now() - launchStartedAt;
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		locale: "en-US",
		reducedMotion: "reduce",
	});
	const page = await context.newPage();
	await installObservers(page);
	await page.goto(owner.result.launchUrl, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
	await waitForUsefulHome(page);
	const navigationToUsefulMs = await browserMark(
		page,
		"taskflow-bench:cold-home-useful",
	);
	const launchToUsefulMs =
		performance.now() - launchStartedAt;
	await context.close();
	await stopUi(owner, env);
	return {
		ownerReadyMs,
		navigationToUsefulMs,
		launchToUsefulMs,
	};
}

async function loadAllTaskPages(page) {
	let previousCount = 0;
	for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
		const currentCount = await page.locator(".task-row").count();
		assert.ok(
			currentCount >= previousCount,
			"task row count regressed while paging",
		);
		previousCount = currentCount;
		const more = page.getByRole("button", { name: "Load more" });
		if ((await more.count()) === 0) break;
		await more.click({ timeout: 120_000 });
		await page.waitForFunction(
			(count) =>
				document.querySelectorAll(".task-row").length > count,
			currentCount,
			{ timeout: 120_000 },
		);
	}
	const rowCount = await page.locator(".task-row").count();
	assert.equal(rowCount, RUN_COUNT);
	return rowCount;
}

async function loadAllGraphPages(page) {
	const panel = page.locator(".pro-panel").first();
	for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
		const currentCount = await panel.locator(".graph-node").count();
		const more = panel.getByRole("button", { name: "Load more" });
		if ((await more.count()) === 0) break;
		await more.click({ timeout: 120_000 });
		await page.waitForFunction(
			(count) =>
				document.querySelectorAll(".graph-node").length >
				count,
			currentCount,
			{ timeout: 120_000 },
		);
	}
	const nodeCount = await panel.locator(".graph-node").count();
	assert.equal(nodeCount, GRAPH_NODE_COUNT);
	return nodeCount;
}

function prepareEventVisibilityRun(projectRoot) {
	const eventRunId = "run-perf-000-001";
	const store = openProjectControlStore(projectRoot);
	const current = store.getRun(eventRunId);
	assert.ok(current);
	if (
		current.status === "running" &&
		current.stage === "executing"
	) {
		return eventRunId;
	}
	const resetAt = Date.now();
	const nextVersion = current.runVersion + 1;
	store.commit({
		run: {
			...current,
			status: "running",
			stage: "executing",
			updatedAt: resetAt,
			runVersion: nextVersion,
			nodes: singleNode("running"),
		},
		events: [
			{
				eventId: `ev-perf-reset-v${nextVersion}`,
				schemaVersion: 1,
				controlDomainId: current.controlDomainId,
				streamId: current.runId,
				streamSeq: 0,
				commitSeq: 0,
				projectId: current.projectId,
				recordedAt: resetAt,
				payload: {
					type: "RunStatusChanged",
					runId: current.runId,
					status: "running",
					stage: "executing",
				},
			},
		],
	});
	return eventRunId;
}

async function measureWarmAndLargeData(browser, projectRoot, env) {
	const eventRunId = prepareEventVisibilityRun(projectRoot);
	const owner = await startUiOwner(projectRoot, env);
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		locale: "en-US",
		reducedMotion: "reduce",
	});
	const page = await context.newPage();
	await installObservers(page);
	const apiFailures = [];
	page.on("response", async (response) => {
		if (
			response.url().includes("/api/") &&
			response.status() >= 400
		) {
			apiFailures.push({
				url: response.url(),
				status: response.status(),
				body: await response.text().catch(() => ""),
			});
		}
	});
	await page.goto(owner.result.launchUrl, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
	await waitForUsefulHome(page);

	for (let index = 0; index < warmups; index += 1) {
		await page.goto(`${owner.result.origin}/`, {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
		await waitForUsefulHome(page);
	}
	const warmHomeMs = [];
	for (let index = 0; index < samples; index += 1) {
		await page.goto(`${owner.result.origin}/`, {
			waitUntil: "domcontentloaded",
			timeout: 120_000,
		});
		await waitForUsefulHome(page);
		warmHomeMs.push(
			await browserMark(
				page,
				"taskflow-bench:warm-home-useful",
			),
		);
	}

	const graphRunUrl =
		`${owner.result.origin}/workspaces/proj-perf-000` +
		"/domains/dom-perf-000/tasks/run-perf-000-002";
	await page.goto(graphRunUrl, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
	try {
		await Promise.race([
			page.locator(".page-header h1").waitFor({
				state: "visible",
				timeout: 120_000,
			}),
			page
				.locator(".error-panel")
				.first()
				.waitFor({
					state: "visible",
					timeout: 120_000,
				})
				.then(async () => {
					throw new Error(
						await page
							.locator(".error-panel")
							.first()
							.innerText(),
					);
				}),
		]);
	} catch (error) {
		throw new Error(
			`Task detail did not become useful at ${graphRunUrl}\n${await page.locator("body").innerText()}\n${JSON.stringify(apiFailures, null, 2)}`,
			{ cause: error },
		);
	}
	const firstProStartedAt = await browserMark(
		page,
		"taskflow-bench:first-pro-start",
	);
	await page.getByRole("button", { name: "Switch to Pro" }).click();
	await page.getByRole("tab", { name: "Overview" }).waitFor({
		state: "visible",
	});
	const firstProUsefulMs =
		(await browserMark(
			page,
			"taskflow-bench:first-pro-useful",
		)) - firstProStartedAt;
	await page.getByRole("switch").click();
	await page.getByRole("switch").click();
	await page.getByRole("tab", { name: "Overview" }).waitFor({
		state: "visible",
	});
	await page.getByRole("switch").click();
	const cachedProMs = [];
	for (let index = 0; index < samples; index += 1) {
		const startedAt = await browserMark(
			page,
			"taskflow-bench:cached-pro-start",
		);
		await page.getByRole("switch").click();
		await page.getByRole("tab", { name: "Overview" }).waitFor({
			state: "visible",
		});
		cachedProMs.push(
			(await browserMark(
				page,
				"taskflow-bench:cached-pro-useful",
			)) - startedAt,
		);
		await page.getByRole("switch").click();
	}

	await page.getByRole("switch").click();
	await page.getByRole("tab", { name: "Graph" }).click();
	await page.locator(".graph-svg").waitFor({ state: "visible" });
	const graphStartedAt = performance.now();
	const graphNodes = await loadAllGraphPages(page);
	const graphAllPagesMs = performance.now() - graphStartedAt;

	await page.goto(`${owner.result.origin}/tasks`, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
	await page.locator(".virtual-page-segment").first().waitFor({
		state: "attached",
	});
	const listStartedAt = performance.now();
	const taskRows = await loadAllTaskPages(page);
	const taskAllPagesMs = performance.now() - listStartedAt;
	const taskSegments = await page
		.locator(".virtual-page-segment")
		.count();
	assert.equal(taskSegments, 50);
	const listStyle = await page
		.locator(".virtual-page-segment")
		.first()
		.evaluate((element) => ({
			contentVisibility:
				getComputedStyle(element).contentVisibility,
			inlineStyleAttributes:
				document.querySelectorAll("[style]").length,
		}));
	assert.equal(listStyle.contentVisibility, "auto");
	assert.equal(listStyle.inlineStyleAttributes, 0);
	const listScrollResponseMs = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const startedAt =
					performance.now();
				window.scrollTo(
					0,
					document.documentElement.scrollHeight,
				);
				requestAnimationFrame(() =>
					requestAnimationFrame(() =>
						resolve(
							performance.now() -
								startedAt,
						),
					),
				);
			}),
	);

	const eventRunUrl =
		`${owner.result.origin}/workspaces/proj-perf-000` +
		`/domains/dom-perf-000/tasks/${eventRunId}`;
	await page.goto(eventRunUrl, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
	await page.getByText("Task in progress").first().waitFor({
		state: "visible",
	});
	const store = openProjectControlStore(projectRoot);
	const eventToVisibleMs = [];
	const eventCommitToReceiptMs = [];
	const eventReceiptToVisibleMs = [];
	const eventIterations = warmups + samples;
	for (
		let iteration = 0;
		iteration < eventIterations;
		iteration += 1
	) {
		const current = store.getRun(eventRunId);
		assert.ok(current);
		const recordedAt = Date.now();
		const completedVersion = current.runVersion + 1;
		const completedCommit = store.commit({
			run: {
				...current,
				status: "completed",
				stage: "terminal",
				updatedAt: recordedAt,
				runVersion: completedVersion,
				nodes: singleNode("completed"),
			},
			events: [
				{
					eventId: `ev-perf-visible-v${completedVersion}`,
					schemaVersion: 1,
					controlDomainId:
						current.controlDomainId,
					streamId: current.runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: current.projectId,
					recordedAt,
					payload: {
						type: "RunStatusChanged",
						runId: current.runId,
						status: "completed",
						stage: "terminal",
					},
				},
			],
		});
		await page.getByText("Task completed").first().waitFor({
			state: "visible",
			timeout: 10_000,
		});
		await page.waitForFunction(
			(runVersion) =>
				performance
					.getEntriesByName(
						"taskflow:run-detail-visible",
					)
					.some(
						(entry) =>
							entry.detail
								?.runVersion ===
							runVersion,
					),
			completedVersion,
			{ timeout: 10_000 },
		);
		const eventTiming = await page.evaluate(
			({
				serverCommittedAt,
				commitSeq,
				runVersion,
			}) => {
				const received = performance
					.getEntriesByName(
						"taskflow:event-change-received",
					)
					.findLast(
						(entry) =>
							entry.detail?.commitSeq ===
							commitSeq,
					);
				const visible = performance
					.getEntriesByName(
						"taskflow:run-detail-visible",
					)
					.findLast(
						(entry) =>
							entry.detail
								?.runVersion ===
							runVersion,
					);
				if (!received || !visible) {
					throw new Error(
						"event receipt/visible performance marks are missing",
					);
				}
				const committedMonotonic =
					serverCommittedAt -
					performance.timeOrigin;
				return {
					commitToVisibleMs:
						visible.startTime -
						committedMonotonic,
					commitToReceiptMs:
						received.startTime -
						committedMonotonic,
					receiptToVisibleMs:
						visible.startTime -
						received.startTime,
				};
			},
			{
				serverCommittedAt:
					completedCommit.committedAt,
				commitSeq:
					completedCommit.commitSeqEnd,
				runVersion: completedVersion,
			},
		);
		if (iteration >= warmups) {
			eventToVisibleMs.push(
				eventTiming.commitToVisibleMs,
			);
			eventCommitToReceiptMs.push(
				eventTiming.commitToReceiptMs,
			);
			eventReceiptToVisibleMs.push(
				eventTiming.receiptToVisibleMs,
			);
		}
		if (iteration === eventIterations - 1) continue;

		const completed = store.getRun(eventRunId);
		assert.ok(completed);
		const resetAt = Date.now();
		const resetVersion = completed.runVersion + 1;
		store.commit({
			run: {
				...completed,
				status: "running",
				stage: "executing",
				updatedAt: resetAt,
				runVersion: resetVersion,
				nodes: singleNode("running"),
			},
			events: [
				{
					eventId: `ev-perf-reset-v${resetVersion}`,
					schemaVersion: 1,
					controlDomainId:
						completed.controlDomainId,
					streamId: completed.runId,
					streamSeq: 0,
					commitSeq: 0,
					projectId: completed.projectId,
					recordedAt: resetAt,
					payload: {
						type: "RunStatusChanged",
						runId: completed.runId,
						status: "running",
						stage: "executing",
					},
				},
			],
		});
		await page.getByText("Task in progress").first().waitFor({
			state: "visible",
			timeout: 10_000,
		});
	}

	const runtime = await page.evaluate(() => ({
		cls: window.__taskflowBench.cls,
		cspViolations: window.__taskflowBench.cspViolations,
		inlineStyleAttributes:
			document.querySelectorAll("[style]").length,
		runtimeStyleElements:
			document.querySelectorAll("style").length,
	}));
	assert.deepEqual(runtime.cspViolations, []);
	assert.equal(runtime.inlineStyleAttributes, 0);
	assert.equal(runtime.runtimeStyleElements, 0);
	await context.close();
	await stopUi(owner, env);
	return {
		warmHomeMs,
		firstProUsefulMs,
		cachedProMs,
		largeData: {
			taskRows,
			taskSegments,
			taskAllPagesMs,
			listScrollResponseMs,
			contentVisibility:
				listStyle.contentVisibility,
			graphNodes,
			graphAllPagesMs,
		},
		eventToVisibleMs,
		eventCommitToReceiptMs,
		eventReceiptToVisibleMs,
		runtime,
	};
}

function fixtureNeedsRegeneration() {
	const metadataPath = path.join(fixtureRoot, "fixture.json");
	if (!fs.existsSync(metadataPath)) return true;
	try {
		return JSON.parse(
			fs.readFileSync(metadataPath, "utf8"),
		).schemaVersion !== 2;
	} catch {
		return true;
	}
}

const fixture =
	regenerate || fixtureNeedsRegeneration()
		? generateFixture()
		: validateFixture();
if (fixtureOnly) {
	process.stdout.write(
		`${JSON.stringify({ ok: true, fixtureRoot, fixture }, null, 2)}\n`,
	);
	process.exit(0);
}
if (!fs.existsSync(cliBin)) {
	throw new Error(
		"built CLI is missing; run pnpm build before scripts/bench-web.mjs",
	);
}

const env = {
	...process.env,
	TASKFLOW_HOME: path.join(fixtureRoot, "home"),
	PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
};
const projectRoot = path.join(
	fixtureRoot,
	"projects/project-000",
);
const browser = await chromium.launch({ headless: true });
let report;
try {
	const browserVersion = browser.version();
	const preflightEnvironment = hardwareEvidence(browserVersion);
	const coldHomeMs = [];
	const coldOwnerReadyMs = [];
	const coldLaunchToUsefulMs = [];
	for (let index = 0; index < samples; index += 1) {
		const cold = await measureColdHome(
			browser,
			projectRoot,
			env,
		);
		coldHomeMs.push(cold.navigationToUsefulMs);
		coldOwnerReadyMs.push(cold.ownerReadyMs);
		coldLaunchToUsefulMs.push(
			cold.launchToUsefulMs,
		);
	}
	const warm = await measureWarmAndLargeData(
		browser,
		projectRoot,
		env,
	);
		const asset = assetEvidence();
		const postflightEnvironment =
			hardwareEvidence(browserVersion);
		const hardware = {
			...postflightEnvironment,
			loadAverageBefore:
				preflightEnvironment.loadAverage,
			loadAverageAfter:
				postflightEnvironment.loadAverage,
			canonicalProfile:
				preflightEnvironment.canonicalProfile &&
				postflightEnvironment.canonicalProfile,
		};
		const checks = {
			simpleShellJs: thresholdCheck({
				actual: asset.simpleShellJsGzipBytes,
				maximum: asset.simpleShellJsBudgetBytes,
				unit: "gzip-bytes",
			}),
			coldHome: thresholdCheck({
				actual: nearestRank(coldHomeMs, 0.95),
				maximum: 2_000,
				unit: "milliseconds-p95",
				applicable: hardware.canonicalProfile,
			}),
			warmHome: thresholdCheck({
				actual: nearestRank(warm.warmHomeMs, 0.95),
				maximum: 1_200,
				unit: "milliseconds-p95",
				applicable: hardware.canonicalProfile,
			}),
			cachedPro: thresholdCheck({
				actual: nearestRank(warm.cachedProMs, 0.95),
				maximum: 250,
				unit: "milliseconds-p95",
				applicable: hardware.canonicalProfile,
			}),
			firstProUseful: thresholdCheck({
				actual: warm.firstProUsefulMs,
				maximum: 1_500,
				unit: "milliseconds",
				applicable: hardware.canonicalProfile,
			}),
			eventToVisible: thresholdCheck({
				actual: nearestRank(
					warm.eventToVisibleMs,
					0.95,
				),
				maximum: 250,
				unit: "milliseconds",
				applicable: hardware.canonicalProfile,
			}),
			listResponsive: thresholdCheck({
				actual:
					warm.largeData.listScrollResponseMs,
				maximum: 250,
				unit: "milliseconds",
				applicable: hardware.canonicalProfile,
			}),
			layoutShift: thresholdCheck({
				actual: warm.runtime.cls,
				maximum: 0.1,
				unit: "cls",
			}),
			cspClean: booleanCheck({
				passed:
					warm.runtime.cspViolations.length === 0 &&
					warm.runtime.inlineStyleAttributes === 0 &&
					warm.runtime.runtimeStyleElements === 0,
				evidence: {
					cspViolationCount:
						warm.runtime.cspViolations.length,
					inlineStyleAttributes:
						warm.runtime.inlineStyleAttributes,
					runtimeStyleElements:
						warm.runtime.runtimeStyleElements,
				},
			}),
		};
		const checkStatuses = Object.values(checks).map(
			(check) => check.status,
		);
		report = {
			schemaVersion: 4,
			profile: smoke ? "smoke" : "web-perf-v1",
			status:
				checkStatuses.includes("fail")
					? "fail"
					: checkStatuses.includes("informational")
						? "structural-pass"
						: "pass",
			measuredAt: new Date().toISOString(),
			git: {
				commit: gitOutput(["rev-parse", "HEAD"]),
				dirty:
					gitOutput(["status", "--porcelain"]).length > 0,
				sourceDigest: sourceDigest(),
			},
			fixture,
			procedure: {
				warmups,
				samples,
				percentile: "nearest-rank",
				scenarioOrder: [
					"cold-home",
					"warm-home",
					"cached-pro",
					"large-graph",
					"large-task-list",
					"event-to-visible",
				],
				cold:
					"fresh daemon/listener and browser context; the normative cold threshold applies to first navigation after session exchange, while owner-ready and launch-to-useful timings are retained separately",
				warm:
					"same daemon and browser context after one complete bootstrap/Home load",
				timing:
					"navigation and interaction samples use browser monotonic performance marks; event samples retain server commit wall time plus browser receipt/render marks",
				layoutShift:
					"maximum standard CLS session window: gaps <=1 second and total window <=5 seconds",
				thresholdApplicability:
					"Latency budgets are normative only on the RFC canonical Mac mini M2 / 16 GiB profile. Raw values are always retained; non-canonical runs are informational, never silently passed.",
			},
			environment: hardware,
			build: asset,
			raw: {
				coldHomeUsefulMs: coldHomeMs,
				coldOwnerReadyMs,
				coldLaunchToUsefulMs,
				warmHomeInteractiveMs: warm.warmHomeMs,
				cachedProInteractionMs: warm.cachedProMs,
				firstProUsefulMs: warm.firstProUsefulMs,
				eventToVisibleMs: warm.eventToVisibleMs,
				eventCommitToReceiptMs:
					warm.eventCommitToReceiptMs,
				eventReceiptToVisibleMs:
					warm.eventReceiptToVisibleMs,
				cls: warm.runtime.cls,
				largeData: warm.largeData,
			},
			aggregates: {
				coldHomeUsefulMs: aggregates(coldHomeMs),
				coldOwnerReadyMs:
					aggregates(coldOwnerReadyMs),
				coldLaunchToUsefulMs: aggregates(
					coldLaunchToUsefulMs,
				),
				warmHomeInteractiveMs: aggregates(
					warm.warmHomeMs,
				),
				cachedProInteractionMs: aggregates(
					warm.cachedProMs,
				),
				eventToVisibleMs: aggregates(
					warm.eventToVisibleMs,
				),
				eventCommitToReceiptMs: aggregates(
					warm.eventCommitToReceiptMs,
				),
				eventReceiptToVisibleMs: aggregates(
					warm.eventReceiptToVisibleMs,
				),
			},
			checks,
		};
} finally {
	await browser.close();
	try {
		runCli(["ui", "--stop"], env);
	} catch {
		// The normal path already stopped the owner.
	}
}

const outputCommit = report.git.dirty
	? `${report.git.commit.slice(0, 12)}-working-tree`
	: report.git.commit;
const outputDir = path.join(
	repositoryRoot,
	"artifacts/web-bench",
	outputCommit,
);
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(
	outputDir,
	`${report.profile}.json`,
);
const summaryPath = path.join(
	outputDir,
	`${report.profile}.md`,
);
fs.writeFileSync(
	outputPath,
	`${JSON.stringify(report, null, 2)}\n`,
);
fs.writeFileSync(
	summaryPath,
	humanSummary(report, path.basename(outputPath)),
);
process.stdout.write(
	`${JSON.stringify({ outputPath, summaryPath, ...report }, null, 2)}\n`,
);
if (report.status === "fail") process.exitCode = 1;
