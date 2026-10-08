import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createApprovalRequester } from "../src/approval-view.ts";

type Mode = "tui" | "rpc" | "json" | "print" | undefined;
function context(mode: Mode, ui: Partial<ExtensionUIContext>, cwd = ".", hasUI = true) {
	return { mode, hasUI, cwd, ui: ui as ExtensionUIContext };
}
const request = { phaseId: "check", message: "Approve?", upstream: "complete proposal" };

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

