import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { ControlError } from "../src/errors.ts";
import { CONTROL_WIRE_SCHEMA_VERSION } from "../src/schema/index.ts";
import { openControlStore } from "../src/store/index.ts";

const roots: string[] = [];
const PROJECT = "00000000-0000-0000-0000-000000000001";
const COMMAND = "00000000-0000-0000-0000-000000000002";
const OTHER = "00000000-0000-0000-0000-000000000003";

after(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function committedStore(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-store-corruption-"));
	roots.push(root);
	const store = openControlStore(root, { projectId: PROJECT, controlDomainId: PROJECT });
	try {
		store.appendBatch({
			command: {
				commandId: COMMAND, kind: "run.submit", requestHash: "a".repeat(64),
				callerPrincipal: "cli", authorizationContextHash: "a".repeat(64),
				projectId: PROJECT, controlDomainId: PROJECT, status: "accepted",
				firstCommitSeq: 1, lastCommitSeq: 1, recordedAt: 1,
			},
			events: [{
				eventId: COMMAND, schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
				controlDomainId: PROJECT, streamId: `command:${COMMAND}`, streamSeq: 1,
				commitSeq: 1, commandId: COMMAND, commandEventIndex: 0,
				causationId: COMMAND, correlationId: COMMAND, projectId: PROJECT,
				recordedAt: 1, payload: { kind: "command.recorded", commandId: COMMAND },
			}],
		});
	} finally { store.close(); }
	return root;
}

function snapshot(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		const relative = path.relative(root, file);
		if (entry.isSymbolicLink()) result[relative] = `symlink:${fs.readlinkSync(file)}`;
		else if (entry.isFile()) result[relative] = fs.readFileSync(file).toString("base64");
	}
	return result;
}

function assertRejectedUnchanged(root: string): void {
	const before = snapshot(root);
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.throws(() => {
			const store = openControlStore(root);
			store.close();
		}, (error: unknown) => error instanceof ControlError && error.code === "TF_DURABILITY_FAILED");
		assert.deepEqual(snapshot(root), before, "failed recovery must preserve every ledger byte");
	}
}

test("store corruption: missing header preserves committed ledger across failed restarts", () => {
	const root = committedStore();
	const header = fs.readFileSync(path.join(root, "header"));
	fs.unlinkSync(path.join(root, "header"));
	assertRejectedUnchanged(root);
	// Operator restores the exact saved identity; the prior committed work survives.
	fs.writeFileSync(path.join(root, "header"), header);
	const reopened = openControlStore(root);
	try {
		assert.equal(reopened.commitSeq, 1);
		assert.equal(reopened.header.projectId, PROJECT);
		assert.equal(reopened.readCommand(COMMAND)?.commandId, COMMAND);
	} finally { reopened.close(); }
});

for (const damagedHeader of ["{", "{}", "null"]) {
	test(`store corruption: malformed header ${damagedHeader} fails closed without overwriting`, () => {
		const root = committedStore();
		fs.writeFileSync(path.join(root, "header"), damagedHeader);
		assertRejectedUnchanged(root);
	});
}

test("store corruption: dangling header symlink is rejected without changing ledger", () => {
	const root = committedStore();
	fs.unlinkSync(path.join(root, "header"));
	fs.symlinkSync(path.join(root, "missing-header"), path.join(root, "header"));
	assertRejectedUnchanged(root);
});

test("store corruption: ahead commit sequence plus torn tail preserves forensic evidence", () => {
	const root = committedStore();
	fs.writeFileSync(path.join(root, "commit-seq.json"), '{"commitSeq":2}\n');
	fs.appendFileSync(path.join(root, "journal/000001.jsonl"), '{"torn":');
	assertRejectedUnchanged(root);
});

for (const corruption of ["null-batch", "missing-command", "invalid-command", "empty-events", "foreign-event", "event-sequence", "duplicate-command"]) {
	test(`store corruption: ${corruption} journal fails closed and preserves torn tail`, () => {
		const root = committedStore();
		const file = path.join(root, "journal/000001.jsonl");
		const original = fs.readFileSync(file, "utf8");
		const batch = JSON.parse(original);
		if (corruption === "missing-command") delete batch.command;
		if (corruption === "invalid-command") delete batch.command.requestHash;
		if (corruption === "empty-events") batch.events = [];
		if (corruption === "foreign-event") batch.events[0].projectId = OTHER;
		if (corruption === "event-sequence") batch.events[0].commitSeq = 7;
		if (corruption === "duplicate-command") {
			batch.commitSeq = 2;
			batch.command.firstCommitSeq = 2;
			batch.command.lastCommitSeq = 2;
			batch.events[0].commitSeq = 2;
		}
		fs.writeFileSync(file, (corruption === "duplicate-command" ? original : "")
			+ JSON.stringify(corruption === "null-batch" ? null : batch) + '\n{"torn":');
		assertRejectedUnchanged(root);
	});
}
