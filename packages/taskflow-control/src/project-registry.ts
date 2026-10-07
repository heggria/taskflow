/** P3 discovery projection. Header identity and the mounted store remain authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ControlError } from "./errors.ts";
import { ControlRegistryEntrySchema, ControlStoreHeaderSchema, type ControlRegistryEntry } from "./schema/header.ts";
import { openControlStore, writeJsonAtomicHardened, type ControlStore } from "./store/store.ts";

export interface ProjectMount {
	readonly store: ControlStore;
	readonly projectRoot: string;
}
interface Mounted extends ProjectMount { rootDevice: number; rootInode: number }
const RegistrySchema = Type.Object({ version: Type.Literal(1), entries: Type.Array(ControlRegistryEntrySchema) }, { additionalProperties: false });
function fail(message: string): never { throw new ControlError("TF_DURABILITY_FAILED", message, { recoveryAction: "operator" }); }
function noLinks(target: string): void {
	let current = path.resolve(target);
	for (;;) {
		try { if (fs.lstatSync(current).isSymbolicLink()) fail("registry refuses symbolic-link paths"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = path.dirname(current); if (parent === current) return; current = parent;
	}
}

/** Constructed by the singleton owner only. Persisted paths are discovery hints,
 * never automatic permission to open a project or restore a run projection. */
export class ProjectRegistry {
	readonly registryPath: string;
	readonly #directory: string;
	readonly #directoryIdentity: { dev: number; ino: number };
	readonly #mounts = new Map<string, Mounted>();
	readonly #entries = new Map<string, ControlRegistryEntry>();
	#closed = false;
	constructor(registryPath: string) {
		this.registryPath = path.resolve(registryPath);
		noLinks(this.registryPath);
		this.#directory = path.dirname(this.registryPath);
		fs.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(this.#directory);
		if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid()) fail("registry directory must belong to the host user");
		this.#directoryIdentity = { dev: stat.dev, ino: stat.ino };
		if (process.platform !== "win32") fs.chmodSync(this.#directory, 0o700);
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
			if (!Value.Check(RegistrySchema, raw)) fail("malformed registry projection; preserve it for operator repair");
			for (const entry of raw.entries) {
				if (this.#entries.has(entry.projectId) || [...this.#entries.values()].some((item) => item.controlDomainId === entry.controlDomainId)) fail("registry contains conflicting identities");
				this.#entries.set(entry.projectId, { ...entry, mountState: "unmounted" });
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	#checkDirectory(): void {
		if (this.#closed) fail("project registry is closed");
		noLinks(this.registryPath);
		const stat = fs.lstatSync(this.#directory);
		if (!stat.isDirectory() || stat.dev !== this.#directoryIdentity.dev || stat.ino !== this.#directoryIdentity.ino) fail("registry directory identity changed");
	}
	#checkMount(mount: Mounted): void {
		noLinks(mount.store.storePath); noLinks(mount.projectRoot);
		const root = fs.lstatSync(mount.projectRoot), dir = fs.lstatSync(mount.store.storePath);
		const header = mount.store.header;
		if (root.dev !== mount.rootDevice || root.ino !== mount.rootInode || !root.isDirectory()
			|| String(dir.dev) !== header.directoryBinding.device || String(dir.ino) !== header.directoryBinding.inode
			|| fs.realpathSync(mount.store.storePath) !== header.directoryBinding.canonicalPath) fail("mounted project directory identity changed");
		let durable: unknown;
		try { const file = path.join(mount.store.storePath, "header"); noLinks(file); durable = JSON.parse(fs.readFileSync(file, "utf8")); }
		catch { fail("mounted project header is absent or unreadable"); }
		if (!Value.Check(ControlStoreHeaderSchema, durable) || JSON.stringify(durable) !== JSON.stringify(header)) fail("mounted project header changed");
		if (mount.store.status !== "healthy") fail("mounted project store is not healthy");
	}
	#save(): void {
		this.#checkDirectory();
		writeJsonAtomicHardened(this.registryPath, { version: 1, entries: [...this.#entries.values()] });
	}
	/** Paths are trusted launcher configuration; never call with unchecked RPC paths. */
	mount(storePath: string, projectRoot?: string): ProjectMount {
		this.#checkDirectory(); noLinks(storePath);
		const resolved = path.resolve(storePath);
		const rootPath = projectRoot ?? (path.basename(resolved) === "control" && path.basename(path.dirname(resolved)) === ".taskflow"
			? path.dirname(path.dirname(resolved)) : fail("nonstandard store path requires an explicit project root"));
		noLinks(rootPath);
		const root = fs.realpathSync(rootPath), rootStat = fs.lstatSync(root);
		if (!rootStat.isDirectory()) fail("project root must be a directory");
		const relative = path.relative(root, resolved);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("project store must be inside its configured root");
		for (const mounted of this.#mounts.values()) {
			if (path.resolve(mounted.store.storePath) !== resolved) continue;
			this.#checkMount(mounted);
			if (mounted.projectRoot !== root) fail("mounted store cannot be rebound to a different project root");
			return mounted;
		}
		const store = openControlStore(resolved);
		try {
			const header = store.header;
			if (this.#mounts.has(header.projectId) || [...this.#mounts.values()].some((m) => m.store.header.controlDomainId === header.controlDomainId)) fail("a project/domain identity is already mounted elsewhere");
			const mounted: Mounted = { store, projectRoot: root, rootDevice: rootStat.dev, rootInode: rootStat.ino };
			this.#checkMount(mounted);
			const entry: ControlRegistryEntry = { projectId: header.projectId, controlDomainId: header.controlDomainId, storePath: resolved, directoryBinding: header.directoryBinding, mountState: "mounted" };
			const previous = this.#entries.get(header.projectId);
			this.#entries.set(header.projectId, entry);
			try { this.#save(); } catch (error) { if (previous) this.#entries.set(header.projectId, previous); else this.#entries.delete(header.projectId); throw error; }
			this.#mounts.set(header.projectId, mounted); return mounted;
		} catch (error) { store.close(); throw error; }
	}
	resolve(projectId?: string): ProjectMount {
		this.#checkDirectory();
		if (projectId === undefined && this.#mounts.size !== 1) throw new ControlError("TF_COMMAND_FAILED", "explicit projectId required for multi-project routing");
		const mount = projectId === undefined ? this.#mounts.values().next().value : this.#mounts.get(projectId);
		if (!mount) throw new ControlError("TF_POLICY_DENIED", "project is not mounted");
		this.#checkMount(mount); return mount;
	}
	list(): ControlRegistryEntry[] {
		this.#checkDirectory();
		for (const mount of this.#mounts.values()) this.#checkMount(mount);
		return structuredClone([...this.#entries.values()]);
	}
	unmount(projectId: string): void {
		const mount = this.resolve(projectId);
		mount.store.close(); this.#mounts.delete(projectId);
		const entry = this.#entries.get(projectId)!; this.#entries.set(projectId, { ...entry, mountState: "unmounted" }); this.#save();
	}
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const mount of this.#mounts.values()) mount.store.close();
		this.#mounts.clear();
	}
}
