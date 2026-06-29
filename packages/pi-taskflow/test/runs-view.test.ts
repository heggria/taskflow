import assert from "node:assert/strict";
import { test } from "node:test";
import { RunHistoryComponent } from "../src/runs-view.ts";
import type { RunState } from "taskflow-core";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mkRun(over: Partial<RunState> = {}): RunState {
	return {
		runId: over.runId ?? "flow-abc-1",
		flowName: over.flowName ?? "demo",
		status: over.status ?? "running",
		createdAt: over.createdAt ?? 1000,
		updatedAt: over.updatedAt ?? 1000,
		cwd: over.cwd ?? "/tmp",
		def: over.def ?? ({ name: "demo", phases: [] } as any),
		phases: over.phases ?? {},
		args: over.args ?? {},
		...over,
	} as RunState;
}

test("runs-view: live refresh re-reads and requestRender fires when state changes", async () => {
	const initial = [mkRun({ status: "running", updatedAt: 1000 })];
	let snapshot = [mkRun({ status: "running", updatedAt: 1000 })];
	let renders = 0;
	const view = new RunHistoryComponent(initial, theme, () => {}, {
		refresh: () => snapshot,
		requestRender: () => {
			renders++;
		},
		intervalMs: 250,
	});
	try {
		// Simulate a background progress write.
		snapshot = [mkRun({ status: "running", updatedAt: 2000 })];
		await new Promise((r) => setTimeout(r, 320));
		assert.ok(renders >= 1, "requestRender should fire after state changed");
	} finally {
		view.dispose();
	}
});

test("runs-view: no requestRender when refreshed state is unchanged", async () => {
	const initial = [mkRun({ status: "running", updatedAt: 1000 })];
	let renders = 0;
	const view = new RunHistoryComponent(initial, theme, () => {}, {
		refresh: () => [mkRun({ status: "running", updatedAt: 1000 })], // identical
		requestRender: () => {
			renders++;
		},
		intervalMs: 250,
	});
	try {
		await new Promise((r) => setTimeout(r, 320));
		assert.equal(renders, 0, "identical snapshot must not trigger a render");
	} finally {
		view.dispose();
	}
});

test("runs-view: dispose stops the refresh timer", async () => {
	let calls = 0;
	const view = new RunHistoryComponent([mkRun()], theme, () => {}, {
		refresh: () => {
			calls++;
			return [mkRun({ updatedAt: 1000 + calls })];
		},
		requestRender: () => {},
		intervalMs: 200,
	});
	await new Promise((r) => setTimeout(r, 250));
	const callsAtDispose = calls;
	view.dispose();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(calls, callsAtDispose, "no further refresh calls after dispose");
});

test("runs-view: selection follows the same runId across a refresh", async () => {
	const a = mkRun({ runId: "flow-a", flowName: "a", updatedAt: 1000 });
	const b = mkRun({ runId: "flow-b", flowName: "b", updatedAt: 1000 });
	let snapshot = [a, b];
	const view = new RunHistoryComponent([a, b], theme, () => {}, {
		refresh: () => snapshot,
		requestRender: () => {},
		intervalMs: 200,
	});
	try {
		// Move selection to second item (flow-b).
		view.handleInput("\x1b[B"); // down arrow
		// A new run appears at the top; flow-b is now at index 2.
		snapshot = [mkRun({ runId: "flow-new", flowName: "new", updatedAt: 1500 }), a, { ...b, updatedAt: 1500 }];
		await new Promise((r) => setTimeout(r, 250));
		const out = view.render(80).join("\n");
		// The detail/selection should still track flow-b; render shows the ❯ marker
		// on the flow-b row. We assert flow-b row carries the selection marker.
		const bLine = out.split("\n").find((l) => l.includes("b") && l.includes("❯"));
		assert.ok(bLine, "selection marker should follow flow-b after refresh");
	} finally {
		view.dispose();
	}
});

test("runs-view: no live hooks → no timer, renders static (back-compat)", () => {
	const view = new RunHistoryComponent([mkRun()], theme, () => {});
	const out = view.render(80).join("\n");
	assert.match(out, /Taskflow runs/);
	// dispose must be a no-op safe to call even without a timer.
	view.dispose();
});
