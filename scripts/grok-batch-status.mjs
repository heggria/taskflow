#!/usr/bin/env node
// Compact status across every grok batch log dir under .scratch.
// Usage: node scripts/grok-batch-status.mjs [--watch] [--full]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".scratch";
const watch = process.argv.includes("--watch");
const full = process.argv.includes("--full");

function batchDirs() {
	if (!existsSync(ROOT)) return [];
	return readdirSync(ROOT)
		.filter((d) => {
			const p = join(ROOT, d);
			return statSync(p).isDirectory() && existsSync(join(p, "state.json"));
		})
		.sort();
}

function mins(job) {
	const end = job.endedAt ? new Date(job.endedAt) : new Date();
	return (end - new Date(job.startedAt)) / 60000;
}

function render() {
	let grand = 0;
	let running = 0;
	const lines = [];
	for (const dir of batchDirs()) {
		let state;
		try {
			state = JSON.parse(readFileSync(join(ROOT, dir, "state.json"), "utf8"));
		} catch {
			continue;
		}
		const jobs = Object.entries(state.jobs ?? {});
		if (jobs.length === 0) continue;
		let cost = 0;
		const rows = [];
		for (const [id, job] of jobs) {
			cost += job.costUSD ?? 0;
			if (job.status === "running") running += 1;
			rows.push(
				`   ${id.padEnd(30)} ${String(job.status).padEnd(10)} ${mins(job).toFixed(1).padStart(5)}min` +
					`${job.attempt && job.attempt > 1 ? ` att${job.attempt}` : "    "}` +
					` ${job.costUSD ? `$${job.costUSD.toFixed(2)}` : "     "}` +
					`${job.transportStatus && job.transportStatus !== "completed" ? ` [${job.transportStatus}]` : ""}`,
			);
		}
		grand += cost;
		const open = jobs.filter(([, j]) => j.status === "running").length;
		lines.push(
			`${dir}  ${jobs.length} jobs  $${cost.toFixed(2)}${open ? `  ${open} RUNNING` : ""}`,
		);
		if (full || open > 0) lines.push(...rows);
	}
	lines.push(`TOTAL $${grand.toFixed(2)}   running jobs: ${running}`);
	return lines.join("\n");
}

if (watch) {
	for (;;) {
		process.stdout.write(`\u001b[2J\u001b[H${new Date().toLocaleTimeString()}\n${render()}\n`);
		await new Promise((r) => setTimeout(r, 20_000));
	}
} else {
	console.log(render());
}
