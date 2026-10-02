import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWebConsole, type WebConsoleOptions, type WebConsoleServer, type WebConsoleAuthorization } from "../src/web-console.ts";
import { ControlError } from "../src/errors.ts";
import { ControlHost, defaultServerHello } from "../src/control-host.ts";
import { createTeExecutionProvider } from "../src/te-provider.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const approvalId = "44444444-4444-4444-8444-444444444444";
const scoped = (suffix: string) => `/api/projects/${projectId}${suffix}?controlDomainId=${domainId}`;
const decision = () => ({ commandId: randomUUID(), runId, expectedRunVersion: 3, decision: "approve" });
async function launch(t: TestContext, options: WebConsoleOptions) {
	const console = await startWebConsole(options);
	t.after(() => console.close());
	return console;
}
async function session(console: WebConsoleServer) {
	const response = await fetch(`${console.url}/api/session`, { method: "POST", headers: { Origin: console.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: console.bootstrapToken }) });
	assert.equal(response.status, 200);
	const data = await response.json() as { csrf: string };
	const setCookie = response.headers.get("set-cookie")!;
	assert.match(setCookie, /HttpOnly/);
	assert.match(setCookie, /SameSite=Strict/);
	return { Cookie: setCookie.split(";")[0]!, Origin: console.url, "X-Taskflow-CSRF": data.csrf, "Content-Type": "application/json" };
}
const unusedClient = { call: async () => ({}) };
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers }, (response) => { response.resume(); resolve(response.statusCode!); });
		request.on("error", reject);
	});
}

test("web console: requires live authorization injection; token absent from public HTML/URL/scripts", async (t) => {
	await assert.rejects(startWebConsole({} as WebConsoleOptions), /authorize/);
	const console = await launch(t, { authorize: async () => unusedClient });
	assert.equal(console.url.includes(console.bootstrapToken), false);
	for (const route of ["/", "/app.js", "/style.css"]) {
		const response = await fetch(console.url + route);
		assert.equal(response.status, 200);
		assert.equal((await response.text()).includes(console.bootstrapToken), false);
		assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	}
});

test("web console: loopback alone gives no access and one-use bootstrap rejects replay", async (t) => {
	const console = await launch(t, { authorize: async () => unusedClient });
	assert.equal((await fetch(console.url + "/api/projects")).status, 401);
	await session(console);
	const replay = await fetch(console.url + "/api/session", { method: "POST", headers: { Origin: console.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: console.bootstrapToken }) });
	assert.equal(replay.status, 401);
	assert.equal((await replay.text()).includes(console.bootstrapToken), false);
});

test("web console: rejects wrong Host, cross-origin, missing Origin and CSRF before owner calls", async (t) => {
	let calls = 0;
	const console = await launch(t, { authorize: async () => { calls++; return unusedClient; } });
	const headers = await session(console);
	assert.equal(await rawStatus(console.url + "/api/projects", { ...headers, Host: "attacker.invalid" }), 403);
	assert.equal((await fetch(console.url + "/api/projects", { headers: { ...headers, Origin: "https://attacker.invalid" } })).status, 403);
	assert.equal((await fetch(console.url + "/api/projects", { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
	for (const bad of [{ ...headers, Origin: "" }, { ...headers, "X-Taskflow-CSRF": "wrong" }]) {
		assert.equal((await fetch(console.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers: bad, body: JSON.stringify(decision()) })).status, 403);
	}
	assert.equal(calls, 0);
});

test("web console: live authorization runs for every request and revocation denies subsequent disclosure", async (t) => {
	const auth: WebConsoleAuthorization[] = [];
	let revoked = false;
	let calls = 0;
	const console = await launch(t, { authorize: async (request) => {
		auth.push(request);
		if (revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "Project access revoked");
		return { call: async () => { calls++; return []; } };
	} });
	const headers = await session(console);
	for (let i = 0; i < 2; i++) assert.equal((await fetch(console.url + scoped("/runs"), { headers })).status, 200);
	revoked = true;
	const denied = await fetch(console.url + scoped("/runs"), { headers });
	assert.equal(denied.status, 403);
	assert.match(await denied.text(), /TF_AUTHORITY_REVOKED/);
	assert.equal(auth.length, 3);
	assert.equal(calls, 2);
	assert.equal(auth[0]!.projectId, projectId);
	assert.equal(auth[0]!.controlDomainId, domainId);
	assert.equal("principalId" in auth[0]!, false);
});

test("web console: project routing comes from path and domain, trusted fields cannot enter decision intent", async (t) => {
	const intents: Record<string, unknown>[] = [];
	const console = await launch(t, { authorize: async () => ({ call: async (_operation, params) => { intents.push({ ...params }); return { accepted: true }; } }) });
	const headers = await session(console);
	const url = console.url + scoped(`/approvals/${approvalId}/decisions`);
	for (const field of ["callerPrincipal", "authorizationContextHash", "events", "projectId", "fencingEpoch"]) {
		assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...decision(), [field]: "forged" }) })).status, 400);
	}
	const body = decision();
	assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status, 200);
	assert.deepEqual(intents, [{ projectId, controlDomainId: domainId, approvalRequestId: approvalId, ...body }]);
});

