/**
 * Files-only project ControlStore (beta.2 S3-minimum).
 *
 * A3: standalone write then reopen sees the same projectId + commit-seq.
 * A5: a second open/mutation is rejected (single writer).
 * P14 hardening: symlink dest fail-closed.
 *
 * Process-level SIGKILL crash matrix lives in store-process.test.ts.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { ControlError } from "../src/errors.ts";
import {
	CONTROL_WIRE_SCHEMA_VERSION,
	type CommandRecord,
	type ControlEvent,
} from "../src/schema/index.ts";
import { openControlStore } from "../src/store/index.ts";

const tempRoots: string[] = [];

function makeStorePath(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-control-store-"));
	tempRoots.push(root);
	return path.join(root, "project-store");
}

after(() => {
	for (const root of tempRoots) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

const UUID = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";
const SHA256 = "a".repeat(64);

function submitBatch(overrides: Partial<CommandRecord> = {}): {
	command: CommandRecord;
	events: ControlEvent[];
} {
	const command: CommandRecord = {
		commandId: UUID2,
		kind: "run.submit",
		requestHash: SHA256,
		callerPrincipal: "cli",
		authorizationContextHash: SHA256,
		projectId: UUID,
		controlDomainId: UUID,
		status: "accepted",
		firstCommitSeq: 1,
		lastCommitSeq: 1,
		recordedAt: 1,
		...overrides,
	};
	const events: ControlEvent[] = [
		{
			eventId: UUID,
			schemaVersion: CONTROL_WIRE_SCHEMA_VERSION,
			controlDomainId: command.controlDomainId,
			streamId: `command:${command.commandId}`,
			streamSeq: 1,
			commitSeq: 1,
			commandId: command.commandId,
			commandEventIndex: 0,
			causationId: command.commandId,
			correlationId: command.commandId,
			projectId: command.projectId,
			recordedAt: 1,
			payload: { kind: "command.recorded", commandId: command.commandId },
		},
	];
	return { command, events };
}

test("store: opening a new path creates a header and empty ledger (A3)", () => {
	const storePath = makeStorePath();
	const store = openControlStore(storePath);
	try {
		assert.equal(store.status, "healthy");
		assert.equal(store.commitSeq, 0);
		assert.equal(store.header.schemaVersion, CONTROL_WIRE_SCHEMA_VERSION);
		assert.match(store.header.projectId, /^[0-9a-f-]{36}$/i);
		assert.equal(store.header.directoryBinding.canonicalPath, fs.realpathSync(storePath));
		assert.ok(fs.existsSync(path.join(storePath, "header")));
		assert.ok(fs.existsSync(path.join(storePath, "commit-seq.json")));
		assert.ok(fs.statSync(path.join(storePath, "journal")).isDirectory());
		assert.ok(fs.statSync(path.join(storePath, "projections")).isDirectory());
		assert.ok(fs.statSync(path.join(storePath, "commands")).isDirectory());
		assert.ok(fs.statSync(path.join(storePath, "receipts")).isDirectory());
	} finally {
		store.close();
	}
});

test("store: reopen after close sees the same projectId and commit-seq (A3)", () => {
	const storePath = makeStorePath();
	const first = openControlStore(storePath, { projectId: UUID, controlDomainId: UUID });
	const projectId = first.header.projectId;
	const domainId = first.header.controlDomainId;
	first.close();

	const second = openControlStore(storePath);
	try {
		assert.equal(second.header.projectId, projectId);
		assert.equal(second.header.controlDomainId, domainId);
		assert.equal(second.commitSeq, 0);
		assert.equal(second.status, "healthy");
	} finally {
		second.close();
	}
});

test("store: run.submit + events commit atomically and survive reopen (A3)", () => {
	const storePath = makeStorePath();
	const first = openControlStore(storePath, { projectId: UUID, controlDomainId: UUID });
	const { command, events } = submitBatch();
	const committed = first.appendBatch({ command, events });
	assert.equal(committed.commitSeq, 1);
	assert.equal(committed.command.kind, "run.submit");
	assert.equal(committed.command.firstCommitSeq, 1);
	assert.equal(committed.command.lastCommitSeq, 1);
	assert.equal(first.readCommand(command.commandId)?.kind, "run.submit");
	first.close();

	const second = openControlStore(storePath);
	try {
		assert.equal(second.commitSeq, 1);
		assert.equal(second.header.projectId, UUID);
		const loaded = second.readCommand(command.commandId);
		assert.ok(loaded);
		assert.equal(loaded.kind, "run.submit");
		assert.equal(loaded.requestHash, SHA256);
	} finally {
		second.close();
	}
});

test("store: a second live opener is rejected (A5 single writer)", () => {
	const storePath = makeStorePath();
	const first = openControlStore(storePath);
	try {
		assert.throws(
			() => openControlStore(storePath),
			(error: unknown) => {
				assert.ok(error instanceof ControlError);
				assert.equal((error as ControlError).code, "TF_DURABILITY_FAILED");
				return true;
			},
		);
	} finally {
		first.close();
	}
});

test("store: rename destination replaced by a symlink fails closed (P14)", () => {
	const storePath = makeStorePath();
	const store = openControlStore(storePath);
	store.close();

	const header = path.join(storePath, "header");
	const decoy = path.join(path.dirname(storePath), "decoy-header");
	fs.writeFileSync(decoy, "stolen\n");
	fs.unlinkSync(header);
	fs.symlinkSync(decoy, header);

	assert.throws(
		() => openControlStore(storePath),
		(error: unknown) => {
			assert.ok(error instanceof ControlError);
			assert.equal((error as ControlError).code, "TF_DURABILITY_FAILED");
			assert.match((error as ControlError).message, /symlink/i);
			return true;
		},
	);
	assert.equal(fs.readFileSync(decoy, "utf8"), "stolen\n", "symlink target must not be overwritten");
});

test("store: writeFile/appendFile/createWriteStream in control src stay on metadata paths (A6)", () => {
	const srcRoot = path.resolve(import.meta.dirname, "../src");
	const hits: string[] = [];
	const stack = [srcRoot];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const text = fs.readFileSync(full, "utf8");
			const re = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(/g;
			let match: RegExpExecArray | null;
			while ((match = re.exec(text)) !== null) {
				const line = text.slice(0, match.index).split("\n").length;
				hits.push(`${path.relative(srcRoot, full)}:${line}`);
			}
		}
	}
	const allowed = [
		"singleton.ts",
		"control-host.ts",
		"store/store.ts",
	];
	for (const hit of hits) {
		const file = hit.split(":")[0];
		assert.ok(allowed.includes(file), `A6: unexpected write at ${hit}`);
	}
	assert.ok(hits.length > 0, "expected to find control-metadata writes");
});

for (const target of ["journal/000001.jsonl", "commit-seq.json", "projections/commands.json"]) {
	test(`store: I/O failure at ${target} rejects later writes until recovery`, () => {
		const storePath = makeStorePath();
		const store = openControlStore(storePath);
		const obstacle = path.join(storePath, target);
		fs.rmSync(obstacle, { force: true });
		fs.mkdirSync(obstacle);
		const first = submitBatch();
		const second = submitBatch({ commandId: "00000000-0000-0000-0000-000000000003" });
		try {
			assert.throws(() => store.appendBatch(first), (error: unknown) => {
				assert.ok(error instanceof ControlError);
				assert.equal(error.code, "TF_DURABILITY_FAILED");
				return true;
			});
			assert.equal(store.status, "fail-closed");
			assert.equal(store.commitSeq, 0);
			assert.equal(store.readCommand(first.command.commandId), undefined);
			fs.rmdirSync(obstacle);
			assert.throws(() => store.appendBatch(second), /fail-closed; refusing mutation/);
		} finally {
			store.close();
		}
		const recovered = openControlStore(storePath);
		try {
			const committed = target.startsWith("journal/") ? 0 : 1;
			assert.equal(recovered.commitSeq, committed);
			assert.equal(recovered.status, "healthy");
			assert.equal(Boolean(recovered.readCommand(first.command.commandId)), committed === 1);
			assert.equal(recovered.appendBatch(second).commitSeq, committed + 1);
			const journal = fs.readFileSync(path.join(storePath, "journal/000001.jsonl"), "utf8")
				.trim().split("\n").map((line) => (JSON.parse(line) as { commitSeq: number }).commitSeq);
			assert.deepEqual(journal, committed === 1 ? [1, 2] : [1]);
		} finally {
			recovered.close();
		}
	});
}

for (const contents of ["", "{", "{}", '{"pid":0}', '{"pid":-1}', '{"pid":"123"}', '{"pid":2147483647}',
	'{"pid":2147483647,"acquiredAt":-1}', '{"pid":2147483647,"acquiredAt":1,"ownerId":"invalid"}']) {
	test(`store: unverified writer lock ${JSON.stringify(contents)} is never stolen`, () => {
		const storePath = makeStorePath();
		fs.mkdirSync(storePath);
		const lock = path.join(storePath, "writer.lock");
		fs.writeFileSync(lock, contents);
		assert.throws(() => openControlStore(storePath), /unverified writer/);
		assert.equal(fs.readFileSync(lock, "utf8"), contents);
	});
}

test("store: a replaced same-process lock is not removed by an old owner", () => {
	const storePath = makeStorePath();
	const store = openControlStore(storePath);
	const lock = path.join(storePath, "writer.lock");
	const replacement = JSON.stringify({ pid: process.pid, ownerId: "other-acquisition", acquiredAt: Date.now() });
	fs.unlinkSync(lock);
	fs.writeFileSync(lock, replacement);
	store.close();
	assert.equal(fs.readFileSync(lock, "utf8"), replacement);
});
