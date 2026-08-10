import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	FILE_BROKER_EVIDENCE_CHECKS,
	HOST_PROBE_VERSION,
	hostProbeTargetsEqual,
	isExactHostProbeTarget,
	loadVerifiedHostSupportBaseline,
	matchSandboxedHostTarget,
	PROCESS_SANDBOX_EVIDENCE_CHECKS,
	validateHostSupportBaseline,
	type HostProbeEvidenceBundle,
	type HostProbeResult,
	type HostProbeTarget,
	type HostSupportBaseline,
} from "../src/resources/baseline.ts";

const target: HostProbeTarget = {
	host: "codex",
	hostVersion: "1.2.3",
	hostBinarySha256: "a".repeat(64),
	os: "macos",
	osVersion: "26.3",
	osBuild: "25D125",
	arch: "arm64",
	sandboxMechanismVersion: "sandbox-exec:25D125",
	backendId: "test-native",
	backendCapabilityVersion: "tfws-macos:v1",
	backendCapabilitiesSha256: "c".repeat(64),
	baselinePolicyId: "baseline",
};

function sha256(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function suite(checks: readonly string[], pass: boolean): { pass: boolean; checks: Record<string, boolean> } {
	return {
		pass,
		checks: Object.fromEntries(checks.map((check) => [check, pass])),
	};
}

function result(
	classification: HostProbeResult["classification"] = "sandboxed-single-root",
	resultTarget: HostProbeTarget = target,
): HostProbeResult {
	return {
		target: resultTarget,
		classification,
		agent: suite(PROCESS_SANDBOX_EVIDENCE_CHECKS, true) as HostProbeResult["agent"],
		script: suite(PROCESS_SANDBOX_EVIDENCE_CHECKS, true) as HostProbeResult["script"],
		fileBroker: suite(FILE_BROKER_EVIDENCE_CHECKS, true) as HostProbeResult["fileBroker"],
	};
}

function evidenceBundle(probeResult: HostProbeResult): HostProbeEvidenceBundle {
	return { schemaVersion: 1, probeVersion: HOST_PROBE_VERSION, results: [probeResult] };
}

function baseline(
	evidenceDigest: string,
	classification: "sandboxed-single-root" | "resolve-only" = "sandboxed-single-root",
): HostSupportBaseline {
	const evidence = { path: "conformance/workspace/results/codex.json", sha256: evidenceDigest };
	return {
		schemaVersion: 1,
		baselineId: "test",
		cells: [{
			target,
			classification,
			agent: { ...evidence },
			script: { ...evidence },
			fileBroker: { ...evidence },
			decision: { owner: "security", status: "approved", reason: "all probes pass" },
		}],
	};
}

function fixture(classification: "sandboxed-single-root" | "resolve-only" = "sandboxed-single-root"): {
	repositoryRoot: string;
	evidencePath: string;
	baselinePath: string;
	baseline: HostSupportBaseline;
} {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-baseline-"));
	const evidencePath = path.join(repositoryRoot, "conformance", "workspace", "results", "codex.json");
	const baselinePath = path.join(repositoryRoot, "conformance", "workspace", "host-support-baseline.json");
	fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
	const evidenceBody = JSON.stringify(evidenceBundle(result(classification)));
	fs.writeFileSync(evidencePath, evidenceBody);
	const value = baseline(sha256(evidenceBody), classification);
	fs.writeFileSync(baselinePath, JSON.stringify(value));
	return { repositoryRoot, evidencePath, baselinePath, baseline: value };
}

test("host baseline authorizes only a trusted-loader verified exact sandbox cell", () => {
	const sandboxed = fixture();
	const resolveOnly = fixture("resolve-only");
	try {
		assert.deepEqual(matchSandboxedHostTarget(sandboxed.baseline, target), {
			ok: false,
			reason: "host support baseline was not loaded and evidence-verified by the trusted loader",
		});
		const verified = loadVerifiedHostSupportBaseline({ repositoryRoot: sandboxed.repositoryRoot });
		assert.equal(matchSandboxedHostTarget(verified, target).ok, true);
		assert.deepEqual(matchSandboxedHostTarget(verified, { ...target, hostVersion: "1.2.4" }), {
			ok: false,
			reason: "no exact host/OS/architecture/binary evidence cell",
		});

		const verifiedResolveOnly = loadVerifiedHostSupportBaseline({ repositoryRoot: resolveOnly.repositoryRoot });
		assert.deepEqual(matchSandboxedHostTarget(verifiedResolveOnly, target), {
			ok: false,
			reason: "evidence cell is classified resolve-only",
		});
	} finally {
		fs.rmSync(sandboxed.repositoryRoot, { recursive: true, force: true });
		fs.rmSync(resolveOnly.repositoryRoot, { recursive: true, force: true });
	}
});

test("host baseline rejects duplicates, unsafe evidence paths, and malformed hashes", () => {
	const value = baseline("a".repeat(64));
	value.cells.push(structuredClone(value.cells[0]));
	value.cells[0].agent.path = "../secret.json";
	value.cells[0].script.sha256 = "ABC";
	const errors = validateHostSupportBaseline(value).join("\n");
	assert.match(errors, /duplicates an exact target cell/);
	assert.match(errors, /safe repository-relative path/);
	assert.match(errors, /lowercase sha256/);
	assert.equal(matchSandboxedHostTarget(value, target).ok, false);
});

test("host target equality has unambiguous field boundaries and rejects control characters", () => {
	const approved = { ...target, osVersion: "26\0evil", osBuild: "build" };
	const live = { ...target, osVersion: "26", osBuild: "evil\0build" };
	assert.equal(isExactHostProbeTarget(approved), false);
	assert.equal(isExactHostProbeTarget(live), false);
	assert.equal(hostProbeTargetsEqual(approved, live), false);
});

test("trusted baseline loader verifies evidence hash, exact target, pass state, and no symlinks", (t) => {
	const tampered = fixture();
	const wrongTarget = fixture();
	const failing = fixture();
	const linked = fixture();
	try {
		fs.appendFileSync(tampered.evidencePath, "\n");
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: tampered.repositoryRoot }),
			/evidence sha256 mismatch/,
		);

		const wrongBody = JSON.stringify(evidenceBundle(result("sandboxed-single-root", { ...target, osBuild: "different" })));
		fs.writeFileSync(wrongTarget.evidencePath, wrongBody);
		const wrongBaseline = baseline(sha256(wrongBody));
		fs.writeFileSync(wrongTarget.baselinePath, JSON.stringify(wrongBaseline));
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: wrongTarget.repositoryRoot }),
			/target does not exactly match/,
		);

		const failingResult = result();
		failingResult.agent = suite(PROCESS_SANDBOX_EVIDENCE_CHECKS, false) as HostProbeResult["agent"];
		const failingBody = JSON.stringify(evidenceBundle(failingResult));
		fs.writeFileSync(failing.evidencePath, failingBody);
		fs.writeFileSync(failing.baselinePath, JSON.stringify(baseline(sha256(failingBody))));
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: failing.repositoryRoot }),
			/agent evidence did not pass/,
		);

		if (process.platform === "win32") {
			t.skip("symlink creation requires platform-specific privileges");
			return;
		}
		const realEvidence = path.join(linked.repositoryRoot, "real-evidence.json");
		fs.renameSync(linked.evidencePath, realEvidence);
		fs.symlinkSync(realEvidence, linked.evidencePath);
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: linked.repositoryRoot }),
			/must not contain symlinks/,
		);
	} finally {
		for (const item of [tampered, wrongTarget, failing, linked]) {
			fs.rmSync(item.repositoryRoot, { recursive: true, force: true });
		}
	}
});

