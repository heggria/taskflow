/**
 * Multi-process helper: open Project ControlStore and print identity JSON.
 * Spawned by closed-loop multi-process identity tests.
 */
import { openProjectControlStore } from "../../src/store/project-store.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("usage: mp-open-store.mts <projectRoot>");
	process.exit(2);
}
const store = openProjectControlStore(projectRoot);
process.stdout.write(
	JSON.stringify({
		projectId: store.header.projectId,
		controlDomainId: store.header.controlDomainId,
		pid: process.pid,
	}),
);
