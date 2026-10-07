import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { CONSOLE_JS } from "../src/web-console/view.ts";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWebConsole, type WebConsoleOptions, type WebConsoleServer, type WebConsoleAuthorization } from "../src/web-console.ts";
import { ControlError } from "../src/errors.ts";
import { ControlHost, defaultServerHello } from "../src/control-host.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { createAuthorizationAuthority } from "../src/authorization.ts";

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
	assert.equal(auth.length, 5);
	assert.deepEqual(auth.map((a) => a.purpose), ["execute", "disclose", "execute", "disclose", "execute"]);
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
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-console-host-"));
	fs.mkdirSync(path.join(root, "home"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot);
	const registry = new ProjectRegistry(path.join(root, "registry.json"));
	const mount = registry.mount(path.join(projectRoot, ".taskflow/control"), projectRoot);
	const binding = { projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot };
	const authorization = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: ["project.read"],
		loadLivePolicy: () => ({ host: { capabilities: [{ kind: "project.read", scopeRoot: projectRoot }] } }) });
	const context = authorization.issueStandalone(binding);
	t.after(() => registry.close());
	const host = new ControlHost({ mode: "standalone", controlHome: path.join(root, "home"), registry, authorization, provider: new RuntimeTeExecutionProvider(path.join(root, "provider")) });
	t.after(() => host.stop());
	await host.start();
	assert.equal(host.hello(defaultServerHello()).ok, true);
	let liveChecks = 0;
	const console = await launch(t, { authorize: async () => {
		liveChecks++;
		await authorization.authorize(context, { ...binding, operation: "read" });
		return { call: (operation, params) => host.dispatchAuthenticated(context, operation, params) };
	} });
	const headers = await session(console);
	const status = await (await fetch(console.url + "/api/status", { headers })).json() as { result: { state: string; singleton: string } };
	assert.equal(status.result.state, "started");
	assert.equal(status.result.singleton, "standalone");
	const projects = await (await fetch(console.url + "/api/projects", { headers })).json() as { result: { projectId: string }[] };
	assert.equal(projects.result.length, 1);
	assert.notEqual(projects.result[0]!.projectId, "00000000-0000-0000-0000-000000000000");
	assert.equal(liveChecks, 4);
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

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

for (const boundary of ["execute", "call", "disclose"] as const) {
	for (const invalidation of ["logout", "expiry", "close", "disconnect"] as const) {
		test(`web console: ${invalidation} during ${boundary} prevents later dispatch/disclosure`, { timeout: 5000 }, async (t) => {
			const entered = deferred();
			const resume = deferred();
			const finished = deferred();
			let calls = 0;
			const console = await launch(t, {
				sessionTtlMs: invalidation === "expiry" ? 200 : 60_000,
				authorize: async ({ purpose }) => {
					if (purpose === boundary) { entered.resolve(); await resume.promise; finished.resolve(); }
					return { call: async () => {
						calls++;
						if (boundary === "call") { entered.resolve(); await resume.promise; finished.resolve(); }
						return { secret: "private-result" };
					} };
				},
			});
			const headers = await session(console);
			const controller = new AbortController();
			const pending = fetch(console.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers, body: JSON.stringify(decision()), signal: controller.signal }).then(async (r) => ({ status: r.status, text: await r.text() }), () => null);
			await entered.promise;
			if (invalidation === "logout") assert.equal((await fetch(console.url + "/api/session", { method: "DELETE", headers })).status, 200);
			if (invalidation === "expiry") await delay(220);
			if (invalidation === "close") await console.close();
			if (invalidation === "disconnect") { controller.abort(); await pending; await delay(20); }
			resume.resolve();
			await finished.promise;
			const result = await pending;
			await delay(10);
			assert.equal(calls, boundary === "execute" ? 0 : 1);
			if (invalidation === "logout" || invalidation === "expiry") {
				assert.equal(result?.status, 401);
				assert.doesNotMatch(result!.text, /private-result/);
			} else assert.equal(result, null);
		});
	}
}

for (const failure of [false, true]) {
	test(`web console: revocation during owner call suppresses delayed ${failure ? "error" : "result"} without replaying mutation`, async (t) => {
		const entered = deferred(); const resume = deferred();
		let revoked = false; let calls = 0;
		const purposes: string[] = [];
		const console = await launch(t, { authorize: async ({ purpose }) => {
			purposes.push(purpose);
			if (revoked) throw new ControlError("TF_AUTHORITY_REVOKED", "revoked");
			return { call: async () => {
				calls++; entered.resolve(); await resume.promise;
				if (failure) throw new ControlError("TF_STALE_VERSION", "private-result");
				return { secret: "private-result" };
			} };
		} });
		const headers = await session(console);
		const pending = fetch(console.url + scoped(`/approvals/${approvalId}/decisions`), { method: "POST", headers, body: JSON.stringify(decision()) });
		await entered.promise; revoked = true; resume.resolve();
		const response = await pending;
		assert.equal(response.status, 403);
		assert.doesNotMatch(await response.text(), /private-result/);
		assert.equal(calls, 1);
		assert.deepEqual(purposes, ["execute", "disclose"]);
	});
}

