#!/usr/bin/env node
import { runCli } from "./cli.ts";

const result = await runCli(process.argv.slice(2));
console.log(JSON.stringify(result.json, null, 2));
process.exit(result.exitCode);
