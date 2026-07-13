import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { emptyUsage, type AgentConfig, type SubagentRunner } from "taskflow-core";
import { makeToolHandlers } from "../src/mcp/server.ts";
import { serveStdio, TRANSPORT_SHUTDOWN_GRACE_MS, type RpcHandler } from "../src/mcp/jsonrpc.ts";

async function resolvesWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
	]);
}

async function runRpc(
	handlers: Record<string, RpcHandler>,
	messages: object[],
): Promise<Array<Record<string, unknown>>> {
	const input = new PassThrough();
	const output = new PassThrough();
	const responses: Array<Record<string, unknown>> = [];
	const expectedResponses = new Set(
		messages
			.filter((message) => "id" in message && (message as { id?: unknown }).id != null)
			.map((message) => `${typeof (message as { id: unknown }).id}:${String((message as { id: unknown }).id)}`),
	).size;
	let ended = false;
	let buffer = "";
	output.on("data", (chunk) => {
		buffer += chunk.toString();
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				responses.push(JSON.parse(line) as Record<string, unknown>);
				if (!ended && responses.length >= expectedResponses) {
					ended = true;
					input.end();
				}
			}
		}
	});
	const done = serveStdio(handlers, { input, output });
	for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
	if (expectedResponses === 0) input.end();
	await done;
	return responses;
}

test("stdio transport dispatches requests concurrently", async () => {
	const handlers: Record<string, RpcHandler> = {
		slow: async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return "slow";
		},
		fast: () => "fast",
	};
	const responses = await runRpc(handlers, [
		{ jsonrpc: "2.0", id: 1, method: "slow" },
		{ jsonrpc: "2.0", id: 2, method: "fast" },
	]);
	assert.deepEqual(responses.map((r) => r.id), [2, 1]);
});

test("input end bounds a non-cooperative request and suppresses its response", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let signal: AbortSignal | undefined;
	let outputText = "";
	output.on("data", (chunk) => (outputText += chunk.toString()));
	const done = serveStdio(
		{
			slow: async (_params, context) => {
				signal = context.signal;
				return await new Promise(() => {});
			},
		},
		{ input, output },
	);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "slow" })}\n`);
	input.end();
	await resolvesWithin(done);
	assert.equal(signal?.aborted, true);
	assert.equal(outputText, "", "disconnect must suppress cancellation and late responses");
});

test("input end bounds a non-cooperative notification too", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let signal: AbortSignal | undefined;
	const done = serveStdio(
		{
			observe: async (_params, context) => {
				signal = context.signal;
				return await new Promise(() => {});
			},
		},
		{ input, output },
	);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "observe" })}\n`);
	input.end();
	await resolvesWithin(done);
	assert.equal(signal?.aborted, true);
});

test("input close bounds non-cooperative handlers without a late write", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let signal: AbortSignal | undefined;
	let outputText = "";
	output.on("data", (chunk) => (outputText += chunk.toString()));
	const done = serveStdio(
		{
			slow: async (_params, context) => {
				signal = context.signal;
				return await new Promise(() => {});
			},
		},
		{ input, output },
	);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "slow" })}\n`);
	input.destroy();
	await resolvesWithin(done);
	assert.equal(signal?.aborted, true);
	assert.equal(outputText, "");
});

test("output EPIPE tears down the transport and aborts active work", async () => {
	const input = new PassThrough();
	const writes: string[] = [];
	const output = new Writable({
		write(chunk, _encoding, callback) {
			writes.push(chunk.toString());
			const error = Object.assign(new Error("peer closed"), { code: "EPIPE" });
			callback(error);
		},
	});
	let slowSignal: AbortSignal | undefined;
	let completeSlow: ((value: string) => void) | undefined;
	const done = serveStdio(
		{
			slow: async (_params, context) => {
				slowSignal = context.signal;
				return await new Promise<string>((resolve) => {
					completeSlow = resolve;
				});
			},
			trigger: () => "write-now",
		},
		{ input, output },
	);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 20, method: "slow" })}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 21, method: "trigger" })}\n`);
	await resolvesWithin(done, TRANSPORT_SHUTDOWN_GRACE_MS);
	assert.equal(slowSignal?.aborted, true);
	assert.equal(writes.length, 1);
	assert.equal(output.listenerCount("error"), 0, "transport must remove its output error listener after teardown");
	completeSlow?.("late result");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(writes.length, 1, "a late handler result must not write after EPIPE");
});

