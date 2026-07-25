import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import {
	createControlHost,
	createWebCursorCodec,
	createWebReadHandlers,
	projectArtifactBlobsDir,
	projectArtifactMetadataDir,
	WEB_MAX_ARTIFACT_BYTES,
	WEB_ENDPOINTS,
	WebBootstrapResponseSchema,
	WebCommandResponseSchema,
	WebOverviewResponseSchema,
	WebSessionExchangeResponseSchema,
	type ControlHost,
	type WebStreamFrame,
} from "taskflow-control";
import { Value } from "typebox/value";
import {
	WEB_ARTIFACT_ABSOLUTE_TIMEOUT_MS,
	WEB_ARTIFACT_IN_FLIGHT_BYTE_BUDGET,
	WEB_DEFAULT_IMPLEMENTED_FEATURES,
	WEB_IMPLEMENTED_GATEWAY_ENDPOINT_IDS,
	pumpWebSseFrames,
	runWebHandlerWithDeadline,
	startWebGateway,
	writeWebArtifactBody,
	type WebGatewayHandle,
} from "../src/web-gateway.ts";
import {
	decodeCanonicalWebStaticPath,
	loadWebStaticAssets,
} from "../src/web-static-assets.ts";

type HttpResult = {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: unknown;
};

function requestRaw(
	gateway: WebGatewayHandle,
	input: {
		readonly method?: string;
		readonly path: string;
		readonly accept?: string;
	},
): Promise<{
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: Buffer;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: gateway.port,
				method: input.method ?? "GET",
				path: input.path,
				headers: {
					Host: `${gateway.hostNonce}.localhost:${gateway.port}`,
					Connection: "close",
					...(input.accept ? { Accept: input.accept } : {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.once("error", reject);
		req.end();
	});
}

function rawSocketRequest(
	gateway: WebGatewayHandle,
	rawRequest: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: gateway.port,
		});
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString("utf8"));
		};
		socket.setTimeout(2_000, () => {
			socket.destroy();
			if (chunks.length > 0) finish();
			else reject(new Error("raw HTTP request timed out without a response"));
		});
		socket.once("connect", () => socket.write(rawRequest));
		socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		socket.once("end", finish);
		socket.once("close", finish);
		socket.once("error", (error) => {
			if (chunks.length > 0) finish();
			else reject(error);
		});
	});
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function digest(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function streamFrame(
	index: number,
): import("taskflow-control").WebStreamFrame {
	const cursor = `cursor-${index}`;
	return {
		type: "change",
		id: cursor,
		cursor,
		observedAt: index,
		kind: "invalidated",
		resourceType: "project",
		resourceId: `project-${index}`,
		projectId: `project-${index}`,
		controlDomainId: `domain-${index}`,
		commitSeq: index,
	};
}

async function exerciseSseOverflow(
	options: {
		readonly maxQueuedFrames: number;
		readonly maxQueuedBytes: number;
	},
): Promise<{
	readonly result: string;
	readonly written: import("taskflow-control").WebStreamFrame[];
}> {
	let releaseFirstWrite!: () => void;
	const firstWrite = new Promise<void>((resolve) => {
		releaseFirstWrite = resolve;
	});
	const written: import("taskflow-control").WebStreamFrame[] = [];
	async function* frames() {
		for (let index = 1; index <= 300; index += 1) {
			yield streamFrame(index);
		}
	}
	const iterator = frames()[Symbol.asyncIterator]();
	const pump = pumpWebSseFrames({
		firstFrame: {
			type: "checkpoint",
			id: "cursor-0",
			cursor: "cursor-0",
			observedAt: 0,
			registryRevision: "registry-1",
			projectWatermarks: [],
		},
		iterator,
		maxQueuedFrames: options.maxQueuedFrames,
		maxQueuedBytes: options.maxQueuedBytes,
		writeFrame: async (frame) => {
			written.push(frame);
			if (written.length === 1) await firstWrite;
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseFirstWrite();
	return {
		result: await pump,
		written,
	};
}

test("WebGateway: SSE queue overflow emits one reset then closes", async () => {
	for (const options of [
		{
			maxQueuedFrames: 2,
			maxQueuedBytes: 1024 * 1024,
		},
		{
			maxQueuedFrames: 256,
			maxQueuedBytes: 512,
		},
	]) {
		const { result, written } =
			await exerciseSseOverflow(options);
		assert.equal(result, "overflow-reset");
		assert.deepEqual(
			written.map((frame) => frame.type),
			["checkpoint", "reset-required"],
		);
		const reset = written[1];
		assert.equal(reset?.type, "reset-required");
		if (reset?.type === "reset-required") {
			assert.equal(reset.error.code, "TF_CURSOR_EXPIRED");
			assert.equal(reset.error.recoveryAction, "refresh");
			assert.equal(reset.error.sideEffects, "none");
		}
	}
});

test("WebGateway: a paused real SSE socket overflows to one reset and releases capacity", async () => {
	const fixture = setup();
	const keysetDigest = digest("sse-real-backpressure-keyset");
	let gateway: WebGatewayHandle | undefined;
	let produced = 0;
	let producerClosed = false;
	const denseCursor = (index: number) =>
		`cursor-${index}-${"x".repeat(7_900)}`;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-sse-real-backpressure",
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			handlers: {
				events: () =>
					(async function* backpressured(): AsyncGenerator<WebStreamFrame> {
						try {
							const checkpointCursor = denseCursor(0);
							yield {
								type: "checkpoint",
								id: checkpointCursor,
								cursor: checkpointCursor,
								observedAt: 1,
								registryRevision: "registry-backpressure",
								projectWatermarks: [],
							};
							for (let index = 1; index <= 2_000; index += 1) {
								produced = index;
								const cursor = denseCursor(index);
								yield {
									type: "change",
									id: cursor,
									cursor,
									observedAt: index + 1,
									kind: "invalidated",
									resourceType: "project",
									resourceId: `project-${index}`,
									projectId: `project-${index}`,
									controlDomainId: `domain-${index}`,
									commitSeq: index,
								};
							}
						} finally {
							producerClosed = true;
						}
					})(),
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]?.split(";")[0];
		assert.ok(cookie);

		const streamText = await new Promise<string>((resolve, reject) => {
			const clientRequest = http.request(
				{
					hostname: "127.0.0.1",
					port: gateway!.port,
					method: "GET",
					path: "/api/v1/events",
					headers: {
						Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
						Cookie: cookie,
						Connection: "close",
					},
				},
				(response) => {
					assert.equal(response.statusCode, 200);
					const chunks: Buffer[] = [];
					response.pause();
					response.on("data", (chunk) =>
						chunks.push(Buffer.from(chunk)),
					);
					response.once("end", () =>
						resolve(Buffer.concat(chunks).toString("utf8")),
					);
					response.once("error", reject);
					setTimeout(() => response.resume(), 150).unref();
				},
			);
			clientRequest.setTimeout(5_000, () => {
				clientRequest.destroy(
					new Error("real SSE backpressure fixture timed out"),
				);
			});
			clientRequest.once("error", reject);
			clientRequest.end();
		});

		const frames = streamText
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => JSON.parse(line.slice("data: ".length)) as WebStreamFrame);
		assert.equal(frames[0]?.type, "checkpoint");
		assert.ok(produced < 2_000);
		assert.equal(producerClosed, true);
		assert.equal(
			frames.filter((frame) => frame.type === "reset-required").length,
			1,
		);
		assert.equal(frames.at(-1)?.type, "reset-required");

		const overview = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/overview HTTP/1.1",
				`Host: ${gateway.hostNonce}.localhost:${gateway.port}`,
				`Cookie: ${cookie}`,
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(overview, /^HTTP\/1\.1 200 /u);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: non-stream handler deadline aborts without inventing an outcome", async () => {
	let observedSignal: AbortSignal | undefined;
	await assert.rejects(
		() =>
			runWebHandlerWithDeadline(
				(signal) => {
					observedSignal = signal;
					return new Promise<never>(() => {
						// Deliberately never settles.
					});
				},
				{
					timeoutMs: 20,
					timeoutError: {
						code: "TF_COMMAND_FAILED",
						message:
							"Command response deadline elapsed.",
						recoveryAction:
							"retry-same-command",
						sideEffects: "unknown",
						commandId: "command-timeout",
					},
				},
			),
		(error: unknown) =>
			error instanceof Error &&
			error.name === "WebReadServiceError" &&
			(error as {
				controlError?: {
					code?: string;
					recoveryAction?: string;
					sideEffects?: string;
				};
			}).controlError?.code === "TF_COMMAND_FAILED" &&
			(error as {
				controlError?: {
					recoveryAction?: string;
				};
			}).controlError?.recoveryAction ===
				"retry-same-command" &&
			(error as {
				controlError?: {
					sideEffects?: string;
				};
			}).controlError?.sideEffects === "unknown",
	);
	assert.equal(observedSignal?.aborted, true);

	const result = await runWebHandlerWithDeadline(
		async (signal) => {
			assert.equal(signal.aborted, false);
			return "completed";
		},
		{
			timeoutMs: 100,
			timeoutError: {
				code: "TF_DURABILITY_FAILED",
				message: "Read response deadline elapsed.",
				recoveryAction: "refresh",
				sideEffects: "none",
			},
		},
	);
	assert.equal(result, "completed");

	const external = new AbortController();
	let externalSignal: AbortSignal | undefined;
	const externallyAborted = runWebHandlerWithDeadline(
		(signal) => {
			externalSignal = signal;
			return new Promise<never>(() => {
				// The request-side abort must settle this even if the handler
				// ignores cancellation.
			});
		},
		{
			timeoutMs: 1_000,
			abortSignal: external.signal,
			abortError: {
				code: "TF_DURABILITY_FAILED",
				message: "Client connection closed.",
				recoveryAction: "refresh",
				sideEffects: "none",
			},
			timeoutError: {
				code: "TF_DURABILITY_FAILED",
				message: "Read response deadline elapsed.",
				recoveryAction: "refresh",
				sideEffects: "none",
			},
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	external.abort();
	await assert.rejects(
		externallyAborted,
		(error: unknown) =>
			error instanceof Error &&
			error.name === "WebReadServiceError" &&
			(error as {
				controlError?: { message?: string };
			}).controlError?.message === "Client connection closed.",
	);
	assert.equal(externalSignal?.aborted, true);
});

test("WebGateway: client disconnect aborts a real handler and releases its request slot", async () => {
	const fixture = setup();
	const listenerId = "listener-client-abort";
	const keysetDigest = digest("client-abort-keyset");
	const cursorCodec = createWebCursorCodec({
		key: Buffer.alloc(32, 41),
		listenerId,
	});
	const authoritative = createWebReadHandlers(fixture.host, {
		cursorCodec,
	});
	let first = true;
	let started!: () => void;
	const handlerStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let observedAbort!: () => void;
	const handlerAborted = new Promise<void>((resolve) => {
		observedAbort = resolve;
	});
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			handlers: {
				overview: async (input, context) => {
					if (!first) {
						return authoritative.overview(input, context);
					}
					first = false;
					assert.ok(context.signal);
					started();
					await new Promise<void>((resolve) => {
						if (context.signal!.aborted) {
							resolve();
							return;
						}
						context.signal!.addEventListener(
							"abort",
							() => resolve(),
							{ once: true },
						);
					});
					observedAbort();
					throw new Error("handler observed client disconnect");
				},
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);

		let clientRequest!: http.ClientRequest;
		const clientClosed = new Promise<void>((resolve, reject) => {
			clientRequest = http.request(
				{
					hostname: "127.0.0.1",
					port: gateway!.port,
					method: "GET",
					path: "/api/v1/overview",
					headers: {
						Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
						Cookie: cookie,
					},
				},
				() => reject(new Error("aborted request unexpectedly received a response")),
			);
			clientRequest.once("error", (error) => {
				if (
					(error as NodeJS.ErrnoException).code ===
					"ECONNRESET"
				) {
					resolve();
				} else {
					reject(error);
				}
			});
			clientRequest.end();
		});
		await handlerStarted;
		const abortStartedAt = Date.now();
		clientRequest.destroy();
		await handlerAborted;
		await clientClosed;
		assert.ok(Date.now() - abortStartedAt < 1_000);

		const retry = await request(gateway, {
			path: "/api/v1/overview",
			cookie,
		});
		assert.equal(retry.status, 200);
		assert.equal(
			Value.Check(WebOverviewResponseSchema, retry.body),
			true,
		);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

function createStaticFixture(root: string, keysetDigest: string): string {
	const staticRoot = path.join(root, "static");
	const assetsRoot = path.join(staticRoot, "assets");
	fs.mkdirSync(assetsRoot, { recursive: true });
	const files = {
		"assets/app-a1b2c3.js": Buffer.from("document.title='Taskflow';\n", "utf8"),
		"assets/content-en-a1b2c3.json": Buffer.from('{"locale":"en"}\n', "utf8"),
		"assets/content-zh-cn-a1b2c3.json": Buffer.from(
			'{"locale":"zh-CN"}\n',
			"utf8",
		),
	};
	for (const [relative, bytes] of Object.entries(files)) {
		fs.writeFileSync(path.join(staticRoot, relative), bytes);
	}
	const index = Buffer.from(
		'<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app-a1b2c3.js"></script></body></html>\n',
		"utf8",
	);
	fs.writeFileSync(path.join(staticRoot, "index.html"), index);
	const patterns = [
		{ id: "home", tokens: [] },
		{ id: "settings", tokens: [{ kind: "literal", value: "settings" }] },
		{
			id: "task",
			tokens: [
				{ kind: "literal", value: "workspaces" },
				{ kind: "safe-id", name: "projectId" },
				{ kind: "literal", value: "domains" },
				{ kind: "safe-id", name: "controlDomainId" },
				{ kind: "literal", value: "tasks" },
				{ kind: "safe-id", name: "runId" },
			],
		},
	];
	const rows = Object.entries(files)
		.map(([relative, bytes]) => ({
			path: relative,
			sha256: digest(bytes),
			size: bytes.byteLength,
			mediaType: relative.endsWith(".js")
				? "text/javascript; charset=utf-8"
				: "application/json; charset=utf-8",
		}))
		.sort((left, right) => left.path.localeCompare(right.path, "en"));
	const manifest = {
		manifestVersion: "taskflow-web-assets.v1",
		packageVersion: "0.3.0-beta.2",
		webBuildId: digest("static-fixture"),
		protocolConsumer: { major: 1, minMinor: 0, maxMinor: 0 },
		entrypoint: { path: "index.html", sha256: digest(index) },
		assets: rows,
		routeRegistry: {
			version: "taskflow-web-routes.v1",
			patterns,
			sha256: digest(Buffer.from(canonical(patterns), "utf8")),
		},
		contentCatalogs: {
			version: "taskflow-content.v1",
			defaultLocale: "en",
			supportedLocales: ["en", "zh-CN"],
			projectedKeysetSha256: keysetDigest,
			staticKeysetSha256: keysetDigest,
			keysetSha256: keysetDigest,
			catalogs: [
				{
					locale: "en",
					path: "assets/content-en-a1b2c3.json",
					sha256: digest(files["assets/content-en-a1b2c3.json"]),
					size: files["assets/content-en-a1b2c3.json"].byteLength,
				},
				{
					locale: "zh-CN",
					path: "assets/content-zh-cn-a1b2c3.json",
					sha256: digest(files["assets/content-zh-cn-a1b2c3.json"]),
					size: files["assets/content-zh-cn-a1b2c3.json"].byteLength,
				},
			],
		},
	};
	fs.writeFileSync(
		path.join(staticRoot, "taskflow-web-assets.json"),
		`${canonical(manifest)}\n`,
	);
	return staticRoot;
}

function mutateStaticManifest(
	staticRoot: string,
	mutate: (manifest: Record<string, unknown>) => void,
): void {
	const manifestPath = path.join(
		staticRoot,
		"taskflow-web-assets.json",
	);
	const manifest = JSON.parse(
		fs.readFileSync(manifestPath, "utf8"),
	) as Record<string, unknown>;
	mutate(manifest);
	fs.writeFileSync(manifestPath, `${canonical(manifest)}\n`);
}

function loadStaticFixture(
	staticRoot: string,
	keysetDigest: string,
	packageVersion = "0.3.0-beta.2",
) {
	return loadWebStaticAssets({
		root: staticRoot,
		packageVersion,
		protocolMajor: 1,
		protocolMinor: 0,
		contentKeysetDigests: {
			projected: keysetDigest,
			static: keysetDigest,
			combined: keysetDigest,
		},
	});
}

test("Web static paths accept only one canonical decode", () => {
	const valid = new Map<string, string>([
		["/", "/"],
		["/?view=simple", "/"],
		["/settings#ignored-by-routing", "/settings"],
		["/assets/app-a1b2c3.js", "/assets/app-a1b2c3.js"],
		[
			"/workspaces/project.A_1/domains/domain-b/tasks/run.2",
			"/workspaces/project.A_1/domains/domain-b/tasks/run.2",
		],
		["/not-a-route/%E4%B8%AD", "/not-a-route/中"],
	]);
	for (const [raw, expected] of valid) {
		assert.equal(
			decodeCanonicalWebStaticPath(raw),
			expected,
			`canonical path was rejected: ${raw}`,
		);
	}

	const invalid = [
		"",
		"settings",
		"\\settings",
		"/assets\\app.js",
		"/a//b",
		"/.",
		"/..",
		"/a/./b",
		"/a/../b",
		"/%2E",
		"/%2e%2e",
		"/%2F",
		"/%2f",
		"/%5C",
		"/%5c",
		"/%00",
		"/%0A",
		"/%0D",
		"/%7F",
		"/\u0000",
		"/\u001f",
		"/\u007f",
		"/\u202e",
		"/\u2066",
		"/%E2%80%AE",
		"/%E2%81%A6",
		"/%",
		"/%2",
		"/%GG",
		"/%C0%AF",
		"/%ED%A0%80",
		"/%252F",
		"/%252e%252e",
		"/%41",
		"/%7e",
		"/中",
		"/not-a-route/%e4%b8%ad",
		"/not-a-route/e%CC%81",
	] as const;
	for (const raw of invalid) {
		assert.equal(
			decodeCanonicalWebStaticPath(raw),
			null,
			`non-canonical path was accepted: ${JSON.stringify(raw)}`,
		);
	}
});

function request(
	gateway: WebGatewayHandle,
	input: {
		method?: string;
		path: string;
		host?: string;
		origin?: string;
		cookie?: string;
		csrf?: string;
		contentType?: string;
		secFetchSite?: string;
		lastEventId?: string;
		body?: unknown;
	},
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const body =
			input.body === undefined
				? undefined
				: Buffer.from(JSON.stringify(input.body), "utf8");
		const headers: http.OutgoingHttpHeaders = {
			Host: input.host ?? `${gateway.hostNonce}.localhost:${gateway.port}`,
			Connection: "close",
			...(input.origin ? { Origin: input.origin } : {}),
			...(input.cookie ? { Cookie: input.cookie } : {}),
			...(input.csrf
				? { "X-Taskflow-CSRF": input.csrf }
				: {}),
			...(input.secFetchSite
				? { "Sec-Fetch-Site": input.secFetchSite }
				: {}),
			...(input.lastEventId
				? { "Last-Event-ID": input.lastEventId }
				: {}),
			...(body
				? {
						"Content-Type":
							input.contentType ??
							"application/json",
						"Content-Length": String(body.byteLength),
					}
				: {}),
		};
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: gateway.port,
				method: input.method ?? "GET",
				path: input.path,
				headers,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) =>
					chunks.push(Buffer.from(chunk)),
				);
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: text ? JSON.parse(text) : null,
					});
				});
			},
		);
		req.once("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

function requestBytes(
	gateway: WebGatewayHandle,
	input: {
		path: string;
		cookie: string;
		range?: string;
		sensitiveAck?: string;
	},
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: gateway.port,
				method: "GET",
				path: input.path,
				headers: {
					Host: `${gateway.hostNonce}.localhost:${gateway.port}`,
					Cookie: input.cookie,
					Connection: "close",
					...(input.range
						? { Range: input.range }
						: {}),
					...(input.sensitiveAck
						? {
								"X-Taskflow-Sensitive-Ack":
									input.sensitiveAck,
							}
						: {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) =>
					chunks.push(Buffer.from(chunk)),
				);
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.once("error", reject);
		req.end();
	});
}

