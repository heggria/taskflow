/**
 * D21 host-entry inventory: all shipped admit surfaces converge on ControlHost
 * or document the residual 0.2 engine path. Behavioral, not string-theater.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	bindControlHostTools,
	bootstrapControl,
	createControlHost,
	tryControlPlaneRun,
} from "../src/index.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("D21 inventory: CLI and daemon depend on taskflow-control package", () => {
	const cliPkg = JSON.parse(
		fs.readFileSync(path.join(REPO, "packages/taskflow-cli/package.json"), "utf-8"),
	) as { dependencies?: Record<string, string> };
	const daemonPkg = JSON.parse(
		fs.readFileSync(path.join(REPO, "packages/taskflow-daemon/package.json"), "utf-8"),
	) as { dependencies?: Record<string, string> };
	const mcpPkg = JSON.parse(
		fs.readFileSync(path.join(REPO, "packages/taskflow-mcp-core/package.json"), "utf-8"),
	) as { dependencies?: Record<string, string> };

	assert.ok(cliPkg.dependencies?.["taskflow-control"], "taskflow-cli must depend on taskflow-control");
	assert.ok(daemonPkg.dependencies?.["taskflow-control"], "taskflow-daemon must depend on taskflow-control");
	assert.ok(
		mcpPkg.dependencies?.["taskflow-control"],
		"taskflow-mcp-core must depend on taskflow-control for D21 MCP route",
	);
});

test("D21 inventory: host delivery packages all bind the same MCP core server", () => {
	// Each host MCP server imports taskflow-mcp-core/server — one tool surface.
	const hosts = ["codex-taskflow", "claude-taskflow", "opencode-taskflow", "grok-taskflow"];
	for (const h of hosts) {
		const serverPath = path.join(REPO, "packages", h, "src/mcp/server.ts");
		assert.ok(fs.existsSync(serverPath), `missing ${serverPath}`);
		const src = fs.readFileSync(serverPath, "utf-8");
		assert.match(src, /taskflow-mcp-core\/server/, `${h} must bind taskflow-mcp-core/server`);
	}
});

test("D21 inventory: ControlHost + bindControlHostTools + tryControlPlaneRun are the public control surface", () => {
	assert.equal(typeof createControlHost, "function");
	assert.equal(typeof bootstrapControl, "function");
	assert.equal(typeof bindControlHostTools, "function");
	assert.equal(typeof tryControlPlaneRun, "function");
});

test("D21 inventory: event-kernel remains Default OFF (dual path documented, not silent production default)", () => {
	const driver = fs.readFileSync(
		path.join(REPO, "packages/taskflow-core/src/exec/driver.ts"),
		"utf-8",
	);
	assert.match(driver, /Default OFF/);
	assert.notEqual(process.env.PI_TASKFLOW_EVENT_KERNEL, "1");
	// Control plane route is opt-in unless TASKFLOW_CONTROL_PLANE set
	assert.notEqual(process.env.TASKFLOW_CONTROL_PLANE, "1");
});
