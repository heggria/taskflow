/**
 * Subordinate immutable evidence storage. The project journal remains authority.
 * These internal ports MUST be implemented by the authenticated ControlHost and
 * its fenced store, never from request body fields. No standalone receipt
 * admission, authentication, journal migration, or physical retention is implied.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { canonicalJson } from "taskflow-core/flowir/hash";
import { ControlError, reconcileRequired } from "../errors.ts";
import {
	ArtifactRefSchema, ControlEventSchema, ReceiptSchema, CONTROL_WIRE_SCHEMA_VERSION,
	type ArtifactRef, type ControlEvent, type Receipt, type ReceiptAssurance,
	type BuildInfoWire,
} from "../schema/index.ts";

export interface EvidenceChainEntry {
	event: ControlEvent;
	previousHash: string;
	hash: string;
}

/** Committed projection; the adapter must derive it from its validated ledger. */
export interface EvidenceRun {
	runId: string;
	eventIds: readonly string[];
	boundPlanHash?: string;
	boundFragmentHash?: string;
	artifactRefs: readonly ArtifactRef[];
	assurance: ReceiptAssurance;
	buildInfo: BuildInfoWire;
	/** Durable TE evidence reference, resolved by the required trusted reader. */
	terminalEvidenceId?: string;
}

export interface IssuedEvidenceReceipt {
	receiptRef: ArtifactRef;
	manifestProofRef: ArtifactRef;
}

/**
 * All projections (runs/commands/receipts) must be derived by the owner's
 * validated journal reader. Hash checking below detects changed chain bytes;
 * it does not turn an untrusted caller-supplied anchor into a trust root.
 */
export interface EvidenceLedgerView {
	projectId: string;
	controlDomainId: string;
	directoryBinding: { canonicalPath: string; device: string; inode: string };
	anchorHash: string;
	tipHash: string;
	tipCommitSeq: number;
	events: readonly EvidenceChainEntry[];
	runs: Readonly<Record<string, EvidenceRun>>;
	commands: Readonly<Record<string, { responseArtifactRef?: ArtifactRef }>>;
	receipts: Readonly<Record<string, IssuedEvidenceReceipt>>;
}

export interface EvidenceStoreOptions {
	storePath: string;
	ledger: {
		read(): EvidenceLedgerView | Promise<EvidenceLedgerView>;
		/**
		 * Hold the SAME writer fence until the returned operation Promise settles,
		 * including disclosures. ALL journal/projection mutations must use this
		 * fence; reads within it must not recursively acquire it. Authorization
		 * must evaluate current policy at completion, not return a cached grant.
		 */
		withWriter<T>(operation: (view: EvidenceLedgerView) => Promise<T>): Promise<T>;
		/** Atomic journal marker + tip CAS, called INSIDE the existing writer fence. */
		commitReceiptOnce(runId: string, prepared: PreparedEvidenceReceipt): Promise<void>;
	};
	/** Resolve an authenticated transport actor and recheck CURRENT policy. */
	authorize(actor: unknown, scope: {
		projectId: string; controlDomainId: string;
		target: { kind: "run" | "command"; id: string };
		artifactRef?: ArtifactRef;
	}): { principal: string; authorizationContextHash: string } | Promise<{ principal: string; authorizationContextHash: string }>;
	terminalEvidence: {
		/** Must reject live processes/jobs, ambiguous jobs and pending/dirty intents. */
		verify(project: { projectId: string; controlDomainId: string }, runId: string, evidenceId: string): TerminalEvidenceObservation | Promise<TerminalEvidenceObservation>;
	};
	/** Optional fault observer; never supplies authority. */
	onDurabilityPoint?: (point: "file-fsynced" | "file-published") => void;
}

export interface TerminalEvidenceObservation {
	terminalStatus: "completed" | "failed" | "blocked" | "cancelled";
	terminalEventId: string;
	evidenceCommit: string;
	providerOutcome: "completed" | "failed" | "operator-intervened";
}

interface ManifestProof {
	version: 1;
	projectId: string;
	controlDomainId: string;
	runId: string;
	entries: { eventId: string; commitSeq: number; eventDigest: string }[];
}

export interface PreparedEvidenceReceipt extends IssuedEvidenceReceipt {
	receipt: Receipt;
	expectedTip: { commitSeq: number; hash: string };
}

