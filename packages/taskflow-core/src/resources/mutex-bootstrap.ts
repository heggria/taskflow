/** Crash-recoverable creation of a new mutex namespace. Existing unanchored
 * queues are never migrated here: that requires a host-wide old-writer fence. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DirectoryIdentity { dev: number; ino: number; }
interface BootstrapOwner { pid: number; birthToken: string; birthTokenKind: "native" | "opaque"; }
interface BootstrapIntent {
	version: 1;
	token: string;
	owner: BootstrapOwner;
	parent: DirectoryIdentity;
	directory: DirectoryIdentity;
	stage: string;
}
interface ObservedJson { value: unknown; identity: DirectoryIdentity; }

const same = (a: DirectoryIdentity, b: DirectoryIdentity) => a.dev === b.dev && a.ino === b.ino;
const fault = (message: string) => new Error(`TFWS_MUTEX_IDENTITY: ${message}`);
const waiting = () => Object.assign(fault("mutex initialization is pending"), { code: "ENOENT" });
function exists(file: string): boolean {
	try { fs.lstatSync(file); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directoryIdentity(directory: string): DirectoryIdentity {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory()) throw fault("bootstrap path must be a real directory");
	return { dev: stat.dev, ino: stat.ino };
}
function read(file: string): ObservedJson {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || !same(stat, fs.lstatSync(file))) throw fault("bootstrap record was replaced");
		return { value: JSON.parse(fs.readFileSync(fd, "utf8")), identity: { dev: stat.dev, ino: stat.ino } };
	} finally { fs.closeSync(fd); }
}
function identity(value: unknown): value is DirectoryIdentity {
	if (!value || typeof value !== "object") return false;
	const v = value as DirectoryIdentity;
	return Number.isSafeInteger(v.dev) && Number.isSafeInteger(v.ino) && v.dev >= 0 && v.ino > 0;
}
function intent(value: unknown, queueName: string): BootstrapIntent {
	if (!value || typeof value !== "object") throw fault("invalid bootstrap intent");
	const v = value as BootstrapIntent;
	if (v.version !== 1 || typeof v.token !== "string" || !/^[0-9a-f-]{36}$/.test(v.token) ||
		v.stage !== `${queueName}.staging-${v.token}` || !identity(v.parent) || !identity(v.directory) ||
		!v.owner || !Number.isSafeInteger(v.owner.pid) || v.owner.pid <= 0 || v.owner.pid > 0x7fffffff ||
		typeof v.owner.birthToken !== "string" || v.owner.birthToken.length === 0 ||
		(v.owner.birthTokenKind !== "native" && v.owner.birthTokenKind !== "opaque")) throw fault("invalid bootstrap intent");
	return v;
}
function publish(file: string, value: unknown, syncDirectory: (directory: string) => void): void {
	const temp = `${file}.tmp.${crypto.randomUUID()}`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	try {
		try { fs.linkSync(temp, file); syncDirectory(path.dirname(file)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	} finally { fs.unlinkSync(temp); }
}

export function bindMutexQueue(
	queue: string,
	owner: BootstrapOwner,
	canRecover: (owner: BootstrapOwner) => boolean,
	syncDirectory: (directory: string) => void,
): DirectoryIdentity {
	const parentPath = path.dirname(queue);
	fs.mkdirSync(parentPath, { recursive: true });
	const parent = directoryIdentity(parentPath);
	const anchor = `${queue}.identity`;
	const journal = `${queue}.initializing`;
	const completed = `${queue}.initialized`;
	let ownToken: string | undefined;

	// Compatibility for already anchored namespaces from the preceding mutex
	// version. A completion record without its genesis is corruption, not legacy.
	if (!exists(journal) && exists(anchor)) {
		if (exists(completed)) throw fault("bootstrap genesis is missing");
		const saved = read(anchor).value;
		const current = directoryIdentity(queue);
		if (!identity(saved) || !same(saved, current)) throw fault("mutex queue was replaced");
		return current;
	}
	if (!exists(journal)) {
		if (exists(completed)) throw fault("bootstrap genesis is missing");
		if (exists(queue)) throw waiting(); // legacy or interrupted old protocol
		const token = crypto.randomUUID();
		const stage = `${path.basename(queue)}.staging-${token}`;
		const stagePath = path.join(parentPath, stage);
		fs.mkdirSync(stagePath, { mode: 0o700 });
		const stagedIdentity = directoryIdentity(stagePath);
		syncDirectory(stagePath);
		syncDirectory(parentPath);
		const proposed: BootstrapIntent = { version: 1, token, owner, parent, directory: stagedIdentity, stage };
		publish(journal, proposed, syncDirectory);
		const winner = intent(read(journal).value, path.basename(queue));
		if (winner.token === token) ownToken = token;
		else {
			if (same(directoryIdentity(stagePath), stagedIdentity)) fs.rmdirSync(stagePath);
		}
	}
	const selected = intent(read(journal).value, path.basename(queue));
	const assertParent = () => {
		if (!same(directoryIdentity(parentPath), selected.parent)) throw fault("bootstrap parent was replaced");
	};
	const assertPublished = () => {
		assertParent();
		const saved = read(anchor).value;
		if (!identity(saved) || !same(saved, selected.directory) || !same(directoryIdentity(queue), selected.directory)) {
			throw fault("bootstrap anchor does not match queue");
		}
	};
	assertParent();
	if (exists(completed)) {
		if (JSON.stringify(read(completed).value) !== JSON.stringify(selected)) throw fault("bootstrap completion does not match genesis");
		assertPublished();
		return selected.directory;
	}
	if (selected.token !== ownToken && !canRecover(selected.owner)) throw waiting();
	const stagePath = path.join(parentPath, selected.stage);
	if (!exists(queue)) {
		if (exists(anchor)) throw fault("anchored mutex queue is missing");
		if (!same(directoryIdentity(stagePath), selected.directory)) throw fault("bootstrap staging directory was replaced");
		try { fs.renameSync(stagePath, queue); syncDirectory(parentPath); }
		catch (error) {
			// Multiple recoverers operate on one permanent selected inode. Only
			// one rename can succeed; another may observe its completed result.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !exists(queue)) throw error;
		}
	}
	if (!same(directoryIdentity(queue), selected.directory)) throw fault("bootstrap queue was replaced");
	publish(anchor, selected.directory, syncDirectory);
	assertPublished();
	// The selected genesis is permanent, closing delayed-creator ABA without a
	// mutable recovery claim. Completion is also immutable and is published only
	// after the anchor. No choosing/ticket record can precede this commit point.
	// A later missing anchor is therefore corruption, never initialization work.
	const latest = intent(read(journal).value, path.basename(queue));
	if (JSON.stringify(latest) !== JSON.stringify(selected)) throw fault("bootstrap genesis was replaced");
	publish(completed, selected, syncDirectory);
	if (JSON.stringify(read(completed).value) !== JSON.stringify(selected)) throw fault("bootstrap completion does not match genesis");
	assertPublished();
	return selected.directory;
}