function firstSseFrame(
	gateway: WebGatewayHandle,
	input: {
		cookie: string;
		path?: string;
		lastEventId?: string;
	},
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	text: string;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: gateway.port,
				method: "GET",
				path: input.path ?? "/api/v1/events",
				headers: {
					Host: `${gateway.hostNonce}.localhost:${gateway.port}`,
					Cookie: input.cookie,
					Connection: "close",
					...(input.lastEventId
						? {
								"Last-Event-ID":
									input.lastEventId,
							}
						: {}),
				},
			},
			(response) => {
				let text = "";
				let settled = false;
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					text += chunk;
					if (
						!settled &&
						text.includes(
							"\nevent: taskflow\ndata: ",
						) &&
						text.endsWith("\n\n")
					) {
						settled = true;
						resolve({
							status:
								response.statusCode ?? 0,
							headers: response.headers,
							text,
						});
						response.destroy();
						req.destroy();
					}
				});
				response.on("end", () => {
					if (settled) return;
					settled = true;
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						text,
					});
				});
				response.once("error", (error) => {
					if (!settled) reject(error);
				});
			},
		);
		req.once("error", (error) => {
			if (
				(error as NodeJS.ErrnoException).code !==
				"ECONNRESET"
			) {
				reject(error);
			}
		});
		req.end();
	});
}

