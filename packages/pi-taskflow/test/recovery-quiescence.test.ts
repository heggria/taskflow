import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { forkRunForResume, resumeSourceAfterOwnerExit } from "../../taskflow-core/src/resume.ts";
import { loadRunDiagnosed, probeProcess } from "../../taskflow-core/src/store.ts";

const fixture = fileURLToPath(new URL("./fixtures/recovery-quiescence-child.mts", import.meta.url));
async function until(check: () => boolean, message: () => string, timeout = 7000) {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout) assert.fail(message());
		await delay(20);
	}
}

for (const scenario of ["parallel", "linear", "timeout"] as const) {
	test(`recovery quiescence: real Pi adapter ${scenario} checkpoint after owner SIGKILL`, { timeout: 15000 }, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-quiescence-"));
		fs.mkdirSync(path.join(cwd, ".pi"));
		const nonce = randomUUID();
		const child = spawn(process.execPath, ["--conditions=development", "--experimental-strip-types", fixture, cwd, scenario, nonce], {
			env: { ...process.env, PI_TASKFLOW_BUILTIN_AGENTS_DIR: "" }, stdio: ["ignore", "pipe", "pipe"],
		});
		// Attach before any kill/exit, and wait for stream closure before removal.
		const closed = once(child, "close");
		let output = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		try {
			await until(() => output.includes('"ready":true'), () => `owned fixture did not reach checkpoint: ${output} ${stderr}`);
			const ready = JSON.parse(output.split("\n").find((line) => line.includes('"ready":true'))!);
			assert.equal(ready.nonce, nonce);
			assert.ok(path.relative(fs.realpathSync(cwd), fs.realpathSync(ready.filePath)).startsWith(".pi"));
			const parentBytes = fs.readFileSync(ready.filePath);
			child.kill("SIGKILL");
			await closed;
			const loaded = loadRunDiagnosed(cwd, ready.runId);
			assert.ok(loaded.ok, JSON.stringify(loaded));
			assert.equal(loaded.value.status, "running");
			assert.equal(probeProcess(loaded.value.foregroundOwner!.pid), "dead");
			const recovered = resumeSourceAfterOwnerExit(loaded.value, { cwd });
			if (scenario !== "linear") {
				assert.ok(ready.failures > 0, "EACCES must actually hit a continuation checkpoint");
				const owner = JSON.parse(fs.readFileSync(path.join(cwd, "child-owner.json"), "utf8"));
				assert.equal(owner.nonce, nonce);
				assert.equal(probeProcess(owner.pid), "alive", "mutating sibling survives the foreground owner");
				assert.deepEqual(Object.values(loaded.value.phases).filter((phase) => phase.status === "running").map((phase) => phase.id), ["approvalA"]);
				assert.equal(loaded.value.foregroundOwner!.approvalWait, undefined, "parallel dispatch or auto-expiry cannot leave a recovery-authorized marker");
				assert.equal(recovered.ok, false, "never fork while an unrecorded sibling remains alive");
				if (!recovered.ok) assert.match(recovered.errors.join(" "), /quiescent approval checkpoint/);
			} else {
				assert.equal(loaded.value.phases.upstream!.status, "done");
				assert.equal(loaded.value.phases.upstream!.output, "reusable");
				assert.deepEqual(loaded.value.foregroundOwner!.approvalWait, ["approvalA"]);
				assert.equal(fs.existsSync(path.join(cwd, "downstream-ran")), false);
				assert.ok(recovered.ok, JSON.stringify(recovered));
				const fork = forkRunForResume(recovered.value, { cwd, host: "pi" });
				assert.notEqual(fork.runId, loaded.value.runId);
				assert.equal(fork.parentRunId, loaded.value.runId);
				assert.deepEqual(fork.phases.upstream, loaded.value.phases.upstream);
				assert.equal(fork.foregroundOwner, undefined, "new host must supply its own owner and cannot inherit approvalWait");
				assert.equal(fork.phases.approvalA, undefined);
				assert.equal(fork.foregroundInterruption?.kind, "approval-owner-exit");
			}
			assert.deepEqual(fs.readFileSync(ready.filePath), parentBytes, "recovery admission never changes parent bytes");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
			const ownerFile = path.join(cwd, "child-owner.json");
			if (fs.existsSync(ownerFile)) {
				const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
				// Request self-exit through a private nonce-bound stop file and
				// wait for its acknowledgement and OS exit. Never signal a stored
				// PID, which could have been reused after the owner was killed.
				assert.equal(owner.nonce, nonce);
				assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid && owner.pid !== child.pid);
				if (probeProcess(owner.pid) === "alive") {
					fs.writeFileSync(path.join(cwd, "child-stop.json"), JSON.stringify({ nonce, pid: owner.pid }));
					await until(() => {
						try { return fs.readFileSync(path.join(cwd, "child-stopped"), "utf8") === nonce; }
						catch { return false; }
					}, () => "owned worker did not acknowledge its stop request", 5000);
					assert.equal(fs.readFileSync(path.join(cwd, "child-stopped"), "utf8"), nonce);
				}
				await until(() => probeProcess(owner.pid) === "dead", () => "owned script worker did not settle after cleanup", 5000);
			}
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
}
