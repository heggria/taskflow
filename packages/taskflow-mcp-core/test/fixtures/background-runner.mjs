const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0.001,
	contextTokens: 5,
	turns: 1,
};

export const instantRunner = {
	usageAccounting: "full",
	runTask: async (_cwd, _agents, agent, task) => ({
		agent,
		task,
		exitCode: 0,
		output: "detached output",
		stderr: "",
		usage,
		stopReason: "end",
	}),
};

export const cancellableRunner = {
	usageAccounting: "full",
	runTask: async (_cwd, _agents, agent, task, options) =>
		await new Promise((resolve) => {
			const finish = () => resolve({
				agent,
				task,
				exitCode: 1,
				output: "",
				stderr: "cancelled",
				error: "Cancelled",
				usage: { ...usage, input: 0, output: 0, contextTokens: 0 },
				stopReason: "aborted",
			});
			if (options?.signal?.aborted) return finish();
			const timer = setTimeout(() => resolve({
				agent,
				task,
				exitCode: 0,
				output: "too late",
				stderr: "",
				usage,
				stopReason: "end",
			}), 10_000);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				finish();
			}, { once: true });
		}),
};
