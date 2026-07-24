import type { WebStaticRoutePattern } from "taskflow-control/web-static-manifest";

export const WEB_APP_ROUTE_PATHS = {
	home: "/",
	tasks: "/tasks",
	needsInput: "/needs-input",
	workspaces: "/workspaces",
	workspace: "/workspaces/$projectId/domains/$controlDomainId",
	task: "/workspaces/$projectId/domains/$controlDomainId/tasks/$runId",
	approval:
		"/workspaces/$projectId/domains/$controlDomainId/tasks/$runId/input/$approvalRequestId",
	policy: "/policy",
	diagnostics: "/diagnostics",
	settings: "/settings",
} as const;

const literal = (value: string) => ({ kind: "literal" as const, value });
const safeId = (
	name: "projectId" | "controlDomainId" | "runId" | "approvalRequestId",
) => ({ kind: "safe-id" as const, name });

export const WEB_APP_ROUTE_PATTERNS = Object.freeze([
	{ id: "home", tokens: [] },
	{ id: "tasks", tokens: [literal("tasks")] },
	{ id: "needs-input", tokens: [literal("needs-input")] },
	{ id: "workspaces", tokens: [literal("workspaces")] },
	{
		id: "workspace",
		tokens: [
			literal("workspaces"),
			safeId("projectId"),
			literal("domains"),
			safeId("controlDomainId"),
		],
	},
	{
		id: "task",
		tokens: [
			literal("workspaces"),
			safeId("projectId"),
			literal("domains"),
			safeId("controlDomainId"),
			literal("tasks"),
			safeId("runId"),
		],
	},
	{
		id: "approval",
		tokens: [
			literal("workspaces"),
			safeId("projectId"),
			literal("domains"),
			safeId("controlDomainId"),
			literal("tasks"),
			safeId("runId"),
			literal("input"),
			safeId("approvalRequestId"),
		],
	},
	{ id: "policy", tokens: [literal("policy")] },
	{ id: "diagnostics", tokens: [literal("diagnostics")] },
	{ id: "settings", tokens: [literal("settings")] },
] satisfies readonly WebStaticRoutePattern[]);
