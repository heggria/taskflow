/** Direct user entry to the public Control Console. Never reads login secrets. */
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const OUTPUT_LIMIT = 64 * 1024;

export interface ConsoleLocation {
	consoleUrl: string;
	browserHandoffFile: string;
}

export interface WebCommandContext {
	cwd: string;
	ui: { notify(message: string, kind?: "info" | "warning" | "error"): void };
}

/** Injection is for local process tests; production always uses the installed carrier. */
export interface WebCommandOptions {
	resolveCli?: () => string;
	openBrowser?: (url: string) => Promise<void>;
	platform?: NodeJS.Platform;
	startupTimeoutMs?: number;
	stopTimeoutMs?: number;
}

class WebCommandError extends Error {}

/** Resolve through the public export, then its package's declared executable.
 * This works with hoisted/nested installs and source development conditions. */
export function resolveControlCli(): string {
	let directory = dirname(fileURLToPath(import.meta.resolve("taskflow-mcp-core")));
	for (;;) {
		try {
			const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
				name?: string; bin?: Record<string, unknown>;
			};
			if (manifest.name === "taskflow-mcp-core") {
				const entry = manifest.bin?.["taskflow-control"];
				if (typeof entry !== "string") break;
				const cli = realpathSync(resolve(directory, entry));
				const suffix = relative(realpathSync(directory), cli);
				if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) break;
				if (!statSync(cli).isFile()) break;
				return cli;
			}
		} catch { /* continue to the owning package manifest */ }
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new WebCommandError("Installed taskflow-mcp-core Control CLI is missing; rebuild or repair the Pi package installation.");
}

function exited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (exited(child)) return Promise.resolve(true);
	return new Promise((done) => {
		const finish = (result: boolean) => {
			clearTimeout(timer);
			child.off("exit", onExit);
			done(result);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
	});
}

/** Only signal the ChildProcess we spawned, never a PID from a registry. */
async function stopChild(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (exited(child)) return;
	child.kill("SIGTERM");
	if (await waitForExit(child, timeoutMs)) return;
	child.kill("SIGKILL");
	if (!await waitForExit(child, timeoutMs)) throw new WebCommandError("Owned Control Console process did not exit after SIGKILL.");
}

export async function openDefaultBrowser(url: string, platform = process.platform, timeoutMs = 5_000): Promise<void> {
	const executable = platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(executable, [url], { stdio: "ignore", shell: false });
	try {
		await new Promise<void>((done, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				child.off("error", onError);
				child.off("exit", onExit);
				if (error) reject(error); else done();
			};
			const onError = () => finish(new WebCommandError("Browser opener unavailable."));
			const onExit = (code: number | null) => finish(code === 0 ? undefined : new WebCommandError("Browser opener failed."));
			const timer = setTimeout(() => finish(new WebCommandError("Browser opener timed out.")), timeoutMs);
			child.once("error", onError);
			child.once("exit", onExit);
		});
	} finally { await stopChild(child, 250); }
}

function locationFrom(value: unknown): ConsoleLocation | undefined {
	if (!value || typeof value !== "object") return;
	const data = value as Partial<ConsoleLocation>;
	if (typeof data.consoleUrl !== "string" || typeof data.browserHandoffFile !== "string") return;
	const url = new URL(data.consoleUrl);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
		url.pathname !== "/" || url.search || url.hash) throw new WebCommandError("Console returned an unsafe browser URL.");
	const file = data.browserHandoffFile;
	if (!isAbsolute(file) || /[\x00-\x1f\x7f]/u.test(file) || !/^console-handoff-[a-f0-9-]+\.json$/u.test(basename(file))) {
		throw new WebCommandError("Console returned an invalid private handoff path.");
	}
	const stat = lstatSync(file);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
		throw new WebCommandError("Console login handoff must be a private same-user file (0600).");
	}
	return { consoleUrl: url.origin, browserHandoffFile: file };
}

/** Deliberately expose only known error codes, never child output or exception text. */
function safeFailure(error: unknown): string {
	if (error instanceof WebCommandError) return error.message;
	const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
	const safeCode = ["ENOENT", "EACCES", "EPERM", "EADDRINUSE"].includes(code) ? ` (${code})` : "";
	return `Control Console could not start${safeCode}; check the installed carrier and local Control service access.`;
}

interface OwnedConsole {
	child: ChildProcess;
	identity: string;
	location?: ConsoleLocation;
}

