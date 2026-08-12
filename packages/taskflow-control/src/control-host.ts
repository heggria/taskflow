/**
 * ControlHost — one control semantic in every mode (D18).
 *
 * Modes (P13 / RFC §5):
 * - auto (default): ensure registry + project store; start or attach the user
 *   singleton multi-mount control (taskflowd OR embedded supervisor competing
 *   for the SAME lock + endpoint — D32). Control cannot run ⇒ fail closed.
 * - coordinated: external control required; attach-only, down ⇒ fail closed.
 * - standalone: explicit; in-process ControlHost, single-owner lease, no
 *   global concurrency claims.
 *
 * The host also enforces hello-before-RPC (P4) and fencing epoch checks
 * (P16) on every dispatch, and accepts only a TE-backed ExecutionProvider as
 * its execution authority (RFC §16 / P8).
 */

import * as fs from "node:fs";
import { getBuildInfo } from "taskflow-core";
import { ControlError, bootstrapFailed } from "./errors.ts";
import { createHelloGate, helloRequiredError, type HelloGate, type HelloVerdict } from "./hello.ts";
import { resolveControlMode, type ControlMode } from "./modes.ts";
import {
	acquireUserSingleton,
	defaultProcessIdentity,
	recoverStaleEndpoint,
	renewCoordinatorLease,
	singletonPaths,
	type ObservedProcessLike,
	type ProcessIdentityLike,
	type SingletonAcquireResult,
	type SingletonPaths,
} from "./singleton.ts";
import { CONTROL_WIRE_SCHEMA_VERSION, PROTOCOL_MAJOR, type NegotiationHandshake } from "./schema/index.ts";
import type { ExecutionProvider } from "./te-provider.ts";
import type { RunSnapshot } from "./schema/run.ts";

export interface ControlHostOptions {
	/** Default auto (fresh install, P13). */
	mode?: ControlMode;
	/** User control home (default `~/.taskflow/control`, TASKFLOW_HOME override). */
	controlHome?: string;
	/** Project ControlStore path (S3 opens it; standalone opens the same store). */
	projectStorePath?: string;
	/** The ONLY legal execution authority: TE-backed (see te-provider.ts). */
	provider: ExecutionProvider;
	holderId?: string;
	processIdentity?: ProcessIdentityLike;
	inspectProcess?: (pid: number) => ObservedProcessLike;
	now?: () => number;
	leaseTtlMs?: number;
	singletonPaths?: SingletonPaths;
	/** Server hello for the negotiation gate (defaults to this package's build). */
	serverHello?: NegotiationHandshake;
	/** Required features the host demands from clients (P4). */
	requiredFeatures?: readonly string[];
	/** Test seam: bypass the real singleton acquire. */
	singletonOverride?: () => SingletonAcquireResult;
}

export type ControlHostState = "stopped" | "started" | "failed-closed";
export type ControlHostSingleton = "won" | "attached" | "standalone" | "none";

export interface ControlHostStatus {
	mode: ControlMode;
	state: ControlHostState;
	singleton: ControlHostSingleton;
	fencingEpoch: number;
	holderId?: string;
	endpoint?: string;
	globalAuthority: boolean;
}

function defaultServerHello(): NegotiationHandshake {
	const info = getBuildInfo();
	return {
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: {
			packageVersion: info.packageVersion,
			gitCommit: info.gitCommit,
			schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
			...(info.buildTime !== undefined ? { buildTime: info.buildTime } : {}),
		},
	};
}

export class ControlHost {
	readonly mode: ControlMode;
	readonly provider: ExecutionProvider;
	readonly paths: SingletonPaths;
	readonly now: () => number;
	readonly #helloGate: HelloGate;
	readonly #options: ControlHostOptions;
	#state: ControlHostState = "stopped";
	#singleton: ControlHostSingleton = "none";
	#fencingEpoch = 0;
	#holderId?: string;
	#releaseSingleton?: () => void;

