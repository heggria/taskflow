#!/usr/bin/env node
/** Explicit local entrypoint; auto never falls back to standalone. */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ControlHost, defaultServerHello } from "./control-host.ts";
import { ProjectRegistry } from "./project-registry.ts";
import { RuntimeTeExecutionProvider } from "./runtime-provider.ts";
import { answerAuthorizationChallenge, type AuthorizationChallenge, type VerifiedContext, type AuthorizationCommandKind } from "./authorization.ts";
import { bootstrapLocalAuthority, createPrivateFileOnce, ensurePrivateDirectory, provisionLocalOperator, readPrivateFile } from "./local-bootstrap.ts";
import { createControlEvidenceStore, readControlEvidence } from "./store/evidence-adapter.ts";
import { launchControlConsole } from "./control-console.ts";
import { serveControlMcp } from "./control-mcp.ts";
import { singletonPaths } from "./singleton.ts";
import { ControlError } from "./errors.ts";
import type { ControlMode } from "./modes.ts";
import type { RunSnapshot } from "./schema/run.ts";
import { Value } from "typebox/value";
import { registerGracefulSignalOwner } from "taskflow-core/control-execution";
import { ControlStoreHeaderSchema } from "./schema/header.ts";

const HELP = `taskflow-control run --root DIR --flow FILE [--args JSON] [--mode auto|coordinated|standalone]
taskflow-control status --root DIR [--run UUID]
taskflow-control serve --root DIR [--root DIR ...] [--console] [--port NUMBER]
taskflow-control mcp --root DIR [--mode auto|coordinated|standalone] [--operator]
taskflow-control operator-provision --root DIR --control-home DIR
taskflow-control coordinator-status --root DIR [--operator]
taskflow-control set-max-active-runs --root DIR --operator --command-id UUID --max-active-runs NUMBER
taskflow-control force-release --root DIR --operator --command-id UUID --reservation UUID --acknowledge-risk --reason TEXT
Common: --control-home DIR (defaults to TASKFLOW_HOME/control or ~/.taskflow/control).
Operator provisioning is an explicit OS-owner action; a separate credential and live project policy grant operations.
maxActiveRuns is user-global. Force release does not stop execution and marks the concurrency guarantee operator-overridden.
Local owner grants are persisted under CONTROL_HOME/policies and reread per operation.
The CLI executes script flows directly; agent execution requires an embedded configured runner.
Console's one-use browser token is saved to a 0600 local file, never printed or put in URLs.
`;
function fail(message: string): never { throw new ControlError("TF_BOOTSTRAP_FAILED", message); }
function parse(argv: string[]) {
 const command = argv[0]; if (!["run", "status", "serve", "mcp", "operator-provision", "coordinator-status", "set-max-active-runs", "force-release"].includes(command)) fail(HELP);
 const flags = new Map<string, string[]>();
 for (let i = 1; i < argv.length; i++) {
  const flag = argv[i]; if (!["--root", "--flow", "--args", "--mode", "--control-home", "--run", "--console", "--port", "--operator", "--command-id", "--max-active-runs", "--reservation", "--acknowledge-risk", "--reason"].includes(flag)) fail(`unknown option ${flag}`);
  const value = ["--console", "--operator", "--acknowledge-risk"].includes(flag) ? "true" : argv[++i]; if (!value || value.startsWith("--")) fail(`value required for ${flag}`);
  if (flag !== "--root" && flags.has(flag)) fail(`duplicate option ${flag}`);
  flags.set(flag, [...(flags.get(flag) ?? []), value]);
 }
 const roots = (flags.get("--root") ?? [process.cwd()]).map(root => fs.realpathSync(root));
 if (roots.some(root => !fs.statSync(root).isDirectory())) fail("project root must be a directory");
 if (command !== "serve" && roots.length !== 1) fail("multiple roots require serve");
 const get = (key: string) => flags.get(key)?.[0];
 const mode = get("--mode") ?? (["status", "coordinator-status", "set-max-active-runs", "force-release"].includes(command) ? "coordinated" : "auto");
 if (!["auto", "coordinated", "standalone"].includes(mode)) fail("invalid control mode");
 const port = get("--port") === undefined ? undefined : Number(get("--port"));
 if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) fail("invalid console port");
 if (command !== "serve" && (get("--console") || port !== undefined)) fail("console options require serve");
 if (get("--operator") && !["mcp", "status", "coordinator-status", "set-max-active-runs", "force-release"].includes(command)) fail("--operator requires an explicit operator-capable client command");
 if (["set-max-active-runs", "force-release"].includes(command) && !get("--command-id")) fail("operator mutations require --command-id UUID for durable retries");
 if (command === "set-max-active-runs" && (!Number.isSafeInteger(Number(get("--max-active-runs"))) || Number(get("--max-active-runs")) < 1)) fail("--max-active-runs must be a positive safe integer");
 if (command === "force-release" && (!get("--reservation") || !get("--acknowledge-risk") || !get("--reason")?.trim())) fail("force-release requires --reservation, --acknowledge-risk and a nonempty --reason");
 return { operator: !!get("--operator"), commandId: get("--command-id"), maxActiveRuns: Number(get("--max-active-runs")), reservationId: get("--reservation"), reason: get("--reason"), command, roots, mode: mode as ControlMode, controlHome: path.resolve(singletonPaths(get("--control-home")).controlHome), flow: get("--flow"), args: get("--args"), runId: get("--run"), console: !!get("--console"), port };
}
function readHeader(root: string) {
 const file = path.join(root, ".taskflow", "control", "header");
 if (fs.lstatSync(file).isSymbolicLink()) fail("project header cannot be a symbolic link");
 const header: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
 if (!Value.Check(ControlStoreHeaderSchema, header)) fail("project header is invalid");
 const directory = fs.realpathSync(path.dirname(file)), stat = fs.statSync(directory);
 if (header.directoryBinding.canonicalPath !== directory || header.directoryBinding.device !== String(stat.dev) || header.directoryBinding.inode !== String(stat.ino)) fail("project store identity mismatch");
 return header;
}
export async function runControlCli(argv = process.argv.slice(2)): Promise<number> {
 if (argv.length === 0 || argv.includes("--help")) { process.stdout.write(HELP); return 0; }
 const config = parse(argv);
 for (const root of config.roots) {
  const suffix = path.relative(root, config.controlHome);
  if (suffix === "" || (!path.isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${path.sep}`))) fail("control home must be outside every project root; TE authority storage cannot overlap the execution workspace");
 }
 // Reject unreadable input before opening an owner. Runtime validates its schema.
 const flow: unknown = config.command === "run" ? JSON.parse(fs.readFileSync(config.flow ?? fail("run requires --flow FILE"), "utf8")) : undefined;
 const args: unknown = JSON.parse(config.args ?? "{}");
 ensurePrivateDirectory(config.controlHome);
 if (config.command === "operator-provision") {
  process.stdout.write(JSON.stringify(provisionLocalOperator(config.controlHome, config.roots[0])) + "\n"); return 0;
 }
 const registry = new ProjectRegistry(path.join(config.controlHome, "registry.json"));
 const { authorization, secret } = bootstrapLocalAuthority(config.controlHome, config.roots, {
  verifyArtifactReachability: (_principal, binding, digest, commandKind) => {
   const mount = registry.resolve(binding.projectId);
   if (mount.projectRoot !== binding.projectRoot || mount.store.header.controlDomainId !== binding.controlDomainId) return false;
   const ledger = readControlEvidence(mount.store);
   if (commandKind === "run.submit") {
    for (const run of Object.values(ledger.runs)) if (run.artifactRefs.some(ref => ref.digest === digest)) return true;
    for (const refs of Object.values(ledger.receipts)) if (refs.receiptRef.digest === digest || refs.manifestProofRef.digest === digest) return true;
   }
   if (ledger.events.some(({ event }) => event.payload.kind === "artifact.recorded" && event.payload.commandKind === commandKind && event.payload.artifact.digest === digest)) return true;
   return mount.store.readJournal().some(batch => batch.command?.kind === commandKind && batch.command?.responseArtifactRef?.digest === digest);
  },
 });
 const credentialSecret = config.operator ? readPrivateFile(path.join(config.controlHome, "operator.key")) : secret;
 const host = new ControlHost({ mode: config.mode, controlHome: config.controlHome, registry, authorization, trustedInProcessFeatures: ["durable-approval"],
  projectRoot: config.roots[0], projectStorePath: path.join(config.roots[0], ".taskflow", "control"),
  projectMounts: config.roots.slice(1).map(projectRoot => ({ projectRoot, storePath: path.join(projectRoot, ".taskflow", "control") })),
  evidenceFactory: (mount, verify) => createControlEvidenceStore(mount.store, {
   terminalEvidence: { verify },
   authorize: async (actor, scope) => {
    const context = actor as VerifiedContext;
    authorization.identity(context);
    const header = mount.store.header;
    if (scope.projectId !== header.projectId || scope.controlDomainId !== header.controlDomainId) fail("evidence request does not match the mounted project");
    let commandKind: AuthorizationCommandKind = "run.submit";
    if (scope.target.kind === "command") {
     const command = mount.store.readJournal().find(batch => batch.command?.commandId === scope.target.id)?.command;
     if (!command) fail("evidence command is absent from the mounted ledger");
     commandKind = command.kind;
    } else {
     if (!mount.store.readRun(scope.target.id)) fail("evidence run is absent from the mounted ledger");
     if (scope.artifactRef) {
      const recorded = readControlEvidence(mount.store).events.find(({ event }) => event.payload.kind === "artifact.recorded"
       && event.payload.runId === scope.target.id && event.payload.artifact.digest === scope.artifactRef!.digest)?.event;
      if (recorded?.payload.kind === "artifact.recorded") commandKind = recorded.payload.commandKind as AuthorizationCommandKind;
     }
    }
    return authorization.authorize(context, { projectId: header.projectId, controlDomainId: header.controlDomainId, projectRoot: mount.projectRoot,
     operation: scope.artifactRef ? "artifact" : "replay", commandKind, ...(scope.artifactRef ? { artifactDigest: scope.artifactRef.digest } : {}) });
   },
  }),
  provider: new RuntimeTeExecutionProvider(path.join(config.controlHome, "provider"), { agents: [], usageAccounting: "unavailable" }),
 });
 let consoleServer: Awaited<ReturnType<typeof launchControlConsole>> | undefined;
 let handoffPath: string | undefined;
 let interrupted = false;
 const interrupt = () => { interrupted = true; };
 const releaseSignalOwner = registerGracefulSignalOwner(interrupt);
 process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
 try {
  await host.start(); host.hello(defaultServerHello());
  const header = readHeader(config.roots[0]);
  let context: VerifiedContext | undefined;
  if (host.status.singleton === "attached") {
   const challenge = await host.dispatch<AuthorizationChallenge>("auth.challenge", { projectId: header.projectId, ...(config.operator ? { credential: "operator" } : {}) }, { fencingEpoch: host.status.fencingEpoch });
   if (challenge.binding.projectRoot !== config.roots[0] || challenge.binding.projectId !== header.projectId || challenge.binding.controlDomainId !== header.controlDomainId) fail("host challenge does not match the configured project");
   await host.dispatch("auth.authenticate", { challengeId: challenge.id, proof: answerAuthorizationChallenge(credentialSecret, challenge) }, { fencingEpoch: host.status.fencingEpoch });
  } else {
   const binding = { projectId: header.projectId, controlDomainId: header.controlDomainId, projectRoot: config.roots[0] };
   context = config.operator ? authorization.issueOperatorStandalone!(binding) : authorization.issueStandalone(binding);
  }
  const call = <T>(method: string, params: unknown) => context ? host.dispatchAuthenticated<T>(context, method, params) : host.dispatch<T>(method, params, { fencingEpoch: host.status.fencingEpoch });
  if (config.command === "mcp") {
   const stopInput = () => process.stdin.destroy();
   process.on("SIGINT", stopInput); process.on("SIGTERM", stopInput);
   try { await serveControlMcp({ call, projectId: header.projectId, operator: config.operator }); }
   finally { process.off("SIGINT", stopInput); process.off("SIGTERM", stopInput); }
   return 0;
  }
  if (["coordinator-status", "set-max-active-runs", "force-release"].includes(config.command)) {
   const method = config.command === "coordinator-status" ? "coordinator.status" : config.command === "set-max-active-runs" ? "coordinator.setMaxActiveRuns" : "coordinator.forceRelease";
   const params = { projectId: header.projectId, ...(config.command === "set-max-active-runs" ? { commandId: config.commandId, maxActiveRuns: config.maxActiveRuns } : config.command === "force-release" ? { commandId: config.commandId, reservationId: config.reservationId, riskAcknowledgement: true, reason: config.reason } : {}) };
   process.stdout.write(JSON.stringify(await call(method, params)) + "\n"); return 0;
  }
  if (config.command === "run") {
   const accepted = await call<{ runId: string }>("commands.submit", { projectId: header.projectId, commandId: randomUUID(), kind: "run.submit", flow, args });
   // Keep individual RPCs bounded; an approval can remain parked until another
   // authenticated client resolves it. SIGINT retains durable reconciliation facts.
   let run: RunSnapshot;
   for (;;) {
    run = await call<RunSnapshot>("runs.status", { projectId: header.projectId, runId: accepted.runId });
    if (interrupted && !["completed", "failed", "blocked", "cancelled"].includes(run.status)) {
     try {
      await call("runs.cancel", { projectId: header.projectId, runId: accepted.runId, commandId: randomUUID(), expectedRunVersion: run.runVersion });
      interrupted = false;
     } catch (error) {
      if (!(error instanceof ControlError) || error.code !== "TF_STALE_VERSION") throw error;
      continue;
     }
     run = await call<RunSnapshot>("runs.status", { projectId: header.projectId, runId: accepted.runId });
    }
    if (["completed", "failed", "blocked", "cancelled", "unknown"].includes(run.status) || run.needsOperator) break;
    await new Promise(resolve => setTimeout(resolve, 100));
   }
   const result = run.status === "unknown" ? undefined : await call("runs.result", { projectId: header.projectId, runId: accepted.runId });
   process.stdout.write(JSON.stringify({ ...accepted, run, ...(result ? { result } : {}) }) + "\n"); return run.status === "completed" ? 0 : 1;
  }
  if (config.command === "status") {
   const result = await call(config.runId ? "runs.status" : "runs.list", { projectId: header.projectId, ...(config.runId ? { runId: config.runId } : {}) });
   process.stdout.write(JSON.stringify({ control: host.status, result }) + "\n"); return 0;
  }
  if (!context) fail("serve requires ownership; a host already owns this control home (use status/run to attach)");
  if (config.console) {
   const contexts = new Map<string, VerifiedContext>();
   for (const root of config.roots) { const h = readHeader(root); contexts.set(h.projectId, authorization.issueStandalone({ projectId: h.projectId, controlDomainId: h.controlDomainId, projectRoot: root })); }
   consoleServer = await launchControlConsole({ host, authorization, registry, contexts, port: config.port });
   handoffPath = path.join(config.controlHome, `console-handoff-${randomUUID()}.json`);
   createPrivateFileOnce(handoffPath, Buffer.from(JSON.stringify({ url: consoleServer.url, token: consoleServer.bootstrapToken }) + "\n"));
  }
  process.stdout.write(JSON.stringify({ control: host.status, projects: registry.list(), ...(consoleServer ? { consoleUrl: consoleServer.url, browserHandoffFile: handoffPath } : {}) }) + "\n");
  if (!interrupted) await new Promise<void>(resolve => {
   const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
   process.on("SIGINT", stop); process.on("SIGTERM", stop);
  });
  return 0;
 } finally {
  releaseSignalOwner();
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  await consoleServer?.close();
  if (handoffPath) { try { fs.unlinkSync(handoffPath); } catch { /* preserve primary shutdown error */ } }
  host.stop(); registry.close(); secret.fill(0); credentialSecret.fill(0);
 }
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
 runControlCli().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(JSON.stringify({ error: error instanceof ControlError ? error.code : "TF_BOOTSTRAP_FAILED", message: error instanceof Error ? error.message : "local control failed" }) + "\n");
  process.exitCode = 1;
 });
}
