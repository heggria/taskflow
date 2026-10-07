/** Protected local-user bootstrap. Possession authenticates; live policy grants. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ControlError } from "./errors.ts";
import { createAuthorizationAuthority, type AuthorizationCapabilityKind, type AuthorizationAuthorityOptions } from "./authorization.ts";

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
 const authorization = createAuthorizationAuthority({ ownerUid: process.getuid!(), bootstrapSecret: secret,
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
 return { authorization, secret, keyPath };
}
