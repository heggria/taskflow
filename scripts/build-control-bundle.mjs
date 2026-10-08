#!/usr/bin/env node
/** Ship the private control implementation inside the existing public MCP package.
 * Compile directly from source on every MCP build: no stale workspace dist copy,
 * runtime workspace dependency, or additional public package is required. */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const control = join(repo, "packages", "taskflow-control");
const delivery = join(repo, "packages", "taskflow-mcp-core");
const output = join(delivery, "dist", "control");
const require = createRequire(join(control, "package.json"));
const compilerManifest = require.resolve("typescript/package.json");
const compiler = JSON.parse(readFileSync(compilerManifest, "utf8"));
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
execFileSync(process.execPath, [resolve(dirname(compilerManifest), compiler.bin.tsc), "-p", join(control, "tsconfig.build.json"), "--outDir", output], { cwd: control, stdio: "inherit" });
copyFileSync(join(control, "GUIDE.md"), join(delivery, "CONTROL_GUIDE.md"));