function holdSseStream(
	gateway: WebGatewayHandle,
	cookie: string,
): Promise<{
	readonly status: number;
	readonly text: string;
	close(): void;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: gateway.port,
				method: "GET",
				path: "/api/v1/events",
				headers: {
					Host: `${gateway.hostNonce}.localhost:${gateway.port}`,
					Cookie: cookie,
				},
			},
			(response) => {
				let text = "";
				let settled = false;
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					text += chunk;
					if (
						!settled &&
						text.includes("\nevent: taskflow\ndata: ") &&
						text.endsWith("\n\n")
					) {
						settled = true;
						resolve({
							status: response.statusCode ?? 0,
							text,
							close() {
								response.destroy();
								req.destroy();
							},
						});
					}
				});
				response.once("error", (error) => {
					if (!settled) reject(error);
				});
			},
		);
		req.once("error", reject);
		req.end();
	});
}

function setup(): {
	root: string;
	host: ControlHost;
	cleanup(): void;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-web-gateway-"));
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: { ...process.env, TASKFLOW_HOME: home },
	});
	return {
		root,
		host,
		cleanup() {
			host.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("WebGateway: approval capability resumes the exact durable continuation over HTTP", async () => {
	const fixture = setup();
	const catalogDigest = digest("approval-capability");
	let gateway: WebGatewayHandle | undefined;
	try {
		const parked = await fixture.host.admitAndRun({
			commandId: "cmd-http-approval-admit",
			program: {
				name: "http-approval",
				phases: [
					{
						id: "before",
						type: "script",
						run: "printf before",
					},
					{
						id: "review",
						type: "approval",
						dependsOn: ["before"],
						task: "Approve this task?",
					},
					{
						id: "after",
						type: "script",
						dependsOn: ["review"],
						run: "printf after",
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
		assert.equal(parked.run?.stage, "parked");
		const rejectParked =
			await fixture.host.admitAndRun({
				commandId:
					"cmd-http-reject-admit",
				program: {
					name: "http-reject",
					phases: [
						{
							id: "review",
							type: "approval",
							task:
								"Approve this task?",
						},
						{
							id: "after",
							type: "script",
							dependsOn: ["review"],
							run: "printf should-not-run",
							final: true,
						},
					],
				},
			});
		assert.equal(
			rejectParked.ok,
			true,
			JSON.stringify(rejectParked.error),
		);
		gateway = await startWebGateway({
			host: fixture.host,
			supportedCommands: [
				"approve",
				"reject",
				"cancel-run",
			],
			contentKeysetDigests: {
				projected: catalogDigest,
				static: catalogDigest,
				combined: catalogDigest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: {
				launchToken: gateway.launchToken,
			},
		});
		assert.equal(exchange.status, 200);
		const cookie =
			exchange.headers["set-cookie"]?.[0]?.split(
				";",
			)[0];
		assert.ok(cookie);
		const csrf = (
			exchange.body as {
				data: { csrfToken: string };
			}
		).data.csrfToken;
		const bootstrap = await request(gateway, {
			path: "/api/v1/bootstrap",
			cookie,
		});
		assert.deepEqual(
			(
				bootstrap.body as {
					data: {
						supportedCommands: string[];
					};
				}
			).data.supportedCommands,
			["approve", "cancel-run", "reject"],
		);
		const submitted = await request(gateway, {
			method: "POST",
			path: "/api/v1/commands",
			origin: gateway.origin,
			cookie,
			csrf,
			body: {
				commandId: "cmd-http-approval",
				kind: "approve",
				projectId: fixture.host.projectId,
				controlDomainId:
					fixture.host.controlDomainId,
				runId: parked.run!.runId,
				expectedRunVersion:
					parked.run!.runVersion,
				approvalRequestId:
					parked.run!.approvalRequestId,
			},
		});
		assert.equal(submitted.status, 200);
		assert.equal(
			Value.Check(
				WebCommandResponseSchema,
				submitted.body,
			),
			true,
		);
		assert.equal(
			(
				submitted.body as {
					data: { status: string };
				}
			).data.status,
			"completed",
		);
		const run = fixture.host.store.getRun(
			parked.run!.runId,
		);
		assert.equal(run?.status, "completed");
		assert.equal(run?.stage, "terminal");
		assert.deepEqual(
			run?.attempts?.map(
				(attempt) =>
					attempt.nodeInstanceId,
			),
			["before", "review", "after"],
		);
		assert.ok(
			fixture.host.store.getReceiptForRun(
				parked.run!.runId,
			),
		);
		assert.equal(
			fixture.host.store.getCommand(
				"cmd-http-approval",
			)?.status,
			"completed",
		);
		const rejected = await request(gateway, {
			method: "POST",
			path: "/api/v1/commands",
			origin: gateway.origin,
			cookie,
			csrf,
			body: {
				commandId: "cmd-http-reject",
				kind: "reject",
				projectId: fixture.host.projectId,
				controlDomainId:
					fixture.host.controlDomainId,
				runId: rejectParked.run!.runId,
				expectedRunVersion:
					rejectParked.run!.runVersion,
				approvalRequestId:
					rejectParked.run!
						.approvalRequestId,
				reason: "Not approved.",
			},
		});
		assert.equal(rejected.status, 200);
		assert.equal(
			(
				rejected.body as {
					data: { status: string };
				}
			).data.status,
			"completed",
		);
		assert.equal(
			fixture.host.store.getRun(
				rejectParked.run!.runId,
			)?.status,
			"blocked",
		);
		assert.equal(
			fixture.host.store.getReceiptForRun(
				rejectParked.run!.runId,
			),
			null,
		);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: artifact writer honors drain and destroys a stalled transport", async () => {
	assert.equal(WEB_ARTIFACT_ABSOLUTE_TIMEOUT_MS, 5 * 60_000);
	const chunks: Buffer[] = [];
	const draining = new Writable({
		highWaterMark: 1,
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			setImmediate(callback);
		},
	});
	const expected = Buffer.from("artifact-backpressure-body", "utf8");
	await writeWebArtifactBody(draining, expected, {
		stallTimeoutMs: 100,
		absoluteTimeoutMs: 1_000,
		chunkBytes: 3,
	});
	assert.equal(draining.writableFinished, true);
	assert.deepEqual(Buffer.concat(chunks), expected);

	const stalled = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, _callback) {
			// Deliberately withhold the callback: no drain/progress is possible.
		},
	});
	const startedAt = Date.now();
	await writeWebArtifactBody(stalled, Buffer.alloc(16), {
		stallTimeoutMs: 20,
		absoluteTimeoutMs: 1_000,
		chunkBytes: 16,
	});
	assert.equal(stalled.destroyed, true);
	assert.ok(Date.now() - startedAt < 500);

	const slowlyProgressing = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			setTimeout(callback, 10).unref();
		},
	});
	const absoluteStartedAt = Date.now();
	await writeWebArtifactBody(
		slowlyProgressing,
		Buffer.alloc(64),
		{
			stallTimeoutMs: 100,
			absoluteTimeoutMs: 25,
			chunkBytes: 1,
		},
	);
	assert.equal(slowlyProgressing.destroyed, true);
	assert.ok(Date.now() - absoluteStartedAt < 500);
});

test("WebGateway: listener-wide artifact byte budget admits only one maximum-size disclosure", async () => {
	assert.equal(
		WEB_ARTIFACT_IN_FLIGHT_BYTE_BUDGET,
		WEB_MAX_ARTIFACT_BYTES,
	);
	const fixture = setup();
	const listenerId = "listener-artifact-byte-budget";
	const keysetDigest = digest("artifact-byte-budget-keyset");
	const body = Buffer.from("bounded artifact", "utf8");
	const artifactDigest = digest(body);
	let enterFirst: (() => void) | undefined;
	const firstEntered = new Promise<void>((resolve) => {
		enterFirst = resolve;
	});
	let releaseFirst: (() => void) | undefined;
	const firstReleased = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let calls = 0;
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			handlers: {
				artifact: async () => {
					calls += 1;
					if (calls === 1) {
						enterFirst?.();
						await firstReleased;
					}
					return {
						metadata: {
							digest: artifactDigest,
							size: body.byteLength,
							mediaType: "application/octet-stream",
							fileName: "bounded.bin",
							redactionClass: "project",
							contentDisposition: "attachment",
						},
						body,
					};
				},
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]?.split(";")[0];
		assert.ok(cookie);
		const artifactPath =
			`/api/v1/projects/${fixture.host.projectId}` +
			`/domains/${fixture.host.controlDomainId}` +
			`/artifacts/${encodeURIComponent(artifactDigest)}`;
		const first = requestBytes(gateway, {
			path: artifactPath,
			cookie,
		});
		await firstEntered;
		const rejected = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
		});
		assert.equal(rejected.status, 429);
		assert.equal(rejected.headers["retry-after"], "1");
		assert.equal(calls, 1);
		releaseFirst?.();
		assert.equal((await first).status, 200);
		assert.equal(
			(
				await requestBytes(gateway, {
					path: artifactPath,
					cookie,
				})
			).status,
			200,
		);
		assert.equal(calls, 2);
	} finally {
		releaseFirst?.();
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: real artifact transport abort does not retain the connection or request slot", async () => {
	const fixture = setup();
	const listenerId = "listener-artifact-abort";
	const keysetDigest = digest("artifact-abort-keyset");
	const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
	const artifactDigest = digest(bytes);
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			handlers: {
				artifact: () => ({
					metadata: {
						digest: artifactDigest,
						size: bytes.byteLength,
						mediaType: "application/octet-stream",
						fileName: "large-artifact.bin",
						redactionClass: "public",
						contentDisposition: "attachment",
					},
					body: bytes,
				}),
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const artifactPath = `/api/v1/projects/${fixture.host.projectId}/domains/${fixture.host.controlDomainId}/artifacts/${encodeURIComponent(
			artifactDigest,
		)}`;
		const aborted = new Promise<void>((resolve, reject) => {
			const clientRequest = http.request(
				{
					hostname: "127.0.0.1",
					port: gateway!.port,
					method: "GET",
					path: artifactPath,
					headers: {
						Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
						Cookie: cookie,
					},
				},
				(response) => {
					response.once("data", () => {
						response.destroy();
						clientRequest.destroy();
					});
					response.once("close", resolve);
					response.once("error", (error) => {
						if (
							(error as NodeJS.ErrnoException).code ===
							"ECONNRESET"
						) {
							resolve();
						} else {
							reject(error);
						}
					});
				},
			);
			clientRequest.once("error", (error) => {
				if (
					(error as NodeJS.ErrnoException).code !==
					"ECONNRESET"
				) {
					reject(error);
				}
			});
			clientRequest.end();
		});
		await aborted;

		const overview = await request(gateway, {
			path: "/api/v1/overview",
			cookie,
		});
		assert.equal(overview.status, 200);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: exact 100 MiB artifact crosses the real HTTP transport intact", async () => {
	const fixture = setup();
	const listenerId = "listener-artifact-100-mib";
	const keysetDigest = digest("artifact-100-mib-keyset");
	const body = Buffer.alloc(WEB_MAX_ARTIFACT_BYTES, 0x61);
	const bodyDigest = `sha256:${createHash("sha256")
		.update(body)
		.digest("hex")}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			handlers: {
				artifact: () => ({
					metadata: {
						digest: bodyDigest,
						size: body.byteLength,
						mediaType: "application/octet-stream",
						fileName: "exact-100-mib.bin",
						redactionClass: "project",
						contentDisposition: "attachment",
					},
					body,
				}),
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]?.split(";")[0];
		assert.ok(cookie);

		const result = await new Promise<{
			readonly status: number;
			readonly headers: http.IncomingHttpHeaders;
			readonly byteLength: number;
			readonly digest: string;
		}>((resolve, reject) => {
			const receivedHash = createHash("sha256");
			let byteLength = 0;
			const clientRequest = http.request(
				{
					hostname: "127.0.0.1",
					port: gateway!.port,
					method: "GET",
					path:
						`/api/v1/projects/${fixture.host.projectId}` +
						`/domains/${fixture.host.controlDomainId}` +
						`/artifacts/${encodeURIComponent(bodyDigest)}`,
					headers: {
						Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
						Cookie: cookie,
						Connection: "close",
					},
				},
				(response) => {
					response.on("data", (chunk) => {
						const bytes = Buffer.from(chunk);
						byteLength += bytes.byteLength;
						receivedHash.update(bytes);
					});
					response.once("end", () =>
						resolve({
							status: response.statusCode ?? 0,
							headers: response.headers,
							byteLength,
							digest: `sha256:${receivedHash.digest("hex")}`,
						}),
					);
					response.once("error", reject);
				},
			);
			clientRequest.once("error", reject);
			clientRequest.end();
		});
		assert.equal(result.status, 200);
		assert.equal(
			result.headers["content-length"],
			String(WEB_MAX_ARTIFACT_BYTES),
		);
		assert.equal(result.byteLength, WEB_MAX_ARTIFACT_BYTES);
		assert.equal(result.digest, bodyDigest);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: exact launch exchange, authenticated bootstrap/read, and logout", async () => {
	const fixture = setup();
	const listenerId = "listener-gateway-test";
	const digest = `sha256:${"a".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		const cursorCodec = createWebCursorCodec({
			key: Buffer.alloc(32, 29),
			listenerId,
		});
		const handlers = createWebReadHandlers(fixture.host, {
			cursorCodec,
		});
		gateway = await startWebGateway({
			host: fixture.host,
			handlers,
			listenerId,
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
			supportedFeatures: [
				"overview",
				"project-detail",
				"run-detail",
			],
			supportedCommands: [],
		});
		assert.match(
			gateway.launchUrl,
			/^http:\/\/[a-z2-7]{26}\.localhost:\d+\/#launch=[A-Za-z0-9_-]{43}$/u,
		);
		const wrongHost = await request(gateway, {
			path: "/api/v1/bootstrap",
			host: `localhost:${gateway.port}`,
		});
		assert.equal(wrongHost.status, 421);

		const wrongOrigin = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: `http://localhost:${gateway.port}`,
			body: { launchToken: gateway.launchToken },
		});
		assert.equal(wrongOrigin.status, 403);

		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		assert.equal(exchange.status, 200);
		assert.equal(
			Value.Check(WebSessionExchangeResponseSchema, exchange.body),
			true,
		);
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		assert.match(
			exchange.headers["set-cookie"]?.[0] ?? "",
			/HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800/u,
		);
		const csrf = (
			exchange.body as {
				data: { csrfToken: string };
			}
		).data.csrfToken;

		const bootstrap = await request(gateway, {
			path: "/api/v1/bootstrap",
			cookie,
		});
		assert.equal(bootstrap.status, 200);
		assert.equal(
			Value.Check(WebBootstrapResponseSchema, bootstrap.body),
			true,
		);
		assert.deepEqual(
			(
				bootstrap.body as {
					data: { supportedCommands: string[] };
				}
			).data.supportedCommands,
			[],
		);
		assert.equal(
			(bootstrap.body as { data: { pollingMinIntervalMs: number } })
				.data.pollingMinIntervalMs,
			3_000,
		);
		assert.equal(
			(bootstrap.body as { data: { csrfToken: string } }).data
				.csrfToken,
			csrf,
		);

		const overview = await request(gateway, {
			path: "/api/v1/overview",
			cookie,
		});
		assert.equal(overview.status, 200);
		assert.equal(
			Value.Check(WebOverviewResponseSchema, overview.body),
			true,
		);
		assert.equal(overview.headers["access-control-allow-origin"], undefined);
		assert.match(
				String(
					overview.headers[
						"content-security-policy"
					] ?? "",
				),
			/default-src 'self'/u,
		);
		const crossOriginGet = await request(gateway, {
			path: "/api/v1/overview",
			origin: `http://${gateway.hostNonce}.localhost:${gateway.port + 1}`,
			cookie,
		});
		assert.equal(crossOriginGet.status, 403);
		const crossSiteGet = await request(gateway, {
			path: "/api/v1/overview",
			cookie,
			secFetchSite: "cross-site",
		});
		assert.equal(crossSiteGet.status, 403);
		const alternateJsonMediaType = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/logout",
			origin: gateway.origin,
			cookie,
			csrf,
			contentType: "application/json; charset=utf-8",
			body: { csrfToken: csrf },
		});
		assert.equal(alternateJsonMediaType.status, 415);
		const optionsRequest = await request(gateway, {
			method: "OPTIONS",
			path: "/api/v1/bootstrap",
		});
		assert.equal(optionsRequest.status, 405);
		assert.equal(optionsRequest.headers.allow, "GET");
		assert.equal(
			optionsRequest.headers["access-control-allow-origin"],
			undefined,
		);

		const missingRun = await request(gateway, {
			method: "POST",
			path: `/api/v1/projects/${fixture.host.projectId}/domains/${fixture.host.controlDomainId}/runs/run-missing/replay`,
			origin: gateway.origin,
			cookie,
			csrf,
			body: {
				traceArtifactDigest: digest,
				overrides: [],
			},
		});
			assert.equal(missingRun.status, 409);
			assert.equal(
				(
					missingRun.body as {
						error: { code: string };
					}
				).error.code,
				"TF_FEATURE_REQUIRED",
			);

		const badCsrf = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/logout",
			origin: gateway.origin,
			cookie,
			csrf: "x".repeat(43),
			body: { csrfToken: "x".repeat(43) },
		});
		assert.equal(badCsrf.status, 403);
		const logout = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/logout",
			origin: gateway.origin,
			cookie,
			csrf,
			body: { csrfToken: csrf },
		});
		assert.equal(logout.status, 200);
		assert.match(
			logout.headers["set-cookie"]?.[0] ?? "",
			/Max-Age=0/u,
		);
		const afterLogout = await request(gateway, {
			path: "/api/v1/bootstrap",
			cookie,
		});
		assert.equal(afterLogout.status, 401);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: raw HTTP parser, framing, Expect, and Upgrade fail closed", async () => {
	const fixture = setup();
	const keysetDigest = digest("raw-http-keyset");
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-raw-http",
			requestBodyTimeoutMs: 50,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
		});
		const authority = `${gateway.hostNonce}.localhost:${gateway.port}`;
		assert.equal(gateway.server.maxHeadersCount, 65);
		assert.equal(gateway.server.headersTimeout, 10_000);
		assert.equal(gateway.server.requestTimeout, 30_000);
		assert.equal(gateway.server.keepAliveTimeout, 5_000);
		assert.equal(gateway.server.maxRequestsPerSocket, 100);

		const duplicateHost = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/bootstrap HTTP/1.1",
				`Host: ${authority}`,
				`Host: ${authority}`,
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(duplicateHost, /^HTTP\/1\.1 421 /u);
		assert.match(duplicateHost, /"code":"TF_INVALID_ARGUMENT"/u);
		for (const hostileHost of [
			`127.0.0.1:${gateway.port}`,
			`localhost:${gateway.port}`,
			`${gateway.hostNonce}.localhost:${gateway.port + 1}`,
			`${gateway.hostNonce}.localhost.evil:${gateway.port}`,
			`prefix-${gateway.hostNonce}.localhost:${gateway.port}`,
			`user@${authority}`,
			`[::1]:${gateway.port}`,
		]) {
			const rebinding = await rawSocketRequest(
				gateway,
				[
					"GET /api/v1/bootstrap HTTP/1.1",
					`Host: ${hostileHost}`,
					"Connection: close",
					"",
					"",
				].join("\r\n"),
			);
			assert.match(
				rebinding,
				/^HTTP\/1\.1 421 /u,
				`host was not rejected: ${hostileHost}`,
			);
		}
		const missingHost = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/bootstrap HTTP/1.1",
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(missingHost, /^HTTP\/1\.1 400 /u);

		const slowBody = await rawSocketRequest(
			gateway,
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Content-Length: 64",
				"Connection: keep-alive",
				"",
				"{",
			].join("\r\n"),
		);
		assert.match(slowBody, /^HTTP\/1\.1 408 /u);
		assert.match(slowBody, /Connection: close/iu);
		assert.match(
			slowBody,
			/"message":"Request body did not complete before the deadline."/u,
		);

		const duplicateLength = await rawSocketRequest(
			gateway,
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Content-Length: 2",
				"Content-Length: 2",
				"Connection: close",
				"",
				"{}",
			].join("\r\n"),
		);
		assert.match(duplicateLength, /^HTTP\/1\.1 400 /u);
		assert.match(duplicateLength, /Connection: close/iu);

		for (const [name, value] of [
			["Content-Type", "application/json"],
			["Cookie", "unrelated=value"],
			["Last-Event-ID", "cursor"],
			["Origin", gateway.origin],
			["Range", "bytes=0-1"],
			["Sec-Fetch-Dest", "empty"],
			["Sec-Fetch-Mode", "cors"],
			["Sec-Fetch-Site", "same-origin"],
			["X-Taskflow-CSRF", "token"],
			["X-Taskflow-Sensitive-Ack", "download"],
		] as const) {
			const duplicateControlHeader = await rawSocketRequest(
				gateway,
				[
					"GET /api/v1/bootstrap HTTP/1.1",
					`Host: ${authority}`,
					`${name}: ${value}`,
					`${name}: ${value}`,
					"Connection: close",
					"",
					"",
				].join("\r\n"),
			);
			assert.match(
				duplicateControlHeader,
				/^HTTP\/1\.1 400 /u,
				`duplicate ${name} was not rejected`,
			);
			assert.match(
				duplicateControlHeader,
				/"message":"Security-sensitive request headers must appear exactly once."/u,
			);
			assert.match(
				duplicateControlHeader,
				/Connection: close/iu,
			);
		}

		const ambiguousFraming = await rawSocketRequest(
			gateway,
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Content-Length: 2",
				"Transfer-Encoding: chunked",
				"Connection: close",
				"",
				"{}",
			].join("\r\n"),
		);
		assert.match(ambiguousFraming, /^HTTP\/1\.1 400 /u);
		assert.match(ambiguousFraming, /Connection: close/iu);

		const expect = await rawSocketRequest(
			gateway,
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Content-Length: 2",
				"Expect: 100-continue",
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(expect, /^HTTP\/1\.1 417 /u);
		assert.doesNotMatch(expect, /100 Continue/u);
		assert.match(expect, /"message":"Expect is not supported."/u);

		const upgrade = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/events HTTP/1.1",
				`Host: ${authority}`,
				"Connection: Upgrade",
				"Upgrade: websocket",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(upgrade, /^HTTP\/1\.1 400 /u);
		assert.doesNotMatch(upgrade, /^HTTP\/1\.1 101 /u);
		assert.match(upgrade, /"message":"HTTP Upgrade is not supported."/u);

		const oversizedHeader = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/bootstrap HTTP/1.1",
				`Host: ${authority}`,
				`X-Oversized: ${"a".repeat(17 * 1024)}`,
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(oversizedHeader, /^HTTP\/1\.1 431 /u);
		assert.match(oversizedHeader, /Content-Length: 0/iu);
		assert.doesNotMatch(oversizedHeader, /X-Oversized/iu);

		const malformed = await rawSocketRequest(
			gateway,
			[
				"G ET /api/v1/bootstrap HTTP/1.1",
				`Host: ${authority}`,
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(malformed, /^HTTP\/1\.1 400 /u);
		assert.match(malformed, /Content-Length: 0/iu);

		for (const hostileHeader of [
			"X-Obsolete: first\r\n second",
			"X-Control: before\u0000after",
			"Bad Header: value",
		]) {
			const rejected = await rawSocketRequest(
				gateway,
				[
					"GET /api/v1/bootstrap HTTP/1.1",
					`Host: ${authority}`,
					hostileHeader,
					"Connection: close",
					"",
					"",
				].join("\r\n"),
			);
			assert.match(
				rejected,
				/^HTTP\/1\.1 400 /u,
				`hostile header was not rejected: ${JSON.stringify(hostileHeader)}`,
			);
			assert.match(rejected, /Connection: close/iu);
		}

		const tooManyHeaders = await rawSocketRequest(
			gateway,
			[
				"GET /api/v1/bootstrap HTTP/1.1",
				`Host: ${authority}`,
				...Array.from(
					{ length: 64 },
					(_, index) => `X-Bounded-${index}: value`,
				),
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(tooManyHeaders, /^HTTP\/1\.1 431 /u);
		assert.match(
			tooManyHeaders,
			/"message":"Request contains too many headers."/u,
		);
		assert.match(tooManyHeaders, /Connection: close/iu);

		for (const malformedChunk of [
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Transfer-Encoding: chunked",
				"Connection: close",
				"",
				"not-hex",
				"{}",
				"0",
				"",
				"",
			].join("\r\n"),
			[
				"POST /api/v1/session/exchange HTTP/1.1",
				`Host: ${authority}`,
				`Origin: ${gateway.origin}`,
				"Content-Type: application/json",
				"Transfer-Encoding: gzip",
				"Connection: close",
				"",
				"{}",
			].join("\r\n"),
		]) {
			const rejected = await rawSocketRequest(
				gateway,
				malformedChunk,
			);
			assert.match(rejected, /^HTTP\/1\.1 400 /u);
			assert.match(rejected, /Connection: close/iu);
		}
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: max requests per keep-alive socket forces bounded connection rotation", async () => {
	const fixture = setup();
	const keysetDigest = digest("keep-alive-rotation-keyset");
	let gateway: WebGatewayHandle | undefined;
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-keep-alive-rotation",
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);

		// Production fixes this at 100. A lower value exercises the same Node
		// close-and-rotate behavior without issuing 101 requests.
		gateway.server.maxRequestsPerSocket = 2;
		const getOverview = () =>
			new Promise<{
				status: number;
				localPort: number | undefined;
				connection: string | undefined;
			}>((resolve, reject) => {
				const clientRequest = http.request(
					{
						hostname: "127.0.0.1",
						port: gateway!.port,
						method: "GET",
						path: "/api/v1/overview",
						agent,
						headers: {
							Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
							Cookie: cookie,
						},
					},
					(response) => {
						const localPort =
							response.socket.localPort;
						response.resume();
						response.once("end", () =>
							resolve({
								status:
									response.statusCode ??
									0,
								localPort,
								connection:
									typeof response
										.headers
										.connection ===
									"string"
										? response
												.headers
												.connection
										: undefined,
							}),
						);
					},
				);
				clientRequest.once("error", reject);
				clientRequest.end();
			});
		const first = await getOverview();
		const second = await getOverview();
		const third = await getOverview();
		assert.deepEqual(
			[first.status, second.status, third.status],
			[200, 200, 200],
		);
		assert.equal(first.localPort, second.localPort);
		assert.equal(second.connection, "close");
		assert.notEqual(third.localPort, second.localPort);
	} finally {
		agent.destroy();
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: verified static manifest serves only assets and known SPA routes", async () => {
	const fixture = setup();
	const keysetDigest = digest("content-keyset");
	const staticRoot = createStaticFixture(fixture.root, keysetDigest);
	fs.writeFileSync(
		path.join(staticRoot, "assets/unlisted-secret.txt"),
		"must never be served",
	);
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-static-assets",
			packageVersion: "0.3.0-beta.2",
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
			staticAssets: { root: staticRoot },
		});
		const shell = await requestRaw(gateway, {
			path: "/",
			accept: "text/html",
		});
		assert.equal(shell.status, 200);
		assert.match(shell.body.toString("utf8"), /id="root"/u);
		assert.equal(shell.headers["cache-control"], "no-store");
		assert.equal(shell.headers["set-cookie"], undefined);
		assert.equal(
			shell.headers["content-length"],
			String(shell.body.byteLength),
		);
			assert.match(
				String(
					shell.headers[
						"content-security-policy"
					] ?? "",
				),
			/default-src 'none'; script-src 'self'/u,
		);
			assert.match(
				String(
					shell.headers[
						"permissions-policy"
					] ?? "",
				),
			/camera=\(\)/u,
		);

		const deepLink = await requestRaw(gateway, {
			path: "/workspaces/project-a/domains/domain-a/tasks/run-a?view=pro",
			accept: "*/*",
		});
		assert.equal(deepLink.status, 200);
		assert.deepEqual(deepLink.body, shell.body);
		const absentAccept = await requestRaw(gateway, {
			path: "/settings",
		});
		assert.equal(absentAccept.status, 200);
		assert.deepEqual(absentAccept.body, shell.body);
		const shellHead = await requestRaw(gateway, {
			method: "HEAD",
			path: "/settings",
			accept: "text/html",
		});
		assert.equal(shellHead.status, 200);
		assert.equal(shellHead.body.byteLength, 0);
		assert.equal(shellHead.headers["content-length"], shell.headers["content-length"]);

		const asset = await requestRaw(gateway, {
			path: "/assets/app-a1b2c3.js",
		});
		assert.equal(asset.status, 200);
		assert.equal(
			asset.headers["cache-control"],
			"public, max-age=31536000, immutable",
		);
		assert.equal(
			asset.headers["content-type"],
			"text/javascript; charset=utf-8",
		);
		for (const unservablePath of [
			"/assets/",
			"/assets/unlisted-secret.txt",
			"/assets/app-a1b2c3.js.map",
		]) {
			const unservable = await requestRaw(gateway, {
				path: unservablePath,
			});
			assert.equal(
				unservable.status,
				404,
				`filesystem fallback exposed ${unservablePath}`,
			);
		}

		const head = await requestRaw(gateway, {
			method: "HEAD",
			path: "/assets/app-a1b2c3.js",
		});
		assert.equal(head.status, 200);
		assert.equal(head.body.byteLength, 0);
		assert.equal(head.headers["content-length"], asset.headers["content-length"]);

		const explicitDeny = await requestRaw(gateway, {
			path: "/",
			accept: "text/html;q=0, */*;q=1",
		});
		assert.equal(explicitDeny.status, 406);
		assert.doesNotMatch(explicitDeny.body.toString("utf8"), /id="root"/u);
		const jsonOnly = await requestRaw(gateway, {
			path: "/",
			accept: "application/json",
		});
		assert.equal(jsonOnly.status, 406);
		const wildcardText = await requestRaw(gateway, {
			path: "/",
			accept: "text/*;q=0.4, */*;q=0",
		});
		assert.equal(wildcardText.status, 200);
		const specificAllowance = await requestRaw(gateway, {
			path: "/",
			accept: "text/html;q=0.1, */*;q=0",
		});
		assert.equal(specificAllowance.status, 200);
		const caseInsensitive = await requestRaw(gateway, {
			path: "/",
			accept: "TEXT/HTML;Q=0.5",
		});
		assert.equal(caseInsensitive.status, 200);
		const invalidAccept = await requestRaw(gateway, {
			path: "/",
			accept: "text/html;q=1.0000",
		});
		assert.equal(invalidAccept.status, 400);
		for (const accept of [
			"text/html;q=0.5;q=0.7",
			"text /html",
			"*/html",
			"text/html;q=.5",
			"text/html;q=01",
			"text/html;q=bogus",
		]) {
			const malformedAccept = await requestRaw(gateway, {
				path: "/",
				accept,
			});
			assert.equal(
				malformedAccept.status,
				400,
				`malformed Accept was not rejected: ${accept}`,
			);
		}
		const multipleAccept = await rawSocketRequest(
			gateway,
			[
				"GET /settings HTTP/1.1",
				`Host: ${gateway.hostNonce}.localhost:${gateway.port}`,
				"Accept: application/json",
				"Accept: text/html;q=0.8",
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		assert.match(multipleAccept, /^HTTP\/1\.1 200 /u);
		assert.match(multipleAccept, /id="root"/u);
		const wrongMethod = await requestRaw(gateway, {
			method: "POST",
			path: "/settings",
			accept: "text/html",
		});
		assert.equal(wrongMethod.status, 405);
		assert.equal(wrongMethod.headers.allow, "GET, HEAD");
		const unknown = await requestRaw(gateway, {
			path: "/not-a-route",
			accept: "text/html",
		});
		assert.equal(unknown.status, 404);
		assert.doesNotMatch(unknown.body.toString("utf8"), /id="root"/u);
		const unknownApi = await requestRaw(gateway, {
			path: "/api/v1/not-a-route",
			accept: "text/html",
		});
		assert.equal(unknownApi.status, 404);
		assert.doesNotMatch(unknownApi.body.toString("utf8"), /id="root"/u);
		const traversal = await requestRaw(gateway, {
			path: "/assets/%2e%2e/index.html",
		});
		assert.equal(traversal.status, 400);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: static integrity mismatch fails before opening a listener", async () => {
	const fixture = setup();
	const keysetDigest = digest("content-keyset-tamper");
	const staticRoot = createStaticFixture(fixture.root, keysetDigest);
	try {
		fs.appendFileSync(path.join(staticRoot, "assets/app-a1b2c3.js"), "tamper");
		await assert.rejects(
			() =>
				startWebGateway({
					host: fixture.host,
					packageVersion: "0.3.0-beta.2",
					contentKeysetDigests: {
						projected: keysetDigest,
						static: keysetDigest,
						combined: keysetDigest,
					},
					staticAssets: { root: staticRoot },
				}),
			/asset (?:size|digest) mismatch/u,
		);
	} finally {
		fixture.cleanup();
	}
});

test("WebGateway: hostile or mixed static packages fail before listener startup", () => {
	const fixture = setup();
	const keysetDigest = digest("hostile-static-keyset");
	try {
		const mixedVersion = createStaticFixture(
			path.join(fixture.root, "mixed-version"),
			keysetDigest,
		);
		assert.throws(
			() =>
				loadStaticFixture(
					mixedVersion,
					keysetDigest,
					"0.3.0-beta.3",
				),
			/web\/daemon package mismatch/u,
		);

		const mixedCatalog = createStaticFixture(
			path.join(fixture.root, "mixed-catalog"),
			keysetDigest,
		);
		assert.throws(
			() =>
				loadStaticFixture(
					mixedCatalog,
					digest("different-keyset"),
				),
			/content keysets are incompatible/u,
		);

		const unknownField = createStaticFixture(
			path.join(fixture.root, "unknown-field"),
			keysetDigest,
		);
		mutateStaticManifest(unknownField, (manifest) => {
			manifest.futureAuthority = true;
		});
		assert.throws(
			() => loadStaticFixture(unknownField, keysetDigest),
			/manifest failed schema/u,
		);

		const unsorted = createStaticFixture(
			path.join(fixture.root, "unsorted"),
			keysetDigest,
		);
		mutateStaticManifest(unsorted, (manifest) => {
			(manifest.assets as unknown[]).reverse();
		});
		assert.throws(
			() => loadStaticFixture(unsorted, keysetDigest),
			/manifest assets must be unique and sorted/u,
		);

		const routeDigest = createStaticFixture(
			path.join(fixture.root, "route-digest"),
			keysetDigest,
		);
		mutateStaticManifest(routeDigest, (manifest) => {
			(
				manifest.routeRegistry as Record<string, unknown>
			).sha256 = digest("wrong-route-registry");
		});
		assert.throws(
			() => loadStaticFixture(routeDigest, keysetDigest),
			/route registry digest mismatch/u,
		);

		const catalogBinding = createStaticFixture(
			path.join(fixture.root, "catalog-binding"),
			keysetDigest,
		);
		mutateStaticManifest(catalogBinding, (manifest) => {
			const catalogs = (
				manifest.contentCatalogs as {
					catalogs: Array<Record<string, unknown>>;
				}
			).catalogs;
			catalogs[0]!.sha256 = digest("wrong-catalog");
		});
		assert.throws(
			() =>
				loadStaticFixture(
					catalogBinding,
					keysetDigest,
				),
			/content catalog is not bound/u,
		);

		const sourceMap = createStaticFixture(
			path.join(fixture.root, "source-map"),
			keysetDigest,
		);
		const appPath = path.join(
			sourceMap,
			"assets/app-a1b2c3.js",
		);
		const appBytes = Buffer.concat([
			fs.readFileSync(appPath),
			Buffer.from("//# sourceMappingURL=app.js.map\n", "utf8"),
		]);
		fs.writeFileSync(appPath, appBytes);
		mutateStaticManifest(sourceMap, (manifest) => {
			const app = (
				manifest.assets as Array<Record<string, unknown>>
			).find(
				(asset) =>
					asset.path === "assets/app-a1b2c3.js",
			);
			assert.ok(app);
			app.size = appBytes.byteLength;
			app.sha256 = digest(appBytes);
		});
		assert.throws(
			() => loadStaticFixture(sourceMap, keysetDigest),
			/source map material is forbidden/u,
		);

		const symlink = createStaticFixture(
			path.join(fixture.root, "symlink"),
			keysetDigest,
		);
		const linkedApp = path.join(
			symlink,
			"assets/app-a1b2c3.js",
		);
		const target = path.join(
			symlink,
			"assets/target.js",
		);
		fs.renameSync(linkedApp, target);
		fs.symlinkSync("target.js", linkedApp);
		assert.throws(
			() => loadStaticFixture(symlink, keysetDigest),
			/asset path contains a symlink/u,
		);

		const rootTarget = createStaticFixture(
			path.join(fixture.root, "root-target"),
			keysetDigest,
		);
		const rootSymlink = path.join(fixture.root, "root-symlink");
		fs.symlinkSync(rootTarget, rootSymlink, "dir");
		assert.throws(
			() => loadStaticFixture(rootSymlink, keysetDigest),
			/web asset root must be a real directory/u,
		);

		const manifestSymlink = createStaticFixture(
			path.join(fixture.root, "manifest-symlink"),
			keysetDigest,
		);
		const manifestPath = path.join(
			manifestSymlink,
			"taskflow-web-assets.json",
		);
		const manifestTarget = path.join(
			manifestSymlink,
			"manifest-target.json",
		);
		fs.renameSync(manifestPath, manifestTarget);
		fs.symlinkSync("manifest-target.json", manifestPath);
		assert.throws(
			() => loadStaticFixture(manifestSymlink, keysetDigest),
			/web asset manifest must be a regular file/u,
		);

		const entrypointSymlink = createStaticFixture(
			path.join(fixture.root, "entrypoint-symlink"),
			keysetDigest,
		);
		const entrypoint = path.join(entrypointSymlink, "index.html");
		const entrypointTarget = path.join(
			entrypointSymlink,
			"index-target.html",
		);
		fs.renameSync(entrypoint, entrypointTarget);
		fs.symlinkSync("index-target.html", entrypoint);
		assert.throws(
			() => loadStaticFixture(entrypointSymlink, keysetDigest),
			/asset path contains a symlink/u,
		);

		const parentSymlink = createStaticFixture(
			path.join(fixture.root, "parent-symlink"),
			keysetDigest,
		);
		const assetsPath = path.join(parentSymlink, "assets");
		const assetsTarget = path.join(parentSymlink, "real-assets");
		fs.renameSync(assetsPath, assetsTarget);
		fs.symlinkSync("real-assets", assetsPath, "dir");
		assert.throws(
			() => loadStaticFixture(parentSymlink, keysetDigest),
			/asset path contains a symlink/u,
		);

		const directoryAsset = createStaticFixture(
			path.join(fixture.root, "directory-asset"),
			keysetDigest,
		);
		const directoryAssetPath = path.join(
			directoryAsset,
			"assets/app-a1b2c3.js",
		);
		fs.unlinkSync(directoryAssetPath);
		fs.mkdirSync(directoryAssetPath);
		assert.throws(
			() => loadStaticFixture(directoryAsset, keysetDigest),
			/asset is not a regular file/u,
		);

		for (const [name, hostilePath] of [
			["parent-path", "../outside.js"],
			["absolute-path", "/tmp/outside.js"],
			["backslash-path", "assets\\outside.js"],
		] as const) {
			const hostileManifest = createStaticFixture(
				path.join(fixture.root, name),
				keysetDigest,
			);
			mutateStaticManifest(hostileManifest, (manifest) => {
				(
					manifest.assets as Array<Record<string, unknown>>
				)[0]!.path = hostilePath;
			});
			assert.throws(
				() => loadStaticFixture(hostileManifest, keysetDigest),
				/manifest failed schema/u,
			);
		}

		const duplicateAsset = createStaticFixture(
			path.join(fixture.root, "duplicate-asset"),
			keysetDigest,
		);
		mutateStaticManifest(duplicateAsset, (manifest) => {
			const assets = manifest.assets as Array<Record<string, unknown>>;
			assets.splice(1, 0, { ...assets[0]! });
		});
		assert.throws(
			() => loadStaticFixture(duplicateAsset, keysetDigest),
			/manifest assets must be unique and sorted/u,
		);

		const duplicateRoute = createStaticFixture(
			path.join(fixture.root, "duplicate-route"),
			keysetDigest,
		);
		mutateStaticManifest(duplicateRoute, (manifest) => {
			const registry = manifest.routeRegistry as {
				patterns: Array<Record<string, unknown>>;
				sha256: string;
			};
			const settings = registry.patterns.find(
				(route) => route.id === "settings",
			);
			assert.ok(settings);
			registry.patterns.push({
				...settings,
				id: "settings-copy",
				tokens: structuredClone(settings.tokens),
			});
			registry.patterns.sort((left, right) =>
				String(left.id).localeCompare(String(right.id), "en"),
			);
			registry.sha256 = digest(
				Buffer.from(canonical(registry.patterns), "utf8"),
			);
		});
		assert.throws(
			() => loadStaticFixture(duplicateRoute, keysetDigest),
			/route token patterns must be unique and sorted/u,
		);

		const duplicateCatalogPath = createStaticFixture(
			path.join(fixture.root, "duplicate-catalog"),
			keysetDigest,
		);
		mutateStaticManifest(duplicateCatalogPath, (manifest) => {
			const catalogs = (
				manifest.contentCatalogs as {
					catalogs: Array<Record<string, unknown>>;
				}
			).catalogs;
			catalogs[1] = {
				...catalogs[1]!,
				path: catalogs[0]!.path,
				sha256: catalogs[0]!.sha256,
				size: catalogs[0]!.size,
			};
		});
		assert.throws(
			() => loadStaticFixture(duplicateCatalogPath, keysetDigest),
			/content catalog paths must be unique and sorted/u,
		);
	} finally {
		fixture.cleanup();
	}
});

test("WebGateway: generated query decoding rejects unknown/scalar duplicates and accepts arrays", async () => {
	const fixture = setup();
	const listenerId = "listener-gateway-query";
	const digest = `sha256:${"b".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			handlers: createWebReadHandlers(fixture.host, {
				cursorCodec: createWebCursorCodec({
					key: Buffer.alloc(32, 31),
					listenerId,
				}),
			}),
			listenerId,
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const accepted = await request(gateway, {
			path: "/api/v1/runs?statuses=running&statuses=paused&limit=2",
			cookie,
		});
		assert.equal(accepted.status, 200);
		const duplicateScalar = await request(gateway, {
			path: "/api/v1/runs?limit=1&limit=2",
			cookie,
		});
		assert.equal(duplicateScalar.status, 400);
			const unknown = await request(gateway, {
				path: "/api/v1/runs?rawPath=%2Fetc%2Fpasswd",
				cookie,
			});
			assert.equal(unknown.status, 400);
			const unsafeInteger = await request(gateway, {
				path:
					`/api/v1/projects/${fixture.host.projectId}` +
					`/domains/${fixture.host.controlDomainId}` +
					"/runs/run-1/timeline?expectedRunVersion=9007199254740992",
				cookie,
			});
			assert.equal(unsafeInteger.status, 400);
		} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: all 29 registered route slots and explicitly enabled durable command recovery", async () => {
	const fixture = setup();
	const digest = `sha256:${"c".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		assert.equal(
			new Set(WEB_IMPLEMENTED_GATEWAY_ENDPOINT_IDS).size,
			29,
		);
		assert.deepEqual(
			Object.keys(WEB_ENDPOINTS).filter(
				(endpointId) =>
					!(
						WEB_IMPLEMENTED_GATEWAY_ENDPOINT_IDS as readonly string[]
					).includes(endpointId),
			),
			[],
		);
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-gateway-default",
			supportedCommands: ["set-max-active-runs"],
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		assert.equal(exchange.status, 200);
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const csrf = (
			exchange.body as {
				data: { csrfToken: string };
			}
		).data.csrfToken;

		const bootstrap = await request(gateway, {
			path: "/api/v1/bootstrap",
			cookie,
		});
		assert.equal(bootstrap.status, 200);
		assert.deepEqual(
			(
				bootstrap.body as {
					data: {
						supportedFeatures: string[];
						supportedCommands: string[];
					};
				}
			).data.supportedFeatures,
			[...WEB_DEFAULT_IMPLEMENTED_FEATURES].sort(
				(left, right) =>
					left.localeCompare(right, "en"),
			),
		);
		assert.deepEqual(
			(
				bootstrap.body as {
					data: { supportedCommands: string[] };
				}
			).data.supportedCommands,
			["set-max-active-runs"],
		);

		const commandBody = {
			commandId: "cmd-http-capacity",
			kind: "set-max-active-runs",
			value: 7,
			expectedMaxActiveRuns: 4,
			expectedCoordinatorEpoch: 0,
		};
		const submitted = await request(gateway, {
			method: "POST",
			path: "/api/v1/commands",
			origin: gateway.origin,
			cookie,
			csrf,
			body: commandBody,
		});
		assert.equal(submitted.status, 200);
		assert.equal(
			Value.Check(
				WebCommandResponseSchema,
				submitted.body,
			),
			true,
		);
		assert.equal(
			(
				submitted.body as {
					data: { status: string };
				}
			).data.status,
			"completed",
		);

		const recovered = await request(gateway, {
			path: `/api/v1/commands/${commandBody.commandId}`,
			cookie,
		});
		assert.equal(recovered.status, 200);
		const recoveredData = (
			recovered.body as {
				data: Record<string, unknown>;
			}
		).data;
		const submittedData = (
			submitted.body as {
				data: Record<string, unknown>;
			}
		).data;
		assert.deepEqual(
			{
				...recoveredData,
				observedAt: undefined,
			},
			{
				...submittedData,
				observedAt: undefined,
			},
		);
		assert.ok(
			Number(recoveredData.observedAt) >=
				Number(submittedData.observedAt),
		);

		const conflict = await request(gateway, {
			method: "POST",
			path: "/api/v1/commands",
			origin: gateway.origin,
			cookie,
			csrf,
			body: { ...commandBody, value: 8 },
		});
		assert.equal(conflict.status, 409);
		assert.equal(
			(
				conflict.body as {
					error: { code: string };
				}
			).error.code,
			"TF_IDEMPOTENCY_CONFLICT",
		);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: artifact bytes require current reachability, redaction acknowledgement, and verified snapshot", async () => {
	const fixture = setup();
	const catalogDigest = `sha256:${"d".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		const admitted = await fixture.host.admitAndRun({
			commandId: "cmd-http-artifact",
			program: {
				name: "http-artifact",
				phases: [
					{
						id: "result",
						type: "script",
						run: "printf gateway-artifact",
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true);
		const artifactId =
			admitted.receipt?.artifactRefs[0];
		assert.ok(artifactId);
		const artifact =
			fixture.host.store.getArtifact(artifactId);
		assert.ok(artifact);
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-gateway-artifact",
			contentKeysetDigests: {
				projected: catalogDigest,
				static: catalogDigest,
				combined: catalogDigest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const artifactPath = `/api/v1/projects/${fixture.host.projectId}/domains/${fixture.host.controlDomainId}/artifacts/${encodeURIComponent(
			artifact!.digest,
		)}`;
		const disclosed = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
		});
		assert.equal(disclosed.status, 200);
		assert.equal(
			disclosed.body.toString("utf8"),
			admitted.run!.finalOutput,
		);
		assert.equal(
			disclosed.headers["content-type"],
			"text/plain; charset=utf-8",
		);
		assert.match(
			disclosed.headers["content-disposition"] ?? "",
			/^inline; filename="[A-Za-z0-9._ -]+"$/u,
		);
		assert.equal(
			disclosed.headers.etag,
			`"${artifact!.digest}"`,
		);
		assert.equal(
			disclosed.headers["content-security-policy"],
			"default-src 'none'; sandbox",
		);
		assert.equal(
			disclosed.headers["x-taskflow-redaction-class"],
			"project",
		);

		const range = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
			range: "bytes=0-3",
		});
		assert.equal(range.status, 416);
		assert.equal(
			range.headers["content-type"],
			"application/json; charset=utf-8",
		);

		const metadataPath = path.join(
			projectArtifactMetadataDir(
				fixture.host.store.projectRoot,
			),
			`${artifactId}.json`,
		);
		const metadata = JSON.parse(
			fs.readFileSync(metadataPath, "utf8"),
		) as Record<string, unknown>;
		fs.writeFileSync(
			metadataPath,
			JSON.stringify({
				...metadata,
				redactionClass: "sensitive",
			}),
		);
		const missingAck = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
		});
		assert.equal(missingAck.status, 403);
		const acknowledged = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
			sensitiveAck: "download",
		});
		assert.equal(acknowledged.status, 200);
			assert.equal(
				acknowledged.headers[
					"x-taskflow-redaction-class"
				],
				"sensitive",
			);
			assert.match(
				acknowledged.headers["content-disposition"] ?? "",
				/^attachment;/u,
			);

			fs.writeFileSync(
				metadataPath,
				JSON.stringify({
					...metadata,
					mediaType: "text/html; charset=utf-8",
					fileName:
						"../../report\u202Ecod.exe\"\r\nInjected",
				}),
			);
			const hostileMetadata = await requestBytes(gateway, {
				path: artifactPath,
				cookie,
			});
			assert.equal(hostileMetadata.status, 200);
			assert.equal(
				hostileMetadata.headers["content-type"],
				"application/octet-stream",
			);
			assert.match(
				hostileMetadata.headers[
					"content-disposition"
				] ?? "",
				/^attachment; filename="[A-Za-z0-9._ -]{1,160}"$/u,
			);
			assert.doesNotMatch(
				hostileMetadata.headers[
					"content-disposition"
				] ?? "",
				/[/\\\r\n\u202A-\u202E\u2066-\u2069]/u,
			);

			fs.writeFileSync(
				metadataPath,
				JSON.stringify(metadata),
		);
		fs.writeFileSync(
			path.join(
				projectArtifactBlobsDir(
					fixture.host.store.projectRoot,
				),
				artifact!.digest.slice("sha256:".length),
			),
			"tampered",
		);
		const tampered = await requestBytes(gateway, {
			path: artifactPath,
			cookie,
		});
		assert.equal(tampered.status, 503);
		assert.equal(
			tampered.headers["content-type"],
			"application/json; charset=utf-8",
		);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: SSE emits exact framing and rejects conflicting resume cursors", async () => {
	const fixture = setup();
	const digest = `sha256:${"d".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-gateway-sse",
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);

		const stream = await firstSseFrame(gateway, {
			cookie,
		});
		assert.equal(stream.status, 200);
		assert.equal(
			stream.headers["content-type"],
			"text/event-stream; charset=utf-8",
		);
		assert.equal(
			stream.headers["cache-control"],
			"no-store, no-transform",
		);
		assert.equal(
			stream.headers["content-encoding"],
			"identity",
		);
		assert.match(stream.text, /^retry: 3000\n\n/u);
		const dataLine = stream.text
			.split("\n")
			.find((line) => line.startsWith("data: "));
		assert.ok(dataLine);
		const frame = JSON.parse(
			dataLine.slice("data: ".length),
		) as {
			type: string;
			id: string;
			cursor: string;
		};
		assert.equal(frame.type, "checkpoint");
		assert.equal(frame.id, frame.cursor);
		assert.match(
			stream.text,
			new RegExp(
				`id: ${frame.id}\\nevent: taskflow\\ndata: `,
				"u",
			),
		);

		const conflict = await request(gateway, {
			path: `/api/v1/events?cursor=${encodeURIComponent(frame.cursor)}`,
			cookie,
			lastEventId: `${frame.cursor}x`,
		});
		assert.equal(conflict.status, 400);
		assert.equal(
			(
				conflict.body as {
					error: { code: string };
				}
			).error.code,
			"TF_INVALID_ARGUMENT",
		);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: SSE closes at the authenticated session absolute expiry", async () => {
	const fixture = setup();
	const keysetDigest = digest("sse-session-expiry-keyset");
	let currentTime = 1_800_000_000_000;
	let gateway: WebGatewayHandle | undefined;
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-sse-session-expiry",
			now: () => currentTime,
			contentKeysetDigests: {
				projected: keysetDigest,
				static: keysetDigest,
				combined: keysetDigest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const absoluteExpiresAt = (
			exchange.body as {
				data: { absoluteExpiresAt: number };
			}
		).data.absoluteExpiresAt;

		const refreshStepMs = 29 * 60_000;
		while (
			absoluteExpiresAt - currentTime >
			refreshStepMs + 50
		) {
			currentTime += refreshStepMs;
			const refresh = await request(gateway, {
				path: "/api/v1/overview",
				cookie,
			});
			assert.equal(refresh.status, 200);
		}
		currentTime = absoluteExpiresAt - 50;
		const streamStartedAt = Date.now();
		const closed = await new Promise<{
			status: number;
			sawCheckpoint: boolean;
		}>((resolve, reject) => {
			let responseStatus = 0;
			let text = "";
			let sawResponse = false;
			const clientRequest = http.request(
				{
					hostname: "127.0.0.1",
					port: gateway!.port,
					method: "GET",
					path: "/api/v1/events",
					headers: {
						Host: `${gateway!.hostNonce}.localhost:${gateway!.port}`,
						Cookie: cookie,
					},
				},
				(response) => {
					sawResponse = true;
					responseStatus = response.statusCode ?? 0;
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						text += chunk;
					});
					response.once("close", () =>
						resolve({
							status: responseStatus,
							sawCheckpoint:
								text.includes(
									"event: taskflow",
								) &&
								text.includes(
									'"type":"checkpoint"',
								),
						}),
					);
					response.once("error", (error) => {
						if (
							(error as NodeJS.ErrnoException)
								.code !== "ECONNRESET"
						) {
							reject(error);
						}
					});
				},
			);
			clientRequest.once("error", (error) => {
				if (
					!sawResponse ||
					(error as NodeJS.ErrnoException).code !==
						"ECONNRESET"
				) {
					reject(error);
				}
			});
			clientRequest.end();
		});
		assert.equal(closed.status, 200);
		assert.equal(closed.sawCheckpoint, true);
		assert.ok(Date.now() - streamStartedAt < 1_000);

		currentTime = absoluteExpiresAt + 1;
		const expired = await request(gateway, {
			path: "/api/v1/bootstrap",
			cookie,
		});
		assert.equal(expired.status, 401);
	} finally {
		await gateway?.stop();
		fixture.cleanup();
	}
});

