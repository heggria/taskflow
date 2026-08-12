/**
 * Unified 0.3-C error envelope (P4). `ControlError` is the runtime shape;
 * `toEnvelope()` produces the closed wire ErrorEnvelope. Custom bare codes are
 * forbidden — only the closed TF_* set (schema/transport.ts) is used.
 */

import {
	CONTROL_ERROR_CODES,
	type ControlErrorCode,
	type ErrorEnvelope,
	type RecoveryAction,
	type SideEffects,
} from "./schema/transport.ts";

export { CONTROL_ERROR_CODES } from "./schema/transport.ts";
export type { ControlErrorCode, ErrorEnvelope } from "./schema/transport.ts";

export interface ControlErrorOptions {
	recoveryAction?: RecoveryAction;
	sideEffects?: SideEffects;
	commandId?: string;
	commitSeq?: number;
	controlDomainId?: string;
	projectId?: string;
	cause?: unknown;
}

/** P4 default mapping: most wire errors are command-level with no side effects. */
const DEFAULT_RECOVERY: { recoveryAction: RecoveryAction; sideEffects: SideEffects } = {
	recoveryAction: "none",
	sideEffects: "none",
};

export class ControlError extends Error {
	readonly code: ControlErrorCode;
	readonly recoveryAction: RecoveryAction;
	readonly sideEffects: SideEffects;
	readonly commandId?: string;
	readonly commitSeq?: number;
	readonly controlDomainId?: string;
	readonly projectId?: string;

	constructor(code: ControlErrorCode, message: string, options: ControlErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ControlError";
		this.code = code;
		this.recoveryAction = options.recoveryAction ?? DEFAULT_RECOVERY.recoveryAction;
		this.sideEffects = options.sideEffects ?? DEFAULT_RECOVERY.sideEffects;
		this.commandId = options.commandId;
		this.commitSeq = options.commitSeq;
		this.controlDomainId = options.controlDomainId;
		this.projectId = options.projectId;
	}

	toEnvelope(): ErrorEnvelope {
		return {
			code: this.code,
			message: this.message,
			recoveryAction: this.recoveryAction,
			sideEffects: this.sideEffects,
			...(this.commandId !== undefined ? { commandId: this.commandId } : {}),
			...(this.commitSeq !== undefined ? { commitSeq: this.commitSeq } : {}),
			...(this.controlDomainId !== undefined ? { controlDomainId: this.controlDomainId } : {}),
			...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
		};
	}
}

/** Convenience builder for protocol/negotiation failures. */
export function protocolError(message: string, options: ControlErrorOptions = {}): ControlError {
	return new ControlError("TF_PROTOCOL_INCOMPATIBLE", message, options);
}

/**
 * P4 normative pin: TF_RECONCILE_REQUIRED is always `operator` + `unknown` and
 * status RPCs return a normal snapshot, never a transport-level failure.
 */
export function reconcileRequired(message: string, options: Omit<ControlErrorOptions, "recoveryAction" | "sideEffects"> = {}): ControlError {
	return new ControlError("TF_RECONCILE_REQUIRED", message, {
		...options,
		recoveryAction: "operator",
		sideEffects: "unknown",
	});
}

/** Fail-closed helper for bootstrap/singleton failures (P13). */
export function bootstrapFailed(message: string, options: ControlErrorOptions = {}): ControlError {
	return new ControlError("TF_BOOTSTRAP_FAILED", message, options);
}

/** Assert a value is a closed wire code (guards against bare custom codes). */
export function assertClosedControlCode(code: string): asserts code is ControlErrorCode {
	if (!(CONTROL_ERROR_CODES as readonly string[]).includes(code)) {
		throw new Error(`TF_COMMAND_FAILED: not a closed 0.3-C wire error code: ${code}`);
	}
}
