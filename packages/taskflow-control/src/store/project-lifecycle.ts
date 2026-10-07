/** Explicit P3 identity maintenance and P10 forensic export. Registry hints do
 * not participate in identity decisions. All callbacks are trusted host ports. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { ControlError } from "../errors.ts";
import { ControlStoreHeaderSchema, type ControlStoreHeader } from "../schema/header.ts";
import { type Receipt } from "../schema/evidence.ts";
import { isTerminalRunStatus } from "../schema/run.ts";
import { JOURNAL_GENESIS, validJournalBatch, journalHash, type JournalBatch } from "./journal.ts";
import { acquireWriterLock, openControlStore, writeJsonAtomicHardened } from "./store.ts";

export type ProjectLifecycleOperation = "move-rebind" | "clone" | "adopt" | "export";
export interface ProjectLifecycleAuthority<C> {
	/** Implement using a verified operator context and CURRENT project policy.
	 * Path arguments are trusted launcher/operator configuration, not wire body. */
	authorize(context: C, scope: { operation: ProjectLifecycleOperation; header: ControlStoreHeader; destination?: string }): Promise<{ principal: string; operator: boolean }> | { principal: string; operator: boolean };
}
export interface ForensicFile { path: string; sha256: string; size: number; bytesBase64?: string }
export interface ProjectForensicExport {
	exportKind: "readonly" | "lossy"; executePromise: false;
	header: ControlStoreHeader; sourcePath: string; integrity: "verified" | "damaged";
	verificationScope: "captured-bytes-and-journal-structure"; diagnostics: string[]; files: ForensicFile[]; journal: JournalBatch[]; receipts: Receipt[];
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never { throw new ControlError("TF_DURABILITY_FAILED", message, { recoveryAction: "operator", sideEffects: "none" }); }
function directory(input: string): string {
	const stat = fs.lstatSync(input);
	if (!stat.isDirectory() || stat.isSymbolicLink()) fail("project store must be a real directory");
	const canonical = fs.realpathSync(input);
	if (process.getuid && stat.uid !== process.getuid()) fail("project store must belong to the current host user");
	return canonical;
}
function read(file: string): Buffer {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd), linked = fs.lstatSync(file);
		if (!stat.isFile() || linked.isSymbolicLink() || stat.dev !== linked.dev || stat.ino !== linked.ino) fail("forensic evidence is not an unchanged regular file");
		const bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
		if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("evidence changed during read");
		return bytes;
	} finally { fs.closeSync(fd); }
}
function headerAt(root: string): ControlStoreHeader {
	let value: unknown;
	try { value = JSON.parse(read(path.join(root, "header")).toString("utf8")); }
	catch { fail("authoritative header is missing or unreadable; identity cannot be reconstructed"); }
	if (!Value.Check(ControlStoreHeaderSchema, value)) fail("authoritative header is invalid");
	return value;
}
function sameHeader(a: ControlStoreHeader, b: ControlStoreHeader): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function authorize<C>(authority: ProjectLifecycleAuthority<C>, context: C, operation: ProjectLifecycleOperation, header: ControlStoreHeader, destination?: string) {
	const result = await authority.authorize(context, { operation, header: structuredClone(header), ...(destination ? { destination } : {}) });
	if (!result || !result.principal?.trim() || result.operator !== true) throw new ControlError("TF_POLICY_DENIED", "verified current operator authority is required");
	return result.principal;
}
function collect(root: string): Map<string, Buffer> {
	const result = new Map<string, Buffer>();
	const walk = (relative: string) => {
		const file = path.join(root, relative); let stat: fs.Stats;
		try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (stat.isSymbolicLink()) fail("forensic export refuses symlink evidence");
		if (stat.isDirectory()) { for (const child of fs.readdirSync(file).sort()) walk(path.join(relative, child)); }
		else if (stat.isFile()) result.set(relative.split(path.sep).join("/"), read(file));
		else fail("forensic export refuses special evidence files");
	};
	for (const name of ["header", "commit-seq.json", "journal", "receipts", "artifacts"]) walk(name);
	return result;
}
function fingerprint(files: Map<string, Buffer>): string { return JSON.stringify([...files].map(([name, bytes]) => [name, bytes.length, digest(bytes)])); }
function parseEvidence(root: string, header: ControlStoreHeader, files: Map<string, Buffer>, kind: "readonly" | "lossy"): ProjectForensicExport {
	const diagnostics: string[] = [], journal: JournalBatch[] = [], receipts: Receipt[] = [];
	let tip = JOURNAL_GENESIS, sequence = 0;
	const commands = new Set<string>(), admissions = new Set<string>(), runVersions = new Map<string, number>();
	for (const [name, bytes] of files) {
		if (!name.startsWith("journal/")) continue;
		if (name !== "journal/000001.jsonl") { diagnostics.push(`unsupported journal segment: ${name}`); continue; }
		const lines = bytes.toString("utf8").split("\n");
		if (bytes.length && bytes.at(-1) !== 10) diagnostics.push("incomplete journal tail preserved");
		for (const [index, line] of lines.entries()) {
			if (!line) continue;
			let value: unknown; try { value = JSON.parse(line); } catch { diagnostics.push(`unreadable journal line ${index + 1}`); continue; }
			if (!validJournalBatch(value)) { diagnostics.push(`invalid journal line ${index + 1}`); continue; }
			const batch = value;
			if (batch.commitSeq !== sequence + 1 || batch.events.some(e => e.projectId !== header.projectId || e.controlDomainId !== header.controlDomainId || e.commitSeq !== batch.commitSeq)
				|| batch.command && (batch.command.projectId !== header.projectId || batch.command.controlDomainId !== header.controlDomainId)
				|| batch.recordKind === "lifecycle-batch" && batch.previousHash !== tip) diagnostics.push(`journal binding or continuity mismatch at ${batch.commitSeq}`);
			if (batch.command) {
				if (commands.has(batch.command.commandId) || batch.command.firstCommitSeq !== batch.commitSeq || batch.command.lastCommitSeq !== batch.commitSeq) diagnostics.push("duplicate or invalid command sequence");
				commands.add(batch.command.commandId);
			}
			if (batch.events.some((e, index) => batch.command ? e.commandId !== batch.command.commandId || e.commandEventIndex !== index : e.commandId !== undefined)) diagnostics.push("event command binding mismatch");
			if (batch.recordKind === "lifecycle-batch") {
				if (batch.command && (batch.responseJson === undefined || !batch.projection)) diagnostics.push("missing immutable command response");
				if (batch.responseJson !== undefined) { try { JSON.parse(batch.responseJson); if (!batch.command) diagnostics.push("orphan command response"); } catch { diagnostics.push("invalid immutable response"); } }
				if (batch.projection) {
					const p = batch.projection, run = p.run, prior = runVersions.get(run.runId);
					if (run.projectId !== header.projectId || run.controlDomainId !== header.controlDomainId || p.approvals.some(a => a.runId !== run.runId) || p.outbox.some(o => o.runId !== run.runId) || prior !== undefined && run.runVersion !== prior + 1) diagnostics.push("projection binding/version mismatch");
					runVersions.set(run.runId, run.runVersion);
				}
				if (batch.admission) { const d = batch.admission;
					if (d.projectId !== header.projectId || d.projectControlDomainId !== header.controlDomainId || d.decisionCommitSeq !== batch.commitSeq || admissions.has(d.reservationId)) diagnostics.push("admission binding mismatch");
					admissions.add(d.reservationId);
				}
				if (batch.receipt) {
					if (batch.receipt.controlDomainId !== header.controlDomainId) diagnostics.push("receipt domain mismatch");
					receipts.push(batch.receipt);
					for (const ref of [batch.receiptRef, batch.manifestProofRef]) {
						if (!ref) { diagnostics.push("missing receipt evidence reference"); continue; }
						const blob = files.get(`artifacts/sha256/${ref.digest.slice(0, 2)}/${ref.digest}`);
						if (!blob || blob.length !== ref.size || digest(blob) !== ref.digest) diagnostics.push("receipt blob missing or corrupt");
					}
				}
			}
			journal.push(batch); sequence = batch.commitSeq; tip = batch.recordKind === "lifecycle-batch" ? batch.contentHash : journalHash(batch);
		}
	}
	for (const [name, bytes] of files) {
		if (name.startsWith("artifacts/sha256/") && path.basename(name) !== digest(bytes)) diagnostics.push(`artifact digest mismatch: ${name}`);
	}
	const onDiskSeq = files.get("commit-seq.json");
	if (onDiskSeq) { try { const n = JSON.parse(onDiskSeq.toString("utf8")).commitSeq; if (!Number.isSafeInteger(n) || n > sequence) diagnostics.push("commit sequence projection exceeds valid journal"); } catch { diagnostics.push("invalid commit sequence projection"); } }
	return { exportKind: kind, executePromise: false, header, sourcePath: root, integrity: diagnostics.length ? "damaged" : "verified", verificationScope: "captured-bytes-and-journal-structure", diagnostics,
		files: [...files].map(([name, bytes]) => ({ path: name, sha256: digest(bytes), size: bytes.length, ...(kind === "readonly" ? { bytesBase64: bytes.toString("base64") } : {}) })), journal, receipts };
}
/** Performs no source writes and does not call recovery/openControlStore. Damaged
 * bytes remain available in readonly export; lossy export explicitly omits raw
 * bytes. A concurrent change fails rather than claiming a coherent snapshot. */
