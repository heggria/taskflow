/** Process boundary fixture. Authority is issued by this test host, never by
 * coordinator wire input. No provider or credential discovery occurs. */
import { openCoordinatorStore, COORDINATOR_CRASH_ENV, type CoordinatorIdentity } from "../../src/store/coordinator-store.ts";
import { ControlError } from "../../src/errors.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const config = JSON.parse(process.argv[2]!) as {
	path: string; mode: "reserve" | "commit" | "persist-admission" | "normalRelease" | "forceRelease" | "snapshot";
	max?: number; epoch?: number; identity: CoordinatorIdentity;
	input: { reservationId: string; projectId: string; projectControlDomainId: string; runId: string; ttlMs: number; projectAdmitCommitSeq?: number };
	crash?: string; clockOffset?: number; commandId?: string;
};
if (config.clockOffset) { const realNow = Date.now; Date.now = () => realNow() + config.clockOffset!; }
const context = Object.freeze({ token: Symbol("test-host-issued-context") });
const epoch = config.epoch ?? 1;
try {
	const store = await openCoordinatorStore(config.path, { initialMaxActiveRuns: config.max ?? 8, epoch, holderId: "fixture-host", authority: {
		readLease: () => ({ holderId: "fixture-host", fencingEpoch: epoch, endpoint: "test://coordinator", expiresAt: Date.now() + 60_000 }),
		authorize: (ctx) => { if (ctx !== context) throw new ControlError("TF_AUTHORITY_REVOKED", "unknown context"); return config.identity; },
		readAdmission: (row) => {
			const proofFile = path.join(config.path, "test-project-admission.json");
			if (fs.existsSync(proofFile)) return JSON.parse(fs.readFileSync(proofFile, "utf8"));
			return row.projectAdmitCommitSeq === undefined ? { status: "not-admitted" as const, reservationId: row.reservationId, projectId: row.projectId, projectControlDomainId: row.projectControlDomainId, runId: row.runId, runVersion: 0 }
				: { ...row, projectAdmitCommitSeq: config.input.projectAdmitCommitSeq ?? 7, runVersion: 1 };
		},
		readRelease: (row) => ({ ...row, projectAdmitCommitSeq: row.projectAdmitCommitSeq!, runVersion: 2, proofId: "fixture-provider-proof", status: "completed", stage: "terminal", requiresReadmission: false, providerNoLiveProcessTree: true, noAmbiguousJobs: true, reconcileTimeoutOnly: false }),
	} });
	if (config.mode === "persist-admission") {
		const fd = fs.openSync(path.join(config.path, "test-project-admission.json"), "wx", 0o600);
		try { fs.writeFileSync(fd, JSON.stringify({ reservationId: config.input.reservationId, projectId: config.input.projectId, projectControlDomainId: config.input.projectControlDomainId, runId: config.input.runId, projectAdmitCommitSeq: 7, runVersion: 1 })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		process.kill(process.pid, "SIGKILL");
	}
	if (config.crash) process.env[COORDINATOR_CRASH_ENV] = config.crash;
	const result = config.mode === "reserve" ? await store.reserve(config.input, context)
		: config.mode === "commit" ? await store.commit(config.input.reservationId, { projectAdmitCommitSeq: config.input.projectAdmitCommitSeq ?? 7 }, context)
		: config.mode === "normalRelease" ? await store.normalRelease(config.input.reservationId, context)
		: config.mode === "forceRelease" ? await store.forceRelease(config.input.reservationId, { commandId: config.commandId!, riskAcknowledgement: true, reason: "operator reviewed unknown provider" }, context)
		: await store.snapshot(context);
	store.close();
	process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error instanceof ControlError ? error.code : "unexpected", message: error instanceof Error ? error.message : String(error) }) + "\n");
	process.exitCode = 2;
}
