import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPersistentOwner } from "../src/persistent-mutex.ts";

for (const code of ["ESRCH", "EPERM", "EIO", "EINVAL"] as const) {
	test(`durable mutex owner probe only reclaims ESRCH: ${code}`, (t) => {
		t.mock.method(process, "kill", (_pid: number, signal: string | number) => {
			assert.equal(signal, 0);
			throw Object.assign(new Error(code), { code });
		});
		assert.equal(inspectPersistentOwner(0x7fffffff).alive, code !== "ESRCH");
	});
}

test("durable mutex owner probe rejects malformed identity without signalling", (t) => {
	t.mock.method(process, "kill", () => { throw new Error("must not signal malformed PID"); });
	for (const pid of [-1, 0, 1.5, NaN, Infinity, 0x80000000]) assert.equal(inspectPersistentOwner(pid).alive, true);
	assert.equal(inspectPersistentOwner(process.pid).alive, true);
});
