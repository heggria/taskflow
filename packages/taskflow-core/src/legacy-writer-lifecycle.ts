/** Explicit upgrade boundary for a closed set of directly supervised writers.
 *
 * This gate must own a NEW namespace before any old writer is admitted. It is
 * not an attestation API for an existing installation. A restarted supervisor
 * cannot recover proof of exclusion from PIDs or an empty queue; it must remain
 * stopped for operator/service-manager reconciliation. Writers that fork other
 * writers must be supervised at that outer service boundary instead.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { bindMutexQueue, type DirectoryIdentity } from "./resources/mutex-bootstrap.ts";
import { defaultProcessIdentity } from "./resources/persistence.ts";

const fault = (detail: string) => new Error(`TFWS_LEGACY_EXCLUSION_REQUIRED: ${detail}`);
const same = (a: DirectoryIdentity, b: DirectoryIdentity) => a.dev === b.dev && a.ino === b.ino;
function directory(file: string): DirectoryIdentity {
	const stat = fs.lstatSync(file);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault("namespace must be a real directory");
	return { dev: stat.dev, ino: stat.ino };
}
function syncDirectory(file: string): void {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableExclusive(file: string, value: unknown): void {
	const fd = fs.openSync(file, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	syncDirectory(path.dirname(file));
}

export interface LegacyMigrationResult {
	lockPath: string;
	preservedQueue: string;
	generation: string;
}

export class LegacyWriterLifecycle {
	readonly directory: string;
	readonly lockPath: string;
	#root: DirectoryIdentity;
	#parent: DirectoryIdentity;
	#genesis: DirectoryIdentity;
	#genesisBytes: string;
	#generation = randomUUID();
	#children = new Set<ChildProcess>();
	#closed = false;
	#closedEvidence?: DirectoryIdentity;
	#draining = false;
	#result?: LegacyMigrationResult;
	#completionProof = new Map<string, { identity: DirectoryIdentity; bytes?: string }>();

	private constructor(scope: string) {
		this.directory = path.resolve(scope);
		this.lockPath = path.join(this.directory, "writer.lock");
		this.#parent = directory(path.dirname(this.directory));
		// No recursive mkdir and no adoption, including after a supervisor crash.
		try { fs.mkdirSync(this.directory, { mode: 0o700 }); }
		catch (error) { throw fault(`new managed namespace required (${(error as NodeJS.ErrnoException).code ?? "unknown"})`); }
		this.#root = directory(this.directory);
		const record = path.join(this.directory, "lifecycle.json");
		this.#genesisBytes = JSON.stringify({ version: 1, generation: this.#generation, root: this.#root, owner: defaultProcessIdentity() });
		durableExclusive(record, JSON.parse(this.#genesisBytes));
		this.#genesis = fs.lstatSync(record);
		syncDirectory(path.dirname(this.directory));
	}

	static create(scopeDirectory: string): LegacyWriterLifecycle {
		return new LegacyWriterLifecycle(scopeDirectory);
	}

	#assertIdentity(): void {
		try {
			if (!same(directory(path.dirname(this.directory)), this.#parent) || !same(directory(this.directory), this.#root)) throw fault("namespace replaced");
			const record = path.join(this.directory, "lifecycle.json");
			const fd = fs.openSync(record, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const stat = fs.fstatSync(fd);
				if (!stat.isFile() || !same(stat, this.#genesis) || !same(stat, fs.lstatSync(record)) || fs.readFileSync(fd, "utf8") !== this.#genesisBytes) throw fault("lifecycle evidence replaced");
			} finally { fs.closeSync(fd); }
			if (this.#closed) {
				const closed = path.join(this.directory, "admission.closed.json");
				const closedFd = fs.openSync(closed, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
				try {
					const stat = fs.fstatSync(closedFd);
					if (!this.#closedEvidence || !stat.isFile() || !same(stat, this.#closedEvidence) || !same(stat, fs.lstatSync(closed)) ||
						fs.readFileSync(closedFd, "utf8") !== JSON.stringify({ generation: this.#generation })) throw fault("admission closure evidence replaced");
				} finally { fs.closeSync(closedFd); }
			}
		} catch (error) { throw fault(`lifecycle evidence unavailable: ${(error as Error).message}`); }
	}

	/** Only direct child writers are covered. Do not use for daemonizing programs.
	 * The caller may request shutdown, but this module never signals a process. */
	spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
		this.#assertIdentity();
		if (this.#closed) throw fault("writer admission is closed");
		if (options.detached || options.shell) throw fault("detached and shell writers require external service exclusion");
		// Persist reservation BEFORE spawn. Lost supervisor state can never be
		// mistaken for a namespace with no historical admissions.
		durableExclusive(path.join(this.directory, `admission-${randomUUID()}.json`), { generation: this.#generation });
		const child = spawn(command, [...args], options);
		this.#children.add(child);
		child.once("exit", () => { this.#children.delete(child); });
		child.once("error", () => {
			// A failed spawn has no OS process; errors on an existing child are not
			// evidence of exit and do not remove it from the admitted population.
			if (child.pid === undefined) this.#children.delete(child);
		});
		return child;
	}

	/** Close admission now; finish only after actual exit observations. A timeout
	 * leaves the gate closed, the queue untouched, and may be retried. */
	async drainAndMigrate(options: { timeoutMs: number }): Promise<LegacyMigrationResult> {
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new RangeError("timeoutMs must be finite and nonnegative");
		this.#assertIdentity();
		if (this.#result) {
			for (const [file, proof] of this.#completionProof) {
				try {
					const stat = fs.lstatSync(file);
					if (stat.isSymbolicLink() || !same(stat, proof.identity) ||
						(proof.bytes === undefined ? !stat.isDirectory() : !stat.isFile() || fs.readFileSync(file, "utf8") !== proof.bytes)) throw fault("completed migration evidence replaced");
				} catch (error) { throw fault(`completed migration evidence unavailable: ${(error as Error).message}`); }
			}
			return this.#result;
		}
		if (this.#draining) throw fault("migration is already running");
		this.#draining = true;
		try {
			if (!this.#closed) {
				this.#closed = true;
				durableExclusive(path.join(this.directory, "admission.closed.json"), { generation: this.#generation });
				this.#closedEvidence = fs.lstatSync(path.join(this.directory, "admission.closed.json"));
			}
			const deadline = performance.now() + options.timeoutMs;
			while (this.#children.size > 0) {
				this.#assertIdentity();
				if (performance.now() >= deadline) throw fault("owned writers have not exited");
				await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - performance.now()))));
			}
			this.#assertIdentity();
			const queue = `${this.lockPath}.queue`;
			// Missing queue is not permission to bootstrap after a failed upgrade.
			const oldQueue = directory(queue);
			for (const suffix of [".identity", ".initializing", ".initialized"]) {
				try { fs.lstatSync(`${queue}${suffix}`); }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
				throw fault("namespace is already anchored or has partial initialization evidence");
			}
			const preservedQueue = `${queue}.legacy-${this.#generation}`;
			durableExclusive(path.join(this.directory, "migration.intent.json"), { generation: this.#generation, queue: oldQueue, preservedQueue });
			this.#assertIdentity();
			if (!same(directory(queue), oldQueue)) throw fault("legacy queue changed before preservation");
			fs.renameSync(queue, preservedQueue);
			syncDirectory(this.directory);
			bindMutexQueue(queue, defaultProcessIdentity(), () => false, syncDirectory);
			this.#assertIdentity();
			durableExclusive(path.join(this.directory, "migration.complete.json"), { generation: this.#generation, preservedQueue });
			for (const file of [queue, preservedQueue, `${queue}.identity`, `${queue}.initializing`, `${queue}.initialized`, path.join(this.directory, "migration.complete.json")]) {
				const stat = fs.lstatSync(file);
				this.#completionProof.set(file, { identity: stat, bytes: stat.isFile() ? fs.readFileSync(file, "utf8") : undefined });
			}
			this.#result = Object.freeze({ lockPath: this.lockPath, preservedQueue, generation: this.#generation });
			return this.#result;
		} finally { this.#draining = false; }
	}
}