test("web console: decision version and error envelope preserved; competing requests reach authoritative CAS", async (t) => {
	let version = 3;
	let commits = 0;
	const console = await launch(t, { authorize: async () => ({ call: async (_operation, params) => {
		if (params.expectedRunVersion !== version) throw new ControlError("TF_STALE_VERSION", "Approval version changed", { recoveryAction: "refresh", sideEffects: "none" });
		version++; commits++; return { committed: true };
	} }) });
	const headers = await session(console);
	const replies = await Promise.all([decision(), decision()].map((body) => fetch(console.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers, body: JSON.stringify(body) })));
	assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
	const stale = await replies.find((r) => r.status === 409)!.json() as { error: { code: string; recoveryAction: string; sideEffects: string } };
	assert.deepEqual(stale.error, { code: "TF_STALE_VERSION", message: "Approval version changed", recoveryAction: "refresh", sideEffects: "none" });
	assert.equal(commits, 1);
});

test("web console: edit unavailable by default; enabled edit requires ArtifactRef", async (t) => {
	let calls = 0;
	const authorize = async () => ({ call: async () => { calls++; return { committed: true }; } });
	const disabled = await launch(t, { authorize });
	const disabledHeaders = await session(disabled);
	assert.equal((await fetch(disabled.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers: disabledHeaders, body: JSON.stringify({ ...decision(), decision: "edit" }) })).status, 409);
	assert.equal(calls, 0);
	const enabled = await launch(t, { authorize, approvalEditWithArtifactRef: true });
	const headers = await session(enabled);
	assert.equal((await fetch(enabled.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers, body: JSON.stringify({ ...decision(), decision: "edit" }) })).status, 400);
	const artifact = { digest: "a".repeat(64), size: 4, mediaType: "text/plain", storageClass: "project", redactionClass: "none" };
	assert.equal((await fetch(enabled.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers, body: JSON.stringify({ ...decision(), decision: "edit", editArtifactRef: artifact }) })).status, 200);
	assert.equal(calls, 1);
});

