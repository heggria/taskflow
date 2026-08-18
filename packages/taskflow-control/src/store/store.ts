/**
 * Files-only ControlStore (beta.2 S3-minimum).
 *
 * Layout: header + commit-seq.json + journal/ + projections/ + empty
 * commands/ + receipts/. Journal is the authority; projections are
 * store-self only (submitted-command index). Single writer via exclusive
 * lock file. Atomic writes use UUID temp + wx + fsync + rename, and fail
 * closed if the destination is a symlink.
 *
 * P14 ADR Status stays Proposed. This is the S3 engine implementation gate.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import { ControlError } from "../errors.ts";
import {
	CONTROL_WIRE_SCHEMA_VERSION,
	CommandRecordSchema,
	ControlEventSchema,
	ControlStoreHeaderSchema,
	type CommandRecord,
	type ControlEvent,
	type ControlStoreHeader,
	type ControlStoreStatus,
} from "../schema/index.ts";

export const CONTROL_CRASH_ENV = "TASKFLOW_CONTROL_CRASH_AT";

export type ControlCrashPoint =
	| "header-fsynced"
	| "journal-append"
	| "projection-rebuild";

const LOCK_NAME = "writer.lock";
const HEADER_NAME = "header";
const COMMIT_SEQ_NAME = "commit-seq.json";
const JOURNAL_DIR = "journal";
const JOURNAL_SEGMENT = "000001.jsonl";
const PROJECTIONS_DIR = "projections";
const COMMAND_INDEX = "commands.json";
const COMMANDS_DIR = "commands";
const RECEIPTS_DIR = "receipts";

export interface OpenControlStoreOptions {
	projectId?: string;
	controlDomainId?: string;
	now?: () => number;
}

export interface CommitBatchInput {
	command: CommandRecord;
	events: readonly ControlEvent[];
}

export interface ControlStoreSnapshot {
	header: ControlStoreHeader;
	commitSeq: number;
	status: ControlStoreStatus;
}

interface JournalBatch {
	recordKind: "commit-batch";
	commitSeq: number;
	command: CommandRecord;
	events: ControlEvent[];
}

interface WriterLock {
	pid: number;
	acquiredAt: number;
}

export class ControlStore {
	readonly storePath: string;
	#header: ControlStoreHeader;
	#commitSeq: number;
	#status: ControlStoreStatus = "healthy";
	#closed = false;
	#commandIndex = new Map<string, CommandRecord>();

	constructor(storePath: string, header: ControlStoreHeader, commitSeq: number, commands: readonly CommandRecord[]) {
		this.storePath = storePath;
		this.#header = header;
		this.#commitSeq = commitSeq;
		for (const command of commands) this.#commandIndex.set(command.commandId, command);
	}

	get header(): ControlStoreHeader {
		return this.#header;
	}

	get commitSeq(): number {
		return this.#commitSeq;
	}

	get status(): ControlStoreStatus {
		return this.#status;
	}

	readCommand(commandId: string): CommandRecord | undefined {
		this.#assertOpen();
		return this.#commandIndex.get(commandId);
	}

	snapshot(): ControlStoreSnapshot {
		this.#assertOpen();
		return { header: this.#header, commitSeq: this.#commitSeq, status: this.#status };
	}

	appendBatch(input: CommitBatchInput): { commitSeq: number; command: CommandRecord } {
		this.#assertOpen();
		if (this.#status === "fail-closed") {
			throw durabilityFailed("control store is fail-closed; refusing mutation");
		}
		if (input.command.kind !== "run.submit") {
			throw durabilityFailed(`beta.2 store only accepts run.submit; got ${input.command.kind}`);
		}
		if (input.events.length === 0) {
			throw durabilityFailed("atomic batch requires at least one ControlEvent");
		}
		for (const event of input.events) {
			if (!Value.Check(ControlEventSchema, event)) {
				throw durabilityFailed("ControlEvent failed schema check");
			}
		}
		if (!Value.Check(CommandRecordSchema, {
			...input.command,
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
		})) {
			// Validate after identity rewrite below; pre-check kind/required fields first.
		}

		const nextSeq = this.#commitSeq + 1;
		const command: CommandRecord = {
			...input.command,
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
			firstCommitSeq: nextSeq,
			lastCommitSeq: nextSeq,
		};
		if (!Value.Check(CommandRecordSchema, command)) {
			throw durabilityFailed("CommandRecord failed schema check");
		}
		if (this.#commandIndex.has(command.commandId)) {
			throw new ControlError(
				"TF_IDEMPOTENCY_CONFLICT",
				`command ${command.commandId} is already committed`,
				{ recoveryAction: "none", sideEffects: "none" },
			);
		}
		const events: ControlEvent[] = input.events.map((event, index) => ({
			...event,
			projectId: this.#header.projectId,
			controlDomainId: this.#header.controlDomainId,
			commitSeq: nextSeq,
			commandId: command.commandId,
			commandEventIndex: index,
		}));

		const record: JournalBatch = {
			recordKind: "commit-batch",
			commitSeq: nextSeq,
			command,
			events,
		};
		crashDuringJournalAppend(journalPath(this.storePath));
		appendJsonLineDurable(journalPath(this.storePath), record);
		writeJsonAtomicHardened(commitSeqPath(this.storePath), { commitSeq: nextSeq });
		this.#commandIndex.set(command.commandId, command);
		maybeCrash("projection-rebuild");
		writeJsonAtomicHardened(commandIndexPath(this.storePath), Object.fromEntries(this.#commandIndex));
		this.#commitSeq = nextSeq;
		this.#status = "healthy";
		return { commitSeq: nextSeq, command };
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		releaseWriterLock(this.storePath);
	}

	#assertOpen(): void {
		if (this.#closed) throw durabilityFailed("control store is closed");
	}
}

export function openControlStore(storePath: string, options: OpenControlStoreOptions = {}): ControlStore {
	const resolved = path.resolve(storePath);
	ensureDirectory(resolved);
	acquireWriterLock(resolved);

	try {
		const existingHeader = readHeader(resolved);
		if (existingHeader === undefined) {
			const header = createHeader(resolved, options);
			writeJsonAtomicHardened(headerPath(resolved), header);
			maybeCrash("header-fsynced");
			writeJsonAtomicHardened(commitSeqPath(resolved), { commitSeq: 0 });
			ensureDirectory(path.join(resolved, JOURNAL_DIR));
			ensureDirectory(path.join(resolved, PROJECTIONS_DIR));
			ensureDirectory(path.join(resolved, COMMANDS_DIR));
			ensureDirectory(path.join(resolved, RECEIPTS_DIR));
			fsyncDirectory(resolved);
			return new ControlStore(resolved, header, 0, []);
		}

		const recovered = recoverFromJournal(resolved, existingHeader);
		return new ControlStore(resolved, existingHeader, recovered.commitSeq, recovered.commands);
	} catch (error) {
		releaseWriterLock(resolved);
		throw error;
	}
}

function createHeader(storePath: string, options: OpenControlStoreOptions): ControlStoreHeader {
	const st = fs.statSync(storePath);
	return {
		projectId: options.projectId ?? crypto.randomUUID(),
		controlDomainId: options.controlDomainId ?? crypto.randomUUID(),
		schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
		directoryBinding: {
			canonicalPath: fs.realpathSync(storePath),
			device: String(st.dev),
			inode: String(st.ino),
		},
	};
}

function readHeader(storePath: string): ControlStoreHeader | undefined {
	const file = headerPath(storePath);
	if (!fs.existsSync(file)) return undefined;
	assertNotSymlink(file);
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!Value.Check(ControlStoreHeaderSchema, raw)) {
		throw durabilityFailed(`malformed control store header at ${file}`);
	}
	return raw;
}

function recoverFromJournal(
	storePath: string,
	header: ControlStoreHeader,
): { commitSeq: number; commands: CommandRecord[] } {
	ensureDirectory(path.join(storePath, JOURNAL_DIR));
	ensureDirectory(path.join(storePath, PROJECTIONS_DIR));
	ensureDirectory(path.join(storePath, COMMANDS_DIR));
	ensureDirectory(path.join(storePath, RECEIPTS_DIR));

	const batches = readJournalBatches(journalPath(storePath));
	truncateTornJournal(journalPath(storePath));
	const commands: CommandRecord[] = [];
	let commitSeq = 0;
	for (const batch of batches) {
		if (batch.recordKind !== "commit-batch") {
			throw durabilityFailed("journal contains an unknown record kind");
		}
		if (batch.commitSeq !== commitSeq + 1) {
			throw durabilityFailed(`journal commitSeq gap: expected ${commitSeq + 1}, got ${batch.commitSeq}`);
		}
		if (
			batch.command.projectId !== header.projectId
			|| batch.command.controlDomainId !== header.controlDomainId
		) {
			throw durabilityFailed("journal command identity does not match store header");
		}
		commands.push(batch.command);
		commitSeq = batch.commitSeq;
	}

	const onDiskSeq = readCommitSeqFile(storePath);
	if (onDiskSeq !== undefined && onDiskSeq > commitSeq) {
		throw durabilityFailed(
			`mixed state: commit-seq.json (${onDiskSeq}) is ahead of journal (${commitSeq})`,
		);
	}
	writeJsonAtomicHardened(commitSeqPath(storePath), { commitSeq });
	writeJsonAtomicHardened(
		commandIndexPath(storePath),
		Object.fromEntries(commands.map((command) => [command.commandId, command])),
	);
	return { commitSeq, commands };
}

function readCommitSeqFile(storePath: string): number | undefined {
	const file = commitSeqPath(storePath);
	if (!fs.existsSync(file)) return undefined;
	assertNotSymlink(file);
	const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { commitSeq?: unknown };
	if (typeof raw.commitSeq !== "number" || !Number.isInteger(raw.commitSeq) || raw.commitSeq < 0) {
		throw durabilityFailed(`malformed commit-seq.json at ${file}`);
	}
	return raw.commitSeq;
}

function readJournalBatches(filePath: string): JournalBatch[] {
	if (!fs.existsSync(filePath)) return [];
	assertNotSymlink(filePath);
	const raw = fs.readFileSync(filePath);
	const text = raw.toString("utf8");
	const lines = text.split("\n");
	const complete = text.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
	// Torn tail (no terminating newline on last line) is discarded — old-complete.
	const batches: JournalBatch[] = [];
	for (const line of complete) {
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw durabilityFailed("journal contains a complete but unreadable line");
		}
		batches.push(parsed as JournalBatch);
	}
	return batches;
}

function truncateTornJournal(filePath: string): void {
	if (!fs.existsSync(filePath)) return;
	assertNotSymlink(filePath);
	const raw = fs.readFileSync(filePath);
	if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;
	const lastNewline = raw.lastIndexOf(0x0a);
	const fd = fs.openSync(filePath, "r+");
	try {
		fs.ftruncateSync(fd, lastNewline === -1 ? 0 : lastNewline + 1);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function acquireWriterLock(storePath: string): void {
	const lockPath = path.join(storePath, LOCK_NAME);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(lockPath, "wx", 0o600);
			try {
				fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies WriterLock));
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fsyncDirectory(storePath);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!isLockHolderAlive(lockPath)) {
				try { fs.unlinkSync(lockPath); } catch { /* retry wx */ }
				continue;
			}
			throw durabilityFailed(`control store already has a live writer at ${storePath}`);
		}
	}
	throw durabilityFailed(`could not acquire control store writer lock at ${storePath}`);
}

