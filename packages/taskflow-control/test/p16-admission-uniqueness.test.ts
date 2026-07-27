/**
 * P16 D2 — admission uniqueness: commitReservation enforces unique
 * (projectId, projectControlDomainId, runId) among capacity-occupying bindings.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	CoordinatorAdmissionConflictError,
	openUserCoordinatorStore,
} from "../src/store/coordinator.ts";
import { parentReleaseStart } from "./helpers/mp-barrier.mts";

function tempEnv(): { env: NodeJS.ProcessEnv; home: string; cleanup: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p16-admit-"));
	return {
		home,
		env: { ...process.env, TASKFLOW_HOME: home },
		cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
	};
}

function openPublic(env: NodeJS.ProcessEnv) {
	return openUserCoordinatorStore(env, {
		allowUnfencedMutationForExplicitNonGaMode: true,
	});
}

const BINDING = {
	projectId: "proj-shared",
	projectControlDomainId: "dom-shared",
	runId: "run-shared",
	projectAdmitCommitSeq: 11,
} as const;

test("P16 D2: interleaved commit of the same triple is unique under the state lock", () => {
	const t = tempEnv();
	try {
		const coordinator = openPublic(t.env);
		const first = coordinator.reserve();
		const second = coordinator.reserve();
		assert.ok(first);
		assert.ok(second);

		const committed = coordinator.commitReservation(first.reservationId, BINDING);
		assert.equal(committed.state, "committed");
		assert.equal(coordinator.occupyingCount(), 2); // second still reserved

		assert.throws(
			() => coordinator.commitReservation(second.reservationId, BINDING),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(
					error.message,
					/TF_ADMISSION_BINDING_CONFLICT|unique|already bound|logical admission/,
				);
				if (error instanceof CoordinatorAdmissionConflictError) {
					assert.equal(error.code, "TF_ADMISSION_BINDING_CONFLICT");
					assert.equal(error.existingReservationId, first.reservationId);
					assert.equal(error.attemptedReservationId, second.reservationId);
				} else {
					const code = (error as { code?: string }).code;
					if (code !== undefined) {
						assert.equal(code, "TF_ADMISSION_BINDING_CONFLICT");
					}
				}
				return true;
			},
		);
		assert.equal(coordinator.getReservation(second.reservationId)?.state, "reserved");
		assert.equal(coordinator.occupyingCount(), 2);

		// Same reservation + same binding is idempotent.
		const again = coordinator.commitReservation(first.reservationId, BINDING);
		assert.equal(again.state, "committed");
		assert.equal(again.reservationId, first.reservationId);
		const occupyingSameBinding = coordinator
			.listReservations()
			.filter(
				(r) =>
					(r.state === "committed" || r.state === "orphan-suspect") &&
					r.projectId === BINDING.projectId &&
					r.projectControlDomainId === BINDING.projectControlDomainId &&
					r.runId === BINDING.runId,
			);
		assert.equal(occupyingSameBinding.length, 1);
	} finally {
		t.cleanup();
	}
});

test("P16 D2: multi-process concurrent commit of the same triple admits exactly one", async () => {
	const t = tempEnv();
	// Drive the race with two child processes via a temp script inside the home
	// dir (not a package source edit). Only p16-*.test.ts may be added here.
	const childScript = path.join(t.home, "mp-commit-child.mts");
	fs.writeFileSync(
		childScript,
		`
import { openUserCoordinatorStore } from ${JSON.stringify(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/store/coordinator.ts"),
		)};
import * as fs from "node:fs";
import * as path from "node:path";

const home = process.argv[2];
const reservationId = process.argv[3];
const barrierDir = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (!home || !reservationId || !barrierDir) process.exit(2);

const readyPath = path.join(barrierDir, \`ready-\${id}\`);
const startPath = path.join(barrierDir, "start");
fs.writeFileSync(readyPath, String(process.pid));
const deadline = Date.now() + 15_000;
while (!fs.existsSync(startPath)) {
  if (Date.now() > deadline) throw new Error("barrier timeout");
}
const env = { ...process.env, TASKFLOW_HOME: home };
const coord = openUserCoordinatorStore(env, { allowUnfencedMutationForExplicitNonGaMode: true });
try {
  const committed = coord.commitReservation(reservationId, {
    projectId: "proj-shared",
    projectControlDomainId: "dom-shared",
    runId: "run-shared",
    projectAdmitCommitSeq: 11,
  });
  process.stdout.write(JSON.stringify({ ok: true, state: committed.state, reservationId }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  process.stdout.write(JSON.stringify({ ok: false, message, code, reservationId }));
}
`,
		"utf-8",
	);

	try {
		const coordinator = openPublic(t.env);
		const first = coordinator.reserve();
		const second = coordinator.reserve();
		assert.ok(first);
		assert.ok(second);

		const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-p16-mp-commit-"));
		const spawnChild = (reservationId: string, id: string): Promise<{ status: number; stdout: string }> => {
			const child: ChildProcess = spawn(
				process.execPath,
				["--conditions=development", "--experimental-strip-types", childScript, t.home, reservationId],
				{
					env: { ...process.env, TF_MP_BARRIER: barrierDir, TF_MP_ID: id },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			return new Promise((resolve) => {
				let stdout = "";
				let stderr = "";
				child.stdout?.setEncoding("utf-8");
				child.stderr?.setEncoding("utf-8");
				child.stdout?.on("data", (c: string) => {
					stdout += c;
				});
				child.stderr?.on("data", (c: string) => {
					stderr += c;
				});
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
					resolve({ status: 124, stdout: stdout + stderr });
				}, 20_000);
				child.on("close", (code) => {
					clearTimeout(timer);
					resolve({ status: code ?? 1, stdout: stdout || stderr });
				});
			});
		};

		const resultsPromise = Promise.all([
			spawnChild(first.reservationId, "0"),
			spawnChild(second.reservationId, "1"),
		]);
		parentReleaseStart(barrierDir, 2, 15_000);
		const results = await resultsPromise;
		try {
			fs.rmSync(barrierDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}

		for (const result of results) {
			assert.equal(result.status, 0, result.stdout);
		}
		const parsed = results.map((r) => JSON.parse(r.stdout) as { ok: boolean; message?: string; code?: string });
		const successes = parsed.filter((p) => p.ok);
		const failures = parsed.filter((p) => !p.ok);
		assert.equal(successes.length, 1, `exactly one commit must win: ${results.map((r) => r.stdout).join(" | ")}`);
		assert.equal(failures.length, 1, `exactly one commit must lose: ${results.map((r) => r.stdout).join(" | ")}`);
		assert.match(
			failures[0]!.message ?? "",
			/TF_ADMISSION_BINDING_CONFLICT|unique|already bound|logical admission/,
		);

		const reopened = openPublic(t.env);
		const occupyingSameBinding = reopened
			.listReservations()
			.filter(
				(r) =>
					(r.state === "committed" || r.state === "orphan-suspect") &&
					r.projectId === BINDING.projectId &&
					r.projectControlDomainId === BINDING.projectControlDomainId &&
					r.runId === BINDING.runId,
			);
		assert.equal(occupyingSameBinding.length, 1);
		// One committed + one still reserved (loser) = 2 occupying.
		assert.equal(reopened.occupyingCount(), 2);
	} finally {
		t.cleanup();
	}
});
