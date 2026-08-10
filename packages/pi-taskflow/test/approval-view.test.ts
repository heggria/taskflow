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
	assert.match(text, /Decision: \[Reject\]\s+Edit guidance\s+Approve/);
	assert.match(text, /←\/→ or R\/E\/A select · Enter confirm · V preview · Esc reject/);
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

test("approval-view: long upstream starts collapsed with a visible sticky decision", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view } = mk(upstream, 24);
	const out = view.render(80);
	const text = out.join("\n");
	assert.match(text, /Proposal: 100 lines · collapsed · \[V\] View proposal/);
	assert.doesNotMatch(text, /line-0\b/, "overflowing content is hidden initially");
	assert.match(text, /Decision: \[Reject\]/, "default decision remains visible");
});

test("approval-view: preview toggle is independent and expanded content remains scrollable", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view, result } = mk(upstream, 24);
	view.render(80); // establish auto-collapsed state
	view.handleInput("v");
	let text = view.render(80).join("\n");
	assert.match(text, /Proposal: 100 lines · expanded · \[V\] Hide proposal/);
	assert.match(text, /line-0/, "toggle reveals the preview");
	assert.equal(result(), undefined, "toggling preview does not decide");

	view.handleInput("\u001b[B"); // down arrow
	text = view.render(80).join("\n");
	assert.doesNotMatch(text, /line-0 /, "first line scrolled out");
	assert.match(text, /↑1 more/, "indicator counts lines above");
	assert.match(text, /Decision: \[Reject\]/, "decision remains visible while scrolled");

	view.handleInput("\u001b[F"); // end
	text = view.render(80).join("\n");
	assert.match(text, /line-99/, "End jumps to the bottom");

	view.handleInput("\u001b[H"); // home
	text = view.render(80).join("\n");
	assert.match(text, /line-0 /, "Home jumps back to the top");

	view.handleInput("v");
	text = view.render(80).join("\n");
	assert.doesNotMatch(text, /line-0\b/, "second toggle collapses without deciding");
	assert.equal(result(), undefined);
});

test("approval-view: decisions require selection followed by Enter", () => {
	{
		const { view, result } = mk("x");
		view.handleInput("\r");
		assert.equal(result(), "reject", "default Enter fails closed");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("e");
		assert.equal(result(), undefined, "single-key edit only selects");
		view.handleInput("\r");
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
		assert.equal(result(), undefined, "single-key approval is impossible");
		view.handleInput("\r");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("r");
		assert.equal(result(), undefined, "single-key rejection only selects");
		view.handleInput("\r");
		assert.equal(result(), "reject");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("\u0003"); // Ctrl-C
		assert.equal(result(), "reject");
	}
});

test("approval-view: arrows and Tab cycle through visible decisions", () => {
	{
		const { view, result } = mk("x");
		view.handleInput("\u001b[C"); // right: reject -> edit
		view.handleInput("\u001b[C"); // right: edit -> approve
		assert.match(view.render(80).join("\n"), /Decision:\s+Reject\s+Edit guidance\s+\[Approve\]/);
		view.handleInput("\r");
		assert.equal(result(), "approve");
	}
	{
		const { view, result } = mk("x");
		view.handleInput("\u001b[Z"); // shift-tab: reject -> approve
		view.handleInput("\r");
		assert.equal(result(), "approve");
	}
});

test("approval-view: Kitty printable keys select and toggle without deciding", () => {
	const upstream = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
	const { view, result } = mk(upstream, 24);
	view.render(80);
	view.handleInput("\u001b[118;1:1u"); // Kitty CSI-u press: v
	view.handleInput("\u001b[118;1:2u"); // repeat must not toggle again
	view.handleInput("\u001b[118;1:3u"); // release must not toggle again
	assert.match(view.render(80).join("\n"), /Proposal: 100 lines · expanded/);
	view.handleInput("\u001b[97;1:1u"); // Kitty CSI-u press: a
	view.handleInput("\u001b[97;1:3u"); // release is ignored
	assert.equal(result(), undefined);
	view.handleInput("\r");
	assert.equal(result(), "approve");
});

test("approval-view: decision fires only once", () => {
	let calls = 0;
	const view = new ApprovalViewComponent(theme, { title: "t", message: "m" }, () => {
		calls++;
	});
	view.handleInput("a");
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
	assert.doesNotMatch(text, /\[V\]/, "no preview toggle without a body");
});

test("approval-view: short upstream fits without scroll indicator", () => {
	const { view } = mk("only\ntwo lines here", 30);
	const text = view.render(80).join("\n");
	assert.match(text, /only/);
	assert.match(text, /two lines here/);
	assert.match(text, /Proposal: 2 lines · expanded/, "short content remains visible by default");
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
	view.handleInput("a");
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
