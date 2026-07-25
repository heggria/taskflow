import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	spawn,
	spawnSync,
	type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import {
	chromium,
	expect,
	type Page,
	type Route,
} from "@playwright/test";
import {
	createControlHost,
	type WebRunDetail,
} from "../../taskflow-control/dist/index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, "../../..");
const cliBin = path.join(
	repositoryRoot,
	"packages/taskflow-cli/dist/bin.js",
);
const fixtureRoot = path.join(
	repositoryRoot,
	"packages/taskflow-control/test/fixtures/web-v1/reference",
);
const outputRoot = process.env.TASKFLOW_WEB_REFERENCE_OUTPUT_ROOT
	? path.resolve(
			repositoryRoot,
			process.env.TASKFLOW_WEB_REFERENCE_OUTPUT_ROOT,
		)
	: path.join(
			repositoryRoot,
			"output/playwright/beta2-reference",
		);
const evidencePath = path.join(
	repositoryRoot,
	"docs/internal/webui/reference-set-v1/render-evidence.json",
);
const webAssetManifestPath = path.join(
	repositoryRoot,
	"packages/taskflow-web/dist/app/taskflow-web-assets.json",
);

type Fixture = {
	readonly id: string;
	readonly screenId: string;
	readonly state: string;
	readonly sourceKind: string;
	readonly source: Record<string, unknown>;
	readonly projection: Record<string, unknown>;
};

type Scenario = {
	readonly fixtureId: string;
	readonly screenId: string;
	readonly route: "home" | "task" | "settings";
	readonly tab?: "graph" | "evidence";
};

type CliLaunchResult = {
	readonly ok: true;
	readonly launchUrl: string;
	readonly origin: string;
};

const representativeScenarios: readonly Scenario[] = [
	{
		fixtureId: "simple-home-partial-disconnected",
		screenId: "simple-home",
		route: "home",
	},
	{
		fixtureId: "active-task-result",
		screenId: "active-task",
		route: "task",
	},
	{
		fixtureId: "needs-input-decision",
		screenId: "needs-input-decision",
		route: "task",
	},
	{
		fixtureId: "completed-verified",
		screenId: "completed-task",
		route: "task",
	},
	{
		fixtureId: "unknown-reconciling",
		screenId: "unknown-reconciling",
		route: "task",
	},
	{
		fixtureId: "pro-graph-node-inspector",
		screenId: "pro-graph",
		route: "task",
		tab: "graph",
	},
	{
		fixtureId: "pro-evidence-receipt",
		screenId: "pro-evidence",
		route: "task",
		tab: "evidence",
	},
	{
		fixtureId: "settings-session",
		screenId: "settings",
		route: "settings",
	},
	{
		fixtureId: "error-command-outcome-unknown",
		screenId: "error-recovery",
		route: "task",
	},
] as const;

const supplementalScenarios: readonly Scenario[] = [
	{
		fixtureId: "simple-home-empty",
		screenId: "simple-home",
		route: "home",
	},
	{
		fixtureId: "completed-verification-unavailable",
		screenId: "completed-task",
		route: "task",
	},
	{
		fixtureId: "error-ordinary-preserved-result",
		screenId: "error-recovery",
		route: "task",
	},
	{
		fixtureId: "error-protocol-incompatible",
		screenId: "error-recovery",
		route: "home",
	},
	{
		fixtureId: "error-cursor-expired",
		screenId: "error-recovery",
		route: "home",
	},
] as const;

const viewports = {
	"1440x900": { width: 1440, height: 900, deviceScaleFactor: 1 },
	"1024x768": { width: 1024, height: 768, deviceScaleFactor: 1 },
	"320-css-px": { width: 320, height: 760, deviceScaleFactor: 1 },
	"200-percent-zoom": {
		width: 720,
		height: 450,
		deviceScaleFactor: 2,
	},
} as const;

