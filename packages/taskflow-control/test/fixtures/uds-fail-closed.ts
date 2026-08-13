/**
 * UDS process-test fixture: `auto` mode must FAIL CLOSED at the process level
 * when the control cannot run — it must never silently become `standalone`.
 *
 * The parent points TF_TEST_CONTROL_HOME at a path that is a regular file
 * (not a directory), so the singleton bootstrap throws. Prints:
 *   FAILED-CLOSED <json>   — error code + message from start()
 *   STATE <state> <singleton>
 * and exits non-zero.
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
	holderId: "uds-fail-closed",
});

host.start()
	.then((status) => {
		console.log(`STARTED ${JSON.stringify({ state: status.state, singleton: status.singleton })}`);
	})
	.catch((error: unknown) => {
		const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
		console.log(`FAILED-CLOSED ${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}`);
		console.log(`STATE ${host.status.state} ${host.status.singleton}`);
		process.exitCode = 1;
	});
