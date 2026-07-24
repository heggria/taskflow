/**
 * ControlRegistry — non-authoritative discovery (D6 / D29 / P3).
 * Rebuild from Project ControlStore header restores same projectId/domainId.
 * All mutations under exclusive registry.lock (multi-process safe).
 */
import type { DirectoryBinding } from "../types.ts";
import {
	ensureDir,
	readJsonFile,
	registryPath,
	userControlRoot,
	writeFileAtomic,
	withExclusiveLockFile,
} from "../paths.ts";
import type { ProjectControlStore } from "./project-store.ts";
import * as path from "node:path";
import { newId } from "../hash.ts";

export interface RegistryEntry {
	projectId: string;
	controlDomainId: string;
	storePath: string;
	projectRoot: string;
	directoryBinding: DirectoryBinding;
	mountState: "mounted" | "unmounted" | "unknown";
	registeredAt: number;
	updatedAt: number;
	summary?: { openRuns?: number; lastRunAt?: number };
}

export interface ControlRegistry {
	/** Monotonic-by-mutation opaque revision for aggregate cursor/SSE binding. */
	readonly revision: string;
	list(): RegistryEntry[];
	getByProjectId(projectId: string): RegistryEntry | null;
	getByProjectRoot(projectRoot: string): RegistryEntry | null;
	/** Register or refresh from an open store header (authoritative identity). */
	registerFromStore(store: ProjectControlStore, projectRoot: string): RegistryEntry;
	/** Drop registry file (tests / recovery); stores remain authoritative. */
	wipe(): void;
}

interface RegistryFile {
	schemaVersion: number;
	revision: string;
	entries: RegistryEntry[];
}

export function openControlRegistry(env: NodeJS.ProcessEnv = process.env): ControlRegistry {
	const file = registryPath(env);
	const lockPath = path.join(userControlRoot(env), "registry.lock");
	ensureDir(userControlRoot(env));

	function load(): RegistryFile {
		const existing = readJsonFile<Partial<RegistryFile>>(file);
		return {
			schemaVersion: existing?.schemaVersion ?? 1,
			revision: existing?.revision ?? "registry-legacy",
			entries: existing?.entries ?? [],
		};
	}

	function save(data: RegistryFile): void {
		writeFileAtomic(file, JSON.stringify(data, null, 2));
	}

	function mutate<T>(
		fn: (
			data: RegistryFile,
		) => { readonly result: T; readonly changed: boolean },
	): T {
		return withExclusiveLockFile(lockPath, () => {
			const data = load();
			const { result, changed } = fn(data);
			if (changed) {
				data.revision = newId("reg");
				save(data);
			}
			return result;
		});
	}

	return {
		get revision() {
			return load().revision;
		},

		list() {
			return load().entries.slice();
		},

		getByProjectId(projectId: string) {
			return load().entries.find((e) => e.projectId === projectId) ?? null;
		},

		getByProjectRoot(projectRoot: string) {
			const resolved = projectRoot.replace(/\/$/, "");
			return (
				load().entries.find(
					(e) => e.projectRoot === resolved || e.directoryBinding.path === resolved,
				) ?? null
			);
		},

		registerFromStore(store: ProjectControlStore, projectRoot: string) {
			return mutate((data) => {
				const h = store.header;
				const now = Date.now();
				const resolvedRoot = path.resolve(projectRoot).replace(/\/$/, "");
				// Domain collision: same controlDomainId registered at a different root → refuse silent share
				const domainClash = data.entries.find(
					(e) =>
						e.controlDomainId === h.controlDomainId &&
						path.resolve(e.projectRoot) !== resolvedRoot &&
						e.projectId === h.projectId,
				);
				if (domainClash) {
					// Mark prior mount demounted; current path becomes mounted (explicit open won at store layer).
					domainClash.mountState = "unmounted";
					domainClash.updatedAt = now;
				}
				const existing = data.entries.findIndex((e) => e.projectId === h.projectId);
				const previous =
					existing >= 0 ? data.entries[existing]! : undefined;
				const entry: RegistryEntry = {
					projectId: h.projectId,
					controlDomainId: h.controlDomainId,
					storePath: store.projectRoot,
					projectRoot: resolvedRoot,
					directoryBinding: h.directoryBinding,
					mountState: "mounted",
					registeredAt: previous?.registeredAt ?? now,
					updatedAt: now,
					...(previous?.summary
						? { summary: previous.summary }
						: {}),
				};
				const unchanged =
					previous !== undefined &&
					domainClash === undefined &&
					previous.controlDomainId === entry.controlDomainId &&
					previous.storePath === entry.storePath &&
					previous.projectRoot === entry.projectRoot &&
					previous.mountState === "mounted" &&
					previous.directoryBinding.path ===
						entry.directoryBinding.path &&
					previous.directoryBinding.inode ===
						entry.directoryBinding.inode &&
					previous.directoryBinding.dev ===
						entry.directoryBinding.dev;
				if (unchanged) {
					return { result: previous, changed: false };
				}
				if (existing >= 0) data.entries[existing] = entry;
				else data.entries.push(entry);
				return { result: entry, changed: true };
			});
		},

		wipe() {
			mutate((data) => {
				const changed = data.entries.length > 0;
				data.entries = [];
				return { result: undefined, changed };
			});
		},
	};
}
