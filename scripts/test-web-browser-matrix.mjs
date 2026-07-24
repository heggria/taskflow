import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const engines = ["chromium", "firefox", "webkit"];

function run(command, args, env = process.env) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10 * 60_000,
	});
	if (result.status !== 0) {
		throw new Error(
			[
				`${command} ${args.join(" ")} failed with ${result.status}`,
				result.stdout,
				result.stderr,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result.stdout;
}

function runBrowserEngine(engine) {
	const args = [
		"packages/taskflow-cli/test/e2e-web-console.mts",
	];
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const result = spawnSync(process.execPath, args, {
			cwd: repositoryRoot,
			env: {
				...process.env,
				TASKFLOW_WEB_BROWSER: engine,
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10 * 60_000,
		});
		if (result.status === 0) {
			return {
				attempts: attempt,
				report: JSON.parse(result.stdout),
			};
		}
		const diagnostic = [result.stdout, result.stderr]
			.filter(Boolean)
			.join("\n");
		const browserClosed =
			/Target page, context or browser has been closed|browser has been closed/u.test(
				diagnostic,
			);
		if (!browserClosed || attempt === 2) {
			throw new Error(
				[
					`${engine} packaged E2E failed on attempt ${attempt} with ${result.status}`,
					diagnostic,
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
	}
	throw new Error(`${engine} packaged E2E exhausted retries`);
}

run("pnpm", ["run", "build"]);

const reports = [];
for (const engine of engines) {
	const { attempts, report } = runBrowserEngine(engine);
	if (report.browserEngine !== engine) {
		throw new Error(
			`${engine} E2E reported ${String(report.browserEngine)}`,
		);
	}
	reports.push({ ...report, matrixAttempts: attempts });
}

const outputDir = path.join(
	repositoryRoot,
	"output/playwright",
	"beta2-browser-matrix",
);
fs.mkdirSync(outputDir, { recursive: true });
const matrix = {
	schemaVersion: 1,
	engines: reports.map((report) => ({
		browserEngine: report.browserEngine,
		browserVersion: report.browserVersion,
		attempts: report.matrixAttempts,
		consoleErrors: report.consoleErrors,
		pageErrors: report.pageErrors,
		browserTransportDiagnostics:
			report.browserTransportDiagnostics,
		cspViolations: report.cspViolations,
		runtimeStyleInsertions:
			report.runtimeStyleInsertions,
		inlineStyleAttributes: report.inlineStyleAttributes,
		runtimeStyleElements: report.runtimeStyleElements,
		a11yViolationCounts: report.a11yViolationCounts,
		simpleAttentionCopyVerified:
			report.simpleAttentionCopyVerified,
		receiptJsonExported: report.receiptJsonExported,
		receiptJsonLocallyChecked:
			report.receiptJsonLocallyChecked,
		whyStaleDistinctFromReplay:
			report.whyStaleDistinctFromReplay,
		zeroTokenReplayExecuted:
			report.zeroTokenReplayExecuted,
		zeroTokenReplayProviderCalls:
			report.zeroTokenReplayProviderCalls,
		zeroTokenReplayDurableWrites:
			report.zeroTokenReplayDurableWrites,
		proGraphListboxKeyboardParityVerified:
			report.proGraphListboxKeyboardParityVerified,
		currentSessionLogoutCommitted:
			report.currentSessionLogoutCommitted,
		listenerWideSessionRevocationCommitted:
			report.listenerWideSessionRevocationCommitted,
		listenerWideSessionRevocationInvalidatedPeer:
			report.listenerWideSessionRevocationInvalidatedPeer,
		sessionTerminationDiagnostics:
			report.sessionTerminationDiagnostics,
	})),
};
fs.writeFileSync(
	path.join(outputDir, "evidence.json"),
	`${JSON.stringify(matrix, null, 2)}\n`,
);
console.log(JSON.stringify(matrix, null, 2));
