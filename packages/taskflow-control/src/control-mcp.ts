/** MCP is a protocol adapter over the launcher's already authenticated Host. */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { TaskflowSchema, getBuildInfo } from "taskflow-core";
import { RPC, RpcError, serveStdio, type RpcHandler } from "taskflow-mcp-core/jsonrpc";
import { UuidSchema, StringEnum } from "./schema/common.ts";
import { ApprovalModeSchema } from "./schema/approval.ts";
import { ArtifactRefSchema } from "./schema/evidence.ts";
import { ControlError } from "./errors.ts";

const scope = { projectId: Type.Optional(UuidSchema), controlDomainId: Type.Optional(UuidSchema) };
const run = { ...scope, runId: UuidSchema };
const closed = { additionalProperties: false };
const definitions = [
 { name: "taskflow_control_coordinator", description: "Read user-global capacity and only this project's reservation identifiers and authorized command audit.", method: "coordinator.status", inputSchema: Type.Object(scope, closed) },
 { name: "taskflow_control_projects", description: "List projects authorized for this local session.", method: "projects.list", inputSchema: Type.Object(scope, closed) },
 { name: "taskflow_control_runs", description: "List durable run status in the authorized project.", method: "runs.list", inputSchema: Type.Object(scope, closed) },
 { name: "taskflow_control_submit", description: "Submit a flow to the authenticated Host. Reuse commandId when retrying the same request.", method: "commands.submit", inputSchema: Type.Object({ ...scope, commandId: UuidSchema, flow: TaskflowSchema, args: Type.Optional(Type.Record(Type.String(), Type.Unknown())), approvalMode: Type.Optional(ApprovalModeSchema) }, closed) },
 { name: "taskflow_control_status", description: "Read durable status without phase transcripts.", method: "runs.status", inputSchema: Type.Object(run, closed) },
 { name: "taskflow_control_result", description: "Read the authorized run result, including final output only.", method: "runs.result", inputSchema: Type.Object(run, closed) },
 { name: "taskflow_control_cancel", description: "Cancel a run through the Host's durable control path with its expected run version.", method: "runs.cancel", inputSchema: Type.Object({ ...run, commandId: UuidSchema, expectedRunVersion: Type.Integer({ minimum: 0 }) }, closed) },
 { name: "taskflow_control_approvals", description: "List durable approval requests in the authorized project.", method: "approvals.list", inputSchema: Type.Object(scope, closed) },
 { name: "taskflow_control_approval_stage_edit", description: "Stage bounded output or plan text as a ledger-reachable approval edit artifact. Refresh status before deciding.", method: "approvals.stageEdit", inputSchema: Type.Object({ ...run, editKind: StringEnum(["output", "plan"]), content: Type.String({ maxLength: 1024 * 1024 }) }, closed) },
 { name: "taskflow_control_approval_decide", description: "Approve, reject, or edit a pending approval with its expected run version. Edit requires a staged artifact and editKind.", method: "approvals.decide", inputSchema: Type.Object({ ...run, commandId: UuidSchema, approvalRequestId: UuidSchema, expectedRunVersion: Type.Integer({ minimum: 0 }), decision: StringEnum(["approve", "reject", "edit"]), editKind: Type.Optional(StringEnum(["output", "plan"])), editArtifactRef: Type.Optional(ArtifactRefSchema) }, closed) },
 { name: "taskflow_control_resume", description: "Resume a recoverable run through Host admission and authority checks.", method: "runs.resume", inputSchema: Type.Object(run, closed) },
 { name: "taskflow_control_receipt", description: "Read the authorized evidence receipt for a terminal run.", method: "receipts.get", inputSchema: Type.Object(run, closed) },
 { name: "taskflow_control_why", description: "Explain authorized durable run evidence and effect causes.", method: "evidence.why", inputSchema: Type.Object({ ...run, effectId: Type.Optional(Type.String({ minLength: 1 })), phaseId: Type.Optional(Type.String({ minLength: 1 })), seeds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, closed) },
] as const;
const operatorDefinitions = [
 { name: "taskflow_control_set_max_active_runs", description: "Explicit operator only: set the user-global admitted-run limit. Reuse commandId for exact retries.", method: "coordinator.setMaxActiveRuns", inputSchema: Type.Object({ ...scope, commandId: UuidSchema, maxActiveRuns: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, closed) },
 { name: "taskflow_control_force_release", description: "Explicit operator only: release capacity without proving execution stopped; permanently marks operator-overridden. Requires acknowledgement and an audit reason.", method: "coordinator.forceRelease", inputSchema: Type.Object({ ...scope, commandId: UuidSchema, reservationId: UuidSchema, riskAcknowledgement: Type.Literal(true), reason: Type.String({ minLength: 1, maxLength: 4096 }) }, closed) },
] as const;
const callSchema = Type.Object({ name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, closed);
const initializeSchema = Type.Object({ protocolVersion: Type.String(), capabilities: Type.Record(Type.String(), Type.Unknown()), clientInfo: Type.Object({ name: Type.String(), version: Type.String(), title: Type.Optional(Type.String()) }, { additionalProperties: true }) }, { additionalProperties: true });

export interface ControlMcpOptions {
 /** Bound by CLI bootstrap/HMAC attach; no caller identity can be supplied over MCP. */
 call(method: string, params: unknown): Promise<unknown>;
 projectId: string;
 /** Trusted launcher choice; this never grants Host authority by itself. */
 operator?: boolean;
 input?: NodeJS.ReadableStream;
 output?: NodeJS.WritableStream;
}

export function serveControlMcp(options: ControlMcpOptions): Promise<void> {
 const tools = [...definitions, ...(options.operator ? operatorDefinitions : [])];
 let initialized = false;
 const requireInitialized = () => { if (!initialized) throw new RpcError(RPC.INVALID_REQUEST, "initialize is required before using control tools"); };
 const handlers: Record<string, RpcHandler> = Object.create(null);
 handlers.initialize = params => {
  if (!Value.Check(initializeSchema, params)) throw new RpcError(RPC.INVALID_PARAMS, "invalid initialize parameters");
  initialized = true;
  return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "taskflow-control", version: getBuildInfo().packageVersion } };
 };
 handlers["notifications/initialized"] = () => undefined;
 handlers.ping = () => ({});
 handlers["tools/list"] = params => {
  requireInitialized();
  if (params !== undefined && !Value.Check(Type.Object({}, closed), params)) throw new RpcError(RPC.INVALID_PARAMS, "tools/list accepts no parameters");
  return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
 };
 handlers["tools/call"] = async params => {
  requireInitialized();
  if (!Value.Check(callSchema, params)) throw new RpcError(RPC.INVALID_PARAMS, "invalid tool call");
  const tool = tools.find(definition => definition.name === params.name);
  if (!tool) throw new RpcError(RPC.INVALID_PARAMS, "unknown control tool");
  const args = params.arguments ?? {};
  if (tool.method === "approvals.decide" && (args.decision === "edit" ? args.editKind === undefined || args.editArtifactRef === undefined : args.editKind !== undefined || args.editArtifactRef !== undefined)) throw new RpcError(RPC.INVALID_PARAMS, "edit decision requires exactly editKind and editArtifactRef");
  if (!Value.Check(tool.inputSchema, args)) throw new RpcError(RPC.INVALID_PARAMS, "invalid tool arguments");
  try {
   const result = await options.call(tool.method, { projectId: options.projectId, ...args, ...(tool.method === "commands.submit" ? { kind: "run.submit" } : {}) });
   return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
   // Never dump request bodies, transcripts, credentials, or unexpected exception text.
   const code = error instanceof ControlError ? error.code : "TF_COMMAND_FAILED";
   return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] };
  }
 };
 return serveStdio(handlers, { input: options.input, output: options.output });
}
