/**
 * ControlStore process-test fixture.
 *
 * Environment:
 *   TF_TEST_STORE_PATH           — project store directory
 *   TF_TEST_ACTION               — init | mutate
 *   TASKFLOW_CONTROL_CRASH_AT    — header-fsynced | journal-append | projection-rebuild
 */
import { randomUUID } from "node:crypto";
import { CONTROL_WIRE_SCHEMA_VERSION } from "../../src/schema/index.ts";
import { openControlStore } from "../../src/store/index.ts";

const storePath = process.env.TF_TEST_STORE_PATH;
const action = process.env.TF_TEST_ACTION ?? "init";
if (!storePath) {
	console.log("ERROR fixture requires TF_TEST_STORE_PATH");
	process.exit(1);
}

const SHA256 = "a".repeat(64);
const commandId = process.env.TF_TEST_COMMAND_ID ?? randomUUID();
const projectId = process.env.TF_TEST_PROJECT_ID ?? "00000000-0000-0000-0000-000000000001";
const domainId = process.env.TF_TEST_DOMAIN_ID ?? "00000000-0000-0000-0000-000000000001";

try {
	const store = openControlStore(storePath, { projectId, controlDomainId: domainId });
	if (action === "mutate") {
		store.appendBatch({
			command: {
				commandId,
				kind: "run.submit",
				requestHash: SHA256,
				callerPrincipal: "crash-fixture",
				authorizationContextHash: SHA256,
				projectId,
				controlDomainId: domainId,
				status: "accepted",
				firstCommitSeq: 1,
				lastCommitSeq: 1,
				recordedAt: Date.now(),
			},
			events: [
				{
					eventId: randomUUID(),
					schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
					controlDomainId: domainId,
					streamId: `command:${commandId}`,
					streamSeq: 1,
					commitSeq: 1,
					commandId,
					commandEventIndex: 0,
					causationId: commandId,
					correlationId: commandId,
					projectId,
					recordedAt: Date.now(),
					payload: { kind: "command.recorded", commandId },
				},
			],
		});
	}
	console.log(`READY ${JSON.stringify({ projectId: store.header.projectId, commitSeq: store.commitSeq })}`);
	store.close();
	process.exit(0);
} catch (error) {
	console.log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
