import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
	chromium,
	expect,
	firefox,
	type Browser,
	type Page,
	webkit,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
	controlClientRpc,
	createControlHost,
	inspectProjectControlStore,
	loadApprovalForRun,
} from "../../taskflow-control/dist/index.js";
import {
	holdWebManualReview,
	isWebManualReviewStage,
	readWebManualReviewConfig,
} from "./web-manual-review-harness.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, "../../..");
const cliBin = path.join(
	repositoryRoot,
	"packages/taskflow-cli/dist/bin.js",
);
const browserEngineName =
	process.env.TASKFLOW_WEB_BROWSER ?? "chromium";
if (
	browserEngineName !== "chromium" &&
	browserEngineName !== "firefox" &&
	browserEngineName !== "webkit"
) {
	throw new Error(
		`unsupported TASKFLOW_WEB_BROWSER: ${browserEngineName}`,
	);
}
const browserType =
	browserEngineName === "firefox"
		? firefox
		: browserEngineName === "webkit"
			? webkit
			: chromium;
const browserChannel = process.env.TASKFLOW_WEB_BROWSER_CHANNEL;
if (
	browserChannel !== undefined &&
	(browserEngineName !== "chromium" ||
		(browserChannel !== "chrome" &&
			browserChannel !== "msedge"))
) {
	throw new Error(
		`unsupported TASKFLOW_WEB_BROWSER_CHANNEL: ${browserChannel}`,
	);
}
const evidenceRoot = path.join(
	repositoryRoot,
	"output/playwright",
	`beta2-e2e-${browserEngineName}${browserChannel ? `-${browserChannel}` : ""}`,
);
const traceEnabled =
	process.env.TASKFLOW_WEB_E2E_TRACE === "1";

function trace(step: string): void {
	if (traceEnabled) {
		console.error(`[e2e:${browserEngineName}] ${step}`);
	}
}

function isNavigationEventSourceDiagnostic(message: string): boolean {
	return (
		browserEngineName === "firefox" &&
		message.includes("/api/v1/events") &&
		message.includes(
			"was interrupted while the page was loading",
		)
	);
}

function isSessionTerminationDiagnostic(message: string): boolean {
	return (
		(message.includes("401") &&
			(message.includes("Failed to load resource") ||
				message.includes("/api/v1/"))) ||
		message.includes("ERR_INCOMPLETE_CHUNKED_ENCODING") ||
		(message.includes("EventSource") &&
			message.includes("text/event-stream"))
	);
}

