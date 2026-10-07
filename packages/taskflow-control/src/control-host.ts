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
import * as path from "node:path";
import { ProjectRegistry } from "./project-registry.ts";
import { HostRuntime, type HostRuntimeOptions } from "./host-runtime.ts";
import { RuntimeTeExecutionProvider } from "./runtime-provider.ts";
import type { AuthorizationAuthority, VerifiedContext } from "./authorization.ts";
import type { UdsConnection } from "./uds.ts";
import { getBuildInfo } from "taskflow-core";
import { ControlError, bootstrapFailed } from "./errors.ts";
import { createHelloGate, helloRequiredError, type HelloGate, type HelloVerdict } from "./hello.ts";
import { resolveControlMode, type ControlMode } from "./modes.ts";
import {
	acquireUserSingleton,
	recoverStaleEndpoint,
	renewCoordinatorLease,
	singletonPaths,
	type ObservedProcessLike,
	type ProcessIdentityLike,
	type SingletonAcquireResult,
	type SingletonPaths,
} from "./singleton.ts";
import { connectUdsClient, startUdsServer, type UdsClient, type UdsServer } from "./uds.ts";
import { openControlStore, type ControlStore } from "./store/index.ts";
import { CONTROL_WIRE_SCHEMA_VERSION, PROTOCOL_MAJOR, type NegotiationHandshake } from "./schema/index.ts";

import type { ExecutionProvider } from "./te-provider.ts";



export interface ControlHostOptions {
	registry?: ProjectRegistry;
	authorization?: AuthorizationAuthority;
	projectRoot?: string;
	projectMounts?: {storePath: string; projectRoot: string}[];
	trustedInProcessFeatures?: readonly string[];
	maxActiveRuns?: number;
	evidenceFactory?: HostRuntimeOptions["evidenceFactory"];
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
		offeredFeatures: ["durable-approval"],
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
	#udsServer?: UdsServer;
	#udsClient?: UdsClient;
	#leaseTimer?: NodeJS.Timeout;
	#store?: ControlStore;
	#standalonePaths?: SingletonPaths;
	#runtime?: HostRuntime;
	#registry?: ProjectRegistry;
	#ownsRegistry = false;
	#ready: Promise<void>;
	#signalReady!: () => void;
	#starting?: Promise<ControlHostStatus>;
	#contextFeatures = new WeakMap<object, readonly string[]>();
	#connections = new WeakMap<object, {context?: VerifiedContext; challengeId?: string}>();

