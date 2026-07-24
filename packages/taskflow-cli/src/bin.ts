#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { startUiCommand } from "./ui.ts";

const argv = process.argv.slice(2);
if (argv[0] === "ui") {
	try {
		const handle = await startUiCommand(argv.slice(1));
		console.log(JSON.stringify(handle.result, null, 2));
		if (handle.keepAlive) {
			const stop = () => {
				void handle.stop();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			await handle.stopped;
		}
		process.exitCode = 0;
	} catch (error) {
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: {
						code:
							(error as { code?: string }).code ??
							"TF_BOOTSTRAP_FAILED",
						message:
							error instanceof Error
								? error.message
								: String(error),
					},
				},
				null,
				2,
			),
		);
		process.exitCode = 1;
	}
} else {
	const result = await runCli(argv);
	console.log(JSON.stringify(result.json, null, 2));
	process.exitCode = result.exitCode;
}
