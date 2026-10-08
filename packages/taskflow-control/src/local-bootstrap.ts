/** Protected local-user bootstrap. Possession authenticates; live policy grants. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ControlError } from "./errors.ts";
import { createAuthorizationAuthority, type AuthorizationCapabilityKind, type AuthorizationAuthorityOptions, type AuthorizationAuthority, type AuthorizationBinding, type VerifiedContext } from "./authorization.ts";

export const LOCAL_OWNER_CAPABILITIES: readonly AuthorizationCapabilityKind[] = [
 "project.read", "run.submit", "run.cancel", "approval.decide", "artifact.read",
];
function fail(message: string): never { throw new ControlError("TF_BOOTSTRAP_FAILED", message); }
function noLinks(target: string): void {
 for (let current = path.resolve(target);;) {
  try { if (fs.lstatSync(current).isSymbolicLink()) fail("bootstrap refuses symbolic-link paths"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = path.dirname(current); if (parent === current) return; current = parent;
 }
}
export function ensurePrivateDirectory(directory: string): string {
 const resolved = path.resolve(directory); noLinks(resolved);
 fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
 const stat = fs.lstatSync(resolved);
 if (!process.getuid || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail("bootstrap directory must be owned by this OS user with mode 0700");
 return resolved;
}
export function readPrivateFile(file: string): Buffer {
 noLinks(file); ensurePrivateDirectory(path.dirname(file));
 const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try {
  const stat = fs.fstatSync(fd), named = fs.lstatSync(file);
  if (!stat.isFile() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
   || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > 1024 * 1024) fail("bootstrap file owner, mode or identity is invalid");
  const bytes = fs.readFileSync(fd); noLinks(file);
  const after = fs.lstatSync(file);
  if (after.dev !== stat.dev || after.ino !== stat.ino) fail("bootstrap file changed while reading");
  return bytes;
 } finally { fs.closeSync(fd); }
}
/** Publish complete bytes without replacing another process's winning secret. */
export function createPrivateFileOnce(file: string, bytes: Uint8Array): void {
 ensurePrivateDirectory(path.dirname(file)); noLinks(file);
 const temp = path.join(path.dirname(file), `.bootstrap-${randomUUID()}`);
 const fd = fs.openSync(temp, "wx", 0o600);
 try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
 try {
  try { fs.linkSync(temp, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
 } finally { fs.unlinkSync(temp); }
 const directory = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function policyPath(controlHome: string, projectRoot: string): string {
 return path.join(controlHome, "policies", `${createHash("sha256").update(projectRoot).digest("hex")}.json`);
}
export function bootstrapLocalAuthority(controlHome: string, projectRoots: readonly string[], options: Pick<AuthorizationAuthorityOptions, "verifyArtifactReachability"> = {}) {
 const home = ensurePrivateDirectory(controlHome);
 const keyPath = path.join(home, "bootstrap.key"); createPrivateFileOnce(keyPath, randomBytes(32));
 const secret = readPrivateFile(keyPath); if (secret.length !== 32) fail("bootstrap secret must contain exactly 32 bytes");
 for (const projectRoot of projectRoots) {
  createPrivateFileOnce(policyPath(home, projectRoot), Buffer.from(JSON.stringify({ version: 1, projectRoot, capabilities: LOCAL_OWNER_CAPABILITIES, revokedPrincipals: [] }) + "\n"));
 }
 const ordinary = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: secret,
  hostBaseline: LOCAL_OWNER_CAPABILITIES, verifyArtifactReachability: options.verifyArtifactReachability,
  loadLivePolicy: (_principal, binding) => {
   const value: unknown = JSON.parse(readPrivateFile(policyPath(home, binding.projectRoot)).toString("utf8"));
   if (!value || typeof value !== "object" || Array.isArray(value)) fail("local policy must be an object");
   const policy = value as Record<string, unknown>;
   if (Object.keys(policy).some(key => !["version", "projectRoot", "capabilities", "revokedPrincipals"].includes(key)) || policy.version !== 1 || policy.projectRoot !== binding.projectRoot
    || !Array.isArray(policy.capabilities) || policy.capabilities.some(kind => !LOCAL_OWNER_CAPABILITIES.includes(kind))
    || !Array.isArray(policy.revokedPrincipals) || policy.revokedPrincipals.some(p => typeof p !== "string")) fail("local policy is invalid");
   return { host: { capabilities: policy.capabilities.map(kind => ({ kind, scopeRoot: binding.projectRoot })) }, revokedPrincipals: policy.revokedPrincipals };
  },
 });
 const authorization = withOperatorIssuer(home, ordinary);
 return { authorization, secret, keyPath };
}


export const LOCAL_OPERATOR_CAPABILITIES: readonly AuthorizationCapabilityKind[] = [
 "project.read", "coordinator.setMaxActiveRuns", "coordinator.forceRelease",
];
export function operatorPolicyPath(controlHome: string, projectRoot: string): string {
 return path.join(controlHome, "operator-policies", `${createHash("sha256").update(projectRoot).digest("hex")}.json`);
}
/** OS-owner local configuration action. Ordinary bootstrap never calls this. */
export function provisionLocalOperator(controlHome: string, projectRoot: string) {
 const home = ensurePrivateDirectory(controlHome), root = fs.realpathSync(projectRoot);
 if (!fs.statSync(root).isDirectory()) fail("operator project root must be a directory");
 const keyPath = path.join(home, "operator.key");
 createPrivateFileOnce(keyPath, randomBytes(32));
 if (readPrivateFile(keyPath).length !== 32) fail("operator secret must contain exactly 32 bytes");
 const file = operatorPolicyPath(home, root);
 createPrivateFileOnce(file, Buffer.from(JSON.stringify({ version: 1, projectRoot: root, capabilities: LOCAL_OPERATOR_CAPABILITIES, revokedPrincipals: [] }) + "\n"));
 return { credential: "operator", principal: `os-user:${process.getuid!()}/credential:operator`, policyPath: file };
}

function withOperatorIssuer(home: string, ordinary: AuthorizationAuthority): AuthorizationAuthority {
 const contexts = new WeakMap<object, AuthorizationAuthority>();
 const challenges = new Map<string, { issuer: AuthorizationAuthority; expiresAt: number }>();
 let operator: AuthorizationAuthority | undefined;
 let operatorSecret: Buffer | undefined;
 const denied = (): never => { throw new ControlError("TF_POLICY_DENIED", "operator credential is absent, invalid, or revoked"); };
 function checkOperatorKey() {
  let current: Buffer;
  try { current = readPrivateFile(path.join(home, "operator.key")); } catch { return denied(); }
  if (current.length !== 32 || operatorSecret && !current.equals(operatorSecret)) return denied();
  return current;
 }
 function issuer() {
  const bytes = checkOperatorKey();
  if (!operator) {
   operatorSecret = bytes;
   operator = createAuthorizationAuthority({ ownerUid: process.getuid!(), credentialIssuerId: "operator", bootstrapSecret: bytes,
    hostBaseline: LOCAL_OPERATOR_CAPABILITIES,
    loadLivePolicy: (_principal, binding) => {
     checkOperatorKey();
     let policy: Record<string, unknown>;
     try { policy = JSON.parse(readPrivateFile(operatorPolicyPath(home, binding.projectRoot)).toString("utf8")); } catch { return denied(); }
     if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => !["version", "projectRoot", "capabilities", "revokedPrincipals"].includes(key))
      || policy.version !== 1 || policy.projectRoot !== binding.projectRoot || !Array.isArray(policy.capabilities)
      || policy.capabilities.some(kind => !LOCAL_OPERATOR_CAPABILITIES.includes(kind)) || !Array.isArray(policy.revokedPrincipals)
      || policy.revokedPrincipals.some(principal => typeof principal !== "string")) return denied();
     return { host: { capabilities: policy.capabilities.map(kind => ({ kind, scopeRoot: binding.projectRoot })) }, revokedPrincipals: policy.revokedPrincipals };
    },
   });
  }
  return operator;
 }
 function remember(context: VerifiedContext, authority: AuthorizationAuthority) { contexts.set(context, authority); return context; }
 function contextIssuer(context: VerifiedContext) {
  const authority = context && typeof context === "object" ? contexts.get(context) : undefined;
  if (!authority) throw new ControlError("TF_AUTHORITY_REVOKED", "verified context is absent, foreign, or revoked");
  if (authority === operator) checkOperatorKey();
  return authority;
 }
 function challenge(binding: AuthorizationBinding, authority: AuthorizationAuthority) {
  for (const [id, pending] of challenges) if (pending.expiresAt <= Date.now()) challenges.delete(id);
  if (challenges.size >= 256) throw new ControlError("TF_POLICY_DENIED", "too many pending authentication challenges");
  const result = authority.createChallenge(binding); challenges.set(result.id, { issuer: authority, expiresAt: result.expiresAt }); return result;
 }
 return {
  issueStandalone: binding => remember(ordinary.issueStandalone(binding), ordinary),
  issueOperatorStandalone: binding => { const authority = issuer(); return remember(authority.issueStandalone(binding), authority); },
  createChallenge: binding => challenge(binding, ordinary),
  createOperatorChallenge: binding => challenge(binding, issuer()),
  authenticate(id, proof) {
   const pending = challenges.get(id); challenges.delete(id);
   if (!pending) throw new ControlError("TF_POLICY_DENIED", "authentication challenge is absent or expired");
   if (pending.issuer === operator) checkOperatorKey();
   return remember(pending.issuer.authenticate(id, proof), pending.issuer);
  },
  identity: context => contextIssuer(context).identity(context),
  revokeContext(context) { const authority = contexts.get(context); authority?.revokeContext(context); contexts.delete(context); },
  async authorize(context, request) {
   const decision = await contextIssuer(context).authorize(context, request);
   contextIssuer(context).identity(context);
   return decision;
  },
 };
}
