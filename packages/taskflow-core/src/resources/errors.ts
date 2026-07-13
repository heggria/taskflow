/** Stable, redaction-safe failures emitted by the workspace capability plane. */

export const WORKSPACE_ERROR_CODES = [
	"TFWS_UNAUTHORIZED_GRANT",
	"TFWS_UNKNOWN_WORKSPACE",
	"TFWS_INVALID_PATH",
	"TFWS_PATH_ESCAPE",
	"TFWS_ACCESS_ESCALATION",
	"TFWS_CREDENTIAL_DENIED",
	"TFWS_PROVIDER_DENIED",
	"TFWS_PROVIDER_ACQUIRE_FAILED",
	"TFWS_PROVIDER_RELEASE_FAILED",
	"TFWS_UNSUPPORTED_SANDBOX_POLICY",
	"TFWS_LEASE_TIMEOUT",
	"TFWS_WRITE_INTENT_FAILED",
	"TFWS_RESOURCE_DIRTY",
	"TFWS_VERSION_COMMIT_UNAVAILABLE",
	"TFWS_CACHE_RESTORE_RACE",
	"TFWS_STATE_RESTORE_FAILED",
	"TFWS_IDENTITY_MISMATCH",
	"TFWS_HANDLE_INVALID",
	"TFWS_SELECTOR_INVALID",
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];
export type WorkspaceErrorScope = "phase" | "run";
export type WorkspaceRetryScope = "none" | "same-attempt" | "new-attempt" | "after-reconcile" | "new-run";
export type WorkspaceRecovery = "none" | "cleanup" | "reconcile" | "rebind";

export interface WorkspacePolicyError {
	code: WorkspaceErrorCode;
	scope: WorkspaceErrorScope;
	retryable: boolean;
	terminal: boolean;
	retryScope: WorkspaceRetryScope;
	affectedResourceDomainIds?: string[];
	recoveryRequired?: WorkspaceRecovery;
	phaseId?: string;
	logicalWorkspaceId?: string;
	/** Must never contain a physical root. */
	redactedMessage: string;
}

interface ErrorDefaults {
	scope: WorkspaceErrorScope;
	retryable: boolean;
	terminal: boolean;
	retryScope: WorkspaceRetryScope;
	recoveryRequired?: WorkspaceRecovery;
}

const DEFAULTS: Record<WorkspaceErrorCode, ErrorDefaults> = {
	TFWS_UNAUTHORIZED_GRANT: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_UNKNOWN_WORKSPACE: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_INVALID_PATH: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_PATH_ESCAPE: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_ACCESS_ESCALATION: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_CREDENTIAL_DENIED: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_PROVIDER_DENIED: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_PROVIDER_ACQUIRE_FAILED: { scope: "phase", retryable: true, terminal: false, retryScope: "new-attempt" },
	TFWS_PROVIDER_RELEASE_FAILED: {
		scope: "run",
		retryable: true,
		terminal: false,
		retryScope: "after-reconcile",
		recoveryRequired: "cleanup",
	},
	TFWS_UNSUPPORTED_SANDBOX_POLICY: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_LEASE_TIMEOUT: { scope: "phase", retryable: true, terminal: false, retryScope: "new-attempt" },
	TFWS_WRITE_INTENT_FAILED: { scope: "phase", retryable: true, terminal: true, retryScope: "new-attempt" },
	TFWS_RESOURCE_DIRTY: {
		scope: "run",
		retryable: true,
		terminal: false,
		retryScope: "after-reconcile",
		recoveryRequired: "reconcile",
	},
	TFWS_VERSION_COMMIT_UNAVAILABLE: {
		scope: "run",
		retryable: true,
		terminal: false,
		retryScope: "after-reconcile",
		recoveryRequired: "reconcile",
	},
	TFWS_CACHE_RESTORE_RACE: { scope: "phase", retryable: true, terminal: false, retryScope: "same-attempt" },
	TFWS_STATE_RESTORE_FAILED: {
		scope: "run",
		retryable: true,
		terminal: true,
		retryScope: "after-reconcile",
		recoveryRequired: "reconcile",
	},
	TFWS_IDENTITY_MISMATCH: {
		scope: "run",
		retryable: false,
		terminal: true,
		retryScope: "none",
		recoveryRequired: "rebind",
	},
	TFWS_HANDLE_INVALID: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
	TFWS_SELECTOR_INVALID: { scope: "phase", retryable: false, terminal: true, retryScope: "none" },
};

export type WorkspacePolicyErrorOverrides = Partial<Omit<WorkspacePolicyError, "code" | "redactedMessage">>;

export function workspacePolicyError(
	code: WorkspaceErrorCode,
	redactedMessage: string,
	overrides: WorkspacePolicyErrorOverrides = {},
): WorkspacePolicyError {
	return { code, ...DEFAULTS[code], redactedMessage, ...overrides };
}

export function isWorkspacePolicyError(value: unknown): value is WorkspacePolicyError {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<WorkspacePolicyError>;
	return (
		typeof candidate.code === "string" &&
		(WORKSPACE_ERROR_CODES as readonly string[]).includes(candidate.code) &&
		(candidate.scope === "phase" || candidate.scope === "run") &&
		typeof candidate.retryable === "boolean" &&
		typeof candidate.terminal === "boolean" &&
		["none", "same-attempt", "new-attempt", "after-reconcile", "new-run"].includes(String(candidate.retryScope)) &&
		typeof candidate.redactedMessage === "string"
	);
}
