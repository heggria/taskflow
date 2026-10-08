import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ControlHost } from "../src/control-host.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority } from "../src/authorization.ts";

test("approval concurrent with real script retains capacity until whole graph is quiescent", { timeout: 15000 }, async () => {
 const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "control-quiescence-")), root = path.join(base, "project"); fs.mkdirSync(root);
 const registry = new ProjectRegistry(path.join(base, "registry.json")); const mount = registry.mount(path.join(root, ".taskflow", "control"), root);
 const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
  loadLivePolicy: () => ({ host: { capabilities: AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: root })) } }) });
 const context = authority.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: root });
 const provider = new RuntimeTeExecutionProvider(path.join(base, "provider")); const host = new ControlHost({ mode: "standalone", trustedInProcessFeatures: ["durable-approval"], controlHome: path.join(base, "home"), registry, authorization: authority, provider });
 await host.start(); let runId: string | undefined;
 try {
  ({ runId } = await host.dispatchAuthenticated<{ runId: string }>(context, "commands.submit", { commandId: randomUUID(), kind: "run.submit", approvalMode: "durable-required",
   flow: { name: "parallel-approval", phases: [
    { id: "approval", type: "approval", task: "Approve?" },
    { id: "sibling", type: "script", run: "printf live > sibling-live; while [ ! -f release-sibling ]; do sleep 0.02; done; printf done" },
   ] } }));
  const deadline = Date.now() + 5000;
  while ((!mount.store.listApprovals().length || !fs.existsSync(path.join(root, "sibling-live"))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(mount.store.listApprovals().length, 1); assert.ok(fs.existsSync(path.join(root, "sibling-live")));
  assert.equal((await provider.quiescence(runId)).quiescent, false);
  assert.equal(mount.store.readRun(runId)!.slot, "committed");
  fs.writeFileSync(path.join(root, "release-sibling"), "release");
  while (!(await provider.quiescence(runId)).quiescent && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await provider.quiescence(runId)).quiescent, true);
 } finally {
  fs.writeFileSync(path.join(root, "release-sibling"), "release");
  host.stop(); if (runId) await provider.wait(runId); registry.close(); fs.rmSync(base, { recursive: true, force: true });
 }
});
