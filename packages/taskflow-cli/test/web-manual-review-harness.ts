import * as fs from "node:fs";

export const WEB_MANUAL_REVIEW_STAGES = [
	"initial",
	"cancel",
	"sessions",
] as const;

export const WEB_CANCEL_MANUAL_REVIEW_MAX_HOLD_MS =
	180_000;

export type WebManualReviewStage =
	(typeof WEB_MANUAL_REVIEW_STAGES)[number];

export type WebManualReviewConfig = {
	readonly enabled: boolean;
	readonly exitAfterHold: boolean;
	readonly holdMs: number;
	readonly releaseDirectory?: string;
	readonly stage: WebManualReviewStage;
};

export type WebManualReviewLaunch = {
	readonly label: string;
	readonly launchUrl: string;
	readonly origin: string;
	readonly project: string;
};

function parseHoldMs(value: string | undefined): number {
	const raw = value ?? "0";
	if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
		throw new Error(
			"TASKFLOW_WEB_MANUAL_REVIEW_MS must be a non-negative safe integer",
		);
	}
	const holdMs = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(holdMs) || holdMs < 0) {
		throw new Error(
			"TASKFLOW_WEB_MANUAL_REVIEW_MS must be a non-negative safe integer",
		);
	}
	return holdMs;
}

function parseStage(
	value: string | undefined,
): WebManualReviewStage {
	const stage = value ?? "initial";
	if (
		!WEB_MANUAL_REVIEW_STAGES.includes(
			stage as WebManualReviewStage,
		)
	) {
		throw new Error(
			`TASKFLOW_WEB_MANUAL_REVIEW_STAGE must be one of: ${WEB_MANUAL_REVIEW_STAGES.join(", ")}`,
		);
	}
	return stage as WebManualReviewStage;
}

export function readWebManualReviewConfig(
	env: NodeJS.ProcessEnv,
): WebManualReviewConfig {
	const holdMs = parseHoldMs(
		env.TASKFLOW_WEB_MANUAL_REVIEW_MS,
	);
	const stage = parseStage(
		env.TASKFLOW_WEB_MANUAL_REVIEW_STAGE,
	);
	if (
		stage === "cancel" &&
		holdMs >
			WEB_CANCEL_MANUAL_REVIEW_MAX_HOLD_MS
	) {
		throw new Error(
			`TASKFLOW_WEB_MANUAL_REVIEW_MS must be <= ${WEB_CANCEL_MANUAL_REVIEW_MAX_HOLD_MS} for cancel stage`,
		);
	}
	const releaseDirectory =
		env.TASKFLOW_WEB_MANUAL_REVIEW_RELEASE_DIR?.trim();
	return {
		enabled: holdMs > 0,
		exitAfterHold:
			env.TASKFLOW_WEB_MANUAL_REVIEW_EXIT_AFTER_HOLD === "1",
		holdMs,
		...(releaseDirectory
			? { releaseDirectory }
			: {}),
		stage,
	};
}

export function isWebManualReviewStage(
	config: WebManualReviewConfig,
	stage: WebManualReviewStage,
): boolean {
	return config.enabled && config.stage === stage;
}

export function webManualReviewRecord(
	config: WebManualReviewConfig,
	stage: WebManualReviewStage,
	launches: readonly WebManualReviewLaunch[],
): Record<string, unknown> {
	return {
		browser: "native",
		exitAfterHold: config.exitAfterHold,
		holdMs: config.holdMs,
		launches,
		releaseDirectoryConfigured:
			config.releaseDirectory !== undefined,
		stage,
	};
}

export async function holdWebManualReview(
	config: WebManualReviewConfig,
	options: {
		readonly launches: readonly WebManualReviewLaunch[];
		readonly stage: WebManualReviewStage;
		readonly write?: (message: string) => void;
	},
): Promise<boolean> {
	if (!isWebManualReviewStage(config, options.stage)) {
		return false;
	}
	if (options.launches.length === 0) {
		throw new Error(
			"manual review requires at least one launch capability",
		);
	}
	const write =
		options.write ??
		((message: string) => {
			process.stderr.write(message);
		});
	write(
		`[manual-review] ${JSON.stringify(
			webManualReviewRecord(
				config,
				options.stage,
				options.launches,
			),
		)}\n`,
	);
	const deadline = Date.now() + config.holdMs;
	while (Date.now() < deadline) {
		if (
			config.releaseDirectory &&
			fs.existsSync(config.releaseDirectory)
		) {
			return true;
		}
		await new Promise<void>((resolve) => {
			setTimeout(
				resolve,
				Math.min(250, deadline - Date.now()),
			);
		});
	}
	return true;
}