	constructor(options: ControlHostOptions) {
		this.#ready = new Promise(resolve => { this.#signalReady = resolve; });
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
		if (this.#starting) return this.#starting;
		const starting=this.#startOnce();this.#starting=starting;
		try { return await starting; } finally { this.#starting=undefined; }
	}

	async #startOnce(): Promise<ControlHostStatus> {
		this.#ready=new Promise(resolve=>{this.#signalReady=resolve;});
		try {
			switch (this.mode) {
				case "standalone": {
					// Explicit standalone: single-owner lease, no singleton
					// competition, no global concurrency claims (P13).
					this.#acquireStandaloneLease();
					this.#state = "started";
					this.#singleton = "standalone";
					this.#startLeaseTimer();
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
						// S2: the winner listens on the user singleton endpoint so
						// losers attach over a real Unix socket (D32 — lock-layer
						// labels are NOT attach).
						try {
							this.#udsServer = await startUdsServer({
								endpointPath: this.paths.endpointPath,
								serverHello: this.#helloGate.serverHello,
								requiredFeatures: this.#options.requiredFeatures,
								getFencingEpoch: () => this.#fencingEpoch,
								handleRpc: async (method, params, fencingEpoch, connection) => { await this.#ready; return this.#dispatchWire(method, params, fencingEpoch, connection); },
								onDisconnect: connection => { const ctx = this.#connections.get(connection.token)?.context; if (ctx) this.#options.authorization?.revokeContext(ctx); this.#connections.delete(connection.token); },
							});
						} catch (error) {
							try { result.release(); } catch { /* best effort */ }
							this.#releaseSingleton = undefined;
							throw bootstrapFailed(
								`won the user singleton but could not listen on control endpoint ${this.paths.endpointPath}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						this.#startLeaseTimer();
					} else {
						// Loser attaches as a client to the winner (D32) — the
						// fencing epoch is received on the wire in the hello-ack,
						// never trusted from the lock file alone (A2b).
						let client: UdsClient;
						try {
							client = await this.#connectWinner(result.endpoint);
						} catch (error) {
							throw bootstrapFailed(
								`attached to the winner but could not reach its control endpoint ${result.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						this.#singleton = "attached";
						this.#holderId = result.holderId;
						this.#fencingEpoch = client.fencingEpoch;
						this.#udsClient = client;
						await this.#verifyAttachedProjectStore(client);
					}
					this.#state = "started";
					break;
				}
			}
			this.#openProjectStore();
			if (this.#registry && this.#options.authorization && this.provider instanceof RuntimeTeExecutionProvider && this.#singleton !== "attached") {
				this.#runtime = new HostRuntime({ registry: this.#registry, authorization: this.#options.authorization, provider: this.provider, controlHome: this.paths.controlHome, maxActiveRuns: this.#options.maxActiveRuns, epoch: () => this.#fencingEpoch, holderId: () => this.#holderId!, liveLease: () => this.#liveLease(), evidenceFactory: this.#options.evidenceFactory, durableApprovalAvailable: context => (this.#contextFeatures.get(context) ?? this.#options.trustedInProcessFeatures ?? []).includes("durable-approval") });
				await this.#runtime.initialize();
			}
		} catch (error) {
			this.stop();
			this.#state = "failed-closed";
			this.#signalReady();
			if (error instanceof ControlError) throw error;
			throw bootstrapFailed(`ControlHost could not start in ${this.mode} mode: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.#signalReady();
		return this.status;
	}

	/**
	 * Hello-before-RPC dispatch. Every method call must follow a successful
	 * hello (P4) and carry a fencingEpoch >= the current lease epoch (P16).
	 *
	 * An ATTACHED host routes its RPCs over the Unix socket to the winner's
	 * control plane (its own hello happened on the wire at connect time).
	 */
	async dispatch<T>(method: string, params: unknown, context: { fencingEpoch: number }): Promise<T> {
		if (this.#state !== "started") {
			throw bootstrapFailed("ControlHost must be started before dispatch");
		}
		if (this.#singleton === "attached" && this.#udsClient !== undefined) {
			if ((method.startsWith("control.store.") || method === "commands.submit") && !this.#options.projectStorePath) {
				throw bootstrapFailed("projectStorePath is required for attached project store RPCs");
			}
			return this.#udsClient.rpc<T>(method, params, context.fencingEpoch);
		}
		if (!this.#helloGate.greeted) {
			throw helloRequiredError();
		}
		return this.#dispatchCore(method, params, context.fencingEpoch);
	}

	/** RPC core without the in-process hello gate (the UDS layer enforces its own). */
	async #dispatchCore<T>(method: string, params: unknown, fencingEpoch: number): Promise<T> {
		if (fencingEpoch !== this.#fencingEpoch) {
			throw new ControlError(
				"TF_AUTHORITY_REVOKED",
				`fencing epoch ${fencingEpoch} is stale; host epoch is ${this.#fencingEpoch}`,
				{ recoveryAction: "refresh", sideEffects: "none" },
			);
		}
		switch (method) {
			case "control.status":
				return this.status as unknown as T;
			case "control.probe": {
				return await this.provider.probe() as unknown as T;
			}
			case "control.store.header":
			case "control.store.status":
			case "commands.submit":
			case "runs.status":
				throw new ControlError("TF_AUTHORITY_REVOKED", "project operations require a verified transport context");
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
		if ((this.#singleton === "won" || this.#singleton === "standalone") && this.#holderId !== undefined) {
			renewCoordinatorLease(this.#standalonePaths ?? this.paths, this.#holderId, this.#fencingEpoch, this.#options.leaseTtlMs ?? 30_000, this.now);
		}
	}

	stop(): void {
		this.#signalReady();
		if (this.#leaseTimer) {
			clearInterval(this.#leaseTimer);
			this.#leaseTimer = undefined;
		}
		this.#runtime?.close(); this.#runtime = undefined;
		if (this.#ownsRegistry) this.#registry?.close();
		this.#registry = undefined;
		if (this.#store) {
			try { this.#store.close(); } catch { /* best effort */ }
			this.#store = undefined;
		}
		this.#standalonePaths = undefined;
		const server = this.#udsServer;
		this.#udsServer = undefined;
		const client = this.#udsClient;
		this.#udsClient = undefined;
		if (server) {
			// Winner: stop accepting, drop live connections, then unlink OUR
			// socket while we still hold the lock (a live owner's endpoint is
			// never touched by recovery; unlinking after release could race a
			// fresh winner's listen).
			void server.close().catch(() => { /* best effort */ });
			try { fs.unlinkSync(this.paths.endpointPath); } catch { /* best effort */ }
		}
		if (client) {
			try { client.close(); } catch { /* best effort */ }
		}
		if (this.#releaseSingleton) {
			try { this.#releaseSingleton(); } catch { /* best effort */ }
			this.#releaseSingleton = undefined;
		}
		this.#singleton = "none";
		this.#holderId = undefined;
		this.#fencingEpoch = 0;
		this.#state = "stopped";
	}

	/**
	 * The host's client-side handshake when attaching to a winner: same build
	 * identity, but a connecting host demands nothing (requiredFeatures) and
	 * offers the features it would require from clients (P4 symmetric check).
	 */
	#clientHello(): NegotiationHandshake {
		const base = this.#options.serverHello ?? defaultServerHello();
		return {
			...base,
			requiredFeatures: [],
			offeredFeatures: [...(this.#options.requiredFeatures ?? [])],
		};
	}

	async #connectWinner(endpointPath: string): Promise<UdsClient> {
		const deadline = Date.now() + 2000;
		for (;;) { try { return await connectUdsClient({endpointPath,clientHello:this.#clientHello()}); }
			catch(error) { if(Date.now()>=deadline)throw error; await new Promise(resolve=>setTimeout(resolve,25)); } }
	}

	/** Keep the coordinator lease valid while the winner holds the singleton. */
	#startLeaseTimer(): void {
		const ttl = this.#options.leaseTtlMs ?? 30_000;
		const intervalMs = Math.max(1_000, Math.floor(ttl / 3));
		const timer = setInterval(() => {
			try {
				this.renewLease();
			} catch {
				/* best effort — the lease only gates fencing */
			}
		}, intervalMs);
		// Never keep a process alive just to renew a lease.
		timer.unref();
		this.#leaseTimer = timer;
	}

	#acquireStandaloneLease(): void {
		const standalonePaths={...this.paths,lockPath:path.join(this.paths.controlHome,"standalone-lease.json"),leasePath:path.join(this.paths.controlHome,"standalone-coordinator-lease.json"),endpointPath:path.join(this.paths.controlHome,"standalone.sock")};
		const result=acquireUserSingleton({paths:standalonePaths,holderId:this.#options.holderId,processIdentity:this.#options.processIdentity,inspectProcess:this.#options.inspectProcess,now:this.#options.now,leaseTtlMs:this.#options.leaseTtlMs});
		if(result.status!=="won")throw bootstrapFailed("standalone lease belongs to a live or unverified owner");
		this.#standalonePaths=standalonePaths;this.#holderId=result.holderId;this.#fencingEpoch=result.fencingEpoch;this.#releaseSingleton=result.release;
	}

	/** Until multi-mount routing exists, never silently use another project's ledger. */
	async #verifyAttachedProjectStore(_client: UdsClient): Promise<void> {
		// Mount identity is checked after authenticated challenge. An unauthenticated
		// peer cannot read another project's header or select its writer path.
	}

	#openProjectStore(): void {
		if (this.#singleton === "attached") return;
		if (this.#options.registry) { this.#registry = this.#options.registry; if (this.#options.projectStorePath) this.#registry.mount(this.#options.projectStorePath, this.#options.projectRoot); for (const mount of this.#options.projectMounts ?? []) this.#registry.mount(mount.storePath, mount.projectRoot); return; }
		const storePath = this.#options.projectStorePath;
		if (!storePath && !this.#options.projectMounts?.length) return;
		if (this.#options.authorization) {
			this.#registry = new ProjectRegistry(path.join(this.paths.controlHome, "registry.json")); this.#ownsRegistry = true;
			if (storePath) this.#registry.mount(storePath, this.#options.projectRoot);
			for (const mount of this.#options.projectMounts ?? []) this.#registry.mount(mount.storePath, mount.projectRoot); return;
		}
		if (storePath) this.#store = openControlStore(storePath);
	}

	#liveLease() {
		if (this.#state !== "started") return null;
		try { const lease = JSON.parse(fs.readFileSync((this.#standalonePaths ?? this.paths).leasePath, "utf8")); return lease.holderId === this.#holderId && lease.fencingEpoch === this.#fencingEpoch ? lease : null; } catch { return null; }
	}

	async dispatchAuthenticated<T = unknown>(context: VerifiedContext, method: string, params: unknown): Promise<T> {
		if (this.#state !== "started" || !this.#runtime || !this.#options.authorization) throw new ControlError("TF_AUTHORITY_REVOKED", "authenticated runtime is unavailable");
		this.#options.authorization.identity(context);
		if (method === "control.status") return this.status as T;
		if (method === "control.probe") return await this.provider.probe() as T;
		return await this.#runtime.dispatch(context, method, params) as T;
	}

	async #dispatchWire(method: string, params: unknown, epoch: number, connection: UdsConnection): Promise<unknown> {
		if (epoch !== this.#fencingEpoch || this.#state !== "started" || connection.closed) throw new ControlError("TF_AUTHORITY_REVOKED", "connection or epoch is no longer live");
		if (method === "control.status" || method === "control.probe") return this.#dispatchCore(method, params, epoch);
		const auth = this.#options.authorization; if (!auth || !this.#registry) throw new ControlError("TF_AUTHORITY_REVOKED", "transport authentication is not configured");
		let session = this.#connections.get(connection.token); if (!session) { session = {}; this.#connections.set(connection.token, session); }
		const body = params && typeof params === "object" ? params as Record<string, unknown> : {};
		if (method === "auth.challenge") {
			const mount = this.#registry.resolve(typeof body.projectId === "string" ? body.projectId : undefined);
			const challenge = auth.createChallenge({ projectId: mount.store.header.projectId, controlDomainId: mount.store.header.controlDomainId, projectRoot: mount.projectRoot });
			session.challengeId = challenge.id; return challenge;
		}
		if (method === "auth.authenticate") {
			if (typeof body.challengeId !== "string" || body.challengeId !== session.challengeId || typeof body.proof !== "string") throw new ControlError("TF_POLICY_DENIED", "challenge belongs to another connection");
			delete session.challengeId;
			if (session.context) auth.revokeContext(session.context);
			session.context = auth.authenticate(body.challengeId, body.proof); this.#contextFeatures.set(session.context, (connection.hello?.offeredFeatures ?? []).filter(feature=>this.#helloGate.serverHello.offeredFeatures.includes(feature))); return { authenticated: true };
		}
		if (!session.context) throw new ControlError("TF_AUTHORITY_REVOKED", "authenticate before project RPCs");
		return this.dispatchAuthenticated(session.context, method, params);
	}

}

// Re-export the mode/env surface used by hosts.
export { CONTROL_MODE_ENV, resolveControlMode } from "./modes.ts";
export type { ControlMode } from "./modes.ts";
export { defaultServerHello };
