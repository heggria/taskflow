/**
 * taskflow-control — 0.3-C control plane core.
 *
 * Exposes the proposed TypeBox wire contracts (`./schema` — not frozen),
 * ControlHost daemon/supervisor/standalone, Unix UDS singleton attach,
 * files-only project ControlStore, hello-before-RPC negotiation, and the
 * TE-backed execution provider (the only legal execution authority in 0.3-C).
 *
 * Depends only on taskflow-core (read-only TE schema/helper imports) and
 * typebox.
 */

export * from "./schema/index.ts";
export * from "./errors.ts";
export * from "./modes.ts";
export * from "./hello.ts";
export * from "./singleton.ts";
export * from "./uds.ts";
export * from "./te-provider.ts";
export * from "./control-host.ts";
export * from "./store/index.ts";
export { ProjectRegistry, type ProjectMount } from "./project-registry.ts";
export { createAuthorizationAuthority, answerAuthorizationChallenge, AUTHORIZATION_CAPABILITIES } from "./authorization.ts";
export type { AuthorizationAuthority, AuthorizationAuthorityOptions, VerifiedContext, AuthorizationBinding } from "./authorization.ts";
export { ApprovalService } from "./approval-service.ts";
export { ProjectAdmissionService } from "./admission-service.ts";
export { RuntimeTeExecutionProvider } from "./runtime-provider.ts";
export { createControlEvidenceStore, readControlEvidence, compactControlEvidence } from "./store/evidence-adapter.ts";
export { launchControlConsole } from "./control-console.ts";
export * from "./store/project-lifecycle.ts";
export * from "./legacy-conflict.ts";

// Convenience: the wire protocol major used by the negotiation gate.
export { PROTOCOL_MAJOR } from "./schema/transport.ts";