test("trusted baseline evidence requires every named boolean check and rejects unknown checks", () => {
	const missing = fixture();
	const unknown = fixture();
	const unknownVersion = fixture();
	try {
		const missingBundle = evidenceBundle(result());
		delete (missingBundle.results[0].agent.checks as Partial<Record<string, boolean>>).abortDescendantCleanup;
		const missingBody = JSON.stringify(missingBundle);
		fs.writeFileSync(missing.evidencePath, missingBody);
		fs.writeFileSync(missing.baselinePath, JSON.stringify(baseline(sha256(missingBody))));
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: missing.repositoryRoot }),
			/agent\.checks must contain exactly/,
		);

		const unknownBundle = evidenceBundle(result());
		(unknownBundle.results[0].fileBroker.checks as Record<string, boolean>).madeUpCheck = true;
		const unknownBody = JSON.stringify(unknownBundle);
		fs.writeFileSync(unknown.evidencePath, unknownBody);
		fs.writeFileSync(unknown.baselinePath, JSON.stringify(baseline(sha256(unknownBody))));
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: unknown.repositoryRoot }),
			/fileBroker\.checks must contain exactly/,
		);

		const versionBundle = evidenceBundle(result());
		versionBundle.probeVersion = "tfws-probe:v0";
		const versionBody = JSON.stringify(versionBundle);
		fs.writeFileSync(unknownVersion.evidencePath, versionBody);
		fs.writeFileSync(unknownVersion.baselinePath, JSON.stringify(baseline(sha256(versionBody))));
		assert.throws(
			() => loadVerifiedHostSupportBaseline({ repositoryRoot: unknownVersion.repositoryRoot }),
			/probeVersion must be tfws-probe:v1/,
		);
	} finally {
		fs.rmSync(missing.repositoryRoot, { recursive: true, force: true });
		fs.rmSync(unknown.repositoryRoot, { recursive: true, force: true });
		fs.rmSync(unknownVersion.repositoryRoot, { recursive: true, force: true });
	}
});

