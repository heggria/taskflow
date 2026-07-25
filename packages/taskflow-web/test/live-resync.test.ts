import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueryClient } from "@tanstack/react-query";
import { refetchActiveWebQueries } from "../src/live-resync.ts";

test("live resync: active query failure is propagated to the state reducer", async () => {
	const calls: unknown[][] = [];
	const failure = new Error("authoritative refresh failed");
	const queryClient = {
		refetchQueries(...args: unknown[]) {
			calls.push(args);
			return Promise.reject(failure);
		},
	} as unknown as Pick<QueryClient, "refetchQueries">;

	await assert.rejects(
		() => refetchActiveWebQueries(queryClient),
		failure,
	);
	assert.deepEqual(calls, [
		[
			{ type: "active" },
			{ throwOnError: true },
		],
	]);
});
