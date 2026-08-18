/**
 * UDS process-test fixture: a ControlHost LOSER in `auto` mode competing for
 * the same user singleton lock + endpoint as a live winner.
 *
 * start() must attach to the winner over the Unix socket, receive the winner's
 * fencing epoch on the wire, then route `control.probe` through the attached
 * client (the winner answers over UDS — A2b). Prints:
 *   ATTACHED <status-json>   — after start(), singleton must be "attached"
 *   PROBE <result-json>      — winner's control.probe over the socket
 *   PROBE-ERROR <json>       — dispatch over the wire failed
 * Exits non-zero with `ERROR <json>` if start() fails closed.
 *
 * Environment:
 *   TF_TEST_CONTROL_HOME  — control home (shared with the competing process)
 *   TF_TEST_HOLDER_ID     — holder id (default "uds-loser")
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
	holderId: process.env.TF_TEST_HOLDER_ID ?? "uds-loser",
});

host.start()
	.then(async (status) => {
		console.log(
			`ATTACHED ${JSON.stringify({
				state: status.state,
				singleton: status.singleton,
				fencingEpoch: status.fencingEpoch,
				holderId: status.holderId,
			})}`,
		);
		if (status.singleton !== "attached") {
			console.log("LOSER-STATUS fixture expected singleton=attached");
			process.exitCode = 2;
			return;
		}
		try {
			const probe = await host.dispatch("control.probe", undefined, { fencingEpoch: status.fencingEpoch });
			console.log(`PROBE ${JSON.stringify(probe)}`);
		} catch (error: unknown) {
			const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
			console.log(`PROBE-ERROR ${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}`);
			process.exitCode = 3;
		}
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

// Ref'd keep-alive so the parent has time to observe ATTACHED/PROBE.
setInterval(() => {}, 10_000);
