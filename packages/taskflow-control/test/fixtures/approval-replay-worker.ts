/** Crash only this private test process after real journal fsync, before response. */
import { readFileSync } from "node:fs";
import { approvalFixture } from "./approval-worker.ts";
const directory=process.env.TF_REPLAY_DIRECTORY!;
const fixture=await approvalFixture(directory);
const input=JSON.parse(readFileSync(process.env.TF_REPLAY_INPUT!,"utf8"));
process.env.TASKFLOW_CONTROL_CRASH_AT="lifecycle-committed";
await fixture.service.decide(fixture.context,input);
throw new Error("injected crash did not happen");
