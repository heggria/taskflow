import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTROL_MODES,
	controlModeContract,
	parseControlMode,
	resolveControlMode,
	resolveControlStart,
	type ControlMode,
} from "../src/modes.ts";
import { ControlError } from "../src/errors.ts";

test("modes: fresh-install default is auto (P13)", () => {
	assert.equal(parseControlMode(undefined), "auto");
	assert.equal(parseControlMode(""), "auto");
	assert.equal(parseControlMode("auto"), "auto");
	assert.equal(parseControlMode("AUTO"), "auto");
});

test("modes: coordinated and standalone parse explicitly", () => {
	assert.equal(parseControlMode("coordinated"), "coordinated");
	assert.equal(parseControlMode("standalone"), "standalone");
});

test("modes: unknown mode string fails closed (never silently weaker)", () => {
	assert.throws(() => parseControlMode("full-power"), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_BOOTSTRAP_FAILED");
		return true;
	});
	assert.throws(() => parseControlMode("auto-standalone"), ControlError);
});

test("modes: closed enum surface matches P13", () => {
	assert.deepEqual([...CONTROL_MODES], ["auto", "coordinated", "standalone"]);
});

test("modes: contracts — auto/coordinated singleton-required; standalone explicit, no global authority", () => {
	const auto = controlModeContract("auto");
	assert.equal(auto.singletonRequired, true);
	assert.equal(auto.externalControlRequired, false);
	assert.equal(auto.globalAuthority, true);

	const coordinated = controlModeContract("coordinated");
	assert.equal(coordinated.singletonRequired, true);
	assert.equal(coordinated.externalControlRequired, true);

	const standalone = controlModeContract("standalone");
	assert.equal(standalone.singletonRequired, false);
	assert.equal(standalone.globalAuthority, false);
});

test("modes: auto + control available → start-or-attach; unavailable → fail closed, never standalone", () => {
	assert.deepEqual(resolveControlStart("auto", true), {
		mode: "auto",
		action: "start-or-attach",
		singletonRequired: true,
		globalAuthority: true,
	});
	assert.throws(() => resolveControlStart("auto", false), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_BOOTSTRAP_FAILED");
		assert.match((error as ControlError).message, /silent fallback to standalone is forbidden/);
		return true;
	});
});

test("modes: coordinated requires an external control; down → fail closed (TF_JOURNAL_UNAVAILABLE)", () => {
	assert.deepEqual(resolveControlStart("coordinated", true), {
		mode: "coordinated",
		action: "attach-external",
		singletonRequired: true,
		globalAuthority: true,
	});
	assert.throws(() => resolveControlStart("coordinated", false), (error: unknown) => {
		assert.ok(error instanceof ControlError);
		assert.equal((error as ControlError).code, "TF_JOURNAL_UNAVAILABLE");
		return true;
	});
});

test("modes: standalone is explicit regardless of singleton availability", () => {
	assert.deepEqual(resolveControlStart("standalone", false), {
		mode: "standalone",
		action: "standalone",
		singletonRequired: false,
		globalAuthority: false,
	});
});

test("modes: resolveControlMode honors the environment override", () => {
	const previous = process.env.TASKFLOW_CONTROL_MODE;
	try {
		delete process.env.TASKFLOW_CONTROL_MODE;
		assert.equal(resolveControlMode(), "auto");
		process.env.TASKFLOW_CONTROL_MODE = "standalone";
		assert.equal(resolveControlMode(), "standalone");
		process.env.TASKFLOW_CONTROL_MODE = "bogus";
		assert.throws(() => resolveControlMode(), ControlError);
	} finally {
		if (previous === undefined) delete process.env.TASKFLOW_CONTROL_MODE;
		else process.env.TASKFLOW_CONTROL_MODE = previous;
	}
});

test("modes: every mode is a member of the closed ControlMode union", () => {
	const modes: ControlMode[] = ["auto", "coordinated", "standalone"];
	for (const mode of modes) {
		assert.equal(controlModeContract(mode).mode, mode);
	}
});