test("web console: missing receipt stays absent, why scope preserved and backend errors do not expose secrets", async (t) => {
	const requests: Record<string, unknown>[] = [];
	const console = await launch(t, { authorize: async () => ({ call: async (op, params) => {
		requests.push({ ...params });
		if (op === "receipts.get") return null;
		if (op === "evidence.why") return { evidence: "<img src=x onerror=alert(1)>" };
		throw new Error("SECRET INTERNAL AUTH MATERIAL");
	} }) });
	const headers = await session(console);
	assert.deepEqual(await (await fetch(console.url + scoped(`/runs/${runId}/receipt`), { headers })).json(), { result: null });
	assert.equal((await fetch(console.url + scoped(`/runs/${runId}/why`) + "&kind=effect&effectId=write&phaseId=save", { headers })).status, 200);
	assert.deepEqual(requests[1], { projectId, controlDomainId: domainId, runId, kind: "effect", effectId: "write", phaseId: "save" });
	const failure = await fetch(console.url + "/api/status", { headers });
	assert.equal(failure.status, 500);
	assert.doesNotMatch(await failure.text(), /SECRET/);
	const js = await (await fetch(console.url + "/app.js")).text();
	assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("web console: session expiry and logout stop API access", async (t) => {
	const console = await launch(t, { authorize: async () => unusedClient, sessionTtlMs: 50 });
	const headers = await session(console);
	await delay(70);
	assert.equal((await fetch(console.url + "/api/status", { headers })).status, 401);
	const active = await launch(t, { authorize: async () => unusedClient });
	const activeHeaders = await session(active);
	assert.equal((await fetch(active.url + "/api/session", { method: "DELETE", headers: activeHeaders })).status, 200);
	assert.equal((await fetch(active.url + "/api/status", { headers: activeHeaders })).status, 401);
});

test("web console: actual ControlHost dispatch serves live status/header through injected bridge", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-console-host-"));
	fs.mkdirSync(path.join(root, "home"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const unavailable = async (): Promise<never> => { throw new Error("Provider execution is outside this status-only integration test"); };
	const host = new ControlHost({ mode: "standalone", controlHome: path.join(root, "home"), projectStorePath: path.join(root, "project"), provider: createTeExecutionProvider({ assurance: "resolve-only-no-sandbox", probe: unavailable, prepare: unavailable, submit: unavailable, watch: async function* () { throw new Error("No test execution provider"); } }) });
	t.after(() => host.stop());
	await host.start();
	assert.equal(host.hello(defaultServerHello()).ok, true);
	let liveChecks = 0;
	const console = await launch(t, { authorize: async () => {
		liveChecks++;
		return { call: async (operation) => {
			if (operation === "control.status") return host.dispatch(operation, {}, { fencingEpoch: host.status.fencingEpoch });
			if (operation === "projects.list") {
				const header = await host.dispatch<{ projectId: string; controlDomainId: string }>("control.store.header", {}, { fencingEpoch: host.status.fencingEpoch });
				return [{ projectId: header.projectId, controlDomainId: header.controlDomainId, path: root }];
			}
			throw new ControlError("TF_FEATURE_REQUIRED", "Owner lifecycle integration pending");
		} };
	} });
	const headers = await session(console);
	const status = await (await fetch(console.url + "/api/status", { headers })).json() as { result: { state: string; singleton: string } };
	assert.equal(status.result.state, "started");
	assert.equal(status.result.singleton, "standalone");
	const projects = await (await fetch(console.url + "/api/projects", { headers })).json() as { result: { projectId: string }[] };
	assert.equal(projects.result.length, 1);
	assert.notEqual(projects.result[0]!.projectId, "00000000-0000-0000-0000-000000000000");
	assert.equal(liveChecks, 2);
});

test("web console: invalid intents and oversized bodies cannot reach owner", async (t) => {
	let calls = 0;
	const console = await launch(t, { authorize: async () => { calls++; return unusedClient; } });
	const headers = await session(console);
	const url = console.url + scoped(`/approvals/${approvalId}/decisions`);
	for (const patch of [{ expectedRunVersion: -1 }, { expectedRunVersion: 1.5 }, { expectedRunVersion: "3" }, { decision: ["approve"] }, { commandId: "bad" }]) {
		assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...decision(), ...patch }) })).status, 400);
	}
	assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...decision(), padding: "x".repeat(70_000) }) })).status, 413);
	assert.equal((await fetch(console.url + `/api/projects/${projectId}/runs`, { headers })).status, 400);
	assert.equal(calls, 0);
});

test("web console: expired bootstrap cannot create session", async (t) => {
	const console = await launch(t, { authorize: async () => unusedClient, bootstrapTtlMs: 20 });
	await delay(30);
	const response = await fetch(console.url + "/api/session", { method: "POST", headers: { Origin: console.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: console.bootstrapToken }) });
	assert.equal(response.status, 401);
});
