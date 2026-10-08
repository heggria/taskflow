/** Bounded approval edits: typed UTF-8 output, or replacement of unstarted
 * downstream phase bodies in the already admitted graph. */
import { compileTaskflowToIR, isQuiescentApprovalCheckpoint, transitiveDownstream, validateTaskflow, type RunState, type Taskflow } from "taskflow-core";
import { contractViolations } from "taskflow-core/contract";
import { ControlError } from "./errors.ts";
import { commandRequestHash } from "./schema/commands.ts";
import type { ArtifactRef } from "./schema/evidence.ts";

export const MAX_APPROVAL_EDIT_BYTES = 1024 * 1024;
function invalid(message: string): never { throw new ControlError("TF_COMMAND_FAILED", message); }

export function decodeApprovalEdit(bytes: Uint8Array, artifact: ArtifactRef, kind: "output" | "plan"): string {
 if (bytes.byteLength > MAX_APPROVAL_EDIT_BYTES || artifact.storageClass !== "project" || artifact.redactionClass !== "internal") invalid("approval edit requires a project/internal artifact of at most 1 MiB");
 if (kind === "output" ? !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(artifact.mediaType) : !/^application\/json(?:;\s*charset=utf-8)?$/i.test(artifact.mediaType)) invalid("approval edit artifact media type does not match its edit kind");
 let text: string;
 try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid("approval edit must be valid UTF-8"); }
 if (text.includes("\0")) invalid("approval edit must not contain NUL");
 return text;
}

export function validateApprovalOutputEdit(state: RunState, phaseId: string, text: string): string {
 const phase = state.def.phases.find(item => item.id === phaseId);
 if (phase?.type !== "approval") invalid("output edit target is not an approval phase");
 const output = text.trim();
 if (!output) invalid("approval output edit must not be empty");
 // Core approval outputs are text (edit.note), so validate that exact value
 // against its OutputContract before admitting any downstream work.
 const violations = contractViolations(output, phase.expect ?? { type: "string" });
 if (violations.length) invalid(`approval output contract failed: ${violations.join("; ")}`);
 return output;
}

export async function validateApprovalPlanEdit(state: RunState, phaseId: string, candidate: unknown): Promise<{ flow: Taskflow; irHash: string }> {
 const check = validateTaskflow(candidate);
 if (!check.ok) invalid(`approval plan is invalid: ${check.errors.join("; ")}`);
 if (!state.foregroundOwner?.approvalWait?.includes(phaseId) || !isQuiescentApprovalCheckpoint(state, state.foregroundOwner.approvalWait)) throw new ControlError("TF_RECONCILE_REQUIRED", "plan edit requires its quiescent approval checkpoint");
 const flow = structuredClone(candidate) as Taskflow;
 const { phases: originalPhases, ...originalTop } = state.def, { phases: nextPhases, ...nextTop } = flow;
 if (commandRequestHash(originalTop) !== commandRequestHash(nextTop)) invalid("plan edit cannot change top-level settings or resource declarations");
 if (commandRequestHash(originalPhases.map(phase => phase.id)) !== commandRequestHash(nextPhases.map(phase => phase.id))) invalid("plan edit cannot add, remove, or reorder phases");
 const downstream = new Set(transitiveDownstream(originalPhases, phaseId));
 for (let i = 0; i < originalPhases.length; i++) {
  const previous = originalPhases[i]!, next = nextPhases[i]!;
  if (commandRequestHash(previous) === commandRequestHash(next)) continue;
  if (!downstream.has(previous.id) || state.phases[previous.id] !== undefined) invalid("plan edit cannot rewrite completed, active, or non-downstream phases");
  if (commandRequestHash([previous.dependsOn, previous.from, previous.join]) !== commandRequestHash([next.dependsOn, next.from, next.join])) invalid("plan edit cannot change phase dependencies or joins");
 }
 const compiled = await compileTaskflowToIR(flow);
 if (!compiled.hash || compiled.usedFallbackHash || compiled.errors.length) invalid("edited plan cannot be linked to a content-addressed IR");
 return { flow, irHash: compiled.hash };
}
