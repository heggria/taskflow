import { openControlStore } from "../../src/store/store.ts";
import { createControlEvidenceStore } from "../../src/store/evidence-adapter.ts";
const [storePath, runId, point] = process.argv.slice(2);
const store = openControlStore(storePath);
const evidence = await createControlEvidenceStore(store, {
	authorize() { throw new Error("crash worker never discloses"); },
	terminalEvidence: { verify(_project, _runId, evidenceId) {
		const terminal = store.readJournal().flatMap(batch => batch.events).find(event => event.eventId === evidenceId);
		if (terminal?.payload.kind !== "run.terminal" || terminal.payload.status !== "completed") throw new Error("missing seeded test terminal");
		return { terminalStatus: "completed", terminalEventId: evidenceId, evidenceCommit: "trusted-test-provider", providerOutcome: "completed" };
	} },
	onDurabilityPoint(observed) { if (observed === point) process.kill(process.pid, "SIGKILL"); },
});
if (point === "lifecycle-committed") process.env.TASKFLOW_CONTROL_CRASH_AT = point;
await evidence.issueFinalReceipt(runId);
throw new Error("expected crash did not occur");
