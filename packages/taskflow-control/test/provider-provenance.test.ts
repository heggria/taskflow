import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createMockExecutionProvider,
	openProjectControlStore,
	projectProjectionsDir,
	type ExecutionProvider,
} from "../src/index.ts";

function workspace() {
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-provider-provenance-home-"),
	);
	const project = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-provider-provenance-project-"),
	);
	return {
		home,
		project,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup() {
			fs.rmSync(home, { recursive: true, force: true });
			fs.rmSync(project, { recursive: true, force: true });
		},
	};
}

test("Receipt provenance is unknown when completion is recovered without a terminal Attempt checkpoint", async () => {
	const temp = workspace();
	const provider: ExecutionProvider = {
		name: "reconcile-completes",
		async submit() {
			return {
				kind: "accepted",
				handle: "job-reconcile-completes",
				leaseEpoch: 1,
			};
		},
		async poll() {
			return { kind: "still-running" };
		},
		async cancel() {
			return { kind: "already-terminal" };
		},
		async reconcile() {
			return {
				kind: "completed",
				output: "recovered output",
			};
		},
		isLive() {
			return false;
		},
	};
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		env: temp.env,
		provider,
		reconcileBudget: {
			maxAttempts: 1,
			deadlineMs: 20,
		},
	});
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-reconcile-provenance",
			program: {
				name: "reconcile-provenance",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf ignored",
						final: true,
					},
				],
			},
		});
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(result.run?.status, "completed");
		assert.equal(result.receipt?.assurance.providerOutcome, "ok");
		assert.equal(result.receipt?.assurance.provenance, "unknown");
		assert.equal(
			host.store.getReceiptForRun(result.run!.runId)
				?.assurance.provenance,
			"unknown",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});

test("provider Attempt checkpoint and ok Receipt provenance survive projection loss", async () => {
	const temp = workspace();
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		env: temp.env,
		provider: createMockExecutionProvider({
			outcome: "completed",
			output: "checkpointed output",
		}),
	});
	let runId = "";
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-provider-checkpoint",
			program: {
				name: "provider-checkpoint",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf ignored",
						final: true,
					},
				],
			},
		});
		assert.equal(result.ok, true, JSON.stringify(result.error));
		runId = result.run!.runId;
		assert.equal(
			result.receipt?.assurance.provenance,
			"ok",
		);
	} finally {
		host.close();
	}
	try {
		for (const file of fs.readdirSync(
			projectProjectionsDir(temp.project),
		)) {
			fs.unlinkSync(
				path.join(
					projectProjectionsDir(temp.project),
					file,
				),
			);
		}
		const reopened = openProjectControlStore(temp.project);
		const recovered = reopened.getRun(runId);
		assert.equal(recovered?.status, "completed");
		assert.equal(recovered?.providerName, "mock");
		assert.equal(
			recovered?.attempts?.[0]
				?.providerJobHandlePresent,
			true,
		);
		assert.equal(
			reopened.getReceiptForRun(runId)?.assurance
				.provenance,
			"ok",
		);
	} finally {
		temp.cleanup();
	}
});

test("Attempt checkpoint failure can recover completion but cannot claim ok provenance", async () => {
	const temp = workspace();
	const host = createControlHost({
		projectRoot: temp.project,
		controlMode: "standalone",
		skipSingleton: true,
		env: temp.env,
		provider: createMockExecutionProvider({
			outcome: "completed",
			output: "completion after checkpoint failure",
		}),
		reconcileBudget: {
			maxAttempts: 1,
			deadlineMs: 20,
		},
	});
	const commit = host.store.commit.bind(host.store);
	let injected = false;
	host.store.commit = (batch) => {
		if (
			!injected &&
			batch.events?.some(
				(event) =>
					event.payload.type === "Generic" &&
					event.payload.kind ===
						"PhaseAttemptStarted",
			)
		) {
			injected = true;
			throw new Error("injected Attempt checkpoint failure");
		}
		return commit(batch);
	};
	try {
		const result = await host.admitAndRun({
			commandId: "cmd-provider-checkpoint-failure",
			program: {
				name: "provider-checkpoint-failure",
				phases: [
					{
						id: "main",
						type: "script",
						run: "printf ignored",
						final: true,
					},
				],
			},
		});
		assert.equal(injected, true);
		assert.equal(result.ok, true, JSON.stringify(result.error));
		assert.equal(result.run?.status, "completed");
		assert.equal(
			result.receipt?.assurance.providerOutcome,
			"ok",
		);
		assert.equal(
			result.receipt?.assurance.provenance,
			"unknown",
		);
		assert.equal(
			host.store.getReceiptForRun(result.run!.runId)
				?.assurance.provenance,
			"unknown",
		);
	} finally {
		host.close();
		temp.cleanup();
	}
});
