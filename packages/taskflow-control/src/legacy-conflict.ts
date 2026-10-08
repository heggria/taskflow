/** P9: read-only inspection of observable legacy store writers. This cannot
 * detect arbitrary old processes that leave no run record or lock. */
import * as fs from "node:fs";
import * as path from "node:path";
import { runsDir, probeProcess } from "taskflow-core";
import { ControlError } from "./errors.ts";
import { writeJsonAtomicHardened } from "./store/store.ts";

const MAX_ENTRIES = 4096, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
interface Observation { path: string; pid?: number }
interface Marker { version: 1; projectRoot: string; state: "blocked" | "acknowledged"; observedAt: number; observations: Observation[]; acknowledgedAt?: number }
function conflict(): never { throw new ControlError("TF_LEGACY_CONFLICT", "legacy store writer conflict requires trusted operator acknowledgement after proving the writer stopped", { recoveryAction: "operator" }); }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function owner(value: unknown): number | undefined {
 const record = object(value), foreground = object(record?.foregroundOwner);
 const pid = record?.pid ?? foreground?.pid;
 return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : undefined;
}
function noLinks(target: string): void {
 for (let current = path.resolve(target);;) {
  try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("symbolic link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = path.dirname(current); if (parent === current) return; current = parent;
 }
}
function readObject(file: string, budget: { bytes: number }): Record<string, unknown> {
 noLinks(file);
 const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
 try {
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES) || (budget.bytes += Number(before.size)) > MAX_TOTAL_BYTES) throw new Error("inspection limit");
  const bytes = Buffer.alloc(Number(before.size) + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
  const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
  noLinks(file);
  if (count !== Number(before.size) || before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("writer changed during inspection");
  const result = object(JSON.parse(bytes.subarray(0, count).toString("utf8"))); if (!result) throw new Error("invalid record"); return result;
 } finally { fs.closeSync(fd); }
}

export class LegacyConflictGuard {
 readonly projectRoot: string;
 readonly markerPath: string;
 constructor(projectRoot: string, storePath: string) {
  this.projectRoot = fs.realpathSync(projectRoot);
  this.markerPath = path.join(storePath, "legacy-conflict.json");
 }
 /** Checks known core layouts without listRuns(), index rebuilds or legacy writes. */
 inspect(): Observation[] {
  const found: Observation[] = [], budget = { bytes: 0 }; let entries = 0;
  const root = runsDir(this.projectRoot), flowRoot = path.dirname(root);
  const inspectFile = (file: string, lock: boolean) => {
   try {
    const record = readObject(file, budget), pid = owner(record), foregroundPid = owner(object(record.foregroundOwner));
    const pids = [...new Set([pid, foregroundPid].filter((value): value is number => value !== undefined))];
    for (const candidate of pids) if (probeProcess(candidate) !== "dead") found.push({ path: file, pid: candidate });
    if (pids.length === 0 && (lock || !["completed", "failed", "blocked"].includes(String(record.status)))) found.push({ path: file });
   } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") found.push({ path: file }); }
  };
  const walk = (directory: string, depth: number, locksOnly = false): void => {
   let handle: fs.Dir | undefined;
   try {
    noLinks(directory); handle = fs.opendirSync(directory);
    for (;;) {
     const entry = handle.readSync(); if (!entry) break;
     if (++entries > MAX_ENTRIES) { found.push({ path: directory }); return; }
     const file = path.join(directory, entry.name);
     if (entry.name.endsWith(".lock") || entry.name.includes(".lock.steal.")) inspectFile(file, true);
     else if (!locksOnly && entry.isDirectory() && depth > 0) walk(file, depth - 1);
     else if (!locksOnly && entry.name.endsWith(".json") && entry.name !== "index.json") inspectFile(file, false);
     else if (!locksOnly && entry.isSymbolicLink()) found.push({ path: file });
     if (entries > MAX_ENTRIES) return;
    }
   } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") found.push({ path: directory }); }
   finally { handle?.closeSync(); }
  };
  walk(flowRoot, 0, true); walk(root, 1);
  return found;
 }
 #marker(): Marker | undefined {
  try {
   const value = readObject(this.markerPath, { bytes: 0 });
   if (value.version !== 1 || value.projectRoot !== this.projectRoot || !["blocked", "acknowledged"].includes(String(value.state)) || !Array.isArray(value.observations)
    || value.observations.some(item => !object(item) || typeof item.path !== "string" || (item.pid !== undefined && owner(item) === undefined))) conflict();
   return value as unknown as Marker;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; conflict(); }
 }
 #record(observations: Observation[], previous?: Marker): void {
  noLinks(this.markerPath);
  const combined = [...(previous?.state === "blocked" ? previous.observations : []), ...observations];
  const unique = [...new Map(combined.map(item => [`${item.path}\0${item.pid ?? "unknown"}`, item])).values()];
  writeJsonAtomicHardened(this.markerPath, { version: 1, projectRoot: this.projectRoot, state: "blocked", observedAt: Date.now(), observations: unique } satisfies Marker);
 }
 assertMayAttempt(): void {
  const previous = this.#marker(), observations = this.inspect();
  if (observations.length) { this.#record(observations, previous); conflict(); }
  if (previous?.state === "blocked") conflict();
 }
 /** Trusted local operator API only. No wire request/boolean proves quiescence.
  * Captured PIDs must be dead even if their record has disappeared. Unknown
  * owners must first be resolved to an observable dead PID at the same path. */
 acknowledgeStopped(): void {
  const previous = this.#marker(); if (!previous || previous.state !== "blocked") return;
  const current = this.inspect(); if (current.length) { this.#record(current, previous); conflict(); }
  for (const observation of previous.observations) {
   let pid = observation.pid;
   if (pid === undefined) { try { pid = owner(readObject(observation.path, { bytes: 0 })); } catch { conflict(); } }
   if (pid === undefined || probeProcess(pid) !== "dead") conflict();
  }
  noLinks(this.markerPath);
  writeJsonAtomicHardened(this.markerPath, { ...previous, state: "acknowledged", acknowledgedAt: Date.now() } satisfies Marker);
 }
}
