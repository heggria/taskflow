import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const includeNativeChrome = process.argv
	.slice(2)
	.includes("--include-native-chrome");
const lanes = [
	{ browserEngine: "chromium" },
	{ browserEngine: "firefox" },
	{ browserEngine: "webkit" },
	...(includeNativeChrome
		? [
				{
					browserEngine: "chromium",
					browserChannel: "chrome",
				},
			]
		: []),
];

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

function runBrowserEngine({ browserEngine, browserChannel }) {
	const args = [
		"packages/taskflow-cli/test/e2e-web-console.mts",
	];
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const result = spawnSync(process.execPath, args, {
			cwd: repositoryRoot,
			env: {
				...process.env,
				TASKFLOW_WEB_BROWSER: browserEngine,
				...(browserChannel
					? {
							TASKFLOW_WEB_BROWSER_CHANNEL:
								browserChannel,
						}
					: {}),
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
					`${browserEngine}${browserChannel ? `:${browserChannel}` : ""} packaged E2E failed on attempt ${attempt} with ${result.status}`,
					diagnostic,
				]
					.filter(Boolean)
					.join("\n"),
			);
		}
	}
	throw new Error(
		`${browserEngine}${browserChannel ? `:${browserChannel}` : ""} packaged E2E exhausted retries`,
	);
}

run("pnpm", ["run", "build"]);

const reports = [];
for (const lane of lanes) {
	const { attempts, report } = runBrowserEngine(lane);
	if (report.browserEngine !== lane.browserEngine) {
		throw new Error(
			`${lane.browserEngine} E2E reported ${String(report.browserEngine)}`,
		);
	}
	if (
		(report.browserChannel ?? undefined) !==
		(lane.browserChannel ?? undefined)
	) {
		throw new Error(
			`${lane.browserEngine} E2E reported channel ${String(report.browserChannel)}`,
		);
	}
	reports.push({ ...report, matrixAttempts: attempts });
}

const [firstReport] = reports;
if (!firstReport) throw new Error("browser matrix produced no reports");
for (const report of reports) {
	if (
		JSON.stringify(report.candidate) !==
		JSON.stringify(firstReport.candidate)
	) {
		throw new Error(
			"browser matrix lanes did not use the same candidate identity",
		);
	}
}
if (firstReport.candidate.trackedDirty) {
	throw new Error(
		"browser candidate evidence requires a tracked-clean worktree",
	);
}

const outputDir = path.join(
	repositoryRoot,
	"output/playwright",
	"beta2-browser-matrix",
);
fs.mkdirSync(outputDir, { recursive: true });
const matrix = {
	schemaVersion: 2,
	status: "pass",
	measuredAt: new Date().toISOString(),
	candidate: firstReport.candidate,
	runtime: {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
	},
	engines: reports.map((report) => ({
		browserEngine: report.browserEngine,
		...(report.browserChannel
			? { browserChannel: report.browserChannel }
			: {}),
		browserVersion: report.browserVersion,
		attempts: report.matrixAttempts,
		packagedCli: report.packagedCli,
		multiProject: report.multiProject,
		listenerReused: report.listenerReused,
		independentLaunchCapabilities:
			report.independentLaunchCapabilities,
		crossPortBrowserCookieIsolation:
			report.crossPortBrowserCookieIsolation,
		sseConnected: report.sseConnected,
		pollingFallbackObserved:
			report.pollingFallbackObserved,
		pollingProjectionEquivalent:
			report.pollingProjectionEquivalent,
		pollingGetSurfaceInventoryCovered:
			report.pollingGetSurfaceInventoryCovered,
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
		approvalDecisionCommitted:
			report.approvalDecisionCommitted,
		approvalContinuationAfterRestartSafe:
			report.approvalContinuationAfterRestartSafe,
		approvalSettledAttemptsNotReplayed:
			report.approvalSettledAttemptsNotReplayed,
		approvalPrivateCheckpointNotReceiptReachable:
			report.approvalPrivateCheckpointNotReceiptReachable,
		cancelCommandCommitted:
			report.cancelCommandCommitted,
		completedReceiptAndArtifactRendered:
			report.completedReceiptAndArtifactRendered,
		proGraphTimelineAndNodeDetailRendered:
			report.proGraphTimelineAndNodeDetailRendered,
		proTabsKeyboardAndFocusVerified:
			report.proTabsKeyboardAndFocusVerified,
		proGraphDisclosureKeyboardVerified:
			report.proGraphDisclosureKeyboardVerified,
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
		taskListPageVirtualizationVerified:
			report.taskListPageVirtualizationVerified,
		artifactDownloadPathObserved:
			report.artifactDownloadPathObserved,
		settingsSwitchAndSingleSelectionKeyboardVerified:
			report.settingsSwitchAndSingleSelectionKeyboardVerified,
		sessionSafetyDialogFocusAndDismissalVerified:
			report.sessionSafetyDialogFocusAndDismissalVerified,
		currentSessionLogoutCommitted:
			report.currentSessionLogoutCommitted,
		listenerWideSessionRevocationCommitted:
			report.listenerWideSessionRevocationCommitted,
		listenerWideSessionRevocationInvalidatedPeer:
			report.listenerWideSessionRevocationInvalidatedPeer,
		sessionTerminationDiagnostics:
			report.sessionTerminationDiagnostics,
		mobileWidth: report.mobileWidth,
		horizontalOverflow: report.horizontalOverflow,
	})),
};
const bytes = `${JSON.stringify(matrix, null, 2)}\n`;
fs.writeFileSync(path.join(outputDir, "evidence.json"), bytes);
const candidateOutputDir = path.join(
	repositoryRoot,
	"artifacts/web-browser-matrix",
	matrix.candidate.gitCommit,
);
fs.mkdirSync(candidateOutputDir, { recursive: true });
fs.writeFileSync(
	path.join(candidateOutputDir, "report.json"),
	bytes,
);
console.log(JSON.stringify(matrix, null, 2));
