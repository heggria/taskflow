/**
 * Project ControlStore — sole Run/Command/Approval/Receipt authority (D6).
 * Files-only engine (P14): atomic batch commits, fsync, rebuildable indexes.
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
	writeFileAtomic,
} from "../paths.ts";

export interface CommitBatch {
	command?: CommandRecord;
	events: ControlEvent[];
	run?: RunProjection;
	receipt?: Receipt;
}

export interface ProjectControlStore {
	readonly projectRoot: string;
	readonly header: ControlStoreHeader;
	/** Atomic commit: assign contiguous commitSeq, fsync journal, update projections. */
	commit(batch: CommitBatch): { commitSeqStart: number; commitSeqEnd: number };
	getRun(runId: string): RunProjection | null;
	listRuns(): RunProjection[];
	getReceipt(receiptId: string): Receipt | null;
	getReceiptForRun(runId: string): Receipt | null;
	getCommand(commandId: string): CommandRecord | null;
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
 */
export function openProjectControlStore(projectRoot: string): ProjectControlStore {
	const root = path.resolve(projectRoot);
	ensureDir(projectControlRoot(root));
	ensureDir(projectJournalDir(root));
	ensureDir(projectProjectionsDir(root));
	ensureDir(projectCommandsDir(root));
	ensureDir(projectReceiptsDir(root));

	const headerPath = projectHeaderPath(root);
	let header = readJsonFile<ControlStoreHeader>(headerPath);
	if (!header) {
		const now = Date.now();
		header = {
			schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
			projectId: newId("proj"),
			controlDomainId: newId("dom"),
			directoryBinding: bindDirectory(root),
			createdAt: now,
			updatedAt: now,
		};
		writeFileAtomic(headerPath, JSON.stringify(header, null, 2));
	} else {
		// Refresh path binding evidence; identity (projectId/domainId) stays.
		header = {
			...header,
			directoryBinding: {
				...header.directoryBinding,
				path: path.resolve(root),
			},
			updatedAt: Date.now(),
		};
		writeFileAtomic(headerPath, JSON.stringify(header, null, 2));
	}

	const seqPath = path.join(projectControlRoot(root), "commit-seq.json");
	const seqState = readJsonFile<{ next: number }>(seqPath) ?? { next: 1 };

	const store: ProjectControlStore = {
		projectRoot: root,
		get header() {
			return header!;
		},

		nextCommitSeq() {
			return seqState.next;
		},

		commit(batch: CommitBatch) {
			const events = batch.events;
			if (events.length === 0 && !batch.command && !batch.run && !batch.receipt) {
				return { commitSeqStart: seqState.next, commitSeqEnd: seqState.next - 1 };
			}
			const start = seqState.next;
			let seq = start;
			const stamped: ControlEvent[] = events.map((ev, i) => {
				const e: ControlEvent = {
					...ev,
					commitSeq: seq,
					streamSeq: ev.streamSeq || i + 1,
					controlDomainId: header!.controlDomainId,
					projectId: header!.projectId,
				};
				seq += 1;
				return e;
			});
			// If no events but we have command/run/receipt, still advance once for the batch.
			if (stamped.length === 0) {
				seq += 1;
			}
			const end = seq - 1;
			seqState.next = seq;

			// Journal entry (atomic)
			const journalEntry = {
				commitSeqStart: start,
				commitSeqEnd: end,
				command: batch.command
					? {
							...batch.command,
							firstCommitSeq: batch.command.firstCommitSeq || start,
							lastCommitSeq: end,
							projectId: header!.projectId,
							controlDomainId: header!.controlDomainId,
						}
					: undefined,
				events: stamped,
				run: batch.run,
				receipt: batch.receipt,
				recordedAt: Date.now(),
			};
			const journalFile = path.join(
				projectJournalDir(root),
				`${String(start).padStart(12, "0")}-${String(end).padStart(12, "0")}.json`,
			);
			writeFileAtomic(journalFile, JSON.stringify(journalEntry, null, 2));
			writeFileAtomic(seqPath, JSON.stringify(seqState, null, 2));

			if (journalEntry.command) {
				writeFileAtomic(
					path.join(projectCommandsDir(root), `${journalEntry.command.commandId}.json`),
					JSON.stringify(journalEntry.command, null, 2),
				);
			}
			if (batch.run) {
				const run = {
					...batch.run,
					projectId: header!.projectId,
					controlDomainId: header!.controlDomainId,
				};
				writeFileAtomic(
					path.join(projectProjectionsDir(root), `run-${run.runId}.json`),
					JSON.stringify(run, null, 2),
				);
			}
			if (batch.receipt) {
				const receipt = {
					...batch.receipt,
					projectId: header!.projectId,
					controlDomainId: header!.controlDomainId,
				};
				writeFileAtomic(
					path.join(projectReceiptsDir(root), `${receipt.receiptId}.json`),
					JSON.stringify(receipt, null, 2),
				);
				// Index by runId
				writeFileAtomic(
					path.join(projectReceiptsDir(root), `by-run-${receipt.runId}.json`),
					JSON.stringify({ receiptId: receipt.receiptId }, null, 2),
				);
			}

			header = { ...header!, updatedAt: Date.now() };
			writeFileAtomic(headerPath, JSON.stringify(header, null, 2));

			return { commitSeqStart: start, commitSeqEnd: end };
		},

		getRun(runId: string) {
			return readJsonFile<RunProjection>(
				path.join(projectProjectionsDir(root), `run-${runId}.json`),
			);
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
