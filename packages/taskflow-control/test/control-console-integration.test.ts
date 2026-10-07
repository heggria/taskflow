import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { ControlHost } from "../src/control-host.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority, type VerifiedContext } from "../src/authorization.ts";
import { createControlEvidenceStore } from "../src/store/evidence-adapter.ts";
import { launchControlConsole } from "../src/control-console.ts";

test("console reads two real Host projects, actual TE run, and live revocation without cross-project data", async () => {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-console-real-"));
	const registry = new ProjectRegistry(path.join(directory, "registry.json"));
	const roots = ["one", "two"].map(name => { const root = path.join(directory, name); fs.mkdirSync(root); return root; });
	const mounts = roots.map(root => registry.mount(path.join(root, ".taskflow/control"), root));
	const denied = new Set<string>();
	const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: (_principal, binding) => ({ host: { capabilities: denied.has(binding.projectId) ? [] : AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: binding.projectRoot })) } }) });
	const contexts = new Map(mounts.map(mount => [mount.store.header.projectId, authority.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: mount.projectRoot })]));
	const provider = new RuntimeTeExecutionProvider(path.join(directory, "provider"));
	const host = new ControlHost({ mode: "standalone", registry, authorization: authority, provider, controlHome: path.join(directory, "home") });
	let consoleServer: Awaited<ReturnType<typeof launchControlConsole>> | undefined;
	try {
		await host.start();
		const first = mounts[0].store.header, second = mounts[1].store.header;
		const accepted = await host.dispatchAuthenticated<{ runId: string }>(contexts.get(first.projectId)!, "commands.submit", {
			commandId: randomUUID(), kind: "run.submit", flow: { name: "console-real", phases: [{ id: "work", type: "script", run: "printf console-visible" }] },
		});
		await host.dispatchAuthenticated(contexts.get(first.projectId)!, "runs.wait", { runId: accepted.runId });
		consoleServer = await launchControlConsole({ host, registry, authorization: authority, contexts });
		const origin = consoleServer.url;
		const bootstrap = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: consoleServer.bootstrapToken }) });
		assert.equal(bootstrap.status, 200);
		const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
		const get = (route: string) => fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
		const projects = await get("/api/projects"); assert.equal(projects.status, 200);
		const projectBody = await projects.json() as { result: { projectId: string }[] };
		assert.deepEqual(new Set(projectBody.result.map(row => row.projectId)), new Set([first.projectId, second.projectId]));
		const list = await get(`/api/projects/${first.projectId}/runs?controlDomainId=${first.controlDomainId}`);
		const listed = await list.json() as { result: { runId: string; status: string }[] };
		assert.equal(list.status, 200); assert.equal(listed.result[0].runId, accepted.runId); assert.equal(listed.result[0].status, "completed");
		const other = await get(`/api/projects/${second.projectId}/runs?controlDomainId=${second.controlDomainId}`);
		assert.deepEqual((await other.json() as { result: unknown }).result, []);
		const mixed = await get(`/api/projects/${first.projectId}/runs?controlDomainId=${second.controlDomainId}`); assert.equal(mixed.status, 403);
		denied.add(first.projectId);
		const revoked = await get(`/api/projects/${first.projectId}/runs?controlDomainId=${first.controlDomainId}`); assert.equal(revoked.status, 403);
		const filtered = await get("/api/projects");
		assert.deepEqual((await filtered.json() as { result: { projectId: string }[] }).result.map(row => row.projectId), [second.projectId]);
		denied.add(second.projectId); assert.equal((await get("/api/projects")).status, 403);
		assert.equal((await provider.observe(accepted.runId)).finalOutput, "console-visible");
	} finally { await consoleServer?.close(); host.stop(); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});


