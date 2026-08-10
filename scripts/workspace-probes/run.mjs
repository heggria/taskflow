#!/usr/bin/env node

/**
 * W0.5 evidence collector.
 *
 * This probe is intentionally conservative: it records exact binaries and a
 * real OS sandbox smoke suite, but it never upgrades a host to `sandboxed-*`
 * merely because the generic script mechanism passes.  Agent, ScriptExecutor,
 * and FileBroker evidence must all pass before an owner may add an approved
 * cell to host-support-baseline.json.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOSTS = ["pi", "codex", "claude", "opencode", "grok"];
const PROCESS_CHECKS = [
	"exactCwd",
	"readInsideReadOnly",
	"writeInsideReadOnlyDenied",
	"readInsideReadWrite",
	"writeInsideReadWrite",
	"siblingScopeDenied",
	"outsideScopeDenied",
	"symlinkEscapeDenied",
	"ambientUserDataDenied",
	"privateTempEnforced",
	"descendantEnforcement",
	"abortDescendantCleanup",
	"networkPolicyEnforced",
	"credentialIsolationEnforced",
	"baselineRuntimeUsable",
	"resolverOpenPathSwapDenied",
	"exactMetadataNoFollow",
	"unsupportedPolicyFailsClosed",
];
const FILE_BROKER_CHECKS = [
	"readInsideReadOnly",
	"writeInsideReadOnlyDenied",
	"readInsideReadWrite",
	"writeInsideReadWrite",
	"siblingScopeDenied",
	"outsideScopeDenied",
	"symlinkEscapeDenied",
	"brokeredReadNoFollow",
	"brokeredWriteNoFollow",
	"fingerprintNoFollow",
	"resolverOpenPathSwapDenied",
	"abortCleanup",
	"exactMetadataNoFollow",
	"unsupportedPolicyFailsClosed",
];
const RESOLVE_ONLY_CAPABILITIES = {
	schemaVersion: 1,
	backendId: "taskflow-resolve-only",
	backendCapabilityVersion: "1",
	agent: "resolve-only",
	script: "resolve-only",
	sandboxFeatures: {
		maxGrants: 1,
		scopeKinds: ["directory"],
		perGrantAccess: true,
		denyAmbientUserData: false,
		exactBaselineMounts: false,
		privateTempPerExecution: false,
		descendantEnforcement: false,
		raceFreeFileBroker: false,
		networkModes: ["host-policy"],
		credentialModes: [],
	},
	brokeredRead: false,
	brokeredWrite: false,
	versionCommitModes: ["generation-only"],
	restoreStrategies: [],
	baselinePolicyId: "taskflow-resolve-only",
};
const BIN_ENV = {
	pi: "PI_TASKFLOW_PI_BIN",
	codex: "PI_TASKFLOW_CODEX_BIN",
	claude: "PI_TASKFLOW_CLAUDE_BIN",
	opencode: "PI_TASKFLOW_OPENCODE_BIN",
	grok: "PI_TASKFLOW_GROK_BIN",
};

function commandPath(command) {
	const override = process.env[BIN_ENV[command]];
	if (override) return override;
	const result = spawnSync("/usr/bin/env", ["sh", "-c", "command -v -- \"$1\"", "sh", command], {
		encoding: "utf8",
	});
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const RESOLVE_ONLY_CAPABILITIES_SHA256 = createHash("sha256")
	.update(canonicalJson(RESOLVE_ONLY_CAPABILITIES))
	.digest("hex");

function versionOf(binary) {
	const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n")[0] || `exit:${result.status ?? "unknown"}`;
}

function osTarget() {
	if (process.arch !== "arm64" && process.arch !== "x64") {
		throw new Error(`Unsupported probe architecture: ${process.arch}`);
	}
	if (process.platform === "darwin") {
		return {
			os: "macos",
			osVersion: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
			osBuild: execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(),
			arch: process.arch,
		};
	}
	if (process.platform === "linux") {
		return {
			os: "linux",
			osVersion: process.release.name,
			osBuild: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
			arch: process.arch,
		};
	}
	if (process.platform === "win32") {
		return { os: "windows", osVersion: process.getSystemVersion?.() ?? "unknown", osBuild: process.version, arch: process.arch };
	}
	throw new Error(`Unsupported probe OS: ${process.platform}`);
}

function sbplQuote(value) {
	return `\"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

function suite(required, observed = {}) {
	const checks = Object.fromEntries(required.map((name) => [name, observed[name] === true]));
	return { pass: required.every((name) => checks[name]), checks };
}

function probeMacOSSandbox() {
	if (process.platform !== "darwin") return { mechanism: "unavailable", script: suite(PROCESS_CHECKS) };
	const sandboxExec = "/usr/bin/sandbox-exec";
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tfws-probe-")));
	const scope = path.join(root, "scope");
	const sibling = path.join(root, "sibling");
	const privateTemp = path.join(root, "private-temp");
	const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "tfws-outside-")));
	try {
		mkdirSync(scope);
		mkdirSync(sibling);
		mkdirSync(privateTemp);
		writeFileSync(path.join(scope, "read.txt"), "inside");
		writeFileSync(path.join(sibling, "deny.txt"), "sibling");
		writeFileSync(path.join(outside, "deny.txt"), "outside");
		symlinkSync(path.join(outside, "deny.txt"), path.join(scope, "escape"));

		// Allow the ordinary runtime baseline, then explicitly remove ambient
		// user/temp data and add back only the exact workspace/private temp.
		const home = realpathSync(process.env.HOME ?? "/nonexistent");
		const userTemp = realpathSync(tmpdir());
		const profile = [
			"(version 1)",
			"(allow default)",
			`(deny file-read* file-write* (subpath ${sbplQuote(home)}))`,
			`(deny file-read* file-write* (subpath ${sbplQuote(userTemp)}))`,
			`(allow file-read* file-write* (subpath ${sbplQuote(scope)}))`,
			`(allow file-read* file-write* (subpath ${sbplQuote(privateTemp)}))`,
		].join("\n");
		const profilePath = path.join(root, "probe.sb");
		writeFileSync(profilePath, profile);
		const childCode = [
			"const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');",
			"const [scope,sibling,outside,home,temp,sharedTemp]=process.argv.slice(1);",
			"const out={};",
			"const canRead=x=>{try{fs.readFileSync(x);return true}catch{return false}};",
			"const canWrite=x=>{try{fs.writeFileSync(x,'x');return true}catch{return false}};",
			"out.exactCwd=process.cwd()===scope;",
			"out.readInside=canRead(p.join(scope,'read.txt'));",
			"out.writeInside=canWrite(p.join(scope,'write.txt'));",
			"out.parentSiblingDenied=!canRead(p.join(sibling,'deny.txt'));",
			"out.outsideDenied=!canRead(p.join(outside,'deny.txt'));",
			"out.symlinkEscapeDenied=!canRead(p.join(scope,'escape'));",
			"out.homeDenied=!canRead(p.join(home,'.ssh','config'));",
			"out.privateTempWritable=canWrite(p.join(temp,'child.tmp'));",
			"out.sharedTempDenied=!canWrite(p.join(sharedTemp,'tfws-shared-'+process.pid));",
			"const child=cp.spawnSync(process.execPath,['-e',`const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(p.join(outside,'deny.txt'))});process.exit(3)}catch{process.exit(0)}`]);",
			"out.descendantInheritance=child.status===0;",
			"out.baselineRuntimeUsable=Buffer.from('ok').toString()==='ok';",
			"process.stdout.write(JSON.stringify(out));",
		].join("");
		const result = spawnSync(sandboxExec, ["-f", profilePath, process.execPath, "-e", childCode, scope, sibling, outside, home, privateTemp, userTemp], {
			cwd: scope,
			encoding: "utf8",
			env: { ...process.env, TMPDIR: privateTemp, TMP: privateTemp, TEMP: privateTemp },
			timeout: 20_000,
		});
		let checks = {};
		try { checks = JSON.parse(result.stdout || "{}"); } catch { /* reported below */ }
		return {
			mechanism: `sandbox-exec:${osTarget().osBuild}`,
			script: suite(PROCESS_CHECKS, result.status === 0 ? {
				exactCwd: checks.exactCwd,
				readInsideReadWrite: checks.readInside,
				writeInsideReadWrite: checks.writeInside,
				siblingScopeDenied: checks.parentSiblingDenied,
				outsideScopeDenied: checks.outsideDenied,
				symlinkEscapeDenied: checks.symlinkEscapeDenied,
				ambientUserDataDenied: checks.homeDenied,
				privateTempEnforced: checks.privateTempWritable && checks.sharedTempDenied,
				descendantEnforcement: checks.descendantInheritance,
				baselineRuntimeUsable: checks.baselineRuntimeUsable,
			} : {}),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
}

const targetOs = osTarget();
const scriptSandbox = probeMacOSSandbox();
const results = HOSTS.flatMap((host) => {
	const binary = commandPath(host);
	if (!binary) return [];
	return [{
		target: {
			host,
			hostVersion: versionOf(binary),
			hostBinarySha256: sha256File(realpathSync(binary)),
			...targetOs,
			sandboxMechanismVersion: scriptSandbox.mechanism,
			backendId: RESOLVE_ONLY_CAPABILITIES.backendId,
			backendCapabilityVersion: RESOLVE_ONLY_CAPABILITIES.backendCapabilityVersion,
			backendCapabilitiesSha256: RESOLVE_ONLY_CAPABILITIES_SHA256,
			baselinePolicyId: RESOLVE_ONLY_CAPABILITIES.baselinePolicyId,
		},
		classification: "resolve-only",
		agent: suite(PROCESS_CHECKS),
		script: scriptSandbox.script,
		fileBroker: suite(FILE_BROKER_CHECKS),
	}];
});

if (results.length === 0) throw new Error("No supported Taskflow host binary is installed; no evidence target can be identified");

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, probeVersion: "tfws-probe:v1", results }, null, 2)}\n`);
