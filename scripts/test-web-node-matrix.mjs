#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { WEB_NODE_MATRIX_VERSIONS } from "./web-runtime-versions.mjs";

const tests = [
	"packages/taskflow-control/test/web-protocol.test.ts",
	"packages/taskflow-control/test/web-cursor.test.ts",
	"packages/taskflow-control/test/web-event-service.test.ts",
	"packages/taskflow-control/test/web-pagination.test.ts",
	"packages/taskflow-control/test/web-live-state-model.test.ts",
	"packages/taskflow-control/test/web-task-state-matrix.test.ts",
	"packages/taskflow-daemon/test/web-session.test.ts",
	"packages/taskflow-daemon/test/web-gateway.test.ts",
];

for (const version of WEB_NODE_MATRIX_VERSIONS) {
	const result = spawnSync(
		"npx",
		[
			"--yes",
			`node@${version}`,
			"--conditions=development",
			"--experimental-strip-types",
			"--test",
			...tests,
		],
		{
			cwd: process.cwd(),
			stdio: "inherit",
			env: process.env,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(
	`P17 Node matrix passed (${WEB_NODE_MATRIX_VERSIONS.join(", ")}; ${tests.length} suites per runtime)\n`,
);