test("WebGateway: SSE enforces four streams and rejects line-injected frames before headers", async () => {
	const fixture = setup();
	const digest = `sha256:${"e".repeat(64)}`;
	let gateway: WebGatewayHandle | undefined;
	const held: Array<{ close(): void }> = [];
	try {
		gateway = await startWebGateway({
			host: fixture.host,
			listenerId: "listener-gateway-sse-capacity",
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
		});
		const exchange = await request(gateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: gateway.origin,
			body: { launchToken: gateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		for (let index = 0; index < 4; index += 1) {
			const stream = await holdSseStream(gateway, cookie);
			assert.equal(stream.status, 200);
			assert.match(stream.text, /event: taskflow/u);
			held.push(stream);
		}
		const fifth = await request(gateway, {
			path: "/api/v1/events",
			cookie,
		});
		assert.equal(fifth.status, 429);
		assert.equal(fifth.headers["retry-after"], "1");
		assert.equal(
			(
				fifth.body as {
					error: { code: string };
				}
			).error.code,
			"TF_CAPACITY_EXCEEDED",
		);
	} finally {
		for (const stream of held) stream.close();
		await gateway?.stop();
		fixture.cleanup();
	}

	const maliciousFixture = setup();
	let maliciousGateway: WebGatewayHandle | undefined;
	try {
		maliciousGateway = await startWebGateway({
			host: maliciousFixture.host,
			listenerId: "listener-gateway-sse-injection",
			contentKeysetDigests: {
				projected: digest,
				static: digest,
				combined: digest,
			},
			handlers: {
				events: () =>
					(async function* injected() {
						yield {
							type: "heartbeat",
							id: "valid\nid: forged",
							cursor: "valid\nid: forged",
							observedAt: Date.now(),
						};
					})(),
			},
		});
		const exchange = await request(maliciousGateway, {
			method: "POST",
			path: "/api/v1/session/exchange",
			origin: maliciousGateway.origin,
			body: { launchToken: maliciousGateway.launchToken },
		});
		const cookie = exchange.headers["set-cookie"]?.[0]
			?.split(";")[0];
		assert.ok(cookie);
		const rejected = await request(maliciousGateway, {
			path: "/api/v1/events",
			cookie,
		});
		assert.equal(rejected.status, 500);
		assert.equal(
			rejected.headers["content-type"],
			"application/json; charset=utf-8",
		);
		assert.doesNotMatch(JSON.stringify(rejected.body), /id: forged/u);
	} finally {
		await maliciousGateway?.stop();
		maliciousFixture.cleanup();
	}
});
