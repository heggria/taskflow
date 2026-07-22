/**
 * Project ControlStore — sole Run/Command/Approval/Receipt authority (D6).
 * Files-only engine (P14): atomic batch commits under exclusive lock, fsync,
 * rebuildable indexes. commitSeq is re-read from disk inside the lock so two
 * open handles cannot mint the same sequence.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONTROL_STORE_SCHEMA_VERSION,
	type CommandRecord,
	type ControlEvent,
	type ControlStoreHeader,
	type DirectoryBinding,
	type Receipt,
	type RunProjection,
} from "../types.ts";
import { newId } from "../hash.ts";
import {
	ensureDir,
	projectCommandsDir,
	projectControlRoot,
	projectHeaderPath,
	projectJournalDir,
	projectProjectionsDir,
	projectReceiptsDir,
	readJsonFile,
	withExclusiveLockFile,
	writeFileAtomic,
} from "../paths.ts";

export interface CommitBatch {
	command?: CommandRecord;
	events: ControlEvent[];
	run?: RunProjection;
	receipt?: Receipt;
}

export type CompareAndCommitFailCode = "TF_NOT_FOUND" | "TF_STALE_VERSION" | "TF_INVALID_ARGUMENT";

export type CompareAndCommitResult =
	| {
			ok: true;
			run: RunProjection;
			receipt?: Receipt;
			commitSeqStart: number;
			commitSeqEnd: number;
	  }
	| {
			ok: false;
			code: CompareAndCommitFailCode;
			message: string;
			run?: RunProjection;
	  };

export interface CompareAndCommitOpts {
	runId: string;
	/** When set, re-read under lock must match (first-commit-wins dual-client CAS). */
	expectedRunVersion?: number;
	/** Return error message to reject (TF_INVALID_ARGUMENT); null = ok. */
	validate?: (run: RunProjection) => string | null;
	/** Build the mutation from the locked durable run snapshot. */
	build: (run: RunProjection) => {
		run: RunProjection;
		events: ControlEvent[];
		command?: CommandRecord;
		receipt?: Receipt;
	};
}

export interface ProjectControlStore {
	readonly projectRoot: string;
	readonly header: ControlStoreHeader;
	/** Atomic commit: exclusive lock + re-read seq + contiguous commitSeq + fsync. */
	commit(batch: CommitBatch): { commitSeqStart: number; commitSeqEnd: number };
	/**
	 * Dual-client first-commit-wins: under exclusive commit lock, re-read run,
	 * check expectedRunVersion + validate, then commit in the same critical section.
	 */
	compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult;
	/** Rebuild projections from journal (also runs on open). */
	recoverFromJournal(): { rebuiltRuns: number; rebuiltCommands: number; rebuiltReceipts: number };
	/**
	 * Atomic command claim under commit.lock — concurrent same commandId:
	 * same hash → existing; different hash → conflict; missing → claim.
	 */
	claimCommand(input: {
		commandId: string;
		requestHash: string;
		callerPrincipal: string;
		kind: string;
		runId: string;
	}):
		| { kind: "claimed" }
		| { kind: "existing"; command: CommandRecord }
		| { kind: "conflict"; command: CommandRecord };
	getRun(runId: string): RunProjection | null;
	listRuns(): RunProjection[];
	getReceipt(receiptId: string): Receipt | null;
	getReceiptForRun(runId: string): Receipt | null;
	getCommand(commandId: string): CommandRecord | null;
	/** Resolve runId for a prior command (idempotent disclosure). */
	getRunIdForCommand(commandId: string): string | null;
	nextCommitSeq(): number;
	/** Events in [start, end] inclusive by commitSeq. */
	readEvents(startCommitSeq: number, endCommitSeq: number): ControlEvent[];
}

function bindDirectory(projectRoot: string): DirectoryBinding {
	const resolved = path.resolve(projectRoot);
	let inode: string | undefined;
	let dev: string | undefined;
	try {
		const st = fs.statSync(resolved);
		inode = String(st.ino);
		dev = String(st.dev);
	} catch {
		/* path may not exist yet */
	}
	return { path: resolved, inode, dev };
}

/**
 * Open or create the project ControlStore at projectRoot.
 * Registry is NOT authoritative — header is the source of projectId/domainId.
 *
 * Header create/open is under exclusive lock so concurrent first-opens
 * (cross-process) mint a single projectId/controlDomainId.
 */