type CliLaunchResult = {
	readonly ok: true;
	readonly action: "launch";
	readonly launchUrl: string;
	readonly origin: string;
	readonly role: string;
	readonly reused: boolean;
	readonly via: string;
};

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
		`taskflow ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
						`packaged UI owner did not launch\nstdout:\n${stdout}\nstderr:\n${stderr}`,
					),
				);
			}, 30_000);
			child.once("exit", (code) => {
				if (stdout.trim().length === 0) {
					clearTimeout(timer);
					reject(
						new Error(
							`packaged UI owner exited ${code}\nstderr:\n${stderr}`,
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

async function seedStores(
	home: string,
	completedProject: string,
	approvalProject: string,
	liveProject: string,
): Promise<{
	readonly completed: {
		readonly projectId: string;
		readonly controlDomainId: string;
		readonly runId: string;
		readonly receiptId: string;
	};
	readonly approval: {
		readonly projectId: string;
		readonly controlDomainId: string;
		readonly runId: string;
		readonly approvalRequestId: string;
		readonly continuationArtifactId: string;
		readonly beforeMarker: string;
		readonly afterMarker: string;
	};
	readonly live: {
		readonly projectId: string;
		readonly controlDomainId: string;
	};
}> {
	const env = {
		...process.env,
		TASKFLOW_HOME: home,
		PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
	};
	const completedHost = createControlHost({
		projectRoot: completedProject,
		controlMode: "auto",
		skipSingleton: true,
		env,
	});
	let completedResult;
	try {
		completedResult = await completedHost.admitAndRun({
			program: {
				name: "Check release package",
				phases: [
					{
						id: "collect-results",
						type: "script",
						run: "printf 'collected\\n'",
					},
					{
						id: "check-results",
						type: "script",
						dependsOn: ["collect-results"],
						run: "printf 'web-console-e2e-result\\n'",
						final: true,
					},
				],
			},
			commandId: "cmd-web-console-e2e-completed",
			callerPrincipal: "packaged-e2e",
		});
		assert.equal(
			completedResult.ok,
			true,
			JSON.stringify(completedResult.error),
		);
		assert.ok(completedResult.run);
		assert.ok(completedResult.receipt);
		assert.equal(
			completedResult.receipt.assurance.artifactIntegrity,
			"ok",
		);
	} finally {
		completedHost.close();
	}

	const approvalHost = createControlHost({
		projectRoot: approvalProject,
		controlMode: "auto",
		skipSingleton: true,
		env,
	});
	try {
		const liveHost = createControlHost({
			projectRoot: liveProject,
			controlMode: "auto",
			skipSingleton: true,
			env,
		});
		const live = {
			projectId: liveHost.projectId,
			controlDomainId: liveHost.controlDomainId,
		};
		liveHost.close();
			const beforeMarker = path.join(
				approvalProject,
				"before-approval.txt",
			);
			const afterMarker = path.join(
				approvalProject,
				"after-approval.txt",
			);
			const parked = await approvalHost.admitAndRun({
				commandId:
					"cmd-web-console-e2e-approval-admit",
				callerPrincipal: "packaged-e2e",
				program: {
					name: "Publish release files",
					phases: [
						{
							id: "prepare-release",
							type: "script",
							run: `test ! -e "${beforeMarker}" && printf once > "${beforeMarker}" && printf prepared`,
						},
						{
							id: "publish-review",
							type: "approval",
							dependsOn: [
								"prepare-release",
							],
							task:
								"Allow this task to publish the prepared release?",
						},
						{
							id: "publish-release",
							type: "script",
							dependsOn: [
								"publish-review",
							],
							run: `printf once > "${afterMarker}" && printf published`,
							final: true,
						},
					],
				},
			});
			assert.equal(
				parked.ok,
				true,
			JSON.stringify(parked.error),
		);
		assert.ok(parked.run?.approvalRequestId);
		return {
			completed: {
				projectId: completedResult.run!.projectId,
				controlDomainId:
					completedResult.run!.controlDomainId,
				runId: completedResult.run!.runId,
				receiptId: completedResult.receipt!.receiptId,
			},
				approval: {
					projectId: approvalHost.projectId,
					controlDomainId:
						approvalHost.controlDomainId,
					runId: parked.run!.runId,
					approvalRequestId:
						parked.run!.approvalRequestId!,
					continuationArtifactId:
						parked.run!
							.approvalContinuationArtifactId!,
					beforeMarker,
					afterMarker,
				},
			live,
		};
	} finally {
		approvalHost.close();
	}
}

async function analyzeA11y(page: Page, label: string): Promise<number> {
	const analysis = await new AxeBuilder({ page })
		.withTags([
			"wcag2a",
			"wcag2aa",
			"wcag21a",
			"wcag21aa",
		])
		.analyze();
	const blocking = analysis.violations.filter(
		(violation) =>
			violation.impact === "critical" ||
			violation.impact === "serious",
	);
	assert.deepEqual(
		blocking.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
		`${label} has serious/critical accessibility violations`,
	);
	return analysis.violations.length;
}

async function assertA11y(page: Page, label: string): Promise<number> {
	return analyzeA11y(page, label);
}

async function captureScreenshot(
	page: Page,
	filePath: string,
): Promise<void> {
	if (browserEngineName !== "webkit") {
		await page.screenshot({
			path: filePath,
			fullPage: true,
		});
		return;
	}
	const screenshotPage = await page.context().newPage();
	try {
		const viewport = page.viewportSize();
		if (viewport) {
			await screenshotPage.setViewportSize(viewport);
		}
		await screenshotPage.goto(page.url(), {
			waitUntil: "domcontentloaded",
		});
		await expect(
			screenshotPage.getByRole("heading", { level: 1 }).first(),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			screenshotPage.locator(".loading-block"),
		).toHaveCount(0, { timeout: 15_000 });
		await screenshotPage.screenshot({
			path: filePath,
			fullPage: true,
		});
	} finally {
		await screenshotPage.close();
	}
}

async function main(): Promise<void> {
	trace("starting");
	const manualReview = readWebManualReviewConfig(
		process.env,
	);
	fs.rmSync(evidenceRoot, { recursive: true, force: true });
	fs.mkdirSync(evidenceRoot, { recursive: true });
	const tempRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-console-e2e-"),
	);
	const home = path.join(tempRoot, "home");
	const completedProject = path.join(
		tempRoot,
		"release-checks",
	);
	const approvalProject = path.join(
		tempRoot,
		"release-publish",
	);
	const liveProject = path.join(tempRoot, "live-check");
	const isolatedHome = path.join(tempRoot, "isolated-home");
	const isolatedProject = path.join(tempRoot, "isolated-project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(completedProject, { recursive: true });
	fs.mkdirSync(approvalProject, { recursive: true });
	fs.mkdirSync(liveProject, { recursive: true });
	fs.mkdirSync(isolatedHome, { recursive: true });
	fs.mkdirSync(isolatedProject, { recursive: true });
	const env = {
		...process.env,
		TASKFLOW_HOME: home,
		PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
	};
	const isolatedEnv = {
		...process.env,
		TASKFLOW_HOME: isolatedHome,
		PI_TASKFLOW_BUILTIN_AGENTS_DIR: "",
	};
	let owner: Awaited<ReturnType<typeof startUiOwner>> | undefined;
	let isolatedOwner:
		| Awaited<ReturnType<typeof startUiOwner>>
		| undefined;
	let browser: Browser | undefined;
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	const browserTransportDiagnostics: string[] = [];
	const sessionTerminationDiagnostics: string[] = [];
	let sessionTerminationExpected = false;
	const cspViolations: Array<{
		readonly blockedURI: string;
		readonly effectiveDirective: string;
		readonly lineNumber: number;
		readonly sample: string;
		readonly sourceFile: string;
	}> = [];
	const runtimeStyleInsertions: Array<{
		readonly id: string;
		readonly text: string;
		readonly url: string;
	}> = [];
	try {
		const seeded = await seedStores(
			home,
			completedProject,
			approvalProject,
			liveProject,
		);
		trace("stores seeded");
		owner = await startUiOwner(completedProject, env);
		assert.equal(owner.result.ok, true);
		assert.equal(owner.result.action, "launch");
		assert.equal(owner.result.role, "writer");
		assert.equal(owner.result.reused, false);
		assert.equal(owner.result.via, "local-singleton");
		trace("primary UI owner started");

		const reused = runCli(
			[
				"ui",
				"--no-open",
				"--project",
				approvalProject,
			],
			env,
		) as unknown as CliLaunchResult;
		assert.equal(reused.reused, true);
		assert.equal(reused.origin, owner.result.origin);
		assert.notEqual(
			reused.launchUrl,
			owner.result.launchUrl,
		);
		const liveMount = runCli(
			[
				"ui",
				"--no-open",
				"--project",
				liveProject,
			],
			env,
		) as unknown as CliLaunchResult;
		assert.equal(liveMount.origin, reused.origin);
		trace("project mounts reused");

		trace("launching browser");
		browser = await browserType.launch({
			headless: true,
			...(browserChannel ? { channel: browserChannel } : {}),
		});
		trace("browser launched");
		const browserVersion = browser.version();
		const context = await browser.newContext({
			locale: "en-US",
			viewport: { width: 1440, height: 900 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
			const page = await context.newPage();
			await page.exposeFunction(
				"__taskflowRecordCspViolation",
				(violation: (typeof cspViolations)[number]) => {
					cspViolations.push(violation);
				},
			);
			await page.exposeFunction(
				"__taskflowRecordRuntimeStyle",
				(insertion: (typeof runtimeStyleInsertions)[number]) => {
					runtimeStyleInsertions.push(insertion);
				},
			);
			await page.addInitScript(() => {
				const observeRuntimeStyles = new MutationObserver(
					(mutations) => {
						for (const mutation of mutations) {
							for (const node of mutation.addedNodes) {
								if (
									!(
										node instanceof
										HTMLStyleElement
									)
								) {
									continue;
								}
								const recordStyle = (
									window as typeof window & {
										__taskflowRecordRuntimeStyle: (
											insertion: {
												id: string;
												text: string;
												url: string;
											},
										) => Promise<void>;
									}
								).__taskflowRecordRuntimeStyle;
								void recordStyle({
									id: node.id,
									text: node.textContent?.slice(
										0,
										500,
									) ?? "",
									url: window.location.href,
								});
							}
						}
					},
				);
				observeRuntimeStyles.observe(document, {
					childList: true,
					subtree: true,
				});
				window.addEventListener(
					"securitypolicyviolation",
					(event) => {
						const record = (
							window as typeof window & {
								__taskflowRecordCspViolation: (
									violation: {
										blockedURI: string;
										effectiveDirective: string;
										lineNumber: number;
										sample: string;
										sourceFile: string;
									},
								) => Promise<void>;
							}
						).__taskflowRecordCspViolation;
						void record({
							blockedURI: event.blockedURI,
							effectiveDirective:
								event.effectiveDirective,
							lineNumber: event.lineNumber,
							sample: event.sample,
							sourceFile: event.sourceFile,
						});
					},
				);
			});
			const requestedApiPaths = new Set<string>();
			page.on("request", (request) => {
				const url = new URL(request.url());
				if (url.pathname.startsWith("/api/v1/")) {
					requestedApiPaths.add(url.pathname);
				}
			});
		page.on("console", (message) => {
			if (message.type() === "error") {
				if (isNavigationEventSourceDiagnostic(message.text())) {
					browserTransportDiagnostics.push(message.text());
				} else if (
					sessionTerminationExpected &&
					isSessionTerminationDiagnostic(message.text())
				) {
					sessionTerminationDiagnostics.push(message.text());
				} else {
					consoleErrors.push(message.text());
				}
			}
		});
		page.on("pageerror", (error) => {
			pageErrors.push(error.message);
		});

		const sseResponsePromise = page.waitForResponse(
			(response) =>
				response.url() ===
					`${reused.origin}/api/v1/events` &&
				response.status() === 200,
		);
		await page.goto(reused.launchUrl, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			page.getByRole("heading", { level: 1 }),
		).toBeVisible({ timeout: 15_000 });
		await expect(page).toHaveTitle(/ · Taskflow$/u);
		await expect(page.locator(".task-row")).toHaveCount(2);
		const sseResponse = await sseResponsePromise;
		trace("primary page and SSE ready");
		assert.match(
			sseResponse.headers()["content-type"] ?? "",
			/^text\/event-stream(?:;|$)/u,
		);
		if (
			isWebManualReviewStage(
				manualReview,
				"initial",
			)
		) {
			const manualReviewLaunch = runCli(
				[
					"ui",
					"--no-open",
					"--project",
					completedProject,
				],
				env,
			) as unknown as CliLaunchResult;
			assert.equal(manualReviewLaunch.reused, true);
			assert.equal(
				manualReviewLaunch.origin,
				owner.result.origin,
			);
			await holdWebManualReview(manualReview, {
				stage: "initial",
				launches: [
					{
						label: "initial",
						launchUrl:
							manualReviewLaunch.launchUrl,
						origin:
							manualReviewLaunch.origin,
						project: "release-checks",
					},
				],
			});
			if (manualReview.exitAfterHold) {
				return;
			}
		}
		const bootstrapEnvelope = (await page.evaluate(async () => {
			const response = await fetch("/api/v1/bootstrap");
			return response.json();
		})) as {
			data: {
				pollingMinIntervalMs: number;
				supportedCommands: string[];
				supportedFeatures: string[];
			};
		};
		assert.equal(
			bootstrapEnvelope.data.pollingMinIntervalMs,
			3_000,
		);
		assert.deepEqual(
			bootstrapEnvelope.data.supportedCommands,
			["approve", "cancel-run", "reject"],
		);
		assert.equal(
			bootstrapEnvelope.data.supportedFeatures.includes(
				"approval-decision",
			),
			true,
		);
		for (const gated of [
			"recompute-preview",
			"set-max-active-runs",
			"force-release",
		]) {
			assert.equal(
				bootstrapEnvelope.data.supportedFeatures.includes(
					gated,
				),
				false,
			);
		}
		const simpleText = await page.locator("body").innerText();
		for (const forbidden of [
			"ControlStore",
			"Receipt",
			"commitSeq",
			"watermark",
			"BoundPlan",
		]) {
			assert.equal(
				simpleText.includes(forbidden),
				false,
				`Simple home exposed ${forbidden}`,
			);
		}
		const homeA11yViolations =
			browserEngineName === "chromium"
				? await assertA11y(page, "Simple home")
				: null;
		await captureScreenshot(
			page,
			path.join(
				evidenceRoot,
				"home.en.desktop.png",
			),
		);
		await page.goto(`${reused.origin}/tasks`, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			page.getByRole("heading", { name: "Tasks", level: 1 }),
		).toBeVisible();
		const taskListVirtualization = await page
			.locator(".virtual-page-segment")
			.first()
			.evaluate((segment) => ({
				contentVisibility:
					getComputedStyle(segment).contentVisibility,
				inlineStyleAttributes:
					segment.querySelectorAll("[style]").length +
					(segment.hasAttribute("style") ? 1 : 0),
				taskRows:
					segment.querySelectorAll(".task-row").length,
			}));
		assert.equal(
			taskListVirtualization.contentVisibility,
			"auto",
		);
		assert.equal(
			taskListVirtualization.inlineStyleAttributes,
			0,
		);
		assert.ok(taskListVirtualization.taskRows >= 1);

		isolatedOwner = await startUiOwner(
			isolatedProject,
			isolatedEnv,
		);
		const primaryOrigin = new URL(reused.origin);
		const isolatedOrigin = new URL(
			isolatedOwner.result.origin,
		);
		assert.notEqual(isolatedOrigin.port, primaryOrigin.port);
		assert.notEqual(isolatedOrigin.hostname, primaryOrigin.hostname);
		const isolatedPage = await context.newPage();
		await isolatedPage.goto(isolatedOwner.result.launchUrl, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			isolatedPage.getByRole("heading", { level: 1 }),
		).toBeVisible({ timeout: 15_000 });
		const primaryCookies = await context.cookies([
			reused.origin,
		]);
		const isolatedCookies = await context.cookies([
			isolatedOwner.result.origin,
		]);
		const primarySessionCookie = primaryCookies.find(
			(cookie) => cookie.name.startsWith("tf_web_"),
		);
		const isolatedSessionCookie = isolatedCookies.find(
			(cookie) => cookie.name.startsWith("tf_web_"),
		);
		assert.ok(primarySessionCookie);
		assert.ok(isolatedSessionCookie);
		assert.equal(
			primaryCookies.some(
				(cookie) =>
					cookie.value === isolatedSessionCookie.value,
			),
			false,
		);
		assert.equal(
			isolatedCookies.some(
				(cookie) =>
					cookie.value === primarySessionCookie.value,
			),
			false,
		);
		assert.notEqual(
			primarySessionCookie.domain,
			isolatedSessionCookie.domain,
		);
		assert.equal(
			await page.evaluate(async () => {
				const response = await fetch("/api/v1/bootstrap");
				return response.status;
			}),
			200,
		);
		assert.equal(
			await isolatedPage.evaluate(async () => {
				const response = await fetch("/api/v1/bootstrap");
				return response.status;
			}),
			200,
		);
		await isolatedPage.close();
		const isolatedStopped = runCli(
			["ui", "--stop"],
			isolatedEnv,
		);
		assert.equal(isolatedStopped.action, "stop");
		assert.equal(isolatedStopped.stopped, true);
		await Promise.race([
			once(isolatedOwner.child, "exit"),
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"isolated packaged UI owner did not exit after --stop",
							),
						),
					10_000,
				);
				timer.unref();
			}),
		]);
		trace("isolated listener and cookie checks complete");

		const pollingPage = await context.newPage();
		const pollingRequestCounts = new Map<string, number>();
		const pollingRequestCount = (pathname: string) =>
			pollingRequestCounts.get(pathname) ?? 0;
		const pollingMatchCount = (
			matches: (pathname: string) => boolean,
		) =>
			[...pollingRequestCounts.entries()]
				.filter(([pathname]) => matches(pathname))
				.reduce((sum, [, count]) => sum + count, 0);
		const assertPollingCycle = async (
			surfaces: readonly {
				readonly label: string;
				readonly matches: (pathname: string) => boolean;
			}[],
		) => {
			const before = new Map(
				surfaces.map((surface) => [
					surface.label,
					pollingMatchCount(surface.matches),
				]),
			);
			await expect
				.poll(
					() =>
						surfaces.every(
							(surface) =>
								pollingMatchCount(
									surface.matches,
								) >
								(before.get(
									surface.label,
								) ?? 0),
						),
					{
						timeout:
							bootstrapEnvelope.data
								.pollingMinIntervalMs +
							5_000,
					},
				)
				.toBe(true);
		};
		pollingPage.on("request", (request) => {
			const pathname = new URL(request.url()).pathname;
			if (pathname.startsWith("/api/v1/")) {
				pollingRequestCounts.set(
					pathname,
					pollingRequestCount(pathname) + 1,
				);
			}
		});
		await pollingPage.route("**/api/v1/events", async (route) => {
			await route.abort("connectionfailed");
		});
		await pollingPage.goto(reused.origin, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			pollingPage.getByRole("heading", { level: 1 }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			pollingPage.getByText(
				"Live updates are paused. Refreshing the latest state will not run the task again.",
			),
		).toBeVisible({ timeout: 15_000 });
		await expect(pollingPage.locator(".task-row")).toHaveCount(2);
		const pollingHomePaths = [
			"/api/v1/overview",
			"/api/v1/runs",
			"/api/v1/approvals",
		] as const;
		await assertPollingCycle(
			pollingHomePaths.map((pathname) => ({
				label: pathname,
				matches: (candidate: string) =>
					candidate === pathname,
			})),
		);
		trace("polling fallback home cycle complete");

		const nativeCancelReview =
			isWebManualReviewStage(
				manualReview,
				"cancel",
			);
		const liveTaskSleepSeconds =
			nativeCancelReview
				? Math.ceil(manualReview.holdMs / 1_000) +
					60
				: 30;
		const liveAdmissionPromise = controlClientRpc(
			"admit",
			{
				projectId: seeded.live.projectId,
				commandId:
					"cmd-web-console-e2e-live-admission",
				program: {
					name: "Stop a live verification",
					phases: [
						{
							id: "wait-for-cancel",
							type: "script",
							run: `sleep ${liveTaskSleepSeconds}; printf 'should-not-complete\\n'`,
							...(nativeCancelReview
								? {
										timeout:
											(liveTaskSleepSeconds +
												60) *
											1_000,
									}
								: {}),
							final: true,
						},
					],
				},
			},
			{
				env,
				principal: "packaged-e2e",
				timeoutMs: 60_000,
			},
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({
				ok: false as const,
				error,
			}),
		);
		const liveRow = page.getByRole("link", {
			name: /Stop a live verification/u,
		});
		await expect(liveRow).toBeVisible({
			timeout: 15_000,
		});
		const pollingLiveRow = pollingPage.getByRole("link", {
			name: /Stop a live verification/u,
		});
		await expect(pollingLiveRow).toBeVisible({
			timeout:
				bootstrapEnvelope.data.pollingMinIntervalMs +
				5_000,
		});
		if (
			isWebManualReviewStage(
				manualReview,
				"cancel",
			)
		) {
			const manualReviewLaunch = runCli(
				[
					"ui",
					"--no-open",
					"--project",
					liveProject,
				],
				env,
			) as unknown as CliLaunchResult;
			assert.equal(manualReviewLaunch.reused, true);
			assert.equal(
				manualReviewLaunch.origin,
				owner.result.origin,
			);
			await holdWebManualReview(manualReview, {
				stage: "cancel",
				launches: [
					{
						label: "live-task",
						launchUrl:
							manualReviewLaunch.launchUrl,
						origin:
							manualReviewLaunch.origin,
						project: "live-check",
					},
				],
			});
			if (manualReview.exitAfterHold) {
				const reviewSnapshot =
					inspectProjectControlStore(liveProject, {
						projectId: seeded.live.projectId,
						controlDomainId:
							seeded.live.controlDomainId,
					});
				assert.equal(reviewSnapshot.ok, true);
				if (reviewSnapshot.ok) {
					const reviewRun =
						reviewSnapshot.snapshot.runs[0];
					assert.ok(reviewRun);
					if (reviewRun.status === "running") {
						await controlClientRpc(
							"cancel",
							{
								projectId:
									seeded.live
										.projectId,
								runId: reviewRun.runId,
								expectedRunVersion:
									reviewRun.runVersion,
							},
							{
								env,
								principal:
									"packaged-e2e-review-cleanup",
								timeoutMs: 30_000,
							},
						);
					}
				}
				const reviewAdmission =
					await liveAdmissionPromise;
				assert.equal(
					reviewAdmission.ok,
					true,
					reviewAdmission.ok
						? undefined
						: String(reviewAdmission.error),
				);
				return;
			}
		}
		assert.equal(
			await pollingLiveRow.innerText(),
			await liveRow.innerText(),
		);
		await pollingLiveRow.click();
		await expect(
			pollingPage.getByRole("heading", {
				name: "Stop a live verification",
				level: 1,
			}),
		).toBeVisible();
		const pollingRunDetailPath =
			`/api/v1/projects/${seeded.live.projectId}` +
			`/domains/${seeded.live.controlDomainId}` +
			"/runs/";
		const pollingDetailRequestsBeforeCancel = [
			...pollingRequestCounts.entries(),
		]
			.filter(([pathname]) =>
				pathname.startsWith(pollingRunDetailPath),
			)
			.reduce((sum, [, count]) => sum + count, 0);
		await liveRow.click();
		await expect(
			page.getByRole("heading", {
				name: "Stop a live verification",
				level: 1,
			}),
		).toBeVisible();
		await expect(page).toHaveTitle(
			"Stop a live verification · Taskflow",
		);
		const stopTask = page.getByRole("button", {
			name: "Stop task",
		});
		await expect(stopTask).toBeEnabled({
			timeout: 15_000,
		});
		await stopTask.click();
		await expect(
			page.getByRole("heading", {
				name: "Task stopped",
				level: 2,
			}),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			pollingPage.getByRole("heading", {
				name: "Task stopped",
				level: 2,
			}),
		).toBeVisible({
			timeout:
				bootstrapEnvelope.data.pollingMinIntervalMs +
				5_000,
		});
		const pollingDetailRequestsAfterCancel = [
			...pollingRequestCounts.entries(),
		]
			.filter(([pathname]) =>
				pathname.startsWith(pollingRunDetailPath),
			)
			.reduce((sum, [, count]) => sum + count, 0);
		assert.ok(
			pollingDetailRequestsAfterCancel >
				pollingDetailRequestsBeforeCancel,
		);
		assert.equal(
			await pollingPage.locator(".hero-status").innerText(),
			await page.locator(".hero-status").innerText(),
		);
		trace("live task cancellation reflected in SSE and polling");
		const liveAdmission = await liveAdmissionPromise;
		assert.equal(
			liveAdmission.ok,
			true,
			liveAdmission.ok
				? undefined
				: String(liveAdmission.error),
		);
		const liveSnapshot =
			inspectProjectControlStore(liveProject, {
				projectId: seeded.live.projectId,
				controlDomainId:
					seeded.live.controlDomainId,
			});
		assert.equal(liveSnapshot.ok, true);
		if (liveSnapshot.ok) {
			assert.equal(
				liveSnapshot.snapshot.runs[0]?.status,
				"cancelled",
			);
		}
		const completedRunPath =
			`/api/v1/projects/${seeded.completed.projectId}` +
			`/domains/${seeded.completed.controlDomainId}` +
			`/runs/${seeded.completed.runId}`;
		await pollingPage.goto(
			`${reused.origin}/needs-input`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			pollingPage.getByRole("heading", {
				name: "Needs your input",
				level: 1,
			}),
		).toBeVisible();
		await expect(
			pollingPage.getByText(
				"This task is waiting for your decision. Review both outcomes before choosing.",
			),
		).toBeVisible();
		const simpleAttentionText =
			await pollingPage.locator("body").innerText();
		for (const forbidden of [
			"ControlStore",
			"provider-ambiguous",
			"needs-user-input",
			"status-only",
			"diagnostic",
		]) {
			assert.equal(
				simpleAttentionText.includes(forbidden),
				false,
				`Simple attention exposed ${forbidden}`,
			);
		}
		await assertPollingCycle([
			{
				label: "needs-input approvals",
				matches: (pathname) =>
					pathname === "/api/v1/approvals",
			},
			{
				label: "needs-input attention",
				matches: (pathname) =>
					pathname === "/api/v1/attention",
			},
		]);

		await pollingPage.goto(
			`${reused.origin}/workspaces`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			pollingPage.getByRole("heading", {
				name: "Workspaces",
				level: 1,
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "projects",
				matches: (pathname) =>
					pathname === "/api/v1/projects",
			},
		]);

		const completedWorkspaceUrl =
			`${reused.origin}/workspaces/${seeded.completed.projectId}` +
			`/domains/${seeded.completed.controlDomainId}`;
		const completedProjectPath =
			`/api/v1/projects/${seeded.completed.projectId}` +
			`/domains/${seeded.completed.controlDomainId}`;
		await pollingPage.goto(completedWorkspaceUrl, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			pollingPage.getByRole("heading", { level: 1 }),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "project detail",
				matches: (pathname) =>
					pathname === completedProjectPath,
			},
		]);

		const approvalUrl =
			`${reused.origin}/workspaces/${seeded.approval.projectId}` +
			`/domains/${seeded.approval.controlDomainId}` +
			`/tasks/${seeded.approval.runId}` +
			`/input/${seeded.approval.approvalRequestId}`;
		const approvalPath =
			`/api/v1/projects/${seeded.approval.projectId}` +
			`/domains/${seeded.approval.controlDomainId}` +
			`/runs/${seeded.approval.runId}` +
			`/approvals/${seeded.approval.approvalRequestId}`;
		await pollingPage.goto(approvalUrl, {
			waitUntil: "domcontentloaded",
		});
		await expect(
			pollingPage.getByRole("heading", {
				name: "Allow this task to take the described action?",
				level: 1,
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "approval detail",
				matches: (pathname) =>
					pathname === approvalPath,
			},
		]);

		await pollingPage.goto(
			`${reused.origin}/policy?view=pro`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			pollingPage.getByRole("heading", {
				name: "Policy",
				level: 1,
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "policy explanation",
				matches: (pathname) =>
					pathname === "/api/v1/policy/explanation",
			},
		]);

		await pollingPage.goto(
			`${reused.origin}/diagnostics?view=pro`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			pollingPage.getByRole("heading", {
				name: "Diagnostics",
				level: 1,
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "diagnostics attention",
				matches: (pathname) =>
					pathname === "/api/v1/attention",
			},
		]);

		const completedTaskUrl =
			`${reused.origin}/workspaces/${seeded.completed.projectId}` +
			`/domains/${seeded.completed.controlDomainId}` +
			`/tasks/${seeded.completed.runId}`;
		await pollingPage.goto(
			`${completedTaskUrl}?view=pro&tab=graph`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			pollingPage.locator("svg.graph-svg"),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "task detail in graph",
				matches: (pathname) =>
					pathname === completedRunPath,
			},
			{
				label: "graph",
				matches: (pathname) =>
					pathname === `${completedRunPath}/graph`,
			},
			{
				label: "node detail",
				matches: (pathname) =>
					pathname.startsWith(
						`${completedRunPath}/nodes/`,
					) &&
					!pathname.endsWith("/attempts"),
			},
			{
				label: "node attempts",
				matches: (pathname) =>
					pathname.startsWith(
						`${completedRunPath}/nodes/`,
					) &&
					pathname.endsWith("/attempts"),
			},
		]);
		await pollingPage
			.getByRole("tab", { name: "Timeline" })
			.click();
		await expect(
			pollingPage.getByRole("heading", {
				name: "Execution timeline",
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "task detail in timeline",
				matches: (pathname) =>
					pathname === completedRunPath,
			},
			{
				label: "timeline",
				matches: (pathname) =>
					pathname === `${completedRunPath}/timeline`,
			},
		]);
		await pollingPage
			.getByRole("tab", { name: "Evidence" })
			.click();
		await expect(
			pollingPage.getByRole("heading", {
				name: "Evidence and checks",
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "task detail in evidence",
				matches: (pathname) =>
					pathname === completedRunPath,
			},
			{
				label: "artifacts",
				matches: (pathname) =>
					pathname === `${completedRunPath}/artifacts`,
			},
			{
				label: "receipt",
				matches: (pathname) =>
					pathname === `${completedRunPath}/receipt`,
			},
			{
				label: "why stale",
				matches: (pathname) =>
					pathname === `${completedRunPath}/why-stale`,
			},
		]);
		await pollingPage
			.getByRole("tab", { name: "Technical" })
			.click();
		await expect(
			pollingPage.getByRole("heading", {
				name: "Technical details",
			}),
		).toBeVisible();
		await assertPollingCycle([
			{
				label: "task detail in technical",
				matches: (pathname) =>
					pathname === completedRunPath,
			},
			{
				label: "fragments",
				matches: (pathname) =>
					pathname === `${completedRunPath}/fragments`,
			},
		]);
		await pollingPage.close();
		trace("polling surface inventory complete");
		await captureScreenshot(
			page,
			path.join(
				evidenceRoot,
				"task-cancelled.en.desktop.png",
			),
		);

		await page.goto(`${reused.origin}/`, {
			waitUntil: "domcontentloaded",
		});
		await page
			.getByRole("link", {
				name: /Check release package/u,
			})
			.click();
		await expect(
			page.getByRole("heading", {
				name: "Check release package",
				level: 1,
			}),
		).toBeVisible();
		await expect(
			page.getByText("web-console-e2e-result"),
		).toBeVisible();
		const switchToPro = page.getByRole("button", {
			name: "Switch to Pro",
		});
		await switchToPro.focus();
		await switchToPro.press("Enter");
		const overviewTab = page.getByRole("tab", {
			name: "Overview",
		});
		await expect(overviewTab).toBeFocused();
		await expect(overviewTab).toHaveAttribute("aria-selected", "true");
		await overviewTab.press("ArrowRight");
		const graphTab = page.getByRole("tab", { name: "Graph" });
		await expect(graphTab).toBeFocused();
		await expect(graphTab).toHaveAttribute("aria-selected", "true");
		await expect(page).toHaveURL(/\btab=graph\b/u);
			await expect(
				page.locator("svg.graph-svg"),
			).toBeVisible();
			const accessibleGraphList = page.getByRole("button", {
				name: "Open accessible graph list",
			});
			await accessibleGraphList.focus();
			await accessibleGraphList.press("Enter");
			const semanticGraphListbox = page.getByRole(
				"listbox",
				{
					name: "Read-only task graph",
				},
			);
			await expect(semanticGraphListbox).toBeVisible();
			const semanticGraphNodes =
				semanticGraphListbox.getByRole("option");
			await expect(semanticGraphNodes).toHaveCount(2);
			const firstSemanticGraphNode =
				semanticGraphNodes.first();
			const secondSemanticGraphNode =
				semanticGraphNodes.nth(1);
			const secondPhaseId = await secondSemanticGraphNode
				.locator("strong")
				.innerText();
			await expect(firstSemanticGraphNode).toBeVisible();
			await firstSemanticGraphNode.focus();
			await firstSemanticGraphNode.press("ArrowDown");
			await expect(secondSemanticGraphNode).toBeFocused();
			await expect(secondSemanticGraphNode).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(page.locator(".graph-inspector")).toBeVisible();
			await expect(
				page.locator(".graph-inspector > strong"),
			).toHaveText(secondPhaseId);
			await expect(
				page.locator(".graph-inspector dl"),
			).toBeVisible();
			await graphTab.press("ArrowRight");
			const timelineTab = page.getByRole("tab", {
				name: "Timeline",
			});
			await expect(timelineTab).toBeFocused();
			await expect(timelineTab).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(
				page.getByRole("heading", {
					name: "Execution timeline",
				}),
			).toBeVisible();
			assert.ok(
				[...requestedApiPaths].some((pathname) =>
					pathname.endsWith("/timeline"),
				),
			);
			await timelineTab.press("ArrowRight");
			const evidenceTab = page.getByRole("tab", {
				name: "Evidence",
			});
			await expect(evidenceTab).toBeFocused();
			await expect(evidenceTab).toHaveAttribute(
				"aria-selected",
				"true",
			);
		await expect(
			page.getByText("Artifact integrity"),
		).toBeVisible();
			await expect(
				page.locator(".artifact-row").first(),
			).toBeVisible();
			await expect(
				page.getByRole("heading", {
					name: "Immutable Receipt",
				}),
			).toBeVisible();
			await expect(
				page.getByRole("heading", {
					name: "Reuse analysis",
				}),
			).toBeVisible();
			const receiptJsonDownloadPromise =
				page.waitForEvent("download");
			await page
				.getByRole("button", {
					name: "Download Receipt JSON",
				})
				.click();
			const receiptJsonDownload =
				await receiptJsonDownloadPromise;
			assert.equal(
				receiptJsonDownload.suggestedFilename(),
				`taskflow-receipt-${seeded.completed.receiptId}.json`,
			);
			const receiptJsonPath =
				await receiptJsonDownload.path();
			assert.ok(receiptJsonPath);
			const receiptExport = JSON.parse(
				fs.readFileSync(receiptJsonPath, "utf8"),
			) as {
				schemaVersion: string;
				receipt: {
					receiptId: string;
					eventManifest: string[];
				};
				currentVerification: {
					receiptId?: string;
				};
				eventManifest: Array<{
					eventId: string;
				}>;
			};
			assert.equal(
				receiptExport.schemaVersion,
				"taskflow-receipt-export.v1",
			);
			assert.equal(
				receiptExport.receipt.receiptId,
				seeded.completed.receiptId,
			);
			assert.equal(
				receiptExport.currentVerification.receiptId,
				seeded.completed.receiptId,
			);
			assert.deepEqual(
				receiptExport.eventManifest.map(
					(entry) => entry.eventId,
				),
				receiptExport.receipt.eventManifest,
			);
			await expect(
				page.getByText(
					"Receipt JSON downloaded. Its event list matched this Receipt.",
				),
			).toBeVisible();
			trace("Receipt JSON export verified");
			const artifactDownload = page.getByRole("button", {
				name: /Download artifact/u,
			}).first();
			await page.evaluate(() => {
				const downloadWindow = window as typeof window & {
					__taskflowDownloadFileName?: string;
				};
				const originalClick =
					HTMLAnchorElement.prototype.click;
				HTMLAnchorElement.prototype.click = function () {
					downloadWindow.__taskflowDownloadFileName =
						this.download;
					return originalClick.call(this);
				};
			});
			const artifactResponsePromise = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname.includes(
						"/artifacts/",
					) && response.status() === 200,
			);
			await artifactDownload.click();
			await artifactResponsePromise;
			trace("artifact download response observed");
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(
								window as typeof window & {
									__taskflowDownloadFileName?: string;
								}
							).__taskflowDownloadFileName ??
							"",
					),
				)
				.not.toBe("");
			for (const suffix of [
				"/graph",
				"/attempts",
				"/timeline",
				"/artifacts",
				"/receipt",
				"/why-stale",
			]) {
				assert.ok(
					[...requestedApiPaths].some((pathname) =>
						pathname.endsWith(suffix),
					),
					`Pro panel did not request ${suffix}`,
				);
			}
			const taskA11yViolations =
				browserEngineName === "chromium"
					? await assertA11y(
							page,
							"Pro task evidence",
						)
					: null;
		await captureScreenshot(
			page,
			path.join(
				evidenceRoot,
				"task-evidence.en.desktop.png",
			),
			);
			trace("Pro evidence surface complete");
			const beforeReplay =
				inspectProjectControlStore(completedProject, {
					projectId: seeded.completed.projectId,
					controlDomainId:
						seeded.completed.controlDomainId,
				});
			assert.equal(beforeReplay.ok, true);
			if (!beforeReplay.ok) {
				throw new Error(beforeReplay.detail);
			}
			await evidenceTab.press("ArrowRight");
			const replayTab = page.getByRole("tab", {
				name: "Replay",
			});
			await expect(replayTab).toBeFocused();
			await expect(replayTab).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(
				page.getByRole("heading", {
					name: "Zero-token replay",
				}),
			).toBeVisible();
			await expect(
				page.getByRole("heading", {
					name: "Reuse analysis",
				}),
			).toHaveCount(0);
			await expect(
				page.getByText(
					"Replay never calls a provider or writes durable state.",
				),
			).toBeVisible();
			await page
				.getByRole("button", {
					name: "Run offline replay",
				})
				.click();
			const replayResult = page
				.locator(".technical-card")
				.filter({
					has: page.getByRole("heading", {
						name: "Replay result",
					}),
				});
			await expect(replayResult).toBeVisible({
				timeout: 15_000,
			});
			const replayProof = await replayResult
				.locator("dl")
				.evaluate((list) =>
					Object.fromEntries(
						[...list.querySelectorAll("dt")].map(
							(term) => [
								term.textContent?.trim() ?? "",
								term.nextElementSibling?.textContent?.trim() ??
									"",
							],
						),
					),
				);
			assert.deepEqual(replayProof, {
				"Provider calls": "0",
				"Durable writes": "0",
			});
			assert.ok(
				[...requestedApiPaths].some((pathname) =>
					pathname.endsWith("/replay"),
				),
			);
			const afterReplay =
				inspectProjectControlStore(completedProject, {
					projectId: seeded.completed.projectId,
					controlDomainId:
						seeded.completed.controlDomainId,
				});
			assert.equal(afterReplay.ok, true);
			if (!afterReplay.ok) {
				throw new Error(afterReplay.detail);
			}
			assert.equal(
				afterReplay.snapshot.nextCommitSeq,
				beforeReplay.snapshot.nextCommitSeq,
			);
			trace("zero-token replay proved read-only");

			await page.goto(`${reused.origin}/`, {
			waitUntil: "domcontentloaded",
		});
		await expect(page.locator(".approval-row")).toHaveCount(1);
		await page.locator(".approval-row").click();
		await expect(
			page.getByRole("heading", {
				name: "Allow this task to take the described action?",
				level: 1,
			}),
		).toBeVisible();
		await expect(
			page.locator(".decision-button"),
		).toHaveCount(2);
		const allowApproval = page.locator(
			".decision-button.allow",
		);
		await expect(allowApproval).toBeEnabled();
		await allowApproval.click();
		trace("approval decision submitted");
		await expect
			.poll(
				() =>
					loadApprovalForRun(
						approvalProject,
						seeded.approval.runId,
					)?.status,
				{ timeout: 15_000 },
			)
			.toBe("approved");
		await expect
			.poll(
				() => {
					const inspected =
						inspectProjectControlStore(
							approvalProject,
							{
								projectId:
									seeded.approval
										.projectId,
								controlDomainId:
									seeded.approval
										.controlDomainId,
							},
						);
					return inspected.ok
						? inspected.snapshot.runs.find(
								(run) =>
									run.runId ===
									seeded.approval
										.runId,
							)?.status
						: inspected.reason;
				},
				{ timeout: 15_000 },
			)
			.toBe("completed");
		assert.equal(
			fs.readFileSync(
				seeded.approval.beforeMarker,
				"utf8",
			),
			"once",
		);
		assert.equal(
			fs.readFileSync(
				seeded.approval.afterMarker,
				"utf8",
			),
			"once",
		);
		await expect
			.poll(
				() => {
					const inspected =
						inspectProjectControlStore(
							approvalProject,
							{
								projectId:
									seeded.approval
										.projectId,
								controlDomainId:
									seeded.approval
										.controlDomainId,
							},
						);
					return (
						inspected.ok &&
						inspected.snapshot.receipts.some(
							(receipt) =>
								receipt.runId ===
								seeded.approval
									.runId,
						)
					);
				},
				{ timeout: 15_000 },
			)
			.toBe(true);
		trace("approved continuation completed with receipt");
		const approvedInspection =
			inspectProjectControlStore(
				approvalProject,
				{
					projectId:
						seeded.approval.projectId,
					controlDomainId:
						seeded.approval
							.controlDomainId,
				},
			);
		assert.equal(
			approvedInspection.ok,
			true,
			approvedInspection.ok
				? undefined
				: approvedInspection.detail,
		);
		if (approvedInspection.ok) {
			const approvedRun =
				approvedInspection.snapshot.runs.find(
					(run) =>
						run.runId ===
						seeded.approval.runId,
				);
			const approvalReceipt =
				approvedInspection.snapshot.receipts.find(
					(receipt) =>
						receipt.runId ===
						seeded.approval.runId,
				);
			assert.equal(
				approvedRun?.finalOutput,
				"published",
			);
			assert.ok(approvalReceipt);
			assert.equal(
				approvalReceipt?.artifactRefs.includes(
					seeded.approval
						.continuationArtifactId,
				),
				false,
			);
		}
		await page.goto(
			`${reused.origin}/workspaces/${seeded.approval.projectId}` +
				`/domains/${seeded.approval.controlDomainId}` +
				`/tasks/${seeded.approval.runId}`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			page.getByRole("heading", {
				name: "Publish release files",
				level: 1,
			}),
		).toBeVisible();
		await expect(
			page.getByText("published"),
		).toBeVisible();
		await captureScreenshot(
			page,
			path.join(
				evidenceRoot,
				"approval-approved.en.desktop.png",
			),
		);
		trace("approval result rendered");

			await page
				.getByRole("link", { name: "Settings" })
				.click();
			await expect(
				page.getByRole("heading", {
					name: "Settings",
					level: 1,
				}),
			).toBeVisible();
			await expect(page).toHaveTitle("Settings · Taskflow");
			const settingsModeSwitch = page
				.locator(".settings-row")
				.first()
				.getByRole("switch");
			await settingsModeSwitch.focus();
			const initialModeSelected =
				(await settingsModeSwitch.getAttribute(
					"aria-checked",
				)) === "true";
			await settingsModeSwitch.press("Space");
			await expect(settingsModeSwitch).toHaveAttribute(
				"aria-checked",
				initialModeSelected ? "false" : "true",
			);
			await expect(settingsModeSwitch).toBeFocused();
			await settingsModeSwitch.press("Space");
			await expect(settingsModeSwitch).toHaveAttribute(
				"aria-checked",
				initialModeSelected ? "true" : "false",
			);
			const systemTheme = page.getByRole("radio", {
				name: "Use system setting",
			});
			await systemTheme.focus();
			await systemTheme.press("ArrowRight");
			const lightTheme = page.getByRole("radio", {
				name: "Light",
			});
			await expect(lightTheme).toBeFocused();
			await lightTheme.press("Space");
			await expect(lightTheme).toHaveAttribute("aria-checked", "true");
			await expect(page.locator("html")).toHaveAttribute(
				"data-theme",
				"light",
			);
			await lightTheme.press("ArrowLeft");
			await expect(systemTheme).toBeFocused();
			await systemTheme.press("Space");
			await expect(systemTheme).toHaveAttribute("aria-checked", "true");
			const endAllSessions = page.getByRole("button", {
				name: "End all sessions",
			});
			await endAllSessions.focus();
			await endAllSessions.press("Enter");
			await expect(page.getByRole("alertdialog")).toContainText(
				"Tasks will keep their current state",
			);
			assert.equal(
				await page.getByRole("alertdialog").evaluate(
					(dialog) => dialog.contains(document.activeElement),
				),
				true,
			);
			await page.keyboard.press("Escape");
			await expect(page.getByRole("alertdialog")).toHaveCount(0);
			await expect(endAllSessions).toBeFocused();
			trace("settings keyboard and dialog checks complete");
			await endAllSessions.press("Enter");
			await expect(page.getByRole("alertdialog")).toContainText(
				"Tasks will keep their current state",
			);
			await page
				.getByRole("button", { name: "Keep session" })
				.click();
			await expect(page.getByRole("alertdialog")).toHaveCount(0);
			await expect(endAllSessions).toBeFocused();

			await page.setViewportSize({
			width: 320,
			height: 760,
		});
		await page.goto(
			`${reused.origin}/workspaces/${seeded.completed.projectId}/domains/${seeded.completed.controlDomainId}/tasks/${seeded.completed.runId}`,
			{ waitUntil: "domcontentloaded" },
		);
		await expect(
			page.getByRole("heading", {
				name: "Check release package",
			}),
		).toBeVisible();
		const layout = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
			inlineStyleAttributes:
				document.querySelectorAll("[style]").length,
			runtimeStyleElements:
				document.querySelectorAll("style").length,
		}));
		assert.equal(layout.scrollWidth, layout.clientWidth);
		assert.equal(layout.inlineStyleAttributes, 0);
		assert.equal(layout.runtimeStyleElements, 0);
		await captureScreenshot(
			page,
			path.join(
				evidenceRoot,
				"task.en.mobile-320.png",
			),
		);
		trace("mobile layout and screenshots complete");

		const navigation = await page.evaluate(() => {
			const value = performance.getEntriesByType(
				"navigation",
			)[0] as PerformanceNavigationTiming | undefined;
			return value
				? {
						domContentLoadedMs:
							value.domContentLoadedEventEnd -
							value.startTime,
						loadMs:
							value.loadEventEnd -
							value.startTime,
					}
				: null;
		});
		assert.deepEqual(
			cspViolations,
			[],
			`CSP violations: ${JSON.stringify({
				cspViolations,
				runtimeStyleInsertions,
			})}`,
		);
		assert.deepEqual(consoleErrors, []);
		assert.deepEqual(pageErrors, []);

		const logoutLaunch = runCli(
			[
				"ui",
				"--no-open",
				"--project",
				completedProject,
			],
			env,
		) as unknown as CliLaunchResult;
		assert.equal(logoutLaunch.reused, true);
		assert.equal(logoutLaunch.origin, reused.origin);
		const logoutContext = await browser.newContext({
			locale: "en-US",
			viewport: { width: 1024, height: 768 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		try {
			const logoutPage = await logoutContext.newPage();
			await logoutPage.goto(logoutLaunch.launchUrl, {
				waitUntil: "domcontentloaded",
			});
			await logoutPage
				.getByRole("link", { name: "Settings" })
				.click();
			await expect(
				logoutPage.getByRole("heading", {
					name: "Settings",
					level: 1,
				}),
			).toBeVisible();
			await logoutPage
				.getByRole("button", {
					name: "End this session",
				})
				.click();
			const logoutDialog =
				logoutPage.getByRole("alertdialog");
			const logoutResponse =
				logoutPage.waitForResponse(
					(response) =>
						new URL(response.url()).pathname ===
							"/api/v1/session/logout" &&
						response.status() === 200,
				);
			await logoutDialog
				.getByRole("button", {
					name: "End this session",
				})
				.click();
			await logoutResponse;
			await expect(
				logoutPage.getByRole("heading", {
					name: "Browser access ended",
					level: 1,
				}),
			).toBeVisible({ timeout: 15_000 });
			await expect(logoutPage).toHaveTitle(
				"Browser access ended · Taskflow",
			);
			await expect(
				logoutPage.getByText(
					"This tab no longer has access. Tasks kept their current state.",
				),
			).toBeVisible();
			assert.equal(
				await logoutPage.evaluate(async () => {
					const response = await fetch(
						"/api/v1/bootstrap",
					);
					return response.status;
				}),
				401,
			);
			assert.equal(
				await page.evaluate(async () => {
					const response = await fetch(
						"/api/v1/bootstrap",
					);
					return response.status;
				}),
				200,
			);
		} finally {
			await logoutContext.close();
		}

		if (
			isWebManualReviewStage(
				manualReview,
				"sessions",
			)
		) {
			const primaryManualLaunch = runCli(
				[
					"ui",
					"--no-open",
					"--project",
					completedProject,
				],
				env,
			) as unknown as CliLaunchResult;
			const peerManualLaunch = runCli(
				[
					"ui",
					"--no-open",
					"--project",
					completedProject,
				],
				env,
			) as unknown as CliLaunchResult;
			assert.equal(primaryManualLaunch.reused, true);
			assert.equal(peerManualLaunch.reused, true);
			assert.equal(
				primaryManualLaunch.origin,
				reused.origin,
			);
			assert.equal(
				peerManualLaunch.origin,
				reused.origin,
			);
			assert.notEqual(
				primaryManualLaunch.launchUrl,
				peerManualLaunch.launchUrl,
			);
			await holdWebManualReview(manualReview, {
				stage: "sessions",
				launches: [
					{
						label: "primary-session",
						launchUrl:
							primaryManualLaunch.launchUrl,
						origin:
							primaryManualLaunch.origin,
						project: "release-checks",
					},
					{
						label: "peer-session",
						launchUrl:
							peerManualLaunch.launchUrl,
						origin:
							peerManualLaunch.origin,
						project: "release-checks",
					},
				],
			});
			if (manualReview.exitAfterHold) {
				return;
			}
		}

		const revokeLaunch = runCli(
			[
				"ui",
				"--no-open",
				"--project",
				completedProject,
			],
			env,
		) as unknown as CliLaunchResult;
		assert.equal(revokeLaunch.reused, true);
		assert.equal(revokeLaunch.origin, reused.origin);
		const revokedPeerContext = await browser.newContext({
			locale: "en-US",
			viewport: { width: 1024, height: 768 },
			colorScheme: "light",
			reducedMotion: "reduce",
		});
		try {
			const revokedPeerPage =
				await revokedPeerContext.newPage();
			await revokedPeerPage.goto(revokeLaunch.launchUrl, {
				waitUntil: "domcontentloaded",
			});
			await expect(
				revokedPeerPage.getByRole("heading", {
					level: 1,
				}),
			).toBeVisible({ timeout: 15_000 });
			sessionTerminationExpected = true;
			await page.goto(`${reused.origin}/settings`, {
				waitUntil: "domcontentloaded",
			});
			await expect(
				page.getByRole("heading", {
					name: "Settings",
					level: 1,
				}),
			).toBeVisible();
			await page
				.getByRole("button", {
					name: "End all sessions",
				})
				.click();
			const revokeDialog =
				page.getByRole("alertdialog");
			const revokeResponse =
				page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname ===
							"/api/v1/sessions/revoke-all" &&
						response.status() === 200,
				);
			await revokeDialog
				.getByRole("button", {
					name: "End all sessions",
				})
				.click();
			await revokeResponse;
			await expect(
				page.getByRole("heading", {
					name: "Browser access ended",
					level: 1,
				}),
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.getByText(
					"Every Taskflow tab for this listener no longer has access. Tasks kept their current state.",
				),
			).toBeVisible();
			assert.equal(
				await revokedPeerPage.evaluate(async () => {
					const response = await fetch(
						"/api/v1/bootstrap",
					);
					return response.status;
				}),
				401,
			);
		} finally {
			await revokedPeerContext.close();
		}
		assert.deepEqual(consoleErrors, []);
		trace("current-session logout and listener-wide revocation verified");

		trace("closing browser context");
		await context.close();
		trace("browser context closed");

		const stopped = runCli(["ui", "--stop"], env);
		assert.equal(stopped.action, "stop");
		assert.equal(stopped.stopped, true);
		await Promise.race([
			once(owner.child, "exit"),
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								"packaged UI owner did not exit after --stop",
							),
						),
					10_000,
				);
				timer.unref();
			}),
		]);
		trace("UI owner stopped");

		const report = {
			schemaVersion: 1,
			browserEngine: browserEngineName,
			...(browserChannel
				? { browserChannel }
				: {}),
			browserVersion,
			packagedCli: true,
			multiProject: true,
			listenerReused: true,
			independentLaunchCapabilities: true,
			crossPortBrowserCookieIsolation: true,
			sseConnected: true,
			pollingFallbackObserved: true,
			pollingProjectionEquivalent: true,
			pollingGetSurfaceInventoryCovered: true,
			simpleAttentionCopyVerified: true,
			approvalDecisionCommitted: true,
			approvalContinuationAfterRestartSafe: true,
			approvalSettledAttemptsNotReplayed: true,
			approvalPrivateCheckpointNotReceiptReachable: true,
			cancelCommandCommitted: true,
			completedReceiptAndArtifactRendered: true,
			proGraphTimelineAndNodeDetailRendered: true,
			proTabsKeyboardAndFocusVerified: true,
			proGraphDisclosureKeyboardVerified: true,
			proGraphListboxKeyboardParityVerified: true,
			taskListPageVirtualizationVerified: true,
			artifactDownloadPathObserved: true,
			receiptJsonExported: true,
			receiptJsonLocallyChecked: true,
			whyStaleDistinctFromReplay: true,
			zeroTokenReplayExecuted: true,
			zeroTokenReplayProviderCalls: 0,
			zeroTokenReplayDurableWrites: 0,
			settingsSwitchAndSingleSelectionKeyboardVerified: true,
			sessionSafetyDialogFocusAndDismissalVerified: true,
			currentSessionLogoutCommitted: true,
			listenerWideSessionRevocationCommitted: true,
			listenerWideSessionRevocationInvalidatedPeer: true,
			sessionTerminationDiagnostics:
				sessionTerminationDiagnostics.length,
			mobileWidth: layout.clientWidth,
			horizontalOverflow: false,
			inlineStyleAttributes:
				layout.inlineStyleAttributes,
			runtimeStyleElements:
				layout.runtimeStyleElements,
			consoleErrors: consoleErrors.length,
			pageErrors: pageErrors.length,
			browserTransportDiagnostics:
				browserTransportDiagnostics.length,
			cspViolations: cspViolations.length,
			runtimeStyleInsertions:
				runtimeStyleInsertions.length,
			a11yViolationCounts: {
				home: homeA11yViolations,
				task: taskA11yViolations,
			},
			navigation,
			screenshots: [
				"home.en.desktop.png",
				"task-cancelled.en.desktop.png",
				"task-evidence.en.desktop.png",
				"approval-approved.en.desktop.png",
				"task.en.mobile-320.png",
			],
		};
		fs.writeFileSync(
			path.join(evidenceRoot, "evidence.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
		trace("evidence written");
		console.log(JSON.stringify(report, null, 2));
	} finally {
		trace("closing browser");
		await browser?.close();
		trace("browser closed");
		if (isolatedOwner?.child.exitCode === null) {
			isolatedOwner.child.kill("SIGTERM");
			await Promise.race([
				once(isolatedOwner.child, "exit"),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 2_000);
					timer.unref();
				}),
			]);
		}
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
