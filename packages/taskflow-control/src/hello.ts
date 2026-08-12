/**
 * Hello-before-RPC negotiation gate (P4 / RFC §18).
 *
 * The first message on any control channel MUST be a NegotiationHandshake.
 * No RPC is dispatched before a successful hello. Failures:
 * - protocolMajor mismatch → TF_PROTOCOL_INCOMPATIBLE
 * - no overlapping supported schema → TF_SCHEMA_UNSUPPORTED
 * - unmet requiredFeatures (either direction) → TF_FEATURE_REQUIRED
 *
 * Compatible clients then exchange their supported read/write schema lists;
 * an unknown schema on a later message → TF_SCHEMA_UNSUPPORTED (never silent
 * reparse — wire-freeze rule 4).
 */

import { protocolError, ControlError } from "./errors.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "./schema/transport.ts";

export type HelloVerdict =
	| { ok: true; serverHello: NegotiationHandshake }
	| { ok: false; error: ControlError };

export interface HelloGateOptions {
	/** Features the server requires a client to offer. */
	requiredFeatures?: readonly string[];
	/** Extra schemas the server accepts beyond its declared list. */
	extraReadSchemas?: readonly string[];
}

export interface HelloGate {
	/** True once a client has passed the handshake; RPCs before this are rejected. */
	readonly greeted: boolean;
	/** The server's own handshake (sent back on success). */
	readonly serverHello: NegotiationHandshake;
	hello(clientHello: unknown): HelloVerdict;
}

export function createHelloGate(
	serverHello: NegotiationHandshake,
	options: HelloGateOptions = {},
): HelloGate {
	const requiredFeatures = [...(options.requiredFeatures ?? [])];
	let greeted = false;

	const validate = (clientHello: unknown): HelloVerdict => {
		if (typeof clientHello !== "object" || clientHello === null || Array.isArray(clientHello)) {
			return { ok: false, error: protocolError("hello must be a NegotiationHandshake object") };
		}
		const hello = clientHello as NegotiationHandshake;
		if (typeof hello.protocolMajor !== "number" || hello.protocolMajor !== PROTOCOL_MAJOR) {
			return {
				ok: false,
				error: protocolError(
					`protocolMajor ${JSON.stringify(hello.protocolMajor)} is incompatible; expected ${PROTOCOL_MAJOR}`,
				),
			};
		}
		if (!Array.isArray(hello.supportedReadSchemas) || !Array.isArray(hello.supportedWriteSchemas)) {
			return { ok: false, error: protocolError("hello must declare supportedReadSchemas and supportedWriteSchemas") };
		}
		const serverRead = new Set([...serverHello.supportedReadSchemas, ...(options.extraReadSchemas ?? [])]);
		const schemaOverlap = hello.supportedReadSchemas.some((schema) => serverRead.has(schema));
		if (!schemaOverlap) {
			return {
				ok: false,
				error: new ControlError(
					"TF_SCHEMA_UNSUPPORTED",
					`no overlapping supported read schema (client: ${hello.supportedReadSchemas.join(",")})`,
					{ recoveryAction: "refresh", sideEffects: "none" },
				),
			};
		}
		const clientRequired = hello.requiredFeatures ?? [];
		for (const feature of clientRequired) {
			if (!(serverHello.offeredFeatures ?? []).includes(feature)) {
				return {
					ok: false,
					error: new ControlError(
						"TF_FEATURE_REQUIRED",
						`client requires feature ${JSON.stringify(feature)} which this control does not offer`,
						{ recoveryAction: "refresh", sideEffects: "none" },
					),
				};
			}
		}
		for (const feature of requiredFeatures) {
			if (!(hello.offeredFeatures ?? []).includes(feature)) {
				return {
					ok: false,
					error: new ControlError(
						"TF_FEATURE_REQUIRED",
						`control requires feature ${JSON.stringify(feature)} which the client does not offer`,
						{ recoveryAction: "refresh", sideEffects: "none" },
					),
				};
			}
		}
		return { ok: true, serverHello };
	};

	return {
		get greeted() {
			return greeted;
		},
		serverHello,
		hello(clientHello: unknown): HelloVerdict {
			const verdict = validate(clientHello);
			if (verdict.ok) greeted = true;
			return verdict;
		},
	};
}

/** Rejection for any RPC attempted before a successful hello. */
export function helloRequiredError(): ControlError {
	return protocolError("hello must precede any RPC on this control channel");
}
