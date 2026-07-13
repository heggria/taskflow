import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** Exact, platform-native process-birth identity when the platform exposes one.
 * Never return an uptime estimate or a lower-precision timestamp: incomparable
 * identities could falsely reclaim a live owner's lock. */
export function readProcessBirthToken(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === "linux") {
			const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
			const commandEnd = stat.lastIndexOf(")");
			if (!bootId || commandEnd < 0) return undefined;
			// Fields after the command start at proc(5) field 3; starttime is field 22.
			const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
			if (!/^\d+$/.test(startTicks ?? "")) return undefined;
			return `linux:${bootId}:${startTicks}`;
		}
		if (process.platform === "win32") {
			const output = execFileSync("powershell.exe", [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`,
			], {
				encoding: "utf8",
				timeout: 1_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return /^\d+$/.test(output) ? `windows:filetime:${output}` : undefined;
		}
		// macOS `ps lstart` is only second precision and can alias PID reuse. Until
		// a native high-resolution token is available, liveness is fail-closed.
		return undefined;
	} catch {
		return undefined;
	}
}

export type ProcessBirthTokenKind = "native" | "opaque";

const NATIVE_PROCESS_BIRTH_TOKEN = readProcessBirthToken(process.pid);
const PROCESS_BIRTH_TOKEN = NATIVE_PROCESS_BIRTH_TOKEN ?? `opaque:${crypto.randomUUID()}`;
const PROCESS_BIRTH_TOKEN_KIND: ProcessBirthTokenKind = NATIVE_PROCESS_BIRTH_TOKEN === undefined ? "opaque" : "native";

export interface ProcessIdentity {
	pid: number;
	birthToken: string;
	birthTokenKind: ProcessBirthTokenKind;
}

export interface ObservedProcess {
	alive: boolean;
	/** Omitted when exact cross-process birth identity is unavailable. Alive but
	 * unidentifiable owners are never reclaimed. */
	birthToken?: string;
	birthTokenKind?: ProcessBirthTokenKind;
}

export type ProcessInspector = (pid: number) => ObservedProcess;

export interface PersistentCoordinatorOptions {
	directory: string;
	namespace?: string;
	pollMs?: number;
	/** A malformed mutex file is recoverable only after this grace period. */
	corruptLockStaleMs?: number;
	processIdentity?: ProcessIdentity;
	inspectProcess?: ProcessInspector;
	now?: () => number;
}

interface MutexChoosingRecord extends ProcessIdentity {
	kind: "choosing";
	token: string;
	createdAt: number;
	state: "held" | "done";
}

interface MutexTicketRecord extends ProcessIdentity {
	kind: "ticket";
	token: string;
	ticket: number;
	createdAt: number;
	/** Same-length values permit an fsynced in-place terminal marker even when
	 * directory permissions temporarily prevent unlink/rename. */
	state: "held" | "done";
}

export class CoordinatorTimeoutError extends Error {
	readonly code = "TFWS_LEASE_TIMEOUT";
	constructor(message: string) {
		super(message);
		this.name = "CoordinatorTimeoutError";
	}
}

export class CoordinatorAbortError extends Error {
	readonly code = "ABORT_ERR";
	constructor(message = "Coordinator operation aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export function defaultProcessIdentity(): ProcessIdentity {
	return { pid: process.pid, birthToken: PROCESS_BIRTH_TOKEN, birthTokenKind: PROCESS_BIRTH_TOKEN_KIND };
}

export function defaultProcessInspector(pid: number): ObservedProcess {
	if (pid === process.pid) {
		return { alive: true, birthToken: PROCESS_BIRTH_TOKEN, birthTokenKind: PROCESS_BIRTH_TOKEN_KIND };
	}
	try {
		process.kill(pid, 0);
		const birthToken = readProcessBirthToken(pid);
		return birthToken === undefined
			? { alive: true }
			: { alive: true, birthToken, birthTokenKind: "native" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EPERM") return { alive: false };
		const birthToken = readProcessBirthToken(pid);
		return birthToken === undefined
			? { alive: true }
			: { alive: true, birthToken, birthTokenKind: "native" };
	}
}

export function namespaceToken(namespace: string): string {
	return crypto.createHash("sha256").update(namespace).digest("hex").slice(0, 24);
}

export function ensureDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true });
}

export function fsyncDirectory(directory: string): void {
	try {
		const fd = fs.openSync(directory, "r");
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	} catch {
		// Some filesystems/platforms do not permit fsync on directories. The WAL or
		// data file itself is still fsynced; directory sync remains best-effort.
	}
}

export function writeJsonAtomicDurable(filePath: string, value: unknown): void {
	ensureDirectory(path.dirname(filePath));
	const temp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value));
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(temp, filePath);
		fsyncDirectory(path.dirname(filePath));
	} catch (error) {
		try { fs.unlinkSync(temp); } catch { /* best effort */ }
		throw error;
	}
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

export function appendJsonLinesDurable(filePath: string, records: readonly unknown[]): void {
	if (records.length === 0) return;
	ensureDirectory(path.dirname(filePath));
	const existed = fs.existsSync(filePath);
	// A crash can leave a partial final JSON record. Because callers serialize WAL
	// access with PersistentFileMutex, it is safe to truncate only that unterminated
	// tail before appending the next durable group.
	if (existed) {
		const raw = fs.readFileSync(filePath);
		if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
			const lastNewline = raw.lastIndexOf(0x0a);
			const repairFd = fs.openSync(filePath, "r+");
			try {
				fs.ftruncateSync(repairFd, lastNewline + 1);
				fs.fsyncSync(repairFd);
			} finally {
				fs.closeSync(repairFd);
			}
		}
	}
	const fd = fs.openSync(filePath, "a", 0o600);
	try {
		for (const record of records) {
			const data = Buffer.from(`${JSON.stringify(record)}\n`);
			let offset = 0;
			while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
		}
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (!existed) fsyncDirectory(path.dirname(filePath));
}

export function readJsonLines<T>(filePath: string): T[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const lines = raw.split("\n");
	const hasTerminatingNewline = raw.endsWith("\n");
	const records: T[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line) continue;
		try {
			records.push(JSON.parse(line) as T);
		} catch (error) {
			if (!hasTerminatingNewline && index === lines.length - 1) break;
			throw new Error(`Corrupt durable JSONL record ${index + 1} in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return records;
}

function ownerIsStale(record: ProcessIdentity, identity: ProcessIdentity, inspect: ProcessInspector): boolean {
	if (record.pid === identity.pid) {
		// Opaque tokens identify one JS module/isolate, not an OS process. Worker
		// threads share a PID but evaluate modules independently, so comparing two
		// opaque UUIDs would let one live worker reclaim another's ticket. Only native
		// kernel birth tokens are comparable; otherwise liveness fails closed.
		return record.birthTokenKind === "native" && identity.birthTokenKind === "native" &&
			record.birthToken !== identity.birthToken;
	}
	const observed = inspect(record.pid);
	if (!observed.alive) return true;
	return record.birthTokenKind === "native" && observed.birthTokenKind === "native" &&
		observed.birthToken !== undefined && observed.birthToken !== record.birthToken;
}

interface TaskflowPersistenceGlobal {
	__taskflowPendingMutexTicketReleasesV1?: Map<string, string>;
}

// A mutex instance can disappear after returning a completed critical-section
// result. Keep deferred exact-ticket cleanup shared by duplicate module instances
// in this JS realm, keyed by the immutable ticket path. The fsynced `done` state
// on the ticket itself carries the same fact across worker isolates/processes.
const persistenceGlobal = globalThis as typeof globalThis & TaskflowPersistenceGlobal;
const PROCESS_PENDING_TICKET_RELEASES =
	persistenceGlobal.__taskflowPendingMutexTicketReleasesV1 ??= new Map<string, string>();

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new CoordinatorAbortError());
	return new Promise((resolve, reject) => {
		const finish = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			finish();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			finish();
			reject(new CoordinatorAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface MutexAcquireOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class PersistentFileMutex {
	readonly lockPath: string;
	readonly identity: ProcessIdentity;
	readonly inspectProcess: ProcessInspector;
	readonly pollMs: number;
	readonly corruptLockStaleMs: number;
	readonly now: () => number;

	constructor(lockPath: string, options: Omit<PersistentCoordinatorOptions, "directory"> = {}) {
		this.lockPath = lockPath;
		this.identity = options.processIdentity ?? defaultProcessIdentity();
		this.inspectProcess = options.inspectProcess ?? defaultProcessInspector;
		this.pollMs = options.pollMs ?? 20;
		this.corruptLockStaleMs = options.corruptLockStaleMs ?? 30_000;
		this.now = options.now ?? Date.now;
	}

	#queueDirectory(): string {
		return `${this.lockPath}.queue`;
	}

	#removeTicketBestEffort(ticketPath: string, queueDirectory: string): boolean {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.unlinkSync(ticketPath);
				fsyncDirectory(queueDirectory);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			}
		}
		return false;
	}

	#markQueueRecordDone(
		recordPath: string,
		expected: MutexChoosingRecord | MutexTicketRecord,
	): boolean {
		const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		for (let attempt = 0; attempt < 3; attempt++) {
			let fd: number | undefined;
			try {
				fd = fs.openSync(recordPath, fs.constants.O_RDWR | noFollow);
				const raw = fs.readFileSync(fd, "utf8");
				const current = JSON.parse(raw) as MutexChoosingRecord | MutexTicketRecord;
				if (current.kind !== expected.kind || current.token !== expected.token ||
					(current.kind === "ticket" && expected.kind === "ticket" && current.ticket !== expected.ticket) ||
					current.pid !== expected.pid ||
					current.birthToken !== expected.birthToken || current.birthTokenKind !== expected.birthTokenKind) {
					return false;
				}
				if (current.state === "done") return true;
				if (current.state !== "held") return false;
				const terminal = Buffer.from(JSON.stringify({ ...current, state: "done" }));
				if (terminal.byteLength !== Buffer.byteLength(raw)) return false;
				let offset = 0;
				while (offset < terminal.byteLength) {
					offset += fs.writeSync(fd, terminal, offset, terminal.byteLength - offset, offset);
				}
				fs.fsyncSync(fd);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
		}
		return false;
	}

	#drainPendingTicketReleases(): void {
		const ownQueueDirectory = this.#queueDirectory();
		for (const [ticketPath, queueDirectory] of PROCESS_PENDING_TICKET_RELEASES) {
			if (queueDirectory !== ownQueueDirectory) continue;
			if (this.#removeTicketBestEffort(ticketPath, queueDirectory)) {
				PROCESS_PENDING_TICKET_RELEASES.delete(ticketPath);
			}
		}
		if ([...PROCESS_PENDING_TICKET_RELEASES.values()].some((queueDirectory) => queueDirectory === ownQueueDirectory)) {
			throw new Error("TFWS_CONTROL_PLANE_CLEANUP: a prior mutex ticket could not be released");
		}
	}

	#readQueueRecord(filePath: string): MutexChoosingRecord | MutexTicketRecord | undefined {
		try {
			const record = readJsonFile<MutexChoosingRecord | MutexTicketRecord | undefined>(filePath, undefined);
			if (!record || (record.kind !== "choosing" && record.kind !== "ticket") ||
				typeof record.token !== "string" || !Number.isSafeInteger(record.pid) ||
				typeof record.birthToken !== "string" || record.birthToken.length === 0 ||
				(record.birthTokenKind !== "native" && record.birthTokenKind !== "opaque") ||
				(record.state !== "held" && record.state !== "done")) {
				throw new Error("invalid mutex queue record");
			}
			if (record.kind === "ticket" &&
				(!Number.isSafeInteger(record.ticket) || record.ticket < 1)) {
				throw new Error("invalid mutex ticket");
			}
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			try {
				const stat = fs.statSync(filePath);
				if (this.now() - stat.mtimeMs >= this.corruptLockStaleMs) {
					// Queue filenames contain a never-reused UUID. Removing this exact
					// corrupt path cannot delete a newer owner's ticket (unlike renaming
					// one shared lockPath after a stale read).
					fs.unlinkSync(filePath);
					return undefined;
				}
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			}
			throw error;
		}
	}

	#queueSnapshot(queueDirectory: string): {
		choosing: Array<{ path: string; record: MutexChoosingRecord }>;
		tickets: Array<{ path: string; record: MutexTicketRecord }>;
	} {
		const choosing: Array<{ path: string; record: MutexChoosingRecord }> = [];
		const tickets: Array<{ path: string; record: MutexTicketRecord }> = [];
		let names: string[];
		try {
			names = fs.readdirSync(queueDirectory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { choosing, tickets };
			throw error;
		}
		for (const name of names) {
			const choosingName = /^choosing-([0-9a-f-]+)\.json$/.exec(name);
			const ticketName = /^ticket-([0-9a-f-]+)\.json$/.exec(name);
			if (!choosingName && !ticketName) continue;
			const filePath = path.join(queueDirectory, name);
			const record = this.#readQueueRecord(filePath);
			if (!record) continue;
			if (record.token !== (choosingName?.[1] ?? ticketName?.[1])) {
				throw new Error("mutex queue token does not match its immutable filename");
			}
			if (record.state === "done") {
				// The owner durably ended its critical section before cleanup failed.
				// Any process/worker may remove this exact immutable terminal ticket;
				// no birth-token inference is involved.
				try { fs.unlinkSync(filePath); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				continue;
			}
			if (ownerIsStale(record, this.identity, this.inspectProcess)) {
				// Every contender owns a unique immutable file, so stale recovery is
				// exact-path deletion with no shared-name ABA window.
				try { fs.unlinkSync(filePath); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				continue;
			}
			if (record.kind === "choosing" && choosingName) choosing.push({ path: filePath, record });
			if (record.kind === "ticket" && ticketName) tickets.push({ path: filePath, record });
		}
		return { choosing, tickets };
	}

	async acquire(options: MutexAcquireOptions = {}): Promise<() => void> {
		// A completed critical section must keep its result even if immutable-ticket
		// cleanup was temporarily unavailable. This exact mutex fails closed on its
		// next acquisition until the deferred cleanup succeeds.
		this.#drainPendingTicketReleases();
		const timeoutMs = options.timeoutMs ?? 10_000;
		const deadline = this.now() + timeoutMs;
		const queueDirectory = this.#queueDirectory();
		ensureDirectory(queueDirectory);
		const token = crypto.randomUUID();
		const choosingPath = path.join(queueDirectory, `choosing-${token}.json`);
		const ticketPath = path.join(queueDirectory, `ticket-${token}.json`);
		const choosing: MutexChoosingRecord = {
			kind: "choosing",
			...this.identity,
			token,
			createdAt: this.now(),
			state: "held",
		};
		let publishedTicket = false;
		let own: MutexTicketRecord | undefined;
		try {
			writeJsonAtomicDurable(choosingPath, choosing);
			if (options.signal?.aborted) throw new CoordinatorAbortError();
			const initial = this.#queueSnapshot(queueDirectory);
			const maxTicket = initial.tickets.reduce((max, item) => Math.max(max, item.record.ticket), 0);
			if (maxTicket >= Number.MAX_SAFE_INTEGER) throw new Error("mutex ticket space exhausted");
			const ticketRecord: MutexTicketRecord = {
				kind: "ticket",
				...this.identity,
				token,
				ticket: maxTicket + 1,
				createdAt: this.now(),
				state: "held",
			};
			own = ticketRecord;
			writeJsonAtomicDurable(ticketPath, ticketRecord);
			publishedTicket = true;
			fs.unlinkSync(choosingPath);
			fsyncDirectory(queueDirectory);

			while (true) {
				if (options.signal?.aborted) throw new CoordinatorAbortError();
				const snapshot = this.#queueSnapshot(queueDirectory);
				const otherChoosing = snapshot.choosing.some((item) => item.record.token !== token);
				const earlier = snapshot.tickets.some((item) =>
					item.record.token !== token &&
					(item.record.ticket < ticketRecord.ticket ||
						(item.record.ticket === ticketRecord.ticket && item.record.token < token)));
				if (!otherChoosing && !earlier) {
					let released = false;
					return () => {
						if (released) return;
						const terminal = this.#markQueueRecordDone(ticketPath, ticketRecord);
						if (this.#removeTicketBestEffort(ticketPath, queueDirectory)) {
							released = true;
							PROCESS_PENDING_TICKET_RELEASES.delete(ticketPath);
							return;
						}
						PROCESS_PENDING_TICKET_RELEASES.set(ticketPath, queueDirectory);
						console.warn(
							`[taskflow] mutex ticket cleanup deferred for ${path.basename(ticketPath)}` +
							(terminal ? " (critical section durably released)" : " (release marker unavailable; fail-closed)"),
						);
					};
				}
				if (this.now() >= deadline) {
					throw new CoordinatorTimeoutError(`Coordinator lock timeout after ${timeoutMs}ms`);
				}
				await delay(Math.min(this.pollMs, Math.max(1, deadline - this.now())), options.signal);
			}
		} catch (error) {
			const candidates: Array<[string, MutexChoosingRecord | MutexTicketRecord]> = [
				[choosingPath, choosing],
				...(publishedTicket && own ? [[ticketPath, own] as [string, MutexTicketRecord]] : []),
			];
			for (const [candidate, record] of candidates) {
				// A cancelled/timed-out contender is no longer live. Persist that fact in
				// the immutable queue record before unlink so permission failures cannot
				// leave a same-process ticket that blocks the queue forever.
				this.#markQueueRecordDone(candidate, record);
				this.#removeTicketBestEffort(candidate, queueDirectory);
			}
			fsyncDirectory(queueDirectory);
			throw error;
		}
	}

	async runExclusive<T>(fn: () => T | Promise<T>, options: MutexAcquireOptions = {}): Promise<T> {
		const release = await this.acquire(options);
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

export function isPersistedOwnerStale(
	record: ProcessIdentity,
	identity: ProcessIdentity,
	inspect: ProcessInspector,
): boolean {
	return ownerIsStale(record, identity, inspect);
}