test("console stages output text through actual Host and edited approval drives actual downstream script", { timeout: 20000 }, async () => {
 const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-console-edit-"));
 const root = path.join(directory, "project"); fs.mkdirSync(root);
 const registry = new ProjectRegistry(path.join(directory, "registry.json"));
 const mount = registry.mount(path.join(root, ".taskflow/control"), root);
 let revoked = false;
 const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
  loadLivePolicy: () => ({ host: { capabilities: revoked ? [] : AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: root })) } }) });
 const { projectId, controlDomainId } = mount.store.header;
 const context = authority.issueStandalone({ projectId, controlDomainId, projectRoot: root });
 const provider = new RuntimeTeExecutionProvider(path.join(directory, "provider"));
 const host = new ControlHost({ mode: "standalone", registry, authorization: authority, provider, trustedInProcessFeatures: ["durable-approval"], controlHome: path.join(directory, "home"),
  evidenceFactory: (project, verify) => createControlEvidenceStore(project.store, { terminalEvidence: { verify }, authorize: (actor, scope) => authority.authorize(actor as VerifiedContext, { projectId: scope.projectId, controlDomainId: scope.controlDomainId, projectRoot: root, operation: "replay", commandKind: "approval.decide" }) }) });
 let server: Awaited<ReturnType<typeof launchControlConsole>> | undefined;
 try {
  await host.start();
  const accepted = await host.dispatchAuthenticated<{runId:string}>(context, "commands.submit", { commandId: randomUUID(), kind: "run.submit", approvalMode: "durable-required", flow: { name: "console-edit", phases: [{ id: "review", type: "approval", task: "Review output" }, { id: "consume", type: "script", dependsOn: ["review"], run: ["printf", "%s", "{steps.review.output}"] }] } });
  const deadline = Date.now() + 10000;
  while (mount.store.readRun(accepted.runId)?.stage !== "parked") { if (Date.now() > deadline) throw new Error("approval did not park"); await new Promise(resolve => setTimeout(resolve, 10)); }
  server = await launchControlConsole({ host, authorization: authority, registry, contexts: new Map([[projectId, context]]) });
  const login = await fetch(server.url + "/api/session", { method: "POST", headers: { Origin: server.url, "Content-Type": "application/json" }, body: JSON.stringify({ token: server.bootstrapToken }) });
  const session = await login.json() as { csrf: string; features: { approvalOutputEdit: boolean } };
  assert.equal(session.features.approvalOutputEdit, true);
  const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: server.url, "Content-Type": "application/json", "X-Taskflow-CSRF": session.csrf };
  const scoped = (suffix: string) => server!.url + `/api/projects/${projectId}${suffix}?controlDomainId=${controlDomainId}`;
  const stageUrl = scoped(`/runs/${accepted.runId}/approval-output`);
  const before = mount.store.journalTip;
  assert.equal((await fetch(stageUrl, { method: "POST", headers: { ...headers, "X-Taskflow-CSRF": "bad" }, body: JSON.stringify({content:"no"}) })).status, 403);
  assert.equal((await fetch(stageUrl, { method: "POST", headers, body: JSON.stringify({content:"no",projectRoot:root}) })).status, 400);
  assert.deepEqual(mount.store.journalTip, before);
  const staged = await fetch(stageUrl, { method: "POST", headers, body: JSON.stringify({content:"Browser reviewed output"}) });
  assert.equal(staged.status, 200, await staged.clone().text());
  const artifact = (await staged.json() as {result:unknown}).result;
  const approvals = await fetch(scoped("/approvals"), { headers });
  const approval = (await approvals.json() as {result:{approvalRequestId:string;expectedRunVersion:number}[]}).result[0]!;
  const decided = await fetch(scoped(`/approvals/${approval.approvalRequestId}/decisions`), { method: "POST", headers, body: JSON.stringify({ commandId: randomUUID(), runId: accepted.runId, expectedRunVersion: approval.expectedRunVersion, decision: "edit", editKind: "output", editArtifactRef: artifact }) });
  assert.equal(decided.status, 200, await decided.clone().text());
  await host.dispatchAuthenticated(context, "runs.wait", {runId:accepted.runId});
  assert.equal((await provider.observe(accepted.runId)).finalOutput, "Browser reviewed output");
  assert.equal(mount.store.readRun(accepted.runId)?.status, "completed");
  revoked = true;
  const committed = mount.store.journalTip;
  assert.equal((await fetch(stageUrl, {method:"POST",headers,body:JSON.stringify({content:"denied"})})).status,403);
  assert.deepEqual(mount.store.journalTip, committed);
 } finally { await server?.close(); host.stop(); await Promise.all(mount.store.listRuns().map(run => provider.wait(run.runId))); registry.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});