function sha256File(filePath: string): string {
	return `sha256:${createHash("sha256")
		.update(fs.readFileSync(filePath))
		.digest("hex")}`;
}

function gitOutput(args: readonly string[]): string {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	assert.equal(
		result.status,
		0,
		`git ${args.join(" ")} failed\n${result.stderr}`,
	);
	return result.stdout.trim();
}

function loadFixture(id: string): Fixture {
	return JSON.parse(
		fs.readFileSync(path.join(fixtureRoot, `${id}.json`), "utf8"),
	) as Fixture;
}

function runCli(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Record<string, unknown> {
	const result = spawnSync(process.execPath, [cliBin, ...args], {
		cwd: repositoryRoot,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(
		result.status,
		0,
		`taskflow ${args.join(" ")} failed\n${result.stderr}`,
	);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function startUiOwner(
	projectRoot: string,
	env: NodeJS.ProcessEnv,
): Promise<{
	readonly child: ChildProcess;
	readonly result: CliLaunchResult;
}> {
	const child = spawn(
		process.execPath,
		[
			cliBin,
			"ui",
			"--no-open",
			"--project",
			projectRoot,
		],
		{
			cwd: repositoryRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const result = await new Promise<CliLaunchResult>(
		(resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				reject(
					new Error(
						`reference UI did not launch\n${stderr}`,
					),
				);
			}, 30_000);
			child.once("exit", (code) => {
				if (!stdout.trim()) {
					clearTimeout(timer);
					reject(
						new Error(
							`reference UI exited ${code}\n${stderr}`,
						),
					);
				}
			});
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
				try {
					const parsed = JSON.parse(
						stdout,
					) as CliLaunchResult;
					clearTimeout(timer);
					resolve(parsed);
				} catch {
					// Pretty-printed JSON is incomplete until the final chunk.
				}
			});
		},
	);
	return { child, result };
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.ok(
		value !== null &&
			typeof value === "object" &&
			!Array.isArray(value),
	);
	return value as Record<string, unknown>;
}

function success(data: unknown): string {
	return JSON.stringify({
		ok: true,
		requestId: "reference-render-request",
		schemaVersion: "web.v1",
		data,
	});
}

function patchActions(
	value: unknown,
	detail: WebRunDetail,
): unknown[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => {
		const action = asRecord(item);
		const requestBase = asRecord(action.requestBase);
		return {
			...action,
			requestBase: {
				...requestBase,
				projectId: detail.run.projectId,
				controlDomainId: detail.run.controlDomainId,
				runId: detail.run.runId,
				expectedRunVersion: detail.run.runVersion,
			},
		};
	});
}

function taskDetailFor(
	fixture: Fixture,
	baseline: WebRunDetail,
): WebRunDetail {
	const sourceRun = asRecord(fixture.source.run);
	const sourceObservation = asRecord(
		fixture.source.sourceObservation,
	);
	return {
		...baseline,
		run: {
			...baseline.run,
			status: sourceRun.status as WebRunDetail["run"]["status"],
			stage: sourceRun.stage as WebRunDetail["run"]["stage"],
			needsOperator: Boolean(sourceRun.needsOperator),
			stopping: Boolean(sourceRun.stopping),
			sideEffects:
				sourceRun.sideEffects as WebRunDetail["run"]["sideEffects"],
		},
		displayTitle: String(
			sourceRun.displayTitle ?? baseline.displayTitle,
		),
		workspaceDisplayName: String(
			sourceRun.workspaceDisplayName ??
				baseline.workspaceDisplayName,
		),
		presentation:
			fixture.projection as WebRunDetail["presentation"],
		sourceObservation:
			sourceObservation as WebRunDetail["sourceObservation"],
		availableActions: patchActions(
			fixture.source.availableActions,
			baseline,
		) as WebRunDetail["availableActions"],
	};
}

function failureStatus(fixtureId: string): number {
	if (fixtureId === "error-cursor-expired") return 410;
	if (fixtureId === "error-protocol-incompatible") return 409;
	return 500;
}

async function settleScenario(
	page: Page,
	scenario: Scenario,
): Promise<void> {
	if (scenario.fixtureId === "error-protocol-incompatible") {
		await expect(
			page.locator(".boot-page .error-panel"),
		).toBeVisible({ timeout: 15_000 });
	} else if (
		scenario.fixtureId.startsWith("error-") &&
		scenario.fixtureId !== "error-command-outcome-unknown"
	) {
		await expect(page.locator(".error-panel")).toBeVisible({
			timeout: 15_000,
		});
	} else if (scenario.route === "task") {
		await expect(
			page.locator(".task-page .hero-status"),
		).toBeVisible({ timeout: 15_000 });
	} else if (scenario.route === "settings") {
		await expect(page.locator(".settings-section")).toBeVisible({
			timeout: 15_000,
		});
	} else {
		await expect(page.locator(".page .empty-state")).toBeVisible({
			timeout: 15_000,
		});
	}
	if (scenario.fixtureId === "pro-graph-node-inspector") {
		await expect(page.locator("svg.graph-svg")).toBeVisible();
		const publish = page
			.locator(".graph-node")
			.filter({ hasText: "publish" });
		await publish.click();
		await expect(page.locator(".graph-inspector")).toContainText(
			"publish",
		);
	}
	if (scenario.fixtureId === "pro-evidence-receipt") {
		await expect(page.locator(".artifact-row")).toHaveCount(3);
		await expect(
			page.locator(".artifact-disclosure-blocked"),
		).toBeVisible();
		const sensitiveArtifactRow = page
			.locator(".artifact-row")
			.filter({ hasText: "replay-trace" });
		await sensitiveArtifactRow
			.getByRole("button")
			.click();
		const sensitiveArtifactDialog = page.locator(
			".sensitive-artifact-dialog",
		);
		await expect(sensitiveArtifactDialog).toBeVisible();
		await sensitiveArtifactDialog
			.locator(".secondary-button")
			.click();
		await expect(sensitiveArtifactDialog).toBeHidden();
		await expect(page.locator(".technical-card").first()).toBeVisible();
	}
	if (scenario.fixtureId === "error-command-outcome-unknown") {
		await expect(page.locator(".error-panel")).toBeVisible();
	}
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
}

async function main(): Promise<void> {
	const outputRelative = path.relative(repositoryRoot, outputRoot);
	assert.equal(
		outputRelative.startsWith("..") || path.isAbsolute(outputRelative),
		false,
		"reference render output must remain inside the repository",
	);
	assert.ok(
		outputRelative.length > 0 &&
			outputRelative.split(path.sep).filter(Boolean).length >= 2,
		"reference render output must be a dedicated nested directory",
	);
	assert.ok(
		["artifacts", "output"].includes(
			outputRelative.split(path.sep)[0] ?? "",
		),
		"reference render output must live under artifacts/ or output/",
	);
	const trackedStatus = gitOutput([
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	assert.equal(
		trackedStatus,
		"",
		"reference renders require a tracked-clean source candidate",
	);
	const gitCommit = gitOutput(["rev-parse", "HEAD"]);
	assert.match(gitCommit, /^[0-9a-f]{40}$/u);
	assert.equal(
		fs.existsSync(webAssetManifestPath),
		true,
		"packaged Web asset manifest is missing; run the full build before rendering",
	);
	const webAssetManifest = JSON.parse(
		fs.readFileSync(webAssetManifestPath, "utf8"),
	) as { webBuildId?: unknown };
	assert.equal(typeof webAssetManifest.webBuildId, "string");
	assert.match(
		webAssetManifest.webBuildId as string,
		/^sha256:[0-9a-f]{64}$/u,
	);
	fs.rmSync(outputRoot, { recursive: true, force: true });
	fs.mkdirSync(outputRoot, { recursive: true });
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-reference-render-"),
	);
	const home = path.join(tempRoot, "home");
	const project = path.join(tempRoot, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	const env = {
		...process.env,
		TASKFLOW_HOME: home,
		PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
	};
	const host = createControlHost({
		projectRoot: project,
		controlMode: "auto",
		skipSingleton: true,
		env,
	});
	try {
		const result = await host.admitAndRun({
			program: {
				name: "Reference task",
				phases: [
					{
						id: "reference-step",
						type: "script",
						run: "printf 'reference-result\\n'",
						final: true,
					},
				],
			},
			commandId: "cmd-reference-render",
			callerPrincipal: "reference-render",
		});
		assert.equal(result.ok, true);
	} finally {
		host.close();
	}

	let owner:
		| Awaited<ReturnType<typeof startUiOwner>>
		| undefined;
	let browser: Awaited<
		ReturnType<typeof chromium.launch>
	> | undefined;
	try {
		owner = await startUiOwner(project, env);
		browser = await chromium.launch({ headless: true });
		const setupContext = await browser.newContext({
			locale: "en-US",
			viewport: { width: 1440, height: 900 },
			reducedMotion: "reduce",
		});
		const setupPage = await setupContext.newPage();
		await setupPage.goto(owner.result.launchUrl, {
			waitUntil: "domcontentloaded",
		});
		await expect(setupPage.locator(".page")).toBeVisible({
			timeout: 15_000,
		});
		const baseline = await setupPage.evaluate(async () => {
			const runEnvelope = await (
				await fetch(
					"/api/v1/runs?limit=1&sortDirection=desc&sortKey=updatedAt",
				)
			).json();
			const run = runEnvelope.data.items[0];
			const detailEnvelope = await (
				await fetch(
					`/api/v1/projects/${encodeURIComponent(run.projectId)}/domains/${encodeURIComponent(run.controlDomainId)}/runs/${encodeURIComponent(run.runId)}`,
				)
			).json();
			const overviewEnvelope = await (
				await fetch("/api/v1/overview")
			).json();
			const bootstrapEnvelope = await (
				await fetch("/api/v1/bootstrap")
			).json();
			return {
				detail: detailEnvelope.data,
				overview: overviewEnvelope.data,
				bootstrap: bootstrapEnvelope.data,
			};
		}) as {
			detail: WebRunDetail;
			overview: Record<string, unknown>;
			bootstrap: Record<string, unknown>;
		};
		await setupContext.close();

		let currentScenario = representativeScenarios[0]!;
		let currentFixture = loadFixture(
			currentScenario.fixtureId,
		);
		const screenshots: Array<{
			fixtureId: string;
			screenId: string;
			locale: string;
			theme: string;
			viewport: string;
			path: string;
			sha256: string;
			horizontalOverflow: boolean;
			seriousOrCriticalA11yViolations: number | null;
		}> = [];

		for (const locale of ["en", "zh-CN"] as const) {
			const context = await browser.newContext({
				locale: locale === "en" ? "en-US" : "zh-CN",
				viewport: { width: 1440, height: 900 },
				colorScheme: "light",
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.goto(
				runCli(
					[
						"ui",
						"--no-open",
						"--project",
						project,
					],
					env,
				).launchUrl as string,
				{ waitUntil: "domcontentloaded" },
			);
			await expect(page.locator(".page")).toBeVisible({
				timeout: 15_000,
			});
			await page.route("**/api/v1/**", async (route: Route) => {
				const url = new URL(route.request().url());
				const pathname = url.pathname;
				const fixtureId = currentScenario.fixtureId;
				const source = currentFixture.source;
				if (pathname === "/api/v1/events") {
					if (
						fixtureId ===
						"simple-home-partial-disconnected"
					) {
						await route.abort("connectionfailed");
					} else {
						await route.continue();
					}
					return;
				}
				if (
					pathname === "/api/v1/bootstrap" &&
					fixtureId === "settings-session"
				) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success(source),
					});
					return;
				}
				if (
					pathname === "/api/v1/bootstrap" &&
					fixtureId === "error-protocol-incompatible"
				) {
					await route.fulfill({
						status: failureStatus(fixtureId),
						contentType: "application/json",
						body: JSON.stringify(source.failure),
					});
					return;
				}
				if (pathname === "/api/v1/overview") {
					if (
						fixtureId ===
							"error-cursor-expired"
					) {
						await route.fulfill({
							status: failureStatus(fixtureId),
							contentType: "application/json",
							body: JSON.stringify(
								source.failure,
							),
						});
						return;
					}
					if (fixtureId === "simple-home-empty") {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: success(source),
						});
						return;
					}
					if (
						fixtureId ===
						"simple-home-partial-disconnected"
					) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: success({
								...baseline.overview,
								sourceObservation:
									source.sourceObservation,
							}),
						});
						return;
					}
				}
				if (pathname === "/api/v1/runs") {
					if (
						currentScenario.route === "home" &&
						fixtureId.startsWith("simple-home")
					) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: success({
								items: [],
								sourceObservation:
									fixtureId ===
									"simple-home-empty"
										? source.sourceObservation
										: asRecord(
												source.sourceObservation,
											),
							}),
						});
						return;
					}
				}
				if (pathname === "/api/v1/approvals") {
					if (
						currentScenario.route === "home" &&
						fixtureId.startsWith("simple-home")
					) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: success({
								items: [],
								sourceObservation:
									fixtureId ===
									"simple-home-empty"
										? source.sourceObservation
										: asRecord(
												source.sourceObservation,
											),
							}),
						});
						return;
					}
				}
				const runPath =
					`/api/v1/projects/${baseline.detail.run.projectId}` +
					`/domains/${baseline.detail.run.controlDomainId}` +
					`/runs/${baseline.detail.run.runId}`;
				if (pathname === runPath) {
					if (
						fixtureId ===
						"error-ordinary-preserved-result"
					) {
						await route.fulfill({
							status: failureStatus(fixtureId),
							contentType: "application/json",
							body: JSON.stringify(
								source.failure,
							),
						});
						return;
					}
					const taskFixture =
						currentFixture.sourceKind ===
						"task-projection"
							? currentFixture
							: loadFixture(
									"completed-verified",
								);
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success(
							taskDetailFor(
								taskFixture,
								baseline.detail,
							),
						),
					});
					return;
				}
				if (pathname === `${runPath}/graph`) {
					const graph = asRecord(source);
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success({
							...graph,
							projectId:
								baseline.detail.run.projectId,
							controlDomainId:
								baseline.detail.run
									.controlDomainId,
							runId: baseline.detail.run.runId,
							runVersion:
								baseline.detail.run.runVersion,
							query: {
								...asRecord(graph.query),
								expectedRunVersion:
									baseline.detail.run
										.runVersion,
							},
						}),
					});
					return;
				}
				if (pathname.includes(`${runPath}/nodes/`)) {
					const graphFixture = loadFixture(
						"pro-graph-node-inspector",
					);
					const graphSource =
						graphFixture.source as {
							nodes: Array<Record<string, unknown>>;
							edges: Array<Record<string, unknown>>;
							sourceObservation: Record<
								string,
								unknown
							>;
						};
					const nodeInstanceId = decodeURIComponent(
						pathname.split("/").at(-1) ?? "",
					);
					const node = graphSource.nodes.find(
						(candidate) =>
							candidate.nodeInstanceId ===
							nodeInstanceId,
					);
					if (
						pathname.endsWith("/attempts") &&
						pathname.split("/").at(-2)
					) {
						await route.fulfill({
							status: 200,
							contentType: "application/json",
							body: success({
								items: [
									{
										attemptId:
											"attempt-1",
										nodeInstanceId:
											pathname
												.split("/")
												.at(-2),
										provider: "fixture",
										status: "completed",
										providerJobHandlePresent:
											true,
									},
								],
								sourceObservation:
									graphSource.sourceObservation,
							}),
						});
						return;
					}
					assert.ok(node);
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success({
							projectId:
								baseline.detail.run.projectId,
							controlDomainId:
								baseline.detail.run
									.controlDomainId,
							runId: baseline.detail.run.runId,
							runVersion:
								baseline.detail.run.runVersion,
							node,
							definitionId: node.phaseId,
							dependencyNodeInstanceIds:
								graphSource.edges
									.filter(
										(edge) =>
											edge.toNodeInstanceId ===
											nodeInstanceId,
									)
									.map(
										(edge) =>
											edge.fromNodeInstanceId,
									),
							attemptCount: node.attemptCount,
							attempts: {
								items: [],
								sourceObservation:
									graphSource.sourceObservation,
							},
							providerObservation: {
								provider: "fixture",
								jobHandlePresent: true,
								outcome: "completed",
							},
							inputRefs: [],
							outputRefs: [],
							cacheExplanation:
								"No cache decision was used.",
							linkedFragmentHashes: [],
							childNodeInstanceIds: [],
							timelineEventIds: [],
							sourceObservation:
								graphSource.sourceObservation,
							availableActions: [],
						}),
					});
					return;
				}
				if (pathname === `${runPath}/artifacts`) {
					const evidenceFixture = loadFixture(
						"pro-evidence-receipt",
					);
					const receipt = asRecord(
						evidenceFixture.source.receipt,
					);
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success({
							items: receipt.artifactRefs,
							sourceObservation:
								evidenceFixture.source
									.sourceObservation,
						}),
					});
					return;
				}
				if (pathname === `${runPath}/receipt`) {
					const evidenceFixture = loadFixture(
						"pro-evidence-receipt",
					);
					const evidenceSource = {
						...evidenceFixture.source,
						receipt: {
							...asRecord(
								evidenceFixture.source.receipt,
							),
							projectId:
								baseline.detail.run.projectId,
							controlDomainId:
								baseline.detail.run
									.controlDomainId,
							runId: baseline.detail.run.runId,
						},
					};
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success(evidenceSource),
					});
					return;
				}
				if (pathname === `${runPath}/why-stale`) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success({
							targets: url.searchParams
								.getAll("targetIds")
								.map((targetId) => ({
									targetId,
									changedComponents: [],
									reuseDecision:
										"unavailable",
									provenanceRefs: [],
									unavailableReason:
										"Fingerprint evidence is unavailable.",
								})),
							sourceObservation:
								baseline.detail
									.sourceObservation,
						}),
					});
					return;
				}
				if (
					pathname === "/api/v1/commands/command-1" &&
					fixtureId ===
						"error-command-outcome-unknown"
				) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: success({
							commandId: "command-1",
							status: "not-found",
							observedAt: Date.now(),
						}),
					});
					return;
				}
				await route.continue();
			});

			for (const theme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme: theme });
				for (const [
					viewportName,
					viewport,
				] of Object.entries(viewports)) {
					await page.setViewportSize({
						width: viewport.width,
						height: viewport.height,
					});
					for (const scenario of representativeScenarios) {
						currentScenario = scenario;
						currentFixture = loadFixture(
							scenario.fixtureId,
						);
						const query = new URLSearchParams();
						if (scenario.tab) {
							query.set("view", "pro");
							query.set("tab", scenario.tab);
						}
						if (
							scenario.fixtureId ===
							"error-command-outcome-unknown"
						) {
							query.set("op", "command-1");
						}
						const routePath =
							scenario.route === "home"
								? "/"
								: scenario.route === "settings"
									? "/settings"
									: `/workspaces/${baseline.detail.run.projectId}/domains/${baseline.detail.run.controlDomainId}/tasks/${baseline.detail.run.runId}`;
						await page.goto(
							`${owner.result.origin}${routePath}${query.size ? `?${query}` : ""}`,
							{ waitUntil: "domcontentloaded" },
						);
						await settleScenario(
							page,
							scenario,
						);
						await page.evaluate(() => {
							window.scrollTo(0, 0);
						});
						const layout = await page.evaluate(
							() => ({
								clientWidth:
									document.documentElement
										.clientWidth,
								scrollWidth:
									document.documentElement
										.scrollWidth,
							}),
						);
						const overflow =
							layout.scrollWidth >
							layout.clientWidth;
						assert.equal(
							overflow,
							false,
							`${scenario.fixtureId}/${locale}/${theme}/${viewportName} overflowed`,
						);
						let blockingCount: number | null = null;
						if (
							theme === "light" &&
							(viewportName === "1440x900" ||
								viewportName ===
									"320-css-px")
						) {
							const analysis =
								await new AxeBuilder({
									page,
								})
									.withTags([
										"wcag2a",
										"wcag2aa",
										"wcag21a",
										"wcag21aa",
									])
									.analyze();
							const blocking =
								analysis.violations.filter(
									(violation) =>
										violation.impact ===
											"critical" ||
										violation.impact ===
											"serious",
								);
							blockingCount = blocking.length;
							assert.equal(
								blockingCount,
								0,
								`${scenario.fixtureId}/${locale}/${viewportName} has serious accessibility violations: ${JSON.stringify(
									blocking.map(
										(violation) => ({
											id: violation.id,
											nodes: violation.nodes.map(
												(node) =>
													node.target,
											),
										}),
									),
								)}`,
							);
						}
						await page.evaluate(() => {
							if (
								document.activeElement instanceof
								HTMLElement
							) {
								document.activeElement.blur();
							}
						});
						const fileName =
							`${scenario.screenId}--${scenario.fixtureId}` +
							`--${locale}--${theme}--${viewportName}.png`;
						const filePath = path.join(
							outputRoot,
							fileName,
						);
						await page.screenshot({
							path: filePath,
							fullPage: true,
						});
						screenshots.push({
							fixtureId:
								scenario.fixtureId,
							screenId: scenario.screenId,
							locale,
							theme,
							viewport: viewportName,
							path: path.relative(
								repositoryRoot,
								filePath,
							),
							sha256: sha256File(filePath),
							horizontalOverflow: overflow,
							seriousOrCriticalA11yViolations:
								blockingCount,
						});
					}
				}
			}
			await context.close();
		}

		const context = await browser.newContext({
			locale: "en-US",
			viewport: { width: 1440, height: 900 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		await page.goto(
			runCli(
				[
					"ui",
					"--no-open",
					"--project",
					project,
				],
				env,
			).launchUrl as string,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(page.locator(".page")).toBeVisible();
		await page.route("**/api/v1/**", async (route) => {
			const fixture = currentFixture;
			const pathname = new URL(route.request().url()).pathname;
			if (
				pathname === "/api/v1/bootstrap" &&
				currentScenario.fixtureId ===
					"error-protocol-incompatible"
			) {
				await route.fulfill({
					status: 409,
					contentType: "application/json",
					body: JSON.stringify(fixture.source.failure),
				});
				return;
			}
			if (
				pathname === "/api/v1/overview" &&
				currentScenario.fixtureId ===
					"error-cursor-expired"
			) {
				await route.fulfill({
					status: 410,
					contentType: "application/json",
					body: JSON.stringify(fixture.source.failure),
				});
				return;
			}
			const runPath =
				`/api/v1/projects/${baseline.detail.run.projectId}` +
				`/domains/${baseline.detail.run.controlDomainId}` +
				`/runs/${baseline.detail.run.runId}`;
			if (
				pathname === runPath &&
				currentScenario.fixtureId ===
					"error-ordinary-preserved-result"
			) {
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify(fixture.source.failure),
				});
				return;
			}
			if (pathname === "/api/v1/overview") {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: success(fixture.source),
				});
				return;
			}
			if (pathname === "/api/v1/runs") {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: success({
						items: [],
						sourceObservation:
							fixture.source.sourceObservation,
					}),
				});
				return;
			}
			if (pathname === "/api/v1/approvals") {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: success({
						items: [],
						sourceObservation:
							fixture.source.sourceObservation,
					}),
				});
				return;
			}
			if (pathname === runPath) {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: success(
						taskDetailFor(
							fixture,
							baseline.detail,
						),
					),
				});
				return;
			}
			await route.continue();
		});
		for (const scenario of supplementalScenarios) {
			currentScenario = scenario;
			currentFixture = loadFixture(scenario.fixtureId);
			const routePath =
				scenario.route === "task"
					? `/workspaces/${baseline.detail.run.projectId}/domains/${baseline.detail.run.controlDomainId}/tasks/${baseline.detail.run.runId}`
					: "/";
			await page.goto(`${owner.result.origin}${routePath}`, {
				waitUntil: "domcontentloaded",
			});
			await settleScenario(page, scenario);
			await page.evaluate(() => {
				window.scrollTo(0, 0);
			});
			const fileName =
				`${scenario.screenId}--${scenario.fixtureId}` +
				"--en--light--1440x900.png";
			const filePath = path.join(outputRoot, fileName);
			await page.screenshot({
				path: filePath,
				fullPage: true,
			});
			screenshots.push({
				fixtureId: scenario.fixtureId,
				screenId: scenario.screenId,
				locale: "en",
				theme: "light",
				viewport: "1440x900",
				path: path.relative(repositoryRoot, filePath),
				sha256: sha256File(filePath),
				horizontalOverflow: false,
				seriousOrCriticalA11yViolations: null,
			});
		}
		await context.close();

		const fixtureDigests = Object.fromEntries(
			fs
				.readdirSync(fixtureRoot)
				.filter((file) => file.endsWith(".json"))
				.sort()
				.map((file) => [
					file.replace(/\.json$/u, ""),
					sha256File(path.join(fixtureRoot, file)),
				]),
		);
		const evidence = {
			evidenceVersion:
				"taskflow-web-reference-render.v2",
			status: "rendered-awaiting-human-approval",
			candidate: {
				gitCommit,
				trackedSourceClean: true,
				webBuildId: webAssetManifest.webBuildId,
				assetManifestSha256:
					sha256File(webAssetManifestPath),
			},
			renderer: {
				engine: "chromium",
				playwrightVersion: "1.61.1",
				packagedDist: true,
			},
			matrix: {
				representativeScreens:
					representativeScenarios.length,
				locales: ["en", "zh-CN"],
				themes: ["light", "dark"],
				viewports: Object.keys(viewports),
				representativeScreenshotCount:
					representativeScenarios.length *
					2 *
					2 *
					Object.keys(viewports).length,
				supplementalScreenshotCount:
					supplementalScenarios.length,
				a11yAssessedScreenshotCount:
					representativeScenarios.length * 2 * 2,
			},
			fixtureDigests,
			screenshots,
			review: {
				approved: false,
				blocker:
					"Human product and content review has not approved these renders.",
			},
		};
		fs.writeFileSync(
			evidencePath,
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		runCli(["ui", "--stop"], env);
		await Promise.race([
			once(owner.child, "exit"),
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"reference UI owner did not stop",
							),
						),
					10_000,
				);
				timer.unref();
			}),
		]);
		console.log(
			JSON.stringify(
				{
					screenshotCount: screenshots.length,
					evidencePath: path.relative(
						repositoryRoot,
						evidencePath,
					),
					outputRoot: path.relative(
						repositoryRoot,
						outputRoot,
					),
					status:
						"rendered-awaiting-human-approval",
				},
				null,
				2,
			),
		);
	} finally {
		await browser?.close();
		if (owner?.child.exitCode === null) {
			owner.child.kill("SIGTERM");
			await Promise.race([
				once(owner.child, "exit"),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 2_000);
					timer.unref();
				}),
			]);
		}
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

await main();
