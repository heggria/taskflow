/**
 * controlMode selection + fail-closed mode contracts (P13 / RFC §5, D5).
 *
 * - auto (default): ensure registry + project store; start or attach the user
 *   singleton multi-mount control; control cannot run ⇒ fail closed.
 * - coordinated: external control required; down ⇒ fail closed.
 * - standalone: explicit; in-process ControlHost opens the same project
 *   ControlStore; single-owner lease; no global concurrency claims.
 *
 * Silent fallback auto → standalone is FORBIDDEN (P13). Only an explicit
 * `controlMode: standalone` may run standalone.
 */

import { ControlError, bootstrapFailed } from "./errors.ts";

export const CONTROL_MODES = ["auto", "coordinated", "standalone"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** Environment override for the mode (documented convenience; CLI wins). */
export const CONTROL_MODE_ENV = "TASKFLOW_CONTROL_MODE";

export interface ControlModeContract {
	mode: ControlMode;
	/** auto/coordinated participate in the user singleton; standalone is explicit in-process. */
	singletonRequired: boolean;
	/** coordinated requires an existing external control; auto may start one. */
	externalControlRequired: boolean;
	/** standalone never claims global (cross-project) concurrency authority. */
	globalAuthority: boolean;
	failClosedDescription: string;
}

const MODE_CONTRACTS: Record<ControlMode, ControlModeContract> = {
	auto: {
		mode: "auto",
		singletonRequired: true,
		externalControlRequired: false,
		globalAuthority: true,
		failClosedDescription: "auto fails closed when the user singleton control cannot run; it never falls back to standalone",
	},
	coordinated: {
		mode: "coordinated",
		singletonRequired: true,
		externalControlRequired: true,
		globalAuthority: true,
		failClosedDescription: "coordinated fails closed when the external control is down",
	},
	standalone: {
		mode: "standalone",
		singletonRequired: false,
		externalControlRequired: false,
		globalAuthority: false,
		failClosedDescription: "standalone is explicit only; single-owner lease, no global concurrency claims",
	},
};

export function controlModeContract(mode: ControlMode): ControlModeContract {
	return MODE_CONTRACTS[mode];
}

/**
 * Parse the control mode. `undefined` / empty / "auto" → auto (fresh-install
 * default, P13). Any other string fails closed (TF_BOOTSTRAP_FAILED) — an
 * unknown mode must never silently choose a weaker one.
 */
export function parseControlMode(value: string | undefined): ControlMode {
	const candidate = value?.trim().toLowerCase();
	if (candidate === undefined || candidate === "" || candidate === "auto") return "auto";
	if ((CONTROL_MODES as readonly string[]).includes(candidate)) return candidate as ControlMode;
	throw bootstrapFailed(`invalid controlMode ${JSON.stringify(value)}; expected auto|coordinated|standalone`);
}

/** Resolve mode from explicit option first, then the environment. */
export function resolveControlMode(explicit?: string): ControlMode {
	return parseControlMode(explicit ?? process.env[CONTROL_MODE_ENV]);
}

export type ControlStartDecision =
	| { mode: "auto"; action: "start-or-attach"; singletonRequired: true; globalAuthority: true }
	| { mode: "coordinated"; action: "attach-external"; singletonRequired: true; globalAuthority: true }
	| { mode: "standalone"; action: "standalone"; singletonRequired: false; globalAuthority: false };

/**
 * Decide what the ControlHost must do for a mode, failing closed when the
 * mode's control cannot be satisfied:
 * - auto + control unavailable → TF_BOOTSTRAP_FAILED (never silent standalone)
 * - coordinated + control unavailable → TF_JOURNAL_UNAVAILABLE (control down)
 * - standalone → explicit standalone regardless of singleton availability
 */
export function resolveControlStart(mode: ControlMode, controlAvailable: boolean): ControlStartDecision {
	switch (mode) {
		case "auto": {
			if (!controlAvailable) {
				throw bootstrapFailed(
					"auto mode requires the user singleton control; control cannot run and silent fallback to standalone is forbidden (P13)",
				);
			}
			return { mode: "auto", action: "start-or-attach", singletonRequired: true, globalAuthority: true };
		}
		case "coordinated": {
			if (!controlAvailable) {
				throw new ControlError(
					"TF_JOURNAL_UNAVAILABLE",
					"coordinated mode requires an external control which is down; failing closed (P13)",
					{ recoveryAction: "refresh", sideEffects: "none" },
				);
			}
			return { mode: "coordinated", action: "attach-external", singletonRequired: true, globalAuthority: true };
		}
		case "standalone": {
			return { mode: "standalone", action: "standalone", singletonRequired: false, globalAuthority: false };
		}
	}
}