interface DirectoryIdentity { path: string; device: number; inode: number }
interface ArtifactPath { file: string; directories: DirectoryIdentity[] }

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
	throw new ControlError("TF_DURABILITY_FAILED", message, { recoveryAction: "operator", sideEffects: "unknown" });
}

function digest(bytes: Uint8Array | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

export function evidenceEventHash(previousHash: string, event: ControlEvent): string {
	if (!HEX.test(previousHash)) fail("invalid evidence chain predecessor");
	return digest(canonicalJson({ format: "taskflow:control-event:v1", previousHash, event }));
}

function proofRoot(proof: ManifestProof): string {
	return digest(canonicalJson({ format: "taskflow:receipt-manifest:v1", proof }));
}

function validRef(ref: ArtifactRef): void {
	if (!Value.Check(ArtifactRefSchema, ref) || !HEX.test(ref.digest) || !Number.isSafeInteger(ref.size)) fail("invalid artifact reference");
}

function sameRef(a: ArtifactRef, b: ArtifactRef): boolean { return canonicalJson(a) === canonicalJson(b); }

/** Resolve committed run artifacts without inventing Receipt metadata for live runs.
 * Callers outside EvidenceStore must supply the validated owner ledger view. */
export function evidenceRunArtifactRefs(view: EvidenceLedgerView, runId: string): readonly ArtifactRef[] {
	if (Object.hasOwn(view.runs, runId)) return view.runs[runId].artifactRefs;
	const scoped = view.events.filter(({ event }) => event.correlationId === runId);
	if (!scoped.some(({ event }) => event.payload.kind === "run.snapshot" && event.payload.run.runId === runId
		&& event.payload.run.projectId === view.projectId && event.payload.run.controlDomainId === view.controlDomainId)) return [];
	const refs: ArtifactRef[] = [];
	for (const { event } of scoped) {
		if (event.payload.kind !== "artifact.recorded" || event.payload.runId !== runId) continue;
		const ref = event.payload.artifact;
		if (!refs.some(candidate => sameRef(candidate, ref))) refs.push(ref);
	}
	return refs;
}

/** Logical compaction only. No method in this class deletes journal or blobs. */
export class EvidenceStore {
	readonly #options: EvidenceStoreOptions;
	readonly #root: string;
	readonly #identity: { projectId: string; controlDomainId: string; device: string; inode: string };
	#failed = false;

	private constructor(options: EvidenceStoreOptions, initial: EvidenceLedgerView) {
		if (!options.ledger || typeof options.ledger.read !== "function" || typeof options.ledger.withWriter !== "function" || typeof options.ledger.commitReceiptOnce !== "function"
			|| typeof options.authorize !== "function" || typeof options.terminalEvidence?.verify !== "function") fail("evidence store requires trusted ledger, writer, terminal evidence and live authorization ports");
		this.#options = options;
		const supplied = path.resolve(options.storePath);
		if (fs.lstatSync(supplied).isSymbolicLink()) fail("evidence root is a symlink");
		this.#root = fs.realpathSync(supplied);
		this.#identity = { projectId: initial.projectId, controlDomainId: initial.controlDomainId,
			device: initial.directoryBinding.device, inode: initial.directoryBinding.inode };
		this.#validateView(initial);
	}

	static async open(options: EvidenceStoreOptions): Promise<EvidenceStore> {
		if (!options.ledger || typeof options.ledger.read !== "function") fail("evidence store requires trusted ledger");
		return new EvidenceStore(options, await options.ledger.read());
	}

	#validateView(view: EvidenceLedgerView): void {
		if (this.#failed) fail("evidence store is fail-closed; reopen after recovery");
		const st = fs.lstatSync(this.#root);
		if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(this.#root) !== this.#root
			|| view.projectId !== this.#identity.projectId || view.controlDomainId !== this.#identity.controlDomainId
			|| String(st.dev) !== this.#identity.device || String(st.ino) !== this.#identity.inode
			|| view.directoryBinding.canonicalPath !== this.#root
			|| view.directoryBinding.device !== String(st.dev) || view.directoryBinding.inode !== String(st.ino)) fail("evidence store directory identity changed");
		if (!UUID.test(view.projectId) || !UUID.test(view.controlDomainId) || !HEX.test(view.anchorHash)
			|| !HEX.test(view.tipHash) || !Number.isSafeInteger(view.tipCommitSeq) || view.tipCommitSeq < 0) fail("invalid evidence ledger identity or tip");
		let previous = view.anchorHash;
		let sequence = 0;
		const ids = new Set<string>();
		for (const entry of view.events) {
			const event = entry.event;
			if (!Value.Check(ControlEventSchema, event) || !Number.isSafeInteger(event.commitSeq)
				|| event.projectId !== view.projectId || event.controlDomainId !== view.controlDomainId
				|| event.commitSeq < sequence || event.commitSeq > sequence + 1 || event.commitSeq < 1
				|| ids.has(event.eventId) || entry.previousHash !== previous
				|| entry.hash !== evidenceEventHash(previous, event)) fail("invalid evidence ledger chain");
			ids.add(event.eventId);
			previous = entry.hash;
			sequence = event.commitSeq;
		}
		if (previous !== view.tipHash || sequence !== view.tipCommitSeq) fail("evidence ledger tip does not match complete retained chain");
		this.#floor(view);
	}

	async #write<T>(operation: (view: EvidenceLedgerView) => T | Promise<T>): Promise<T> {
		return this.#options.ledger.withWriter(async (view) => {
			this.#validateView(view);
			try { return await operation(view); } catch (error) {
				if (!(error instanceof ControlError) || error.code === "TF_DURABILITY_FAILED") this.#failed = true;
				throw error;
			}
		});
	}

	#path(ref: ArtifactRef, create: boolean): ArtifactPath {
		validRef(ref);
		let current = this.#root;
		const root = fs.lstatSync(current);
		if (!root.isDirectory() || root.isSymbolicLink() || fs.realpathSync(current) !== current
			|| String(root.dev) !== this.#identity.device || String(root.ino) !== this.#identity.inode) fail("evidence root identity changed");
		const directories: DirectoryIdentity[] = [{ path: current, device: root.dev, inode: root.ino }];
		for (const part of ["artifacts", "sha256", ref.digest.slice(0, 2)]) {
			current = path.join(current, part);
			if (create && !fs.existsSync(current)) {
				fs.mkdirSync(current, { mode: 0o700 });
				const parentFd = fs.openSync(path.dirname(current), "r");
				try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
			}
			const st = fs.lstatSync(current);
			if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(current) !== current) fail("artifact directory is not a confined regular directory");
			directories.push({ path: current, device: st.dev, inode: st.ino });
		}
		const file = path.join(current, ref.digest);
		try { if (!fs.lstatSync(file).isFile()) fail("artifact destination is not a regular file"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return { file, directories };
	}

	// Revalidate every ancestor at durability boundaries, including before any
	// cleanup. Portable Node path APIs cannot guarantee confinement against a
	// hostile same-UID process replacing paths between individual syscalls.
	#assertDirectories(directories: readonly DirectoryIdentity[]): void {
		for (const directory of directories) {
			const st = fs.lstatSync(directory.path);
			if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== directory.device || st.ino !== directory.inode
				|| fs.realpathSync(directory.path) !== directory.path) fail("artifact directory identity changed");
		}
	}

	#read(ref: ArtifactRef): Buffer {
		const { file, directories } = this.#path(ref, false);
		this.#assertDirectories(directories);
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		let bytes: Buffer;
		try {
			if (!fs.fstatSync(fd).isFile()) fail("artifact is not a regular file");
			bytes = fs.readFileSync(fd);
		} finally { fs.closeSync(fd); }
		this.#assertDirectories(directories);
		if (bytes.length !== ref.size || digest(bytes) !== ref.digest) fail("artifact bytes do not match committed reference");
		return bytes;
	}

	#stage(bytes: Uint8Array, metadata: Omit<ArtifactRef, "digest" | "size">): ArtifactRef {
		if (metadata.redactionClass === "secret") throw new ControlError("TF_POLICY_DENIED", "secret material must use SecretRef, not the generic artifact store");
		const ref: ArtifactRef = { ...metadata, size: bytes.length, digest: digest(bytes) };
		const { file, directories } = this.#path(ref, true);
		if (fs.existsSync(file)) { this.#read(ref); return ref; }
		const temp = path.join(path.dirname(file), `.${crypto.randomUUID()}`);
		this.#assertDirectories(directories);
		const fd = fs.openSync(temp, "wx", 0o600);
		const tempIdentity = fs.fstatSync(fd);
		try {
			try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			this.#options.onDurabilityPoint?.("file-fsynced");
			this.#assertDirectories(directories);
			const staged = fs.lstatSync(temp);
			if (!staged.isFile() || staged.dev !== tempIdentity.dev || staged.ino !== tempIdentity.ino) fail("staged artifact identity changed");
			try { fs.linkSync(temp, file); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				this.#read(ref);
			}
			this.#assertDirectories(directories);
			const directoryFd = fs.openSync(path.dirname(file), "r");
			try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
			this.#options.onDurabilityPoint?.("file-published");
			this.#assertDirectories(directories);
			this.#read(ref);
		} finally {
			// Preserve forensic staging bytes if the original directory or file was
			// replaced. In particular, never follow a replacement symlink to clean up.
			let unchanged = false;
			try {
				this.#assertDirectories(directories);
				const staged = fs.lstatSync(temp);
				unchanged = staged.isFile() && staged.dev === tempIdentity.dev && staged.ino === tempIdentity.ino;
			} catch { /* Untrusted cleanup path: leave it alone. */ }
			if (unchanged) fs.unlinkSync(temp);
		}
		return ref;
	}

	async stageArtifact(bytes: Uint8Array, metadata: Omit<ArtifactRef, "digest" | "size">): Promise<ArtifactRef> {
		return this.#write(() => this.#stage(bytes, metadata));
	}

	/** Owner must call under its commit fence before acknowledging acceptance. */
	async assertDurableReferences(refs: readonly ArtifactRef[]): Promise<void> {
		await this.#write(() => { for (const ref of refs) this.#read(ref); });
	}

	#json(value: unknown, mediaType: string): ArtifactRef {
		return this.#stage(Buffer.from(canonicalJson(value)), { mediaType, storageClass: "local", redactionClass: "internal" });
	}

	#run(view: EvidenceLedgerView, runId: string): EvidenceRun {
		if (!UUID.test(runId) || !Object.hasOwn(view.runs, runId)) fail("run has no committed evidence");
		const run = view.runs[runId];
		if (run.runId !== runId || (!run.boundPlanHash && !run.boundFragmentHash)) fail("run evidence identity or bound plan missing");
		return run;
	}

	#proof(view: EvidenceLedgerView, run: EvidenceRun): ManifestProof {
		const selected = new Set(run.eventIds);
		const events = view.events.filter(({ event }) => selected.has(event.eventId));
		if (selected.size !== run.eventIds.length || events.length !== selected.size || events.length === 0
			|| events.some(({ event }, index) => event.eventId !== run.eventIds[index])) fail("run event manifest is incomplete, duplicated or out of order");
		return { version: 1, projectId: view.projectId, controlDomainId: view.controlDomainId, runId: run.runId,
			entries: events.map(({ event }) => ({ eventId: event.eventId, commitSeq: event.commitSeq,
				eventDigest: digest(canonicalJson(event)) })) };
	}

	/** Internal preparation only; its blobs remain unreachable until committed. */
	async prepareFinalReceipt(runId: string): Promise<PreparedEvidenceReceipt> {
		return this.#write((view) => this.#prepare(view, runId));
	}

	/** Trusted control service entry. Holds the owner fence through commit-once. */
	async issueFinalReceipt(runId: string): Promise<Receipt> {
		return this.#write(async (view) => {
			const prepared = await this.#prepare(view, runId);
			if (!Object.hasOwn(view.receipts, runId)) {
				await this.#options.ledger.commitReceiptOnce(runId, prepared);
			}
			const committed = await this.#options.ledger.read();
			this.#validateView(committed);
			if (!Object.hasOwn(committed.receipts, runId)) fail("receipt journal commit did not establish reachability");
			const issued = committed.receipts[runId];
			if (!sameRef(issued.receiptRef, prepared.receiptRef) || !sameRef(issued.manifestProofRef, prepared.manifestProofRef)) fail("receipt commit returned a different immutable outcome");
			return this.#verifyReceipt(committed, runId, issued);
		});
	}

	async #prepare(view: EvidenceLedgerView, runId: string): Promise<PreparedEvidenceReceipt> {
		const expectedTip = { commitSeq: view.tipCommitSeq, hash: view.tipHash };
		if (Object.hasOwn(view.receipts, runId)) {
			const existing = view.receipts[runId];
			return { ...existing, receipt: this.#verifyReceipt(view, runId, existing), expectedTip };
		}
		const run = this.#run(view, runId);
		const proof = this.#proof(view, run);
		const last = view.events.find(({ event }) => event.eventId === run.eventIds.at(-1))!.event;
		if (last.payload.kind !== "run.terminal" || !run.terminalEvidenceId) throw reconcileRequired("final Receipt requires committed terminal and complete provider quiescence evidence");
		const termination = await this.#options.terminalEvidence.verify(view, runId, run.terminalEvidenceId);
		this.#validateView(view);
		if (termination.terminalStatus !== last.payload.status || termination.terminalEventId !== last.eventId || !termination.evidenceCommit
			|| !["completed", "failed", "operator-intervened"].includes(termination.providerOutcome)) throw reconcileRequired("terminal evidence is incomplete or ambiguous");
		for (const ref of run.artifactRefs) this.#read(ref);
		const receipt: Receipt = {
			schemaVersion: CONTROL_WIRE_SCHEMA_VERSION, controlDomainId: view.controlDomainId, runId,
			...(run.boundPlanHash ? { boundPlanHash: run.boundPlanHash } : {}),
			...(run.boundFragmentHash ? { boundFragmentHash: run.boundFragmentHash } : {}),
			eventManifest: [...run.eventIds], manifestRoot: proofRoot(proof),
			startCommitSeq: proof.entries[0].commitSeq, endCommitSeq: proof.entries.at(-1)!.commitSeq,
			artifactRefs: [...run.artifactRefs], assurance: { ...run.assurance, providerOutcome: termination.providerOutcome, journalContinuity: true, artifactIntegrity: "verified" },
			buildInfo: run.buildInfo,
		};
		if (!Value.Check(ReceiptSchema, receipt)) fail("derived Receipt failed schema validation");
		const manifestProofRef = this.#json(proof, "application/vnd.taskflow.manifest+json");
		const receiptRef = this.#json(receipt, "application/vnd.taskflow.receipt+json");
		return { receipt, receiptRef, manifestProofRef, expectedTip };
	}

	async #disclose<T>(actor: unknown, target: { kind: "run" | "command"; id: string }, artifactRef: ArtifactRef | undefined,
		read: (view: EvidenceLedgerView) => T): Promise<T> {
		return this.#write(async (view) => {
			const authorize = () => this.#options.authorize(actor, { projectId: view.projectId, controlDomainId: view.controlDomainId,
				target, ...(artifactRef ? { artifactRef } : {}) });
			const validateDecision = (decision: Awaited<ReturnType<EvidenceStoreOptions["authorize"]>>) => {
				if (!decision || typeof decision.principal !== "string" || decision.principal.length === 0
					|| !HEX.test(decision.authorizationContextHash)) throw new ControlError("TF_POLICY_DENIED", "evidence authorization decision unavailable");
			};
			validateDecision(await authorize());
			// The owner fence protects this fresh projection through disclosure. A
			// final live policy check must follow the last asynchronous ledger read:
			// revocation during that read may not reuse the earlier decision.
			const current = await this.#options.ledger.read();
			this.#validateView(current);
			validateDecision(await authorize());
			this.#validateView(current);
			// No await between final authorization, reachability and filesystem read.
			return read(current);
		});
	}

	async readArtifact(actor: unknown, target: { kind: "run" | "command"; id: string }, ref: ArtifactRef): Promise<Buffer> {
		return this.#disclose(actor, target, ref, (view) => {
			validRef(ref);
			const refs = target.kind === "run"
				? evidenceRunArtifactRefs(view, target.id)
				: (Object.hasOwn(view.commands, target.id) && view.commands[target.id].responseArtifactRef ? [view.commands[target.id].responseArtifactRef!] : []);
			if (!refs.some((candidate) => sameRef(candidate, ref))) throw new ControlError("TF_POLICY_DENIED", "artifact has no authorized ledger reference");
			return this.#read(ref);
		});
	}

	#verifyReceipt(view: EvidenceLedgerView, runId: string, issued: IssuedEvidenceReceipt): Receipt {
		let receipt: Receipt;
		let proof: ManifestProof;
		try {
			receipt = JSON.parse(this.#read(issued.receiptRef).toString("utf8"));
			proof = JSON.parse(this.#read(issued.manifestProofRef).toString("utf8"));
		} catch { return fail("committed Receipt or manifest proof is missing or damaged"); }
		const run = this.#run(view, runId);
		const expected = this.#proof(view, run);
		if (!Value.Check(ReceiptSchema, receipt) || receipt.runId !== runId || receipt.controlDomainId !== view.controlDomainId
			|| receipt.boundPlanHash !== run.boundPlanHash || receipt.boundFragmentHash !== run.boundFragmentHash
			|| canonicalJson(receipt.artifactRefs) !== canonicalJson(run.artifactRefs)
			|| canonicalJson(receipt.buildInfo) !== canonicalJson(run.buildInfo)
			|| canonicalJson(proof) !== canonicalJson(expected) || receipt.manifestRoot !== proofRoot(expected)
			|| canonicalJson(receipt.eventManifest) !== canonicalJson(expected.entries.map((entry) => entry.eventId))
			|| receipt.startCommitSeq !== expected.entries[0].commitSeq || receipt.endCommitSeq !== expected.entries.at(-1)!.commitSeq) fail("Receipt manifest does not match committed run evidence");
		return receipt;
	}

	async readReceipt(actor: unknown, runId: string): Promise<{ receipt: Receipt; verification: { artifactIntegrity: "verified" | "unknown" } }> {
		return this.#disclose(actor, { kind: "run", id: runId }, undefined, (view) => {
			if (!Object.hasOwn(view.receipts, runId)) throw new ControlError("TF_POLICY_DENIED", "run has no issued Receipt");
			const receipt = this.#verifyReceipt(view, runId, view.receipts[runId]);
			let artifactIntegrity: "verified" | "unknown" = "verified";
			for (const ref of receipt.artifactRefs) {
				try { this.#read(ref); } catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") artifactIntegrity = "unknown";
					else throw error;
				}
			}
			return { receipt, verification: { artifactIntegrity } };
		});
	}

	#floor(view: EvidenceLedgerView): number {
		let through = 0;
		for (const { event } of view.events) if (event.payload.kind === "compaction.checkpoint") {
			if (!Number.isSafeInteger(event.payload.throughCommitSeq) || event.payload.throughCommitSeq < through
				|| event.payload.throughCommitSeq >= event.commitSeq) fail("invalid committed compaction checkpoint");
			through = event.payload.throughCommitSeq;
		}
		return through + 1;
	}

	async prepareCheckpoint(throughCommitSeq: number): Promise<{ eventPayload: { kind: "compaction.checkpoint"; throughCommitSeq: number }; expectedTip: { commitSeq: number; hash: string } }> {
		return this.#write((view) => {
			if (!Number.isSafeInteger(throughCommitSeq) || throughCommitSeq < this.#floor(view) || throughCommitSeq > view.tipCommitSeq) fail("invalid logical compaction boundary");
			// Full chain remains on disk. Validate issued evidence before advancing
			// visibility; this method never commits a checkpoint or deletes a byte.
			for (const [runId, issued] of Object.entries(view.receipts)) this.#verifyReceipt(view, runId, issued);
			return { eventPayload: { kind: "compaction.checkpoint", throughCommitSeq }, expectedTip: { commitSeq: view.tipCommitSeq, hash: view.tipHash } };
		});
	}

	async checkCursor(cursor: { nextCommitSeq: number; leaseExpiresAt: number }, now: number): Promise<{ minAvailableCommitSeq: number }> {
		const view = await this.#options.ledger.read();
		this.#validateView(view);
		const minAvailableCommitSeq = this.#floor(view);
		if (!Number.isSafeInteger(now) || !Number.isSafeInteger(cursor.nextCommitSeq) || !Number.isSafeInteger(cursor.leaseExpiresAt)
			|| cursor.nextCommitSeq < minAvailableCommitSeq || cursor.leaseExpiresAt <= now) throw new ControlError("TF_CURSOR_EXPIRED", "cursor requires checkpoint resync", { recoveryAction: "refresh" });
		return { minAvailableCommitSeq };
	}
}

export async function createEvidenceStore(options: EvidenceStoreOptions): Promise<EvidenceStore> { return EvidenceStore.open(options); }
