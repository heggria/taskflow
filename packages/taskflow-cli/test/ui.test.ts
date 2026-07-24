import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	projectWebUiSocketPath,
	singletonLockPath,
	udsPath,
} from "taskflow-control";
import {
	startUiCommand,
	type UiCommandHandle,
} from "../src/ui.ts";

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonical(record[key])}`,
		)
		.join(",")}}`;
}

function digest(value: string | Buffer): string {
	return `sha256:${createHash("sha256")
		.update(value)
		.digest("hex")}`;
}

function createStaticFixture(root: string): {
	readonly staticRoot: string;
	readonly keysetDigest: string;
} {
	const staticRoot = path.join(root, "web");
	const assetsRoot = path.join(staticRoot, "assets");
	fs.mkdirSync(assetsRoot, { recursive: true });
	const files = {
		"assets/app-a1b2c3.js": Buffer.from(
			"document.title='Taskflow';\n",
			"utf8",
		),
		"assets/content-en-a1b2c3.json": Buffer.from(
			'{"locale":"en"}\n',
			"utf8",
		),
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
		{
			id: "settings",
			tokens: [
				{ kind: "literal", value: "settings" },
			],
		},
		{
			id: "task",
			tokens: [
				{
					kind: "literal",
					value: "workspaces",
				},
				{ kind: "safe-id", name: "projectId" },
				{ kind: "literal", value: "domains" },
				{
					kind: "safe-id",
					name: "controlDomainId",
				},
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
		.sort((left, right) =>
			left.path.localeCompare(right.path, "en"),
		);
	const keysetDigest = digest("ui-test-content-keys");
	const manifest = {
		manifestVersion: "taskflow-web-assets.v1",
		packageVersion: "0.3.0-beta.2",
		webBuildId: digest("ui-cli-static-fixture"),
		protocolConsumer: {
			major: 1,
			minMinor: 0,
			maxMinor: 0,
		},
		entrypoint: {
			path: "index.html",
			sha256: digest(index),
		},
		assets: rows,
		routeRegistry: {
			version: "taskflow-web-routes.v1",
			patterns,
			sha256: digest(
				Buffer.from(canonical(patterns), "utf8"),
			),
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
					sha256: digest(
						files[
							"assets/content-en-a1b2c3.json"
						],
					),
					size: files[
						"assets/content-en-a1b2c3.json"
					].byteLength,
				},
				{
					locale: "zh-CN",
					path: "assets/content-zh-cn-a1b2c3.json",
					sha256: digest(
						files[
							"assets/content-zh-cn-a1b2c3.json"
						],
					),
					size: files[
						"assets/content-zh-cn-a1b2c3.json"
					].byteLength,
				},
			],
		},
	};
	fs.writeFileSync(
		path.join(staticRoot, "taskflow-web-assets.json"),
		`${canonical(manifest)}\n`,
	);
	return { staticRoot, keysetDigest };
}

function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-ui-cli-"),
	);
	const home = path.join(root, "home");
	const firstProject = path.join(root, "project-a");
	const secondProject = path.join(root, "project-b");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(firstProject, { recursive: true });
	fs.mkdirSync(secondProject, { recursive: true });
	const staticFixture = createStaticFixture(root);
	const env = {
		...process.env,
		TASKFLOW_HOME: home,
		TASKFLOW_WEB_ASSETS_ROOT:
			staticFixture.staticRoot,
	};
	return {
		root,
		home,
		firstProject,
		secondProject,
		env,
		cleanup() {
			fs.rmSync(root, {
				recursive: true,
				force: true,
			});
		},
	};
}

function launchResult(handle: UiCommandHandle) {
	assert.equal(handle.result.action, "launch");
	if (handle.result.action !== "launch") {
		throw new Error("expected launch result");
	}
	return handle.result;
}

async function waitForStop(handle: UiCommandHandle): Promise<void> {
	await Promise.race([
		handle.stopped,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							"UI owner did not stop within 5 seconds",
						),
					),
				5_000,
			);
			timer.unref();
		}),
	]);
}

function request(
	origin: string,
	input: {
		readonly method?: string;
		readonly path: string;
		readonly cookie?: string;
		readonly body?: unknown;
	},
): Promise<{
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: unknown;
}> {
	const url = new URL(origin);
	const encoded =
		input.body === undefined
			? undefined
			: Buffer.from(JSON.stringify(input.body), "utf8");
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: Number(url.port),
				method: input.method ?? "GET",
				path: input.path,
				headers: {
					Host: url.host,
					Origin: origin,
					Accept: "application/json",
					Connection: "close",
					...(input.cookie
						? { Cookie: input.cookie }
						: {}),
					...(encoded
						? {
								"Content-Type":
									"application/json",
								"Content-Length": String(
									encoded.byteLength,
								),
							}
						: {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) =>
					chunks.push(Buffer.from(chunk)),
				);
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString(
						"utf8",
					);
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: text ? JSON.parse(text) : null,
					});
				});
			},
		);
		req.once("error", reject);
		if (encoded) req.write(encoded);
		req.end();
	});
}

