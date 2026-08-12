/**
 * taskflow-control — 0.3-C control plane core.
 *
 * Exposes the frozen TypeBox wire contracts (`./schema`), the ControlHost
 * daemon/supervisor/standalone contracts, the user singleton lock/endpoint/
 * fencing layer, hello-before-RPC negotiation, and the TE-backed execution
 * provider (the only legal execution authority in 0.3-C).
 *
 * Depends only on taskflow-core (read-only TE schema/helper imports) and
 * typebox.
 */

export * from "./schema/index.ts";
export * from "./errors.ts";
export * from "./modes.ts";
export * from "./hello.ts";
export * from "./singleton.ts";
export * from "./te-provider.ts";
export * from "./control-host.ts";

// Convenience: the wire protocol major used by the negotiation gate.
export { PROTOCOL_MAJOR } from "./schema/transport.ts";