test("checked-in probe evidence uses the exact trusted-loader schema", () => {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-baseline-probe-"));
	try {
		const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
		const source = path.join(projectRoot, "conformance", "workspace", "results", "macos-26.3-arm64-25D125.json");
		const evidenceBody = fs.readFileSync(source, "utf8");
		const bundle = JSON.parse(evidenceBody) as HostProbeEvidenceBundle;
		assert.ok(bundle.results.length > 0);
		const probeResult = bundle.results[0];
		const evidencePath = path.join(repositoryRoot, "conformance", "workspace", "results", "probe.json");
		const baselinePath = path.join(repositoryRoot, "conformance", "workspace", "host-support-baseline.json");
		fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
		fs.writeFileSync(evidencePath, evidenceBody);
		const evidence = { path: "conformance/workspace/results/probe.json", sha256: sha256(evidenceBody) };
		const value: HostSupportBaseline = {
			schemaVersion: 1,
			baselineId: "probe-schema",
			cells: [{
				target: probeResult.target,
				classification: probeResult.classification,
				agent: { ...evidence },
				script: { ...evidence },
				fileBroker: { ...evidence },
				decision: { owner: "test", status: "rejected", reason: "schema-only validation" },
			}],
		};
		fs.writeFileSync(baselinePath, JSON.stringify(value));
		const verified = loadVerifiedHostSupportBaseline({ repositoryRoot });
		assert.equal(verified.cells.length, 1);
		assert.equal(matchSandboxedHostTarget(verified, probeResult.target).ok, false);
	} finally {
		fs.rmSync(repositoryRoot, { recursive: true, force: true });
	}
});

test("an empty verified proposed baseline enables no sandbox target", () => {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-baseline-empty-"));
	try {
		const directory = path.join(repositoryRoot, "conformance", "workspace");
		fs.mkdirSync(directory, { recursive: true });
		const empty: HostSupportBaseline = { schemaVersion: 1, baselineId: "proposed-empty", cells: [] };
		fs.writeFileSync(path.join(directory, "host-support-baseline.json"), JSON.stringify(empty));
		assert.deepEqual(validateHostSupportBaseline(empty), []);
		const verified = loadVerifiedHostSupportBaseline({ repositoryRoot });
		assert.equal(matchSandboxedHostTarget(verified, target).ok, false);
	} finally {
		fs.rmSync(repositoryRoot, { recursive: true, force: true });
	}
});
