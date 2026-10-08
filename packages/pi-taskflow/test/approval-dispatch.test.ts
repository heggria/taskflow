import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunState } from "taskflow-core";
import registerTaskflow from "../src/index.ts";
import { createApprovalRequester } from "../src/approval-view.ts";

type Mode = ExtensionContext["mode"] | undefined;
function context(mode: Mode, ui: Partial<ExtensionUIContext>, cwd = ".", hasUI = true) {
	return { mode, hasUI, cwd, ui: ui as ExtensionUIContext };
}
const request = { phaseId: "check", message: "Approve?", upstream: "complete proposal" };
function tool(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	registerTaskflow({
		on() {}, registerCommand() {},
		registerTool(value: ToolDefinition) { if (value.name === "taskflow") registered = value; },
	} as unknown as ExtensionAPI);
	assert.ok(registered);
	return registered;
}

for (const [choice, expected] of [["approve", "approve"], ["reject", "reject"], [undefined, "reject"], ["unexpected", "reject"]] as const) {
	test(`approval dispatch: TUI ${choice} resolves ${expected}`, async () => {
		const approve = createApprovalRequester(context("tui", {
			custom: async () => choice,
		} as unknown as Partial<ExtensionUIContext>), "flow");
		assert.equal((await approve!(request)).decision, expected);
	});
}

test("approval dispatch: legacy Pi without mode preserves the custom overlay", async () => {
	let overlay: unknown;
	const approve = createApprovalRequester(context(undefined, {
		custom: async (_factory: unknown, options: unknown) => { overlay = options; return "approve"; },
	} as unknown as Partial<ExtensionUIContext>), "flow");
	assert.equal((await approve!(request)).decision, "approve");
	assert.equal((overlay as { overlay: boolean }).overlay, true);
});

for (const [choice, expected] of [["Approve", "approve"], ["Reject", "reject"], [undefined, "reject"], ["unexpected", "reject"]] as const) {
	test(`approval dispatch: RPC ${choice} resolves ${expected} without custom UI`, async () => {
		const approve = createApprovalRequester(context("rpc", {
			custom: async () => { throw new Error("RPC custom unsupported"); },
			select: async (title, choices) => {
				assert.match(title, /complete proposal/);
				assert.deepEqual(choices, ["Reject", "Edit guidance", "Approve"]);
				return choice;
			},
		}), "flow");
		assert.equal((await approve!(request)).decision, expected);
	});
}

for (const mode of ["tui", "rpc"] as const) {
	for (const note of ["Revise the plan", "", undefined]) {
		test(`approval dispatch: ${mode} edit guidance ${JSON.stringify(note)}`, async () => {
			const approve = createApprovalRequester(context(mode, {
				custom: async () => "edit", select: async () => "Edit guidance", input: async () => note,
			} as unknown as Partial<ExtensionUIContext>), "flow");
			const decision = await approve!(request);
			assert.equal(decision.decision, note === undefined ? "reject" : "edit");
			if (note !== undefined) assert.equal(decision.note, note);
		});
	}
	test(`approval dispatch: ${mode} thrown UI error fails closed`, async () => {
		const fail = async () => { throw new Error("UI disconnected"); };
		const approve = createApprovalRequester(context(mode, { custom: fail, select: fail }), "flow");
		assert.equal((await approve!(request)).decision, "reject");
	});
	test(`approval dispatch: ${mode} abort stops an unresponsive dialog`, async () => {
		const controller = new AbortController();
		const hang = async () => new Promise<never>(() => {});
		const approve = createApprovalRequester(context(mode, { custom: hang, select: hang }), "flow", controller.signal);
		const pending = approve!(request);
		controller.abort();
		assert.deepEqual(await pending, { decision: "reject", note: "aborted" });
	});
	test(`approval dispatch: ${mode} abort during edit cannot release downstream work`, async () => {
		const controller = new AbortController();
		const approve = createApprovalRequester(context(mode, {
			custom: async () => "edit", select: async () => "Edit guidance",
			input: async () => { controller.abort(); return "guidance after abort"; },
		} as unknown as Partial<ExtensionUIContext>), "flow", controller.signal);
		assert.equal((await approve!(request)).decision, "reject");
	});
}