export function createWebCommand(options: WebCommandOptions = {}) {
	const platform = options.platform ?? process.platform;
	const stopTimeout = options.stopTimeoutMs ?? 1_000;
	let owned: OwnedConsole | undefined;
	let closed = false;
	let queue = Promise.resolve();
	const shutdown = new AbortController();
	const serialize = (action: () => Promise<void>) => {
		const next = queue.then(action);
		queue = next.catch(() => {});
		return next;
	};
	const stopOwned = async () => {
		if (!owned) return;
		await stopChild(owned.child, stopTimeout);
		owned = undefined;
	};

	async function start(root: string, identity: string): Promise<OwnedConsole> {
		const cli = (options.resolveCli ?? resolveControlCli)();
		const child = spawn(process.execPath, [cli, "serve", "--root", root, "--console"], {
			cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: false,
		});
		const record: OwnedConsole = { child, identity };
		owned = record;
		try {
			record.location = await new Promise<ConsoleLocation>((done, reject) => {
				let buffer = "", bytes = 0, diagnostics = "";
				const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
				let settled = false;
				const finish = (error?: Error, location?: ConsoleLocation) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					shutdown.signal.removeEventListener("abort", onAbort);
					child.off("error", onError);
					child.off("exit", onExit);
					// Keep the pipes draining without retaining any further output.
					child.stdout?.off("data", onOutput);
					child.stderr?.off("data", onStderr);
					child.stdout?.resume(); child.stderr?.resume();
					if (error) reject(error); else done(location!);
				};
				const count = (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > OUTPUT_LIMIT) { finish(new WebCommandError("Console startup output exceeded 64 KiB.")); return false; }
					return true;
				};
				const onOutput = (chunk: Buffer) => {
					if (!count(chunk)) return;
					buffer += stdoutDecoder.write(chunk);
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0 && !settled) {
						const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
						let value: unknown;
						try { value = JSON.parse(line); } catch { continue; }
						try { const location = locationFrom(value); if (location) finish(undefined, location); }
						catch (error) { finish(new WebCommandError(safeFailure(error))); }
					}
				};
				const onStderr = (chunk: Buffer) => { if (count(chunk)) diagnostics += stderrDecoder.write(chunk); };
				const onError = (error: Error) => finish(new WebCommandError(safeFailure(error)));
				const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
					const reason = [...new Set(diagnostics.match(/\b(?:EPERM|EACCES|EADDRINUSE|ENOENT|TF_BOOTSTRAP_FAILED)\b/gu) ?? [])].join(", ");
					const hint = diagnostics.includes("serve requires ownership") ? " Another host owns this Control home; stop it before launching a console." : "";
					finish(new WebCommandError(`Console exited before readiness (${signal ?? code ?? "unknown"})${reason ? `: ${reason}` : ""}.${hint}`));
				};
				const onAbort = () => finish(new WebCommandError("Console startup cancelled by session shutdown."));
				const timer = setTimeout(() => finish(new WebCommandError("Console startup timed out.")), options.startupTimeoutMs ?? 15_000);
				child.stdout!.on("data", onOutput); child.stderr!.on("data", onStderr);
				child.once("error", onError); child.once("exit", onExit);
				shutdown.signal.addEventListener("abort", onAbort, { once: true });
				if (shutdown.signal.aborted) onAbort();
			});
			if (exited(child)) throw new WebCommandError("Console exited immediately after readiness.");
			return record;
		} catch (error) { await stopOwned(); throw error; }
	}

	return {
		async run(ctx: WebCommandContext): Promise<void> {
			return serialize(async () => {
				try {
					if (closed) throw new WebCommandError("Control Console session is already shut down.");
					if (platform === "win32") throw new WebCommandError("/tf web requires Unix local Control transport; Windows is unsupported.");
					const root = realpathSync(ctx.cwd), stat = statSync(root);
					const identity = `${root}:${stat.dev}:${stat.ino}`;
					if (owned && (owned.identity !== identity || exited(owned.child))) await stopOwned();
					const console = owned ?? await start(root, identity);
					const location = console.location!;
					// Always make the safe URL/file visible, including when opening fails.
					ctx.ui.notify(`Control Console: ${location.consoleUrl}\nPrivate login handoff: ${location.browserHandoffFile}\nSame-user local access: use this private file's one-use token in the console login form.\nViews Control Plane runs and evidence; legacy raw transcripts are outside this view.`, "info");
					try {
						await (options.openBrowser ?? ((url) => openDefaultBrowser(url, platform)))(location.consoleUrl);
					} catch {
						ctx.ui.notify(`Browser launch failed. Open ${location.consoleUrl} manually; use the private login handoff file shown above.`, "warning");
					}
				} catch (error) { ctx.ui.notify(safeFailure(error), "error"); }
			});
		},
		async close(): Promise<void> {
			closed = true;
			shutdown.abort();
			return serialize(stopOwned);
		},
	};
}
