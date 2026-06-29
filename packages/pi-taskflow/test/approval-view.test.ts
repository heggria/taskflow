import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalViewComponent, type ApprovalChoice } from "../src/approval-view.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mk(upstream?: string, rows = 24) {
	let result: ApprovalChoice | undefined;
	const view = new ApprovalViewComponent(
		theme,
		{ title: "Taskflow approval — flow/checkpoint", message: "Approve the plan?", upstream },
		(c) => {
			result = c;
		},
		() => rows,
	);
	return { view, result: () => result };
}

test("approval-view: renders title, message and hints inside a bordered dialog", () => {
	const { view } = mk("a plan");
	const out = view.render(80);
	const text = out.join("\n");
	assert.match(text, /Taskflow approval — flow\/checkpoint/);
	assert.match(text, /Approve the plan\?/);
	assert.match(text, /a\/Enter approve · e edit · r\/Esc reject/);
	assert.match(out[0], /^╭/, "top border");
	assert.match(out[out.length - 1], /^╰/, "bottom border");
});

test("approval-view: every rendered line is exactly the dialog width (no see-through)", () => {
	const upstream = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 30);
	const out = view.render(72);
	for (const l of out) {
		assert.equal(visibleWidth(l), 72, `line padded to full width: ${JSON.stringify(l)}`);
	}
});

test("approval-view: long upstream is windowed with scroll indicator", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 24);
	const out = view.render(80);
	const text = out.join("\n");
	assert.match(text, /line-0/, "top of content visible initially");
	assert.doesNotMatch(text, /line-99\b/, "bottom not visible before scrolling");
	assert.match(text, /↓\d+ more/, "scroll indicator shows hidden lines below");
	assert.match(text, /scroll/, "hint mentions scrolling when content overflows");
});

test("approval-view: down/pageDown/end scroll the viewport", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 24);
	view.render(80); // establish wrapped body cache
	view.handleInput("\u001b[B"); // down arrow
	let text = view.render(80).join("\n");
	assert.doesNotMatch(text, /line-0 /, "first line scrolled out");
	assert.match(text, /↑1 more/, "indicator counts lines above");

	view.handleInput("\u001b[F"); // end
	text = view.render(80).join("\n");
	assert.match(text, /line-99/, "End jumps to the bottom");

	view.handleInput("\u001b[H"); // home
	text = view.render(80).join("\n");
	assert.match(text, /line-0 /, "Home jumps back to the top");
});

test("approval-view: decisions — enter approves, e edits, esc rejects", () => {
	{
		const { view, result } = mk("x");
		view.handleInput("\r");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("e");
		assert.equal(result(), "edit");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("\u001b"); // escape
		assert.equal(result(), "reject");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("a");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("r");
		assert.equal(result(), "reject");
	}
});

test("approval-view: decision fires only once", () => {
	let calls = 0;
	const view = new ApprovalViewComponent(theme, { title: "t", message: "m" }, () => {
		calls++;
	});
	view.handleInput("\r");
	view.handleInput("\u001b");
	view.handleInput("e");
	assert.equal(calls, 1, "subsequent inputs after a decision are ignored");
});

test("approval-view: dispose is a safe no-op (no mouse tracking)", () => {
	const { view } = mk("x");
	view.dispose();
	view.dispose();
	// Idempotent, never throws
	assert.ok(true);
});

test("approval-view: no upstream → no scroll hint, no scroll indicator", () => {
	const { view } = mk(undefined);
	const text = view.render(80).join("\n");
	assert.doesNotMatch(text, /more/, "no scroll indicator without body");
	assert.doesNotMatch(text, /scroll/, "no scroll hint without overflow");
});

test("approval-view: short upstream fits without scroll indicator", () => {
	const { view } = mk("only\ntwo lines here", 30);
	const text = view.render(80).join("\n");
	assert.match(text, /only/);
	assert.match(text, /two lines here/);
	assert.doesNotMatch(text, /more/, "no scroll indicator when content fits");
});

test("approval-view: getRows failure falls back to default height", () => {
	let result: ApprovalChoice | undefined;
	const view = new ApprovalViewComponent(
		theme,
		{ title: "t", message: "m", upstream: "body" },
		(c) => {
			result = c;
		},
		() => {
			throw new Error("no tty");
		},
	);
	const text = view.render(80).join("\n");
	assert.match(text, /body/, "renders despite getRows throwing");
	view.handleInput("\r");
	assert.equal(result, "approve");
});

test("approval-view: invalidate clears cache and re-wraps on width change", () => {
	const upstream = "x".repeat(200);
	const { view } = mk(upstream, 30);
	const wide = view.render(120);
	view.invalidate();
	const narrow = view.render(40);
	assert.ok(narrow.length >= wide.length, "narrower width wraps into more lines");
});
