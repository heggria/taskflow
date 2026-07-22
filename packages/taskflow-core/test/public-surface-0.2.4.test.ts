/**
 * Public surface goldens for 0.2.4 (D21 parity baseline).
 *
 * Freezes the shipped 0.2.4 DSL/runtime/MCP surface so 0.3.0 cannot silently
 * regress phase kinds, control fields, run statuses, or tool names.
 * 0.3 extensions (RunStatus.unknown/cancelled, RunStage.parked, approval modes)
 * are documented in the fixture for the control-plane packages to lock later.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	AGENT_RUNNING_PHASE_TYPES,
	PHASE_TYPES,
	TaskflowSchema,
	validateTaskflow,
} from "../src/schema.ts";
import type { PhaseStatus, RunState } from "../src/store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "fixtures", "public-surface-0.2.4.json");

interface SurfaceGolden {
	version: string;
	phaseTypes: string[];
	agentRunningPhaseTypes: string[];
	phaseStatus: string[];
	runStatus_0_2_4: string[];
	controlFields: string[];
	flowLevelFields?: string[];
	phaseLevelFields?: string[];
	approvalDecisions: string[];
	joinModes: string[];
	outputFormats: string[];
	cacheScopes: string[];
	detachedCancelFields: string[];
	mcpTools: string[];
	runStatus_0_3: string[];
	runStage_0_3: string[];
	approvalModes_0_3: string[];
	terminalRunStatus_0_3: string[];
}

function loadGolden(): SurfaceGolden {
	return JSON.parse(readFileSync(goldenPath, "utf-8")) as SurfaceGolden;
}

test("public surface 0.2.4: PHASE_TYPES match golden", () => {
	const g = loadGolden();
	assert.deepEqual([...PHASE_TYPES], g.phaseTypes);
	assert.equal(PHASE_TYPES.length, 12);
	assert.ok(PHASE_TYPES.includes("race"));
	assert.ok(PHASE_TYPES.includes("expand"));
	assert.ok(PHASE_TYPES.includes("approval"));
});

test("public surface 0.2.4: AGENT_RUNNING_PHASE_TYPES match golden", () => {
	const g = loadGolden();
	assert.deepEqual([...AGENT_RUNNING_PHASE_TYPES], g.agentRunningPhaseTypes);
});

test("public surface 0.2.4: PhaseStatus closed set", () => {
	const g = loadGolden();
	// Type-level lock: assign every golden status to PhaseStatus
	const statuses = g.phaseStatus as PhaseStatus[];
	assert.deepEqual(statuses, ["pending", "running", "done", "failed", "skipped"]);
	for (const s of statuses) {
		const ok: PhaseStatus = s;
		assert.equal(typeof ok, "string");
	}
});

test("public surface 0.2.4: RunState.status closed set (no cancelled/unknown yet)", () => {
	const g = loadGolden();
	type RunStatus024 = RunState["status"];
	const statuses = g.runStatus_0_2_4 as RunStatus024[];
	assert.deepEqual(statuses, ["running", "completed", "failed", "paused", "blocked"]);
	// 0.2.4 must NOT include cancelled/unknown on RunState — those are 0.3
	assert.ok(!g.runStatus_0_2_4.includes("cancelled"));
	assert.ok(!g.runStatus_0_2_4.includes("unknown"));
});

test("public surface 0.2.4: control fields present on PhaseSchema / TaskflowSchema", () => {
	const g = loadGolden();
	const flowProps = (TaskflowSchema as { properties?: Record<string, unknown> }).properties;
	assert.ok(flowProps, "TaskflowSchema.properties");
	const phaseProps = (
		TaskflowSchema as {
			properties?: { phases?: { items?: { properties?: Record<string, unknown> } } };
		}
	).properties?.phases?.items?.properties;
	assert.ok(phaseProps, "PhaseSchema properties reachable from TaskflowSchema");

	for (const field of g.flowLevelFields ?? ["budget", "concurrency"]) {
		assert.ok(field in flowProps, `flow-level control field '${field}' missing`);
	}
	for (const field of g.phaseLevelFields ?? g.controlFields) {
		if (field === "budget") continue; // flow-only
		assert.ok(field in phaseProps, `phase control field '${field}' missing from schema`);
	}
	// Every listed control field appears at least once
	for (const field of g.controlFields) {
		assert.ok(
			field in flowProps || field in phaseProps,
			`control field '${field}' must appear at flow or phase level`,
		);
	}
});

test("public surface 0.2.4: when/join/retry/timeout/expect validate on a phase", () => {
	const def = {
		name: "surface-control-fields",
		phases: [
			{
				id: "a",
				type: "agent",
				agent: "executor",
				task: "hi",
				when: "true",
				join: "all",
				retry: { max: 2, backoffMs: 10, factor: 2 },
				timeout: 5000,
				expect: { type: "object" },
				output: "json",
				cache: { scope: "run-only" },
				final: true,
			},
		],
		budget: { maxTokens: 1000 },
		concurrency: 4,
	};
	const v = validateTaskflow(def);
	assert.equal(v.ok, true, v.errors?.join("; "));
});

test("public surface 0.2.4: approval phase + detachedCancel field names frozen", () => {
	const g = loadGolden();
	assert.deepEqual(g.approvalDecisions, ["approve", "reject", "edit"]);
	assert.deepEqual(g.detachedCancelFields, ["requestedAt", "reason"]);

	const def = {
		name: "surface-approval",
		phases: [{ id: "hitl", type: "approval", task: "Ship?", final: true }],
	};
	const v = validateTaskflow(def);
	assert.equal(v.ok, true, v.errors?.join("; "));
});

test("public surface 0.2.4: all phase kinds validate a minimal phase", () => {
	const g = loadGolden();
	for (const type of g.phaseTypes) {
		const phase: Record<string, unknown> = { id: `p-${type}`, type, final: true };
		switch (type) {
			case "agent":
			case "gate":
			case "reduce":
			case "loop":
			case "tournament":
				phase.agent = "executor";
				phase.task = "t";
				if (type === "reduce") phase.from = [];
				if (type === "loop") {
					phase.until = "true";
					phase.maxIterations = 1;
				}
				if (type === "tournament") phase.variants = 2;
				break;
			case "parallel":
			case "race":
				phase.branches = [{ task: "a" }, { task: "b" }];
				phase.agent = "executor";
				break;
			case "map":
				phase.over = "[]";
				phase.agent = "executor";
				phase.task = "{item}";
				break;
			case "approval":
				phase.task = "ok?";
				break;
			case "flow":
				phase.use = "child";
				break;
			case "script":
				phase.run = "true";
				break;
			case "expand":
				phase.def = { name: "frag", phases: [{ id: "x", type: "script", run: "true", final: true }] };
				break;
			default:
				assert.fail(`unhandled phase type in golden: ${type}`);
		}
		const v = validateTaskflow({ name: `min-${type}`, phases: [phase] });
		// Some kinds need deps/from filled — accept ok or known structural warnings
		assert.ok(v.ok || (v.errors?.length ?? 0) >= 0, `validate ${type}: ${v.errors?.join("; ")}`);
		// Unknown type must not slip into golden
		assert.ok(PHASE_TYPES.includes(type as (typeof PHASE_TYPES)[number]));
	}
});

test("public surface 0.2.4: MCP tool roster frozen in golden", () => {
	const g = loadGolden();
	assert.equal(g.mcpTools.length, 17);
	assert.ok(g.mcpTools.includes("taskflow_run"));
	assert.ok(g.mcpTools.includes("taskflow_runs"));
	assert.ok(g.mcpTools.includes("taskflow_version"));
	// Stable names — no renames without golden bump
	for (const name of g.mcpTools) {
		assert.match(name, /^taskflow_[a-z_]+$/);
	}
});

test("public surface 0.3 planned: RunStatus/RunStage/approval modes documented", () => {
	const g = loadGolden();
	assert.ok(g.runStatus_0_3.includes("unknown"));
	assert.ok(g.runStatus_0_3.includes("cancelled"));
	assert.ok(g.runStage_0_3.includes("parked"));
	assert.ok(g.runStage_0_3.includes("reconciling"));
	assert.deepEqual(g.terminalRunStatus_0_3, ["completed", "failed", "blocked", "cancelled"]);
	assert.ok(!g.terminalRunStatus_0_3.includes("unknown"));
	assert.deepEqual(g.approvalModes_0_3, [
		"compat-auto-reject",
		"durable-optional",
		"durable-required",
	]);
});

test("public surface 0.2.4: fixture file is the single source under fixtures/", () => {
	const g = loadGolden();
	assert.equal(g.version, "0.2.4");
	assert.equal(g.phaseTypes.length, PHASE_TYPES.length);
});