export function openProjectControlStore(projectRoot: string): ProjectControlStore {
	const root = path.resolve(projectRoot);
	ensureDir(projectControlRoot(root));
	ensureDir(projectJournalDir(root));
	ensureDir(projectProjectionsDir(root));
	ensureDir(projectCommandsDir(root));
	ensureDir(projectReceiptsDir(root));

	const headerPath = projectHeaderPath(root);
	const headerLockPath = path.join(projectControlRoot(root), "header.lock");

	// Cross-process identity mint: lock → re-read → create-if-missing → write.
	const header = withExclusiveLockFile(headerLockPath, () => {
		const existing = readJsonFile<ControlStoreHeader>(headerPath);
		if (existing) {
			const refreshed: ControlStoreHeader = {
				...existing,
				directoryBinding: {
					...existing.directoryBinding,
					path: path.resolve(root),
				},
				updatedAt: Date.now(),
			};
			// Preserve identity fields exactly; only refresh binding path.
			writeFileAtomic(headerPath, JSON.stringify(refreshed, null, 2));
			return refreshed;
		}
		const now = Date.now();
		const created: ControlStoreHeader = {
			schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
			projectId: newId("proj"),
			controlDomainId: newId("dom"),
			directoryBinding: bindDirectory(root),
			createdAt: now,
			updatedAt: now,
		};
		writeFileAtomic(headerPath, JSON.stringify(created, null, 2));
		// Re-read after write in case another process won a rare race after unlock
		// (should not happen under lock; defensive).
		return readJsonFile<ControlStoreHeader>(headerPath) ?? created;
	});

	const seqPath = path.join(projectControlRoot(root), "commit-seq.json");
	const commitLockPath = path.join(projectControlRoot(root), "commit.lock");

	function readSeqNext(): number {
		return readJsonFile<{ next: number }>(seqPath)?.next ?? 1;
	}

	// Mutable local cache; identity fields never change after first create.
	let headerCache = header;

	function readRunFromDisk(runId: string): RunProjection | null {
		return readJsonFile<RunProjection>(
			path.join(projectProjectionsDir(root), `run-${runId}.json`),
		);
	}

	/**
	 * Journal is authoritative: rebuild run projections / command indexes / receipt
	 * indexes from journal segments when projections are missing (half-commit recovery).
	 */
	function rebuildFromJournal(): { rebuiltRuns: number; rebuiltCommands: number; rebuiltReceipts: number } {
		const dir = projectJournalDir(root);
		let rebuiltRuns = 0;
		let rebuiltCommands = 0;
		let rebuiltReceipts = 0;
		if (!fs.existsSync(dir)) return { rebuiltRuns, rebuiltCommands, rebuiltReceipts };
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		for (const f of files) {
			const entry = readJsonFile<{
				command?: CommandRecord;
				run?: RunProjection;
				receipt?: Receipt;
				events?: ControlEvent[];
			}>(path.join(dir, f));
			if (!entry) continue; // corrupt segment: skip (fail-open recover other segments)
			if (entry.command && isSafeCommandId(entry.command.commandId)) {
				// Later segments overwrite earlier (journal order = authority)
				writeFileAtomic(
					path.join(projectCommandsDir(root), `${entry.command.commandId}.json`),
					JSON.stringify(entry.command, null, 2),
				);
				if (entry.command.runId && isSafeCommandId(entry.command.runId)) {
					writeFileAtomic(
						path.join(projectCommandsDir(root), `by-cmd-${entry.command.commandId}.json`),
						JSON.stringify({ runId: entry.command.runId }, null, 2),
					);
				}
				rebuiltCommands += 1;
			}
			if (entry.run && isSafeCommandId(entry.run.runId)) {
				// Always write: later journal segments win (full rebuild to latest)
				writeFileAtomic(
					path.join(projectProjectionsDir(root), `run-${entry.run.runId}.json`),
					JSON.stringify(entry.run, null, 2),
				);
				rebuiltRuns += 1;
			}
			if (entry.receipt && isSafeCommandId(entry.receipt.receiptId)) {
				writeFileAtomic(
					path.join(projectReceiptsDir(root), `${entry.receipt.receiptId}.json`),
					JSON.stringify(entry.receipt, null, 2),
				);
				if (isSafeCommandId(entry.receipt.runId)) {
					writeFileAtomic(
						path.join(projectReceiptsDir(root), `by-run-${entry.receipt.runId}.json`),
						JSON.stringify({ receiptId: entry.receipt.receiptId }, null, 2),
					);
				}
				rebuiltReceipts += 1;
			}
		}
		return { rebuiltRuns, rebuiltCommands, rebuiltReceipts };
	}

	function isSafeCommandId(id: string): boolean {
		return typeof id === "string" && id.length > 0 && !id.includes("..") && !id.includes("/");
	}

	// Recover half-commits before serving reads.
	rebuildFromJournal();

	/** Caller MUST hold commitLockPath. */
	function commitUnlocked(batch: CommitBatch): { commitSeqStart: number; commitSeqEnd: number } {
		const events = batch.events;
		let next = readSeqNext();
		if (events.length === 0 && !batch.command && !batch.run && !batch.receipt) {
			return { commitSeqStart: next, commitSeqEnd: next - 1 };
		}
		const start = next;
		let seq = start;
		const stamped: ControlEvent[] = events.map((ev, i) => {
			const e: ControlEvent = {
				...ev,
				commitSeq: seq,
				streamSeq: ev.streamSeq || i + 1,
				controlDomainId: headerCache.controlDomainId,
				projectId: headerCache.projectId,
			};
			seq += 1;
			return e;
		});
		if (stamped.length === 0) {
			seq += 1;
		}
		const end = seq - 1;
		next = seq;

		const command: CommandRecord | undefined = batch.command
			? {
					...batch.command,
					firstCommitSeq: batch.command.firstCommitSeq || start,
					lastCommitSeq: end,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
				}
			: undefined;

		const journalEntry = {
			commitSeqStart: start,
			commitSeqEnd: end,
			command,
			events: stamped,
			run: batch.run,
			receipt: batch.receipt,
			recordedAt: Date.now(),
		};
		const journalFile = path.join(
			projectJournalDir(root),
			`${String(start).padStart(12, "0")}-${String(end).padStart(12, "0")}.json`,
		);
		if (fs.existsSync(journalFile)) {
			throw new Error(
				`journal segment collision at commitSeq ${start}-${end} — commit lock / seq broken`,
			);
		}
		writeFileAtomic(journalFile, JSON.stringify(journalEntry, null, 2));
		writeFileAtomic(seqPath, JSON.stringify({ next }, null, 2));

		if (command) {
			writeFileAtomic(
				path.join(projectCommandsDir(root), `${command.commandId}.json`),
				JSON.stringify(command, null, 2),
			);
			if (command.runId) {
				writeFileAtomic(
					path.join(projectCommandsDir(root), `by-cmd-${command.commandId}.json`),
					JSON.stringify({ runId: command.runId }, null, 2),
				);
			}
		}
		if (batch.run) {
			const run = {
				...batch.run,
				projectId: headerCache.projectId,
				controlDomainId: headerCache.controlDomainId,
			};
			writeFileAtomic(
				path.join(projectProjectionsDir(root), `run-${run.runId}.json`),
				JSON.stringify(run, null, 2),
			);
		}
		if (batch.receipt) {
			const receipt = {
				...batch.receipt,
				projectId: headerCache.projectId,
				controlDomainId: headerCache.controlDomainId,
			};
			writeFileAtomic(
				path.join(projectReceiptsDir(root), `${receipt.receiptId}.json`),
				JSON.stringify(receipt, null, 2),
			);
			writeFileAtomic(
				path.join(projectReceiptsDir(root), `by-run-${receipt.runId}.json`),
				JSON.stringify({ receiptId: receipt.receiptId }, null, 2),
			);
		}

		headerCache = { ...headerCache, updatedAt: Date.now() };
		writeFileAtomic(headerPath, JSON.stringify(headerCache, null, 2));

		return { commitSeqStart: start, commitSeqEnd: end };
	}

	const store: ProjectControlStore = {
		projectRoot: root,
		get header() {
			return headerCache;
		},

		nextCommitSeq() {
			// Always durable view — never a stale in-memory counter.
			return readSeqNext();
		},

		commit(batch: CommitBatch) {
			return withExclusiveLockFile(commitLockPath, () => commitUnlocked(batch));
		},

		compareAndCommit(opts: CompareAndCommitOpts): CompareAndCommitResult {
			return withExclusiveLockFile(commitLockPath, () => {
				// Re-read durable projection under the same lock as commit (P15 first-commit-wins).
				const current = readRunFromDisk(opts.runId);
				if (!current) {
					return {
						ok: false as const,
						code: "TF_NOT_FOUND" as const,
						message: `run ${opts.runId} not found`,
					};
				}
				if (
					opts.expectedRunVersion !== undefined &&
					current.runVersion !== opts.expectedRunVersion
				) {
					return {
						ok: false as const,
						code: "TF_STALE_VERSION" as const,
						message: `expected runVersion ${opts.expectedRunVersion}, have ${current.runVersion}`,
						run: current,
					};
				}
				if (opts.validate) {
					const msg = opts.validate(current);
					if (msg) {
						return {
							ok: false as const,
							code: "TF_INVALID_ARGUMENT" as const,
							message: msg,
							run: current,
						};
					}
				}
				const built = opts.build(current);
				const ranges = commitUnlocked({
					command: built.command,
					events: built.events,
					run: built.run,
					receipt: built.receipt,
				});
				return {
					ok: true as const,
					run: built.run,
					receipt: built.receipt,
					commitSeqStart: ranges.commitSeqStart,
					commitSeqEnd: ranges.commitSeqEnd,
				};
			});
		},

		recoverFromJournal() {
			return withExclusiveLockFile(commitLockPath, () => rebuildFromJournal());
		},

		claimCommand(input) {
			return withExclusiveLockFile(commitLockPath, () => {
				const existing = readJsonFile<CommandRecord>(
					path.join(projectCommandsDir(root), `${input.commandId}.json`),
				);
				if (existing) {
					if (existing.requestHash === input.requestHash) {
						return { kind: "existing" as const, command: existing };
					}
					return { kind: "conflict" as const, command: existing };
				}
				const cmd: CommandRecord = {
					commandId: input.commandId,
					requestHash: input.requestHash,
					callerPrincipal: input.callerPrincipal,
					authorizationContextHash: input.requestHash,
					projectId: headerCache.projectId,
					controlDomainId: headerCache.controlDomainId,
					kind: input.kind,
					status: "accepted",
					firstCommitSeq: 0,
					lastCommitSeq: 0,
					runId: input.runId,
					recordedAt: Date.now(),
				};
				writeFileAtomic(
					path.join(projectCommandsDir(root), `${input.commandId}.json`),
					JSON.stringify(cmd, null, 2),
				);
				writeFileAtomic(
					path.join(projectCommandsDir(root), `by-cmd-${input.commandId}.json`),
					JSON.stringify({ runId: input.runId }, null, 2),
				);
				return { kind: "claimed" as const };
			});
		},

		getRun(runId: string) {
			return readRunFromDisk(runId);
		},

		listRuns() {
			const dir = projectProjectionsDir(root);
			if (!fs.existsSync(dir)) return [];
			const out: RunProjection[] = [];
			for (const f of fs.readdirSync(dir)) {
				if (!f.startsWith("run-") || !f.endsWith(".json")) continue;
				const r = readJsonFile<RunProjection>(path.join(dir, f));
				if (r) out.push(r);
			}
			return out.sort((a, b) => b.updatedAt - a.updatedAt);
		},

		getReceipt(receiptId: string) {
			return readJsonFile<Receipt>(path.join(projectReceiptsDir(root), `${receiptId}.json`));
		},

		getReceiptForRun(runId: string) {
			const idx = readJsonFile<{ receiptId: string }>(
				path.join(projectReceiptsDir(root), `by-run-${runId}.json`),
			);
			if (!idx) return null;
			return store.getReceipt(idx.receiptId);
		},

		getCommand(commandId: string) {
			return readJsonFile<CommandRecord>(
				path.join(projectCommandsDir(root), `${commandId}.json`),
			);
		},

		getRunIdForCommand(commandId: string) {
			const idx = readJsonFile<{ runId: string }>(
				path.join(projectCommandsDir(root), `by-cmd-${commandId}.json`),
			);
			if (idx?.runId) return idx.runId;
			const cmd = store.getCommand(commandId);
			return cmd?.runId ?? null;
		},

		readEvents(startCommitSeq: number, endCommitSeq: number) {
			const dir = projectJournalDir(root);
			if (!fs.existsSync(dir)) return [];
			const events: ControlEvent[] = [];
			for (const f of fs.readdirSync(dir).sort()) {
				if (!f.endsWith(".json")) continue;
				const entry = readJsonFile<{
					commitSeqStart: number;
					commitSeqEnd: number;
					events: ControlEvent[];
				}>(path.join(dir, f));
				if (!entry) continue;
				if (entry.commitSeqEnd < startCommitSeq || entry.commitSeqStart > endCommitSeq) continue;
				for (const ev of entry.events) {
					if (ev.commitSeq >= startCommitSeq && ev.commitSeq <= endCommitSeq) {
						events.push(ev);
					}
				}
			}
			return events.sort((a, b) => a.commitSeq - b.commitSeq);
		},
	};

	return store;
}
