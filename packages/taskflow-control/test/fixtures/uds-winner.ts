/**
 * UDS process-test fixture: a ControlHost WINNER in `auto` mode.
 *
 * Listens on the user singleton endpoint (the UDS server is created inside
 * `start()`), prints `READY <status-json>` once started, then stays alive
 * until the parent kills it (SIGTERM → clean stop; SIGKILL → stale-socket
 * scenario). Exits non-zero with `ERROR <json>` if start() fails closed.
 *
 * Environment:
 *   TF_TEST_CONTROL_HOME  — control home (shared with the competing process)
 *   TF_TEST_HOLDER_ID     — holder id (default "uds-winner")
 */

import { ControlHost } from "../../src/control-host.ts";
import { createTeExecutionProvider, type TeExecutionAuthority } from "../../src/te-provider.ts";

function fakeProvider() {
	const te: TeExecutionAuthority = {
		assurance: "resolve-only-no-sandbox",
		probe: async () => ({
			classification: "resolve-only" as const,
			baselinePolicyId: "taskflow-resolve-only",
			hostProbeSha256: "a".repeat(64),
		}),
		prepare: async () => ({
			outcome: "accepted" as const,
			fulfillment: {
				preparationId: "prep",
				enforcementCapabilities: {
					resolution: "contained",
					mutationMediation: "brokered",
					processIsolation: "none",
					revocation: "admission-only",
					baselinePolicyId: "b",
					hostProbeSha256: "a".repeat(64),
				},
			},
		}),
		submit: async () => ({ outcome: "accepted" as const, providerJobHandle: "job" }),
		watch: async function* () {
			yield { kind: "terminal" as const, outcome: "completed" as const };
		},
	};
	return createTeExecutionProvider(te);
}

const controlHome = process.env.TF_TEST_CONTROL_HOME;
if (!controlHome) {
	console.log("ERROR fixture requires TF_TEST_CONTROL_HOME");
	process.exit(1);
}

const host = new ControlHost({
	mode: "auto",
	controlHome,
	provider: fakeProvider(),
	holderId: process.env.TF_TEST_HOLDER_ID ?? "uds-winner",
});

host.start()
	.then((status) => {
		console.log(
			`READY ${JSON.stringify({
				state: status.state,
				singleton: status.singleton,
				fencingEpoch: status.fencingEpoch,
				holderId: status.holderId,
			})}`,
		);
	})
	.catch((error: unknown) => {
		const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
		console.log(`ERROR ${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}`);
		process.exitCode = 1;
	});

const shutdown = (): void => {
	try {
		host.stop();
	} catch {
		/* best effort */
	}
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Ref'd keep-alive: the winner must stay up until the parent kills it.
setInterval(() => {}, 10_000);