	constructor(options: ControlHostOptions) {
		if (!options.provider || options.provider.kind !== "te-resources") {
			throw new ControlError(
				"TF_AUTHORITY_REVOKED",
				"ControlHost requires a TE-backed execution authority (kind te-resources); no other provider is legal in 0.3-C",
				{ recoveryAction: "none", sideEffects: "none" },
			);
		}
		this.mode = resolveControlMode(options.mode);
		this.provider = options.provider;
		this.paths = options.singletonPaths ?? singletonPaths(options.controlHome);
		this.now = options.now ?? Date.now;
		this.#options = options;
		this.#helloGate = createHelloGate(options.serverHello ?? defaultServerHello(), {
			requiredFeatures: options.requiredFeatures,
		});
	}

	get state(): ControlHostState {
		return this.#state;
	}

	get status(): ControlHostStatus {
		return {
			mode: this.mode,
			state: this.#state,
			singleton: this.#singleton,
			fencingEpoch: this.#fencingEpoch,
			holderId: this.#holderId,
			endpoint: this.#singleton === "won" || this.#singleton === "attached" ? this.paths.endpointPath : undefined,
			globalAuthority: this.mode !== "standalone",
		};
	}

	get greeted(): boolean {
		return this.#helloGate.greeted;
	}

	hello(clientHello: unknown): HelloVerdict {
		return this.#helloGate.hello(clientHello);
	}

	async start(): Promise<ControlHostStatus> {
		if (this.#state === "started") return this.status;
		try {
			switch (this.mode) {
				case "standalone": {
					// Explicit standalone: single-owner lease, no singleton
					// competition, no global concurrency claims (P13).
					this.#acquireStandaloneLease();
					this.#state = "started";
					this.#singleton = "standalone";
					break;
				}
				case "auto":
				case "coordinated": {
					recoverStaleEndpoint(this.paths, { inspectProcess: this.#options.inspectProcess });
					const result = this.#options.singletonOverride
						? this.#options.singletonOverride()
						: acquireUserSingleton({
								paths: this.paths,
								holderId: this.#options.holderId,
								processIdentity: this.#options.processIdentity,
								inspectProcess: this.#options.inspectProcess,
								now: this.#options.now,
								leaseTtlMs: this.#options.leaseTtlMs,
								attachOnly: this.mode === "coordinated",
							});
					if (result.status === "won") {
						this.#singleton = "won";
						this.#holderId = result.holderId;
						this.#fencingEpoch = result.fencingEpoch;
						this.#releaseSingleton = result.release;
					} else {
						// Loser attaches as a client to the winner (D32) — never
						// an independent multi-mount authority.
						this.#singleton = "attached";
						this.#holderId = result.holderId;
						this.#fencingEpoch = result.fencingEpoch;
					}
					this.#state = "started";
					break;
				}
			}
		} catch (error) {
			this.#state = "failed-closed";
			if (error instanceof ControlError) throw error;
			throw bootstrapFailed(`ControlHost could not start in ${this.mode} mode: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.status;
	}

	/**
	 * Hello-before-RPC dispatch. Every method call must follow a successful
	 * hello (P4) and carry a fencingEpoch >= the current lease epoch (P16).
	 */
	async dispatch<T>(method: string, params: unknown, context: { fencingEpoch: number }): Promise<T> {
		if (!this.#helloGate.greeted) {
			throw helloRequiredError();
		}
		if (context.fencingEpoch < this.#fencingEpoch) {
			throw new ControlError(
				"TF_AUTHORITY_REVOKED",
				`fencing epoch ${context.fencingEpoch} is stale; host epoch is ${this.#fencingEpoch}`,
				{ recoveryAction: "refresh", sideEffects: "none" },
			);
		}
		switch (method) {
			case "control.status":
				return this.status as unknown as T;
			case "control.probe": {
				return await this.provider.probe() as unknown as T;
			}
			case "runs.status": {
				const runId = typeof params === "object" && params !== null && "runId" in params
					? String((params as { runId: unknown }).runId)
					: undefined;
				const snapshot: RunSnapshot = {
					runId: runId ?? "00000000-0000-0000-0000-000000000000",
					projectId: "00000000-0000-0000-0000-000000000000",
					controlDomainId: "00000000-0000-0000-0000-000000000000",
					status: "unknown",
					stage: "received",
					slot: "none",
					needsOperator: false,
				};
				return snapshot as unknown as T;
			}
			default:
				throw new ControlError(
					"TF_COMMAND_FAILED",
					`unknown control RPC ${JSON.stringify(method)}`,
					{ recoveryAction: "retry-new-command", sideEffects: "none" },
				);
		}
	}

	/** Renew the coordinator lease while held (best-effort; S3 wires the timer). */
	renewLease(): void {
		if (this.#singleton === "won" && this.#holderId !== undefined) {
			renewCoordinatorLease(this.paths, this.#holderId, this.#fencingEpoch, this.#options.leaseTtlMs ?? 30_000, this.now);
		}
	}

	stop(): void {
		if (this.#releaseSingleton) {
			try { this.#releaseSingleton(); } catch { /* best effort */ }
			this.#releaseSingleton = undefined;
		}
		this.#singleton = "none";
		this.#fencingEpoch = 0;
		this.#state = "stopped";
	}

	#acquireStandaloneLease(): void {
		const leasePath = `${this.paths.controlHome}/standalone-lease.json`;
		const holderId = this.#options.holderId ?? `standalone-${defaultProcessIdentity().pid}`;
		const identity = this.#options.processIdentity ?? defaultProcessIdentity();
		try {
			const fd = fs.openSync(leasePath, "wx", 0o600);
			try {
				fs.writeFileSync(fd, JSON.stringify({
					version: 1,
					holderId,
					pid: identity.pid,
					birthToken: identity.birthToken,
					acquiredAt: this.now(),
					endpoint: this.paths.endpointPath,
				}));
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw bootstrapFailed(`standalone lease already exists at ${leasePath}; a standalone control is already running for this project`);
			}
			throw error;
		}
		this.#holderId = holderId;
		this.#fencingEpoch = 1;
	}
}

// Re-export the mode/env surface used by hosts.
export { CONTROL_MODE_ENV, resolveControlMode } from "./modes.ts";
export type { ControlMode } from "./modes.ts";
export { defaultServerHello };
