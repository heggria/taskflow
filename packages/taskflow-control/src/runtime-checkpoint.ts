/** Exact engine checkpoints; recovery never infers process death from timeouts. */
import { randomUUID } from "node:crypto";
import { isQuiescentApprovalCheckpoint, resumeSourceAfterOwnerExit, type RunState } from "taskflow-core";
import { defaultProcessIdentity, type ProcessIdentityLike } from "./singleton.ts";
import { ControlError } from "./errors.ts";

export interface RuntimeCheckpoint {
 state: RunState;
 writer: ProcessIdentityLike;
}

export function isWaitingRuntimeCheckpoint(checkpoint: RuntimeCheckpoint | undefined): boolean {
 return !!checkpoint && checkpoint.state.status === "running" &&
  isQuiescentApprovalCheckpoint(checkpoint.state, checkpoint.state.foregroundOwner?.approvalWait ?? []);
}

export function ownRuntimeState(state: RunState): ProcessIdentityLike {
 const writer = defaultProcessIdentity();
 state.foregroundOwner = { version: 1, pid: writer.pid, instanceId: randomUUID(), startedAt: Date.now(),
  ...(state.foregroundOwner?.approvalWait ? { approvalWait: [...state.foregroundOwner.approvalWait] } : {}) };
 return writer;
}

export function captureRuntimeCheckpoint(state: RunState, writer: ProcessIdentityLike, waiting: ReadonlySet<string>): RuntimeCheckpoint {
 const snapshot = structuredClone(state);
 const running = Object.values(snapshot.phases).filter(phase => phase.status === "running").map(phase => phase.id).sort();
 if (snapshot.foregroundOwner) {
  delete snapshot.foregroundOwner.approvalWait;
  if (running.length && running.every(id => waiting.has(id)) && isQuiescentApprovalCheckpoint(snapshot, running)) snapshot.foregroundOwner.approvalWait = running;
 }
 return { state: snapshot, writer: { ...writer } };
}

export function recoverRuntimeCheckpoint(checkpoint: RuntimeCheckpoint | undefined, cwd: string): RunState {
 const state = checkpoint?.state, writer = checkpoint?.writer;
 if (!state || !writer || !writer.birthToken || !["native", "opaque"].includes(writer.birthTokenKind)
  || writer.pid !== state.foregroundOwner?.pid || state.status !== "running") {
  throw new ControlError("TF_RECONCILE_REQUIRED", "runtime has no verifiable approval checkpoint writer");
 }
 // Core requires an actual ESRCH process probe. A live reused PID, EPERM,
 // unavailable OS identity, and every other unknown remain closed. No kill is sent.
 const source = resumeSourceAfterOwnerExit(state, { cwd });
 if (!source.ok) throw new ControlError("TF_RECONCILE_REQUIRED", source.errors.join("; "));
 return structuredClone(state);
}
