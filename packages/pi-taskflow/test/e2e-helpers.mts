import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Run real-pi E2Es with automatic extension discovery disabled.
 *
 * Context-sharing phases explicitly inject this checkout's pi-taskflow
 * extension so ctx_* tools are available. If the developer also has a released
 * pi-taskflow installed globally, normal `pi` startup discovers both copies and
 * rejects the duplicate tool registrations. `pi -ne` keeps the child isolated
 * while preserving the extension explicitly supplied by piSubagentRunner.
 *
 * An explicit PI_TASKFLOW_PI_BIN override always wins.
 */
export function installNoExtPiWrapper(prefix: string): () => void {
	if (process.env.PI_TASKFLOW_PI_BIN) return () => {};

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
	const wrapper = path.join(dir, process.platform === "win32" ? "pi-noext.cmd" : "pi-noext.sh");
	const body = process.platform === "win32"
		? "@echo off\r\npi -ne %*\r\n"
		: "#!/bin/sh\nexec pi -ne \"$@\"\n";
	fs.writeFileSync(wrapper, body, { mode: 0o700 });
	process.env.PI_TASKFLOW_PI_BIN = wrapper;

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		delete process.env.PI_TASKFLOW_PI_BIN;
		fs.rmSync(dir, { recursive: true, force: true });
	};
	process.once("exit", cleanup);
	return cleanup;
}
