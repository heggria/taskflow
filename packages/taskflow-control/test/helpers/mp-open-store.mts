/**
 * Multi-process helper: open Project ControlStore and print identity JSON.
 * Optional barrier: TF_MP_BARRIER + TF_MP_ID → wait for start before open (true overlap).
 */
import { openProjectControlStore } from "../../src/store/project-store.ts";
import { childAwaitStart } from "./mp-barrier.mts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("usage: mp-open-store.mts <projectRoot>");
	process.exit(2);
}
const barrier = process.env.TF_MP_BARRIER;
const id = process.env.TF_MP_ID ?? String(process.pid);
if (barrier) {
	childAwaitStart(barrier, id);
}
const store = openProjectControlStore(projectRoot);
process.stdout.write(
	JSON.stringify({
		projectId: store.header.projectId,
		controlDomainId: store.header.controlDomainId,
		pid: process.pid,
	}),
);
