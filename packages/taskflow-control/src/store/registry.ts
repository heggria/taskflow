/**
 * ControlRegistry — non-authoritative discovery (D6 / D29 / P3).
 * Rebuild from Project ControlStore header restores same projectId/domainId.
 */
import type { DirectoryBinding } from "../types.ts";
import {
	ensureDir,
	readJsonFile,
	registryPath,
	userControlRoot,
	writeFileAtomic,
} from "../paths.ts";
import type { ProjectControlStore } from "./project-store.ts";

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
	ensureDir(userControlRoot(env));

	function load(): RegistryFile {
		return readJsonFile<RegistryFile>(file) ?? { schemaVersion: 1, entries: [] };
	}

	function save(data: RegistryFile): void {
		writeFileAtomic(file, JSON.stringify(data, null, 2));
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
			const h = store.header;
			const data = load();
			const now = Date.now();
			const existing = data.entries.findIndex((e) => e.projectId === h.projectId);
			const entry: RegistryEntry = {
				projectId: h.projectId,
				controlDomainId: h.controlDomainId,
				storePath: store.projectRoot,
				projectRoot: projectRoot.replace(/\/$/, ""),
				directoryBinding: h.directoryBinding,
				mountState: "mounted",
				registeredAt: existing >= 0 ? data.entries[existing]!.registeredAt : now,
				updatedAt: now,
			};
			if (existing >= 0) data.entries[existing] = entry;
			else data.entries.push(entry);
			save(data);
			return entry;
		},

		wipe() {
			save({ schemaVersion: 1, entries: [] });
		},
	};
}
