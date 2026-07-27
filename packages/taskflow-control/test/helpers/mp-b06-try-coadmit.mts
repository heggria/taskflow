/**
 * Multi-process helper for B06 D6 dual-writer counterexamples.
 * Attempts unfenced standalone skipSingleton co-admit on the given project.
 *
 * exit 2 + REFUSED on TF_BOOTSTRAP_FAILED co-admit refusal
 * exit 0 + COADMITTED when a second mutator opens (closed-case test failure)
 * exit 0 + RESIDUAL_COADMIT when TF_D6_EXPECT_RESIDUAL=1 and open succeeds —
 *          the residual vandalism set (lease absent AND singleton dead/absent)
 *          is documented to co-admit; never describe that outcome as fail-closed
 */
import {
	createControlHost,
	createScriptExecutionProvider,
} from "../../src/index.ts";

const projectRoot = process.argv[2];
if (!projectRoot) {
	console.error("usage: mp-b06-try-coadmit.mts <projectRoot>");
	process.exit(3);
}

try {
	const host = createControlHost({
		projectRoot,
		env: process.env,
		controlMode: "standalone",
		skipSingleton: true,
		provider: createScriptExecutionProvider({
			stateDir: `${projectRoot}/.taskflow/control/provider-jobs-coadmit-probe`,
		}),
	});
	// Opened a second mutator. Residual tests require an explicit co-admit label.
	const residual = process.env.TF_D6_EXPECT_RESIDUAL === "1";
	console.log(
		residual
			? "RESIDUAL_COADMIT same-UID non-cooperative (lease absent AND singleton dead/absent)"
			: "COADMITTED",
	);
	host.close();
	process.exit(0);
} catch (error) {
	const err = error as { code?: string; message?: string };
	const msg = err.message ?? String(error);
	console.log(`REFUSED ${err.code ?? ""} ${msg}`);
	process.exit(2);
}
