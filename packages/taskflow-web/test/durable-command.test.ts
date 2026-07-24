import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { JSDOM } from "jsdom";
import type {
	WebCommandOutcome,
	WebCommandRequest,
	WebGeneratedClient,
} from "taskflow-control/web-protocol";
import { useDurableCommand } from "../src/use-durable-command.ts";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;

function installDom(url = "http://127.0.0.1/task"): JSDOM {
	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: dom.window,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: dom.window.document,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: dom.window.navigator,
	});
	return dom;
}

afterEach(() => {
	cleanup();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: originalWindow,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: originalDocument,
	});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: originalNavigator,
	});
});

function completed(commandId: string): WebCommandOutcome {
	return {
		commandId,
		requestHash: `sha256:${"a".repeat(64)}`,
		kind: "cancel-run",
		projectId: "project-1",
		controlDomainId: "domain-1",
		runId: "run-1",
		firstCommitSeq: 1,
		lastCommitSeq: 2,
		observedAt: 3,
		status: "completed",
	};
}

const cancelBase = {
	kind: "cancel-run",
	projectId: "project-1",
	controlDomainId: "domain-1",
	runId: "run-1",
	expectedRunVersion: 2,
} as const;

test("durable command recovery retries the byte-identical in-memory command id", async () => {
	const dom = installDom();
	const submitted: WebCommandRequest[] = [];
	let submitCount = 0;
	const client = {
		async commands(input: { body: WebCommandRequest }) {
			submitted.push(input.body);
			submitCount += 1;
			if (submitCount === 1) throw new TypeError("connection lost");
			return completed(input.body.commandId);
		},
		async command(input: { params: { commandId: string } }) {
			return {
				commandId: input.params.commandId,
				status: "not-found",
				observedAt: 2,
			} satisfies WebCommandOutcome;
		},
	} as unknown as WebGeneratedClient;
	let settled = 0;
	const { result } = renderHook(() =>
		useDurableCommand({
			client,
			onSettled: () => {
				settled += 1;
			},
		}),
	);

	await act(async () => {
		await result.current.execute(cancelBase);
	});
	assert.equal(result.current.state.status, "unknown");
	assert.match(dom.window.location.search, /op=web-/u);
	await act(async () => {
		await result.current.retrySame();
	});
	assert.equal(result.current.state.status, "settled");
	assert.equal(settled, 1);
	assert.equal(submitted.length, 2);
	assert.deepEqual(submitted[1], submitted[0]);
	assert.equal(dom.window.location.search, "");
});

test("reload recovery checks the durable command without inventing a request body", async () => {
	installDom("http://127.0.0.1/task?op=web-reload-command");
	let queried = 0;
	const client = {
		async command(input: { params: { commandId: string } }) {
			queried += 1;
			assert.equal(input.params.commandId, "web-reload-command");
			return {
				commandId: input.params.commandId,
				status: "not-found",
				observedAt: 2,
			} satisfies WebCommandOutcome;
		},
	} as unknown as WebGeneratedClient;
	const { result } = renderHook(() =>
		useDurableCommand({ client, onSettled: () => undefined }),
	);

	await act(async () => {
		await new Promise<void>((resolve) => {
			window.setTimeout(resolve, 0);
		});
	});
	assert.equal(queried, 1);
	assert.equal(result.current.state.status, "unknown");
	if (result.current.state.status === "unknown") {
		assert.equal(result.current.state.request, undefined);
	}
});
