/**
 * B06: MCP tryControlPlaneRun + empty-mount taskflowd share one ControlStore
 * ledger via UDS admit (projectRoot on-demand mount). Agent-over-UDS remains
 * fail-closed — no portable host LLM provider crosses the socket.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
// Relative import: mcp-core does not depend on taskflow-daemon at package level;
// this cross-package attach proof is lane-owned test surface only.
import { startDaemon } from "../../taskflow-daemon/src/index.ts";
import {
	controlPlaneEnabled,
	tryControlPlaneRun,
} from "taskflow-control";

function temp(): {
	env: NodeJS.ProcessEnv;
	home: string;
	project: string;
	cleanup: () => void;
} {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-mcp-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-mcp-proj-"));
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

const SCRIPT_FLOW = {
	name: "b06-mcp-ingress",
	phases: [
		{
			id: "main",
			type: "script" as const,
			run: "echo mcp-single-ingress-ok",
			final: true,
		},
	],
};

test("D1: MCP attach + empty-mount daemon share one ControlStore run/Receipt", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	const env = { ...t.env };
	delete env.TASKFLOW_CONTROL_PLANE;
	assert.equal(controlPlaneEnabled(env), true);

	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env,
			projectRoots: [],
			mountAllowRoots: [t.project],
			holderId: "b06-mcp-ingress-daemon",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.equal(daemon.hosts.size, 0);
		assert.ok(daemon.socketPath);

		const routed = await tryControlPlaneRun(t.project, SCRIPT_FLOW, {
			env,
			commandId: "b06-mcp-uds-1",
			principal: "mcp:b06",
		});
		assert.equal(routed.handled, true, JSON.stringify(routed));
		if (!routed.handled) throw new Error("unreachable");
		assert.equal(routed.ok, true, routed.text);
		assert.equal(routed.viaControlHost, true);
		assert.equal(
			(routed as { via?: string }).via,
			"uds-client",
			"MCP must attach via ControlClient, not a second local ledger",
		);
		assert.ok(routed.runId);
		assert.ok(routed.receiptId);
		assert.match(routed.text, /mcp-single-ingress-ok|control-plane run completed/);

		assert.equal(daemon.hosts.size, 1, "daemon mounted the MCP project once");
		const writerHost = [...daemon.hosts.values()][0]!;
		const snap = writerHost.getSnapshot(routed.runId!);
		assert.ok(snap, "daemon writer must see the MCP run on the shared project store");
		assert.equal(snap!.run.runId, routed.runId);
		assert.equal(snap!.receipt?.receiptId, routed.receiptId);
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("D5: MCP admit of pre-mounted project succeeds under empty allowlist (reuse before policy)", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	const env = { ...t.env };
	delete env.TASKFLOW_CONTROL_PLANE;

	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		// Operator pre-mounted the project; on-demand allowlist is empty.
		daemon = await startDaemon({
			env,
			projectRoots: [t.project],
			mountAllowRoots: [],
			holderId: "b06-mcp-premount-reuse",
			listenUds: true,
		});
		assert.equal(daemon.role, "writer");
		assert.equal(daemon.hosts.size, 1);
		const writerHost = [...daemon.hosts.values()][0]!;

		const routed = await tryControlPlaneRun(t.project, SCRIPT_FLOW, {
			env,
			commandId: "b06-mcp-premount-1",
			principal: "mcp:b06-premount",
		});
		assert.equal(routed.handled, true, JSON.stringify(routed));
		if (!routed.handled) throw new Error("unreachable");
		assert.equal(routed.ok, true, routed.text);
		assert.equal((routed as { via?: string }).via, "uds-client");
		assert.equal(daemon.hosts.size, 1, "must reuse pre-mounted host");
		assert.ok(writerHost.getSnapshot(routed.runId!));

		// Unlisted first-time root still denied (allowlist only on first open).
		const outsider = fs.mkdtempSync(path.join(os.tmpdir(), "tf-b06-mcp-out-"));
		try {
			const denied = await tryControlPlaneRun(
				outsider,
				SCRIPT_FLOW,
				{ env, commandId: "b06-mcp-out-deny", principal: "mcp:b06-out" },
			);
			assert.equal(denied.handled, true);
			if (!denied.handled) throw new Error("unreachable");
			assert.equal(denied.ok, false, "unlisted first-time root must not admit");
			assert.match(denied.text, /TF_POLICY_DENIED|allowlist|denied|policy/i);
			assert.equal(daemon.hosts.size, 1);
		} finally {
			fs.rmSync(outsider, { recursive: true, force: true });
		}
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});

test("D4: MCP agent admit over UDS is fail-closed (no host LLM bridge)", async () => {
	if (process.platform === "win32") return;
	const t = temp();
	const env = { ...t.env };
	delete env.TASKFLOW_CONTROL_PLANE;

	let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
	try {
		daemon = await startDaemon({
			env,
			projectRoots: [],
			mountAllowRoots: [t.project],
			holderId: "b06-mcp-agent-deny",
			listenUds: true,
		});
		assert.ok(daemon.socketPath);

		const routed = await tryControlPlaneRun(
			t.project,
			{
				name: "agent-uds",
				phases: [
					{
						id: "main",
						type: "agent",
						agent: "executor",
						task: "no portable LLM over UDS",
						final: true,
					},
				],
			},
			{
				env,
				commandId: "b06-mcp-agent",
				principal: "mcp:b06",
				// Local llmProvider must NOT be smuggled over UDS.
				llmProvider: {
					name: "fake-local-llm",
					async submit() {
						throw new Error("local llm must not be invoked over UDS attach");
					},
					async poll() {
						throw new Error("local llm must not be invoked over UDS attach");
					},
					async cancel() {
						throw new Error("local llm must not be invoked over UDS attach");
					},
					async reconcile() {
						throw new Error("local llm must not be invoked over UDS attach");
					},
				},
			},
		);
		assert.equal(routed.handled, true);
		if (!routed.handled) throw new Error("unreachable");
		assert.equal(routed.ok, false, "agent-over-UDS must fail closed");
		assert.equal((routed as { via?: string }).via, "uds-client");
		assert.match(routed.text, /LLM|llm|provider|fail|unavailable/i);
	} finally {
		await daemon?.stop();
		t.cleanup();
	}
});