async function exchangeLaunch(launchUrl: string): Promise<{
	readonly origin: string;
	readonly cookie: string;
}> {
	const url = new URL(launchUrl);
	const launchToken = new URLSearchParams(
		url.hash.slice(1),
	).get("launch");
	assert.ok(launchToken);
	const origin = url.origin;
	const exchanged = await request(origin, {
		method: "POST",
		path: "/api/v1/session/exchange",
		body: { launchToken },
	});
	assert.equal(exchanged.status, 200);
	const setCookie = exchanged.headers["set-cookie"]?.[0];
	assert.ok(setCookie);
	return {
		origin,
		cookie: setCookie.split(";", 1)[0]!,
	};
}

test("taskflow ui: coordinated calls reuse one writer/listener and --stop closes both", async () => {
	if (process.platform === "win32") return;
	const value = fixture();
	let owner: UiCommandHandle | undefined;
	try {
		owner = await startUiCommand(
			[
				"--no-open",
				"--project",
				value.firstProject,
			],
			{ env: value.env },
		);
		const first = launchResult(owner);
		assert.equal(owner.keepAlive, true);
		assert.equal(first.role, "writer");
		assert.equal(first.reused, false);
		assert.equal(first.via, "local-singleton");
		assert.ok(fs.existsSync(udsPath(value.env)));

		const attached = await startUiCommand(
			[
				"--no-open",
				"--project",
				value.secondProject,
			],
			{ env: value.env },
		);
		const second = launchResult(attached);
		assert.equal(attached.keepAlive, false);
		assert.equal(second.role, "attach");
		assert.equal(second.reused, true);
		assert.equal(second.origin, first.origin);
		assert.notEqual(second.launchUrl, first.launchUrl);
		assert.equal(owner.daemon?.hosts.size, 2);
		const firstSession = await exchangeLaunch(
			first.launchUrl,
		);
		const secondSession = await exchangeLaunch(
			second.launchUrl,
		);
		assert.notEqual(
			firstSession.cookie,
			secondSession.cookie,
		);
		const projects = await request(second.origin, {
			path: "/api/v1/projects?limit=100",
			cookie: secondSession.cookie,
		});
		assert.equal(projects.status, 200);
		assert.equal(
			(
				projects.body as {
					data?: { items?: unknown[] };
				}
			).data?.items?.length,
			2,
		);

		const stop = await startUiCommand(["--stop"], {
			env: value.env,
		});
		assert.equal(stop.result.action, "stop");
		if (stop.result.action === "stop") {
			assert.equal(stop.result.stopped, true);
		}
		await waitForStop(owner);
		assert.equal(fs.existsSync(udsPath(value.env)), false);
		assert.equal(
			fs.existsSync(singletonLockPath(value.env)),
			false,
		);
	} finally {
		if (owner) await owner.stop();
		value.cleanup();
	}
});

test("taskflow ui: explicit standalone reuses only its project listener and supports --stop", async () => {
	if (process.platform === "win32") return;
	const value = fixture();
	let owner: UiCommandHandle | undefined;
	try {
		const args = [
			"--standalone",
			"--no-open",
			"--project",
			value.firstProject,
		];
		owner = await startUiCommand(args, {
			env: value.env,
		});
		const first = launchResult(owner);
		assert.equal(first.role, "standalone-local");
		assert.equal(first.reused, false);
		assert.equal(first.via, "standalone");
		const socket = projectWebUiSocketPath(
			value.firstProject,
			value.env,
		);
		assert.ok(
			fs.existsSync(socket),
			`standalone socket missing; control entries=${JSON.stringify(
				fs.readdirSync(path.dirname(socket)),
			)}`,
		);

		const attached = await startUiCommand(args, {
			env: value.env,
		});
		const second = launchResult(attached);
		assert.equal(second.reused, true);
		assert.equal(second.origin, first.origin);
		assert.notEqual(second.launchUrl, first.launchUrl);

		const stop = await startUiCommand(
			[
				"--standalone",
				"--stop",
				"--project",
				value.firstProject,
			],
			{ env: value.env },
		);
		assert.equal(stop.result.action, "stop");
		if (stop.result.action === "stop") {
			assert.equal(stop.result.stopped, true);
		}
		await waitForStop(owner);
		assert.equal(fs.existsSync(socket), false);
	} finally {
		if (owner) await owner.stop();
		value.cleanup();
	}
});
