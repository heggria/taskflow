/** Real Host -> ControlStore -> concrete TE runtime -> receipt and diagnostics. */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ControlHost } from "../src/control-host.ts";
import { RuntimeTeExecutionProvider } from "../src/runtime-provider.ts";
import { ProjectRegistry } from "../src/project-registry.ts";
import { AUTHORIZATION_CAPABILITIES, createAuthorizationAuthority, type VerifiedContext } from "../src/authorization.ts";
import { createControlEvidenceStore } from "../src/store/evidence-adapter.ts";
import type { explainControlEvidence } from "../src/store/evidence-explanation.ts";
import type { RunSnapshot, Receipt } from "../src/schema/index.ts";

test("real Host receipt contains actual TE output and why explains checkpoint provenance", { timeout: 30000 }, async () => {
	const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tf-host-evidence-"));
	const root = path.join(base, "project"); fs.mkdirSync(root);
	const registry = new ProjectRegistry(path.join(base, "registry.json"));
	const mount = registry.mount(path.join(root, ".taskflow/control"), root);
	let allowed = true;
	const authority = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: randomBytes(32), hostBaseline: AUTHORIZATION_CAPABILITIES,
		loadLivePolicy: () => ({ host: { capabilities: allowed ? AUTHORIZATION_CAPABILITIES.map(kind => ({ kind, scopeRoot: root })) : [] } }) });
	const context = authority.issueStandalone({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: root });
	const provider = new RuntimeTeExecutionProvider(path.join(base, "provider"));
	const host = new ControlHost({ mode: "standalone", controlHome: path.join(base, "home"), registry, authorization: authority, provider,
		evidenceFactory: (project, verify) => createControlEvidenceStore(project.store, {
			terminalEvidence: { verify },
			authorize: (actor, scope) => authority.authorize(actor as VerifiedContext, { projectId: scope.projectId,
				controlDomainId: scope.controlDomainId, projectRoot: project.projectRoot, operation: "replay", commandKind: "run.submit" }),
		}) });
	try {
		await host.start();
		const accepted = await host.dispatchAuthenticated<{ runId: string }>(context, "commands.submit", { commandId: randomUUID(), kind: "run.submit",
			flow: { name: "evidence-actual", phases: [{ id: "first", type: "script", run: "printf first-output", effects: [{ id: "declared-output", kind: "fs.write", target: { kind: "path", path: { workspace: "project", subpath: { literalPath: "declared.txt" }, access: "read-write", intent: "create-file", maxLifetime: { scope: "phase" } } } }] },
				{ id: "second", type: "script", dependsOn: ["first"], run: "printf second-output" }] } });
		const run = await host.dispatchAuthenticated<RunSnapshot>(context, "runs.wait", { runId: accepted.runId });
		assert.equal(run.status, "completed");
		const receipt = await host.dispatchAuthenticated<Receipt>(context, "receipts.get", { runId: run.runId });
		assert.equal(receipt.runId, run.runId);
		assert.equal(receipt.assurance.providerOutcome, "completed");
		assert.equal(receipt.assurance.artifactIntegrity, "verified");
		assert.equal(receipt.artifactRefs.length, 1);
		const output = receipt.artifactRefs[0];
		assert.equal(fs.readFileSync(path.join(mount.store.storePath, "artifacts/sha256", output.digest.slice(0, 2), output.digest), "utf8"), "second-output");
		const why = await host.dispatchAuthenticated<Awaited<ReturnType<typeof explainControlEvidence>>>(context, "evidence.why", { runId: run.runId, seeds: ["first"] });
		assert.equal(why.status, "completed"); assert.equal(why.receiptIssued, true);
		assert.equal(why.checkpoint.available, true);
		if (!why.checkpoint.available) assert.fail("checkpoint unavailable");
		assert.match(why.checkpoint.stale!, /why-stale/);
		assert.match(why.checkpoint.stale!, /first/);
		assert.ok(why.lifecycle.some(event => event.payload.kind === "run.terminal"));
		const unknownEffect = await host.dispatchAuthenticated<Awaited<ReturnType<typeof explainControlEvidence>>>(context, "evidence.why", { runId: run.runId, effectId: "absent-effect" });
		if (!unknownEffect.checkpoint.available) assert.fail();
		assert.equal(unknownEffect.checkpoint.effect?.ok, false);
		const declaredEffect = await host.dispatchAuthenticated<Awaited<ReturnType<typeof explainControlEvidence>>>(context, "evidence.why", { runId: run.runId, effectId: "declared-output", phaseId: "first" });
		if (!declaredEffect.checkpoint.available || !declaredEffect.checkpoint.effect?.ok) assert.fail("declared effect diagnostic missing");
		assert.equal(declaredEffect.checkpoint.effect.why.authorized.allowed, false);
		assert.match(declaredEffect.checkpoint.effect.why.reasons.join(" "), /durable|journal|intent/);
		allowed = false;
		await assert.rejects(host.dispatchAuthenticated(context, "evidence.why", { runId: run.runId }), /capability|denied|revoked/);
		await assert.rejects(host.dispatchAuthenticated(context, "receipts.get", { runId: run.runId }), /capability|denied|revoked/);
	} finally { host.stop(); registry.close(); fs.rmSync(base, { force: true, recursive: true }); }
});
