/**
 * Regression for https://github.com/heggria/taskflow/issues/121
 *
 * `/tf` autocomplete listed `verify`, but the slash handler fell through to
 * "Unknown subcommand: verify". The taskflow tool path (action=verify) worked.
 *
 * Also guards the sibling hole: every entry in the /tf autocomplete list must
 * resolve to a real handler (not "Unknown subcommand").
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, before, after } from "node:test";

const extModule = await import("../src/index.ts");
const extension = extModule.default;

function loadExtension() {
	const capturedCommands = new Map<string, any>();
	const mockPi = {
		registerTool: (_tool: any) => {},
		registerCommand: (name: string, def: any) => {
			capturedCommands.set(name, def);
		},
		on: (_event: string, _handler: any) => {},
		sendUserMessage: (_text: string) => {},
	};
	extension(mockPi as any);
	return capturedCommands;
}

function makeCtx(cwd: string, notify: (text: string, kind?: string) => void) {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		ui: {
			notify,
			input: async () => "",
			custom: async () => ({} as any),
		},
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
		},
	} as any;
}

describe("/tf verify slash command (#121)", () => {
	let cwd: string;
	let tf: any;

	before(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-verify-cmd-"));
		fs.mkdirSync(path.join(cwd, ".pi", "taskflows"), { recursive: true });
		// Minimal clean flow — verify should report no issues.
		const def = {
			name: "minimal repro",
			strictInterpolation: true,
			agentScope: "project",
			phases: [
				{
					id: "hello",
					type: "script",
					run: "printf 'hello world\\n'",
					final: true,
				},
			],
		};
		fs.writeFileSync(
			path.join(cwd, ".pi", "taskflows", "minimal_repro.json"),
			JSON.stringify(def, null, 2),
		);
		// Flow that validates but emits a dead-end warning under verifyTaskflow.
		const warnFlow = {
			name: "warn-flow",
			phases: [
				{ id: "a", type: "script", run: "true" },
				{ id: "b", type: "script", run: "true", final: true },
			],
		};
		fs.writeFileSync(
			path.join(cwd, ".pi", "taskflows", "warn-flow.json"),
			JSON.stringify(warnFlow, null, 2),
		);

		const cmds = loadExtension();
		tf = cmds.get("tf");
		assert.ok(tf, "tf command should be registered");
	});

	after(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	test("autocomplete lists verify", () => {
		const items = tf.getArgumentCompletions("ver");
		assert.ok(Array.isArray(items), "expected completion items");
		assert.ok(
			items.some((i: { value: string }) => i.value === "verify"),
			`verify should appear in completions, got ${JSON.stringify(items)}`,
		);
	});

	test("/tf verify preserves a saved flow name containing spaces", async () => {
		let notified = "";
		let kind = "";
		await tf.handler("verify minimal repro", makeCtx(cwd, (text, k) => {
			notified = text;
			kind = k ?? "";
		}));
		assert.doesNotMatch(notified, /unknown subcommand/i);
		assert.match(notified, /Verification of "minimal repro"/);
		assert.match(notified, /✅ No issues found/);
		assert.equal(kind, "info");
	});

	test("/tf verify without name shows usage", async () => {
		let notified = "";
		let kind = "";
		await tf.handler("verify", makeCtx(cwd, (text, k) => {
			notified = text;
			kind = k ?? "";
		}));
		assert.match(notified, /Usage: \/tf verify <name>/);
		assert.equal(kind, "warning");
	});

	test("/tf verify missing flow errors cleanly", async () => {
		let notified = "";
		let kind = "";
		await tf.handler("verify does-not-exist", makeCtx(cwd, (text, k) => {
			notified = text;
			kind = k ?? "";
		}));
		assert.doesNotMatch(notified, /unknown subcommand/i);
		assert.match(notified, /does-not-exist/);
		assert.equal(kind, "error");
	});

	test("/tf verify reports warnings for a flow with dead-end issues", async () => {
		let notified = "";
		let kind = "";
		await tf.handler("verify warn-flow", makeCtx(cwd, (text, k) => {
			notified = text;
			kind = k ?? "";
		}));
		assert.doesNotMatch(notified, /unknown subcommand/i);
		assert.match(notified, /Verification of "warn-flow"/);
		assert.match(notified, /Warnings|dead-end|Status: PASS/);
		// warnings-only still ok=true → info severity (mirrors tool path semantics)
		assert.equal(kind, "info");
	});

	test("autocomplete name completion after verify works once cwd is known", async () => {
		// Warm completionCwd via a real handler call.
		await tf.handler("list", makeCtx(cwd, () => {}));
		const items = tf.getArgumentCompletions("verify min");
		assert.ok(Array.isArray(items), `expected items, got ${items}`);
		assert.ok(
			items.some((i: { value: string }) => i.value === "verify minimal repro"),
			`expected verify minimal repro in ${JSON.stringify(items)}`,
		);
	});

	test("every autocomplete subcommand has a handler (no unknown fallthrough)", async () => {
		const items = tf.getArgumentCompletions("");
		assert.ok(Array.isArray(items) && items.length > 0);
		const subs: string[] = items.map((i: { value: string }) => i.value);
		assert.ok(subs.includes("verify"));
		assert.ok(subs.includes("save"));

		for (const sub of subs) {
			let notified = "";
			// Pass a dummy arg so name-required subs don't only show usage —
			// either is fine; the regression is specifically "Unknown subcommand".
			const arg = ["list", "runs", "init", "version", "save", "reconcile-workspace"].includes(sub)
				? sub
				: `${sub} __no_such_flow__`;
			await tf.handler(arg, makeCtx(cwd, (text) => {
				notified = text;
			}));
			assert.doesNotMatch(
				notified,
				/unknown subcommand/i,
				`subcommand "${sub}" fell through to unknown: ${notified}`,
			);
		}
	});
});