function releaseWriterLock(storePath: string): void {
	const lockPath = path.join(storePath, LOCK_NAME);
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as WriterLock;
		if (raw.pid !== process.pid) return;
		fs.unlinkSync(lockPath);
	} catch {
		/* best effort */
	}
}

function isLockHolderAlive(lockPath: string): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as WriterLock;
		if (typeof raw.pid !== "number") return false;
		process.kill(raw.pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		// EPERM: process exists but we cannot signal it — treat as live.
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		return false;
	}
}

export function maybeCrash(point: ControlCrashPoint): void {
	if (process.env[CONTROL_CRASH_ENV] === point) {
		process.kill(process.pid, "SIGKILL");
	}
}

/** SIGKILL after a torn (unterminated) journal write — process-level A4. */
function crashDuringJournalAppend(filePath: string): void {
	if (process.env[CONTROL_CRASH_ENV] !== "journal-append") return;
	ensureDirectory(path.dirname(filePath));
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		fs.writeSync(fd, Buffer.from("{\"recordKind\":\"commit-batch\""));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	process.kill(process.pid, "SIGKILL");
}

export function writeJsonAtomicHardened(filePath: string, value: unknown): void {
	assertNotSymlink(filePath);
	const directory = path.dirname(filePath);
	ensureDirectory(directory);
	let temp = "";
	let fd = -1;
	for (let attempt = 0; attempt < 8; attempt++) {
		temp = path.join(directory, `.${crypto.randomUUID()}`);
		try {
			fd = fs.openSync(temp, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	if (fd < 0) throw durabilityFailed(`could not create exclusive temp file for ${filePath}`);
	try {
		fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		assertNotSymlink(filePath);
		fs.renameSync(temp, filePath);
		fsyncDirectory(directory);
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

function appendJsonLineDurable(filePath: string, record: unknown): void {
	assertNotSymlink(filePath);
	ensureDirectory(path.dirname(filePath));
	const existed = fs.existsSync(filePath);
	if (existed) {
		const raw = fs.readFileSync(filePath);
		if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
			const lastNewline = raw.lastIndexOf(0x0a);
			const repairFd = fs.openSync(filePath, "r+");
			try {
				fs.ftruncateSync(repairFd, lastNewline === -1 ? 0 : lastNewline + 1);
				fs.fsyncSync(repairFd);
			} finally {
				fs.closeSync(repairFd);
			}
		}
	}
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		const data = Buffer.from(`${JSON.stringify(record)}\n`);
		let offset = 0;
		while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (!existed) fsyncDirectory(path.dirname(filePath));
}

function assertNotSymlink(filePath: string): void {
	try {
		const st = fs.lstatSync(filePath);
		if (st.isSymbolicLink()) {
			throw durabilityFailed(`refusing to touch symlink at ${filePath}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

function ensureDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function fsyncDirectory(directory: string): void {
	try {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	} catch {
		/* some filesystems refuse directory fsync */
	}
}

function durabilityFailed(message: string): ControlError {
	return new ControlError("TF_DURABILITY_FAILED", message, {
		recoveryAction: "none",
		sideEffects: "unknown",
	});
}

function headerPath(storePath: string): string {
	return path.join(storePath, HEADER_NAME);
}

function commitSeqPath(storePath: string): string {
	return path.join(storePath, COMMIT_SEQ_NAME);
}

function journalPath(storePath: string): string {
	return path.join(storePath, JOURNAL_DIR, JOURNAL_SEGMENT);
}

function commandIndexPath(storePath: string): string {
	return path.join(storePath, PROJECTIONS_DIR, COMMAND_INDEX);
}

export function controlStorePaths(storePath: string) {
	return {
		header: headerPath(storePath),
		commitSeq: commitSeqPath(storePath),
		journal: journalPath(storePath),
		commandIndex: commandIndexPath(storePath),
		lock: path.join(storePath, LOCK_NAME),
	};
}
