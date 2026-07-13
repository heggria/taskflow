import assert from "node:assert/strict";
import { buildSource } from "../../packages/taskflow-dsl/src/build.ts";
import { compileTaskflowToFlowIR, hashFlowIR, validateTaskflow } from "../../packages/taskflow-core/src/index.ts";
import { sampleJson, sampleTs } from "../lib/home-samples.ts";

const built = buildSource(sampleTs, "website-home.tf.ts");
assert.equal(built.ok, true, built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
assert.ok(built.taskflow, "homepage TypeScript sample must emit a Taskflow");

const json = JSON.parse(sampleJson);
const validation = validateTaskflow(json);
assert.equal(validation.ok, true, validation.errors.join("\n"));

const jsonHash = hashFlowIR(compileTaskflowToFlowIR(json).canonical);
assert.equal(built.irHash, jsonHash, "homepage JSON and TypeScript samples must compile to the same FlowIR");
process.stdout.write("Homepage authoring samples are valid and FlowIR-equivalent.\n");