test("input error tears down the transport and aborts active work", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let signal: AbortSignal | undefined;
	let outputText = "";
	output.on("data", (chunk) => (outputText += chunk.toString()));
	const done = serveStdio(
		{
			slow: async (_params, context) => {
				signal = context.signal;
				return await new Promise(() => {});
			},
		},
		{ input, output },
	);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 22, method: "slow" })}\n`);
	input.destroy(new Error("input failed"));
	await resolvesWithin(done, TRANSPORT_SHUTDOWN_GRACE_MS);
	assert.equal(signal?.aborted, true);
	assert.equal(outputText, "");
	assert.equal(input.listenerCount("error"), 0, "transport must remove its input error listener after teardown");
});

test("duplicate request ids abort the first controller instead of overwriting it", async () => {
	let calls = 0;
	let firstSignal: AbortSignal | undefined;
	const handlers: Record<string, RpcHandler> = {
		slow: async (_params, context) => {
			calls++;
			firstSignal = context.signal;
			return await new Promise(() => {});
		},
	};
	const responses = await runRpc(handlers, [
		{ jsonrpc: "2.0", id: 11, method: "slow" },
		{ jsonrpc: "2.0", id: 11, method: "slow" },
	]);
	assert.equal(calls, 1);
	assert.equal(firstSignal?.aborted, true);
	assert.equal(responses.length, 1);
	assert.equal((responses[0]?.error as { code?: number }).code, -32800);
});

test("notifications/cancelled aborts the matching in-flight request", async () => {
	let signal: AbortSignal | undefined;
	const handlers: Record<string, RpcHandler> = {
		slow: async (_params, context) => {
			signal = context.signal;
			return await new Promise(() => {});
		},
	};
	const responses = await runRpc(handlers, [
		{ jsonrpc: "2.0", id: "run-1", method: "slow" },
		{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "run-1", reason: "client timeout" } },
	]);
	assert.equal(signal?.aborted, true);
	assert.equal(responses.length, 1);
	assert.equal(responses[0]?.id, "run-1");
	assert.equal((responses[0]?.error as { code?: number }).code, -32800);
});

test("a handler that returns after abort still receives a cancellation error response", async () => {
	let completeLate: ((value: string) => void) | undefined;
	const handlers: Record<string, RpcHandler> = {
		slow: async (_params, context) =>
			await new Promise((resolve) => {
				completeLate = resolve;
				void context;
			}),
	};
	const responses = await runRpc(handlers, [
		{ jsonrpc: "2.0", id: 7, method: "slow" },
		{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
	]);
	assert.equal((responses[0]?.error as { code?: number }).code, -32800);
	assert.equal(responses[0]?.result, undefined);
	completeLate?.("late result");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(responses.length, 1, "late handler completion must not emit a second response");
});

test("a handler that rejects after cancellation is observed, never unhandled", async () => {
	let rejectLate: ((reason: Error) => void) | undefined;
	let unhandled: unknown;
	const observeUnhandled = (reason: unknown) => {
		unhandled = reason;
	};
	process.once("unhandledRejection", observeUnhandled);
	try {
		const responses = await runRpc(
			{
				slow: async () =>
					await new Promise((_resolve, reject) => {
						rejectLate = reject;
					}),
			},
			[
				{ jsonrpc: "2.0", id: 8, method: "slow" },
				{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } },
			],
		);
		assert.equal((responses[0]?.error as { code?: number }).code, -32800);
		rejectLate?.(new Error("late rejection"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled, undefined);
	} finally {
		process.removeListener("unhandledRejection", observeUnhandled);
	}
});

test("taskflow_run forwards the JSON-RPC AbortSignal into the host runner", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "taskflow-mcp-signal-"));
	try {
		const agentDir = join(cwd, ".pi", "agents");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "signal-agent.md"),
			"---\nname: signal-agent\ndescription: signal test\n---\nYou are a signal test agent.\n",
		);
		let seenSignal: AbortSignal | undefined;
		const runner: SubagentRunner<AgentConfig> = {
			runTask: async (_cwd, _agents, agent, task, opts) => {
				seenSignal = opts.signal;
				return { agent, task, exitCode: 0, output: "ok", stderr: "", usage: emptyUsage() };
			},
		};
		const tools = makeToolHandlers(cwd, runner);
		const controller = new AbortController();
		const result = (await tools.taskflow_run?.(
			{
				define: {
					name: "signal-flow",
					phases: [{ id: "run", type: "agent", agent: "signal-agent", task: "go", final: true }],
				},
			},
			{ requestId: 1, signal: controller.signal },
		)) as { isError?: boolean };
		assert.equal(result.isError, false);
		assert.equal(seenSignal, controller.signal);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a host without usage accounting refuses budgeted runs before spawning", async () => {
	let calls = 0;
	const runner: SubagentRunner<AgentConfig> & { usageAccounting: "unavailable" } = {
		usageAccounting: "unavailable",
		runTask: async (_cwd, _agents, agent, task) => {
			calls++;
			return { agent, task, exitCode: 0, output: "unsafe", stderr: "", usage: emptyUsage() };
		},
	};
	const tools = makeToolHandlers(process.cwd(), runner);
	const result = (await tools.taskflow_run?.({
		define: {
			name: "budgeted-grok",
			budget: { maxTokens: 1 },
			phases: [{ id: "run", type: "agent", agent: "executor", task: "go", final: true }],
		},
	})) as { isError?: boolean; content?: Array<{ text?: string }> };
	assert.equal(result.isError, true);
	assert.match(result.content?.[0]?.text ?? "", /does not report token or cost usage/i);
	assert.equal(calls, 0);
});

test("a tokens-only host accepts maxTokens but refuses maxUSD before spawning", async () => {
	let calls = 0;
	const runner: SubagentRunner<AgentConfig> = {
		usageAccounting: "tokens-only",
		runTask: async (_cwd, _agents, agent, task) => {
			calls++;
			return { agent, task, exitCode: 0, output: "ok", stderr: "", usage: { ...emptyUsage(), input: 1 } };
		},
	};
	const tools = makeToolHandlers(process.cwd(), runner);
	const tokenResult = (await tools.taskflow_run?.({
		define: {
			name: "token-budget",
			budget: { maxTokens: 10 },
			phases: [{ id: "run", type: "agent", agent: "executor", task: "go", final: true }],
		},
	})) as { isError?: boolean };
	assert.equal(tokenResult.isError, false);
	assert.equal(calls, 1);

	const dollarResult = (await tools.taskflow_run?.({
		define: {
			name: "dollar-budget",
			budget: { maxUSD: 1 },
			phases: [{ id: "run", type: "agent", agent: "executor", task: "go", final: true }],
		},
	})) as { isError?: boolean; content?: Array<{ text?: string }> };
	assert.equal(dollarResult.isError, true);
	assert.match(dollarResult.content?.[0]?.text ?? "", /reports token usage but not cost/i);
	assert.equal(calls, 1);
});