test("web console UI: older evidence response cannot overwrite a newer request in the same project", async () => {
	const elements = new Map<string, { value: string; textContent: string; addEventListener: () => void }>();
	const getElementById = (id: string) => {
		if (!elements.has(id)) elements.set(id, { value: "", textContent: "", addEventListener: () => {} });
		return elements.get(id)!;
	};
	const reads = [deferred<{ ok: boolean; json: () => Promise<unknown> }>(), deferred<{ ok: boolean; json: () => Promise<unknown> }>()];
	let index = 0;
	const context = vm.createContext({ document: { getElementById, querySelectorAll: () => [] }, fetch: (url: string) => url === "/api/session" ? new Promise(() => {}) : reads[index++]!.promise });
	vm.runInContext(CONSOLE_JS, context);
	vm.runInContext(`state.project = { projectId: '${projectId}', controlDomainId: '${domainId}' }; state.runs = [{}];`, context);
	getElementById("run-choice").value = runId;
	const old = vm.runInContext("evidence('receipt')", context) as Promise<void>;
	const current = vm.runInContext("evidence('stale')", context) as Promise<void>;
	reads[1]!.resolve({ ok: true, json: async () => ({ result: { current: true } }) });
	await current;
	reads[0]!.resolve({ ok: true, json: async () => ({ result: { obsolete: true } }) });
	await old;
	assert.match(getElementById("evidence-output").textContent, /current/);
	assert.doesNotMatch(getElementById("evidence-output").textContent, /obsolete/);
});


test("web console UI stages output text, uses the refreshed version and replays one decision after a lost response", async () => {
 class Element {
  value = ""; textContent = ""; hidden = false; disabled = false; placeholder = ""; className = "";
  children: Element[] = []; attributes = new Map<string,string>(); listeners = new Map<string,()=>Promise<void>>();
  classList = { toggle() {} };
  readonly tag: string;
  constructor(tag = "div") { this.tag = tag; }
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name,value); }
  addEventListener(name: string, callback: ()=>Promise<void>) { this.listeners.set(name,callback); }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
 }
 const elements = new Map<string,Element>();
 const getElementById = (id:string) => { if(!elements.has(id)) elements.set(id,new Element()); return elements.get(id)!; };
 const artifact = { digest: "a".repeat(64), size: 13, mediaType: "text/plain; charset=utf-8", storageClass: "project", redactionClass: "internal" };
 const requests: {url:string;body?:Record<string,unknown>}[] = []; let decisions = 0;
 const context = vm.createContext({ document: { getElementById, querySelectorAll:()=>[], createElement:(tag:string)=>new Element(tag) }, crypto:{randomUUID},
  fetch: async(url:string,options?:{body?:string}) => {
   if(url === "/api/session") return new Promise(()=>{});
   const body = options?.body ? JSON.parse(options.body) as Record<string,unknown> : undefined;
   requests.push({url,body});
   let result:unknown;
   if(url.includes("/approval-output?")) result = artifact;
   else if(url.includes("/approvals?")) result = [{approvalRequestId:approvalId,status:"pending",expectedRunVersion:4}];
   else if(url.includes("/decisions?")) { decisions++; if(decisions===1) return {ok:false,status:503,json:async()=>({error:{message:"response lost"}})}; result={committed:true}; }
   else throw new Error("Unexpected request " + url);
   return {ok:true,status:200,json:async()=>({result})};
  }
 });
 vm.runInContext(CONSOLE_JS,context);
 vm.runInContext(`state.features={approvalEditWithArtifactRef:true,approvalOutputEdit:true}; refreshProject=async()=>{}; renderApprovals([{approvalRequestId:'${approvalId}',runId:'${runId}',expectedRunVersion:3,status:'pending',allowedDecisions:['approve','reject','edit'],deadline:Date.now()+10000}],{projectId:'${projectId}',controlDomainId:'${domainId}'});`,context);
 const textarea = getElementById("approvals").querySelectorAll("textarea")[0]!;
 assert.equal(textarea.attributes.get("aria-label"),"Edited output"); textarea.value="edited output";
 const button=getElementById("approvals").querySelectorAll("button").find(item=>item.textContent==="Edit")!;
 await button.listeners.get("click")!(); await button.listeners.get("click")!();
 assert.equal(requests.filter(item=>item.url.includes("/approval-output?")).length,1);
 assert.deepEqual(requests[0]!.body,{content:"edited output"});
 const sent=requests.filter(item=>item.url.includes("/decisions?")); assert.equal(sent.length,2);
 assert.deepEqual(sent[0]!.body,sent[1]!.body);
 assert.equal(sent[0]!.body!.expectedRunVersion,4); assert.equal(sent[0]!.body!.editKind,"output");
 assert.deepEqual(sent[0]!.body!.editArtifactRef,artifact);
});
