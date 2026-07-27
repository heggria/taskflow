/** Child role for cross-process ScriptExecutionProvider idempotency proof. */
import { createScriptExecutionProvider } from "../../src/index.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const [stateDir, cwd, marker] = process.argv.slice(2);
if (!stateDir || !cwd || !marker) {
	throw new Error("usage: mp-idempotent-script.mts <state-dir> <cwd> <marker>");
}
const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? "unknown";
if (!barrier) throw new Error("TF_MP_BARRIER is required");

childAwaitStart(barrier, id);
const provider = createScriptExecutionProvider({ stateDir });
const result = await provider.submit({
	runId: "mp-idempotent-run",
	idempotencyKey: "mp-stable-script-attempt",
	cwd,
	program: {
		name: "mp-idempotent-script",
		phases: [
			{
				id: "main",
				type: "script",
				run: [
					process.execPath,
					"-e",
					`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "once\\n")`,
				],
				final: true,
			},
		],
	},
});
let terminal: string | undefined;
if (result.kind === "accepted") {
	let polled = await provider.poll(result.handle);
	const deadline = Date.now() + 5_000;
	while (polled.kind === "still-running" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 15));
		polled = await provider.poll(result.handle);
	}
	terminal = polled.kind;
}
process.stdout.write(
	JSON.stringify({
		kind: result.kind,
		handle: "handle" in result ? result.handle ?? null : null,
		terminal: terminal ?? null,
	}),
);