export async function exportProjectEvidence<C>(storePath: string, kind: "readonly" | "lossy", context: C, authority: ProjectLifecycleAuthority<C>): Promise<ProjectForensicExport> {
	if (kind !== "readonly" && kind !== "lossy") fail("unknown forensic export kind");
	const root = directory(storePath), identity = fs.statSync(root), header = headerAt(root);
	const principal = await authorize(authority, context, "export", header);
	const first = collect(root), result = parseEvidence(root, header, first, kind);
	if (await authorize(authority, context, "export", header) !== principal) throw new ControlError("TF_AUTHORITY_REVOKED", "export authority changed");
	const second = collect(root), current = fs.statSync(root);
	if (identity.dev !== current.dev || identity.ino !== current.ino || !sameHeader(header, headerAt(root)) || fingerprint(first) !== fingerprint(second)) fail("project evidence changed during forensic snapshot");
	return result;
}

/** Same inode/device is necessary; a copied directory cannot adopt an identity
 * using a caller's claim that the original is gone. Explicit adoption is only
 * accepted for the same proven moved store until a stronger global fence exists. */
export async function rebindMovedProject<C>(storePath: string, context: C, authority: ProjectLifecycleAuthority<C>, operation: "move-rebind" | "adopt" = "move-rebind"): Promise<ControlStoreHeader> {
	const root = directory(storePath), header = headerAt(root);
	const principal = await authorize(authority, context, operation, header, root);
	const release = acquireWriterLock(root);
	try {
		const original = read(path.join(root, "header"));
		if (!sameHeader(header, headerAt(root))) fail("header changed during identity maintenance");
		const stat = fs.statSync(root), binding = header.directoryBinding;
		if (binding.device !== String(stat.dev) || binding.inode !== String(stat.ino)) fail("copy/adopt exclusivity is unproven; create a fresh project and domain");
		if (binding.canonicalPath === root) return header;
		try { fs.lstatSync(binding.canonicalPath); fail("old project binding still exists; identity cannot be rebound"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const beforeFiles = collect(root), evidence = parseEvidence(root, header, beforeFiles, "readonly");
		if (evidence.integrity !== "verified") fail("damaged project evidence cannot authorize identity maintenance");
		const runs = new Map(evidence.journal.flatMap(batch => batch.recordKind === "lifecycle-batch" && batch.projection ? [[batch.projection.run.runId, batch.projection.run] as const] : []));
		for (const run of runs.values()) if (!isTerminalRunStatus(run.status) && !(run.status === "paused" && run.stage === "parked" && run.slot === "released" && run.requiresReadmission === true)) fail("active or ambiguous run prevents exclusive project rebind");
		if (await authorize(authority, context, operation, header, root) !== principal) throw new ControlError("TF_AUTHORITY_REVOKED", "identity maintenance authority changed");
		const current = fs.statSync(root);
		if (current.dev !== stat.dev || current.ino !== stat.ino || !read(path.join(root, "header")).equals(original) || fingerprint(beforeFiles) !== fingerprint(collect(root))) fail("project binding or evidence changed before header publication");
		try { fs.lstatSync(binding.canonicalPath); fail("old project binding reappeared"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const updated = { ...header, directoryBinding: { ...binding, canonicalPath: root } };
		writeJsonAtomicHardened(path.join(root, "header"), updated); return updated;
	} finally { release(); }
}

/** Copies no authoritative history. A copied ledger stays untouched as evidence;
 * destination must be a separate empty path and receives two fresh UUIDs. */
export async function createProjectClone<C>(sourcePath: string, destinationPath: string, context: C, authority: ProjectLifecycleAuthority<C>): Promise<ControlStoreHeader> {
	const source = directory(sourcePath), header = headerAt(source);
	const parent = directory(path.dirname(path.resolve(destinationPath))), destination = path.join(parent, path.basename(destinationPath));
	if (destination === source || destination.startsWith(source + path.sep)) fail("clone destination must be outside the source ledger");
	const principal = await authorize(authority, context, "clone", header, destination);
	if (await authorize(authority, context, "clone", header, destination) !== principal) throw new ControlError("TF_AUTHORITY_REVOKED", "clone authority changed");
	if (!sameHeader(header, headerAt(source))) fail("source identity changed during clone authorization");
	// Exclusive mkdir prevents an existing copied ledger from being overwritten.
	try { fs.mkdirSync(destination, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("clone destination already exists; preserve it and choose a fresh directory"); throw error; }
	const store = openControlStore(destination);
	try { return store.header; } finally { store.close(); }
}
