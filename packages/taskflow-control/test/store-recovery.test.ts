/**
 * Journal-authoritative recovery after half-commit (projection deleted).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createControlHost,
	createScriptExecutionProvider,
	openProjectControlStore,
} from "../src/index.ts";

test("journal recovery: deleted run projection rebuilds from journal on open", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-home-"));
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "tf-rec-proj-"));
	const env = { ...process.env, TASKFLOW_HOME: home };
	try {
		const host = createControlHost({
			projectRoot: project,
			env,
			skipSingleton: true,
			controlMode: "standalone",
			provider: createScriptExecutionProvider(),
		});
		const r = await host.admitAndRun({
			program: {
				name: "recover-me",
				phases: [{ id: "main", type: "script", run: "echo recovered", final: true }],
			},
			commandId: "cmd-recover-1",
		});
		assert.equal(r.ok, true, JSON.stringify(r.error));
		const runId = r.run!.runId;
		const receiptId = r.receipt!.receiptId;
		host.close();

		// Simulate half-commit: journal intact, projection deleted
		const projPath = path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`);
		assert.ok(fs.existsSync(projPath));
		fs.unlinkSync(projPath);
		const byRun = path.join(project, ".taskflow", "control", "receipts", `by-run-${runId}.json`);
		if (fs.existsSync(byRun)) fs.unlinkSync(byRun);
		const receiptPath = path.join(project, ".taskflow", "control", "receipts", `${receiptId}.json`);
		if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);

		const store = openProjectControlStore(project);
		const recovered = store.getRun(runId);
		assert.ok(recovered, "run projection must rebuild from journal");
		assert.equal(recovered!.status, "completed");
		assert.equal(recovered!.runId, runId);

		const cmd = store.getCommand("cmd-recover-1");
		assert.ok(cmd);
		assert.equal(cmd!.runId, runId);

		// Explicit recover after deleting again
		fs.unlinkSync(path.join(project, ".taskflow", "control", "projections", `run-${runId}.json`));
		const stats = store.recoverFromJournal();
		assert.ok(stats.rebuiltRuns >= 1);
		assert.ok(store.getRun(runId));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	}
});
