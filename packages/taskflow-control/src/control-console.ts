/** Trusted local launcher bridge. All run/approval/evidence semantics stay in Host. */
import { ControlError } from "./errors.ts";
import type { AuthorizationAuthority, VerifiedContext } from "./authorization.ts";
import type { ProjectRegistry } from "./project-registry.ts";
import { startWebConsole, type WebConsoleAuthorization, type WebConsoleServer } from "./web-console.ts";

export interface AuthenticatedControlDispatcher {
	dispatchAuthenticated(context: VerifiedContext, method: string, params: unknown): Promise<unknown>;
}
export interface ControlConsoleOptions {
	host: AuthenticatedControlDispatcher;
	authorization: AuthorizationAuthority;
	registry: ProjectRegistry;
	/** Issued by the trusted launcher before HTTP starts, never from a browser body. */
	contexts: ReadonlyMap<string, VerifiedContext>;
	port?: number;
	sessionTtlMs?: number;
}

export async function launchControlConsole(options: ControlConsoleOptions): Promise<WebConsoleServer> {
	const contexts = new Map(options.contexts);
	if (contexts.size === 0) throw new ControlError("TF_POLICY_DENIED", "console requires verified mounted-project contexts");
	const validate = async (projectId: string, request: WebConsoleAuthorization): Promise<VerifiedContext> => {
		const context = contexts.get(projectId);
		if (!context) throw new ControlError("TF_POLICY_DENIED", "project is not available to this console launcher");
		const { store, projectRoot } = options.registry.resolve(projectId);
		const header = store.header;
		if (request.controlDomainId !== undefined && request.controlDomainId !== header.controlDomainId) throw new ControlError("TF_POLICY_DENIED", "project domain does not match this mount");
		await options.authorization.authorize(context, {
			projectId, controlDomainId: header.controlDomainId, projectRoot,
			operation: ["approval.decide", "approvals.stageEdit"].includes(request.operation) ? "submit" : "read",
			...(["approval.decide", "approvals.stageEdit"].includes(request.operation) ? { commandKind: "approval.decide" as const } : {}),
		});
		return context;
	};
	return startWebConsole({
		port: options.port, sessionTtlMs: options.sessionTtlMs,
		approvalEditWithArtifactRef: true, approvalOutputEdit: true,
		async authorize(request) {
			if (request.projectId !== undefined) {
				const context = await validate(request.projectId, request);
				return { call: (operation, params) => options.host.dispatchAuthenticated(context, operation, params) };
			}
			// A context never expands to other mounts. Global navigation aggregates
			// project-scoped Host calls and filters denied projects at live policy.
			const allowed: { projectId: string; context: VerifiedContext }[] = [];
			for (const projectId of contexts.keys()) {
				try { allowed.push({ projectId, context: await validate(projectId, request) }); }
				catch (error) {
					if (!(error instanceof ControlError) || !["TF_POLICY_DENIED", "TF_AUTHORITY_REVOKED"].includes(error.code)) throw error;
				}
			}
			if (allowed.length === 0) throw new ControlError("TF_POLICY_DENIED", "no mounted project is currently authorized");
			return { async call(operation, params) {
				if (operation === "projects.list") {
					const rows: unknown[] = [];
					for (const entry of allowed) {
						const result = await options.host.dispatchAuthenticated(entry.context, operation, { ...params, projectId: entry.projectId });
						await validate(entry.projectId, request);
						if (!Array.isArray(result)) throw new ControlError("TF_COMMAND_FAILED", "host project list is invalid");
						rows.push(...result);
					}
					// Recheck every disclosed scope after the last Host await. Revocation
					// refuses the whole response; it cannot return a cached earlier grant.
					await Promise.all(allowed.map(entry => validate(entry.projectId, request)));
					return rows;
				}
				if (operation !== "control.status") throw new ControlError("TF_POLICY_DENIED", "project selection is required");
				return options.host.dispatchAuthenticated(allowed[0].context, operation, params);
			} };
		},
	});
}
