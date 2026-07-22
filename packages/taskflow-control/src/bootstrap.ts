/**
 * Fresh-install bootstrap (P13 / §5).
 * controlMode auto: ensure registry + project store + singleton attach/start.
 * Silent auto→standalone is forbidden.
 */
import {
	DEFAULT_CONTROL_MODE,
	type ControlMode,
} from "./types.ts";
import { createControlHost, type ControlHost, type ControlHostOptions } from "./control-host.ts";
import type { ExecutionProvider } from "./provider.ts";

export interface BootstrapOptions {
	projectRoot: string;
	controlMode?: ControlMode;
	env?: NodeJS.ProcessEnv;
	provider?: ExecutionProvider;
	holderId?: string;
	skipSingleton?: boolean;
}

export interface BootstrapResult {
	host: ControlHost;
	controlMode: ControlMode;
	/** writer | attach | standalone-local */
	role: "writer" | "attach" | "standalone-local";
}

/**
 * Bootstrap ControlHost per controlMode.
 * - auto (default): registry + project store + singleton multi-mount; fail closed if singleton impossible
 * - coordinated: same as auto but requires existing singleton writer (attach only) — fail closed if none
 * - standalone: explicit only; in-process host on project store; no multi-project concurrency claims intent
 */
export function bootstrapControl(opts: BootstrapOptions): BootstrapResult {
	const controlMode = opts.controlMode ?? DEFAULT_CONTROL_MODE;

	if (controlMode === "standalone") {
		const host = createControlHost({
			projectRoot: opts.projectRoot,
			controlMode: "standalone",
			env: opts.env,
			provider: opts.provider,
			holderId: opts.holderId,
			skipSingleton: true,
		});
		return { host, controlMode, role: "standalone-local" };
	}

	// auto | coordinated — never silently degrade to full standalone
	const hostOpts: ControlHostOptions = {
		projectRoot: opts.projectRoot,
		controlMode,
		env: opts.env,
		provider: opts.provider,
		holderId: opts.holderId,
		skipSingleton: opts.skipSingleton,
	};

	const host = createControlHost(hostOpts);

	if (controlMode === "coordinated" && !opts.skipSingleton) {
		if (!host.singleton) {
			host.close();
			throw Object.assign(new Error("TF_BOOTSTRAP_FAILED: coordinated mode requires singleton control"), {
				code: "TF_BOOTSTRAP_FAILED",
			});
		}
		// coordinated prefers attach to external writer; if we became writer that's OK
		// (we are the control) — if skip not set, singleton always set.
	}

	const role =
		host.singleton?.role === "attach"
			? "attach"
			: host.singleton?.role === "writer"
				? "writer"
				: "writer";

	return { host, controlMode, role };
}

/** Assert mode is never silently rewritten. */
export function assertControlModeExplicit(
	requested: ControlMode | undefined,
	effective: ControlMode,
): void {
	const req = requested ?? DEFAULT_CONTROL_MODE;
	if (req === "auto" && effective === "standalone") {
		throw new Error(
			"forbidden: silent controlMode auto → standalone (set controlMode: standalone explicitly)",
		);
	}
}
