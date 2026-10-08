/** Narrow durable-mutex entry point for cooperating local control services.
 * Unknown process observations never authorize reclamation of a live lock. */
import {
	PersistentFileMutex as BasePersistentFileMutex,
	defaultProcessIdentity,
	readProcessBirthToken,
	type ObservedProcess,
	type PersistentCoordinatorOptions,
} from "./resources/persistence.ts";

export {
	defaultProcessIdentity,
	readProcessBirthToken,
	type ObservedProcess,
	type PersistentCoordinatorOptions,
	type ProcessIdentity,
	type ProcessInspector,
} from "./resources/persistence.ts";

export function inspectPersistentOwner(pid: number): ObservedProcess {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return { alive: true };
	if (pid === process.pid) return { alive: true, ...defaultProcessIdentity() };
	try { process.kill(pid, 0); }
	catch (error) {
		// EPERM and unexpected OS errors mean unknown, not proof of death.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return { alive: false };
		return { alive: true };
	}
	const birthToken = readProcessBirthToken(pid);
	return birthToken === undefined ? { alive: true } : { alive: true, birthToken, birthTokenKind: "native" };
}

export class PersistentFileMutex extends BasePersistentFileMutex {
	constructor(lockPath: string, options: Omit<PersistentCoordinatorOptions, "directory"> = {}) {
		super(lockPath, { ...options, inspectProcess: options.inspectProcess ?? inspectPersistentOwner });
	}
}
