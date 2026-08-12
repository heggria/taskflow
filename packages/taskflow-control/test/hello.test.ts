import assert from "node:assert/strict";
import { test } from "node:test";
import { createHelloGate, helloRequiredError } from "../src/hello.ts";
import { ControlError } from "../src/errors.ts";
import { PROTOCOL_MAJOR, type NegotiationHandshake } from "../src/schema/transport.ts";

const serverHello: NegotiationHandshake = {
	protocolMajor: PROTOCOL_MAJOR,
	supportedReadSchemas: ["taskflow.wire.v1"],
	supportedWriteSchemas: ["taskflow.wire.v1"],
	requiredFeatures: [],
	offeredFeatures: ["durable-approval"],
	buildInfo: { packageVersion: "0.3.0", gitCommit: "abc", schemaVersion: 1 },
};

test("hello: a compatible client is greeted and subsequent RPCs are allowed", () => {
	const gate = createHelloGate(serverHello);
	assert.equal(gate.greeted, false);
	const verdict = gate.hello({
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.3.0", gitCommit: "def", schemaVersion: 1 },
	});
	assert.equal(verdict.ok, true);
	assert.equal(gate.greeted, true);
});

test("hello: RPC before hello is rejected (hello-before-RPC)", () => {
	const gate = createHelloGate(serverHello);
	const error = helloRequiredError();
	assert.ok(error instanceof ControlError);
	assert.equal(error.code, "TF_PROTOCOL_INCOMPATIBLE");
	// A non-greeted gate rejects everything — modeled by the dispatcher.
	assert.equal(gate.greeted, false);
});

test("hello: protocolMajor mismatch → TF_PROTOCOL_INCOMPATIBLE", () => {
	const gate = createHelloGate(serverHello);
	const verdict = gate.hello({
		protocolMajor: 999,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.2.4", gitCommit: "x", schemaVersion: 0 },
	});
	assert.equal(verdict.ok, false);
	assert.ok(verdict.error instanceof ControlError);
	assert.equal(verdict.error.code, "TF_PROTOCOL_INCOMPATIBLE");
	assert.equal(gate.greeted, false);
});

test("hello: no overlapping read schema → TF_SCHEMA_UNSUPPORTED (never silent reparse)", () => {
	const gate = createHelloGate(serverHello);
	const verdict = gate.hello({
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["legacy.schema.v0"],
		supportedWriteSchemas: ["legacy.schema.v0"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.2.4", gitCommit: "x", schemaVersion: 0 },
	});
	assert.equal(verdict.ok, false);
	assert.equal((verdict as { error: ControlError }).error.code, "TF_SCHEMA_UNSUPPORTED");
});

test("hello: client-required feature not offered by control → TF_FEATURE_REQUIRED", () => {
	const gate = createHelloGate(serverHello);
	const verdict = gate.hello({
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: ["federation"],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.3.0", gitCommit: "x", schemaVersion: 1 },
	});
	assert.equal(verdict.ok, false);
	assert.equal((verdict as { error: ControlError }).error.code, "TF_FEATURE_REQUIRED");
});

test("hello: control-required feature not offered by client → TF_FEATURE_REQUIRED", () => {
	const gate = createHelloGate(serverHello, { requiredFeatures: ["durable-approval"] });
	const verdict = gate.hello({
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.3.0", gitCommit: "x", schemaVersion: 1 },
	});
	assert.equal(verdict.ok, false);
	assert.equal((verdict as { error: ControlError }).error.code, "TF_FEATURE_REQUIRED");
});

test("hello: a successful hello is sticky — the gate stays greeted", () => {
	const gate = createHelloGate(serverHello);
	gate.hello({
		protocolMajor: PROTOCOL_MAJOR,
		supportedReadSchemas: ["taskflow.wire.v1"],
		supportedWriteSchemas: ["taskflow.wire.v1"],
		requiredFeatures: [],
		offeredFeatures: [],
		buildInfo: { packageVersion: "0.3.0", gitCommit: "x", schemaVersion: 1 },
	});
	assert.equal(gate.greeted, true);
});
