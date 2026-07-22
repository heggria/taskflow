/**
 * Multi-process helper: bootstrapControl auto on a project, print identity + role.
 */
import { bootstrapControl, createMockExecutionProvider } from "../../src/index.ts";

const projectRoot = process.argv[2];
const home = process.argv[3];
const holderId = process.argv[4] ?? `holder-${process.pid}`;
if (!projectRoot || !home) {
	console.error("usage: mp-bootstrap.mts <projectRoot> <TASKFLOW_HOME> [holderId]");
	process.exit(2);
}
const env = { ...process.env, TASKFLOW_HOME: home };
const { host, role } = bootstrapControl({
	projectRoot,
	env,
	holderId,
	provider: createMockExecutionProvider({ outcome: "completed" }),
});
process.stdout.write(
	JSON.stringify({
		projectId: host.projectId,
		controlDomainId: host.controlDomainId,
		role,
		canMutate: host.canMutate,
		pid: process.pid,
	}),
);
host.close();