test("approval dispatch: already aborted does not open a dialog", async () => {
	const controller = new AbortController();
	controller.abort();
	const approve = createApprovalRequester(context("rpc", { select: async () => assert.fail("must not prompt") }), "flow", controller.signal);
	assert.equal((await approve!(request)).decision, "reject");
});

for (const mode of ["print", "json", "tui"] as const) {
	test(`approval dispatch: ${mode} without dialog capability has no approver`, () => {
		assert.equal(createApprovalRequester(context(mode, {}, ".", mode !== "tui"), "flow"), undefined);
	});
}

// Exercise the registered adapter with the real runtime, persistence, and shell
// phase. A safe decision must prevent the downstream side effect, not merely
// return the expected string from a helper.
for (const scenario of [
	{ mode: "rpc", choice: "Approve", allow: true },
	{ mode: "rpc", choice: "Reject", allow: false },
	{ mode: "rpc", choice: undefined, allow: false },
	{ mode: "rpc", choice: "Edit guidance", note: "Revised guidance", allow: true },
	{ mode: "rpc", choice: "Edit guidance", note: undefined, allow: false },
	{ mode: "tui", choice: undefined, allow: false },
	{ mode: "print", choice: "Approve", allow: false },
] as const) {
	test(`approval tool/runtime: ${scenario.mode} ${scenario.choice}/${"note" in scenario ? scenario.note : ""} blocks or releases downstream shell`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskflow-approval-"));
		try {
			const registered = tool();
			const args = validateToolArguments(registered, {
				type: "toolCall", id: "approval", name: "taskflow",
				arguments: { define: { name: "approval-regression", phases: [
					{ id: "proposal", type: "script", run: "printf 'complete proposal'" },
					{ id: "check", type: "approval", task: "Approve?", dependsOn: ["proposal"] },
					{ id: "effect", type: "script", run: "touch approval-effect; printf 'released'", dependsOn: ["check"], final: true },
				] } },
			});
			const ctx = context(scenario.mode, {
				select: async () => scenario.choice,
				custom: async () => scenario.choice,
				input: async () => "note" in scenario ? scenario.note : undefined,
			} as unknown as Partial<ExtensionUIContext>, cwd);
			const result = await registered.execute("approval", args, undefined, undefined, ctx as unknown as ExtensionToolContext);
			const state = (result.details as { state: RunState }).state;
			assert.ok(state, JSON.stringify(result));
			assert.equal(existsSync(join(cwd, "approval-effect")), scenario.allow);
			assert.equal(state.phases.check.approval?.decision, scenario.allow ? (scenario.choice === "Edit guidance" ? "edit" : "approve") : "reject");
			if (scenario.allow) assert.equal(state.phases.effect.status, "done");
			else {
				assert.notEqual(state.phases.effect.status, "done");
				assert.equal(state.status, "blocked", "rejection preserves the existing blocked terminal state");
			}
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("Pi tool skill instructions use the stock read workflow", () => {
	const registered = tool();
	const guidance = [registered.description, ...(registered.promptGuidelines ?? [])].join("\n");
	assert.doesNotMatch(guidance, /skill_load/);
	assert.match(guidance, /read tool.*SKILL\.md/);
});

for (const mode of ["tui", "rpc"] as const) {
	test(`approval dispatch: ${mode} guidance UI error fails closed`, async () => {
		const approve = createApprovalRequester(context(mode, {
			custom: async () => "edit", select: async () => "Edit guidance",
			input: async () => { throw new Error("Input unavailable"); },
		} as unknown as Partial<ExtensionUIContext>), "flow");
		assert.equal((await approve!(request)).decision, "reject");
	});
}
