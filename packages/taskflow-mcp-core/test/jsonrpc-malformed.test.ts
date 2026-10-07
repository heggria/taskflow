import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio, RPC } from "../src/mcp/jsonrpc.ts";

test("stdio rejects nonobjects and invalid ids, ignores inherited handlers, and remains usable", async () => {
 const input = new PassThrough(), output = new PassThrough();
 let text = ""; output.on("data", chunk => { text += chunk.toString(); });
 const done = serveStdio({ ping: () => ({ alive: true }) }, { input, output });
 for (const line of ["null", "[]", "true", "42", '{"jsonrpc":"2.0","id":{},"method":"ping"}', '{"jsonrpc":"2.0","id":1,"method":"toString"}', '{"jsonrpc":"2.0","id":2,"method":"ping"}']) input.write(line + "\n");
 await new Promise(resolve => setImmediate(resolve));
 input.end(); await done;
 const messages = text.trim().split("\n").map(line => JSON.parse(line));
 assert.equal(messages.length, 7);
 assert.equal(messages.filter(message => message.error?.code === RPC.INVALID_REQUEST).length, 5);
 assert.equal(messages.find(message => message.id === 1).error.code, RPC.METHOD_NOT_FOUND);
 assert.deepEqual(messages.find(message => message.id === 2).result, { alive: true });
});
