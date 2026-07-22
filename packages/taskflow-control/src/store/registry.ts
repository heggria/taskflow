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
	entries: RegistryEntry[];
}

export function openControlRegistry(env: NodeJS.ProcessEnv = process.env): ControlRegistry {
	const file = registryPath(env);
	const lockPath = path.join(userControlRoot(env), "registry.lock");
	ensureDir(userControlRoot(env));

	function load(): RegistryFile {
		return readJsonFile<RegistryFile>(file) ?? { schemaVersion: 1, entries: [] };
	}

	function save(data: RegistryFile): void {
		writeFileAtomic(file, JSON.stringify(data, null, 2));
	}

	function mutate<T>(fn: (data: RegistryFile) => T): T {
		return withExclusiveLockFile(lockPath, () => {
			const data = load();
			const result = fn(data);
			save(data);
			return result;
		});
	}

	return {
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
				const entry: RegistryEntry = {
					projectId: h.projectId,
					controlDomainId: h.controlDomainId,
					storePath: store.projectRoot,
					projectRoot: resolvedRoot,
					directoryBinding: h.directoryBinding,
					mountState: "mounted",
					registeredAt: existing >= 0 ? data.entries[existing]!.registeredAt : now,
					updatedAt: now,
				};
				if (existing >= 0) data.entries[existing] = entry;
				else data.entries.push(entry);
				return entry;
			});
		},

		wipe() {
			mutate((data) => {
				data.entries = [];
			});
		},
	};
}
