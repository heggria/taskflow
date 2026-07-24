import {
	WEB_BLOCKING_REASON_CODES,
	WEB_CAPACITY_REASON_CODES,
	WEB_DECISION_OPERATION_CLASSES,
	WEB_PROJECTED_CONTENT_ARGUMENTS,
	WEB_PROJECTED_CONTENT_KEYS,
	WEB_VERIFICATION_CONTENT_KEYS,
	WEB_VERIFICATION_REASON_CODES,
	type WebContentArgName,
	type WebProjectedContentKey,
} from "taskflow-control/web-presentation-schema";
import {
	TF_ERROR_CODES,
	type TfErrorCode,
} from "taskflow-control/types";
import type {
	WebCatalogArgumentKind,
	WebContentLocale,
	WebContentTemplate,
	WebLocalizedCatalogEntry,
} from "./content-types.ts";

const projectedArgumentKinds = {
	activeStepLabel: "string",
	taskDisplayTitle: "string",
	workspaceDisplayName: "string",
	activeStepCount: "count",
	completedStepCount: "count",
	workspaceCount: "count",
	omittedWorkspaceCount: "count",
	preservedResultCount: "count",
	activeStepLabels: "string-list",
	deadline: "timestamp",
	capacityReason: "capacity-reason",
	blockingReason: "blocking-reason",
	recoveryLabel: "recovery-action",
	verificationReason: "verification-reason",
} as const satisfies Record<WebContentArgName, WebCatalogArgumentKind>;

function entry(
	key: WebProjectedContentKey,
	en: WebContentTemplate,
	zhCN: WebContentTemplate,
): WebLocalizedCatalogEntry {
	return {
		args: WEB_PROJECTED_CONTENT_ARGUMENTS[key].map((name) => ({
			name,
			kind: projectedArgumentKinds[name],
		})),
		surface: "shared",
		values: { en, "zh-CN": zhCN },
	};
}

function select(
	arg: string,
	values: readonly string[],
	base: string,
	overrides: Readonly<Record<string, string>> = {},
): WebContentTemplate {
	return {
		kind: "select",
		arg,
		cases: Object.fromEntries(
			values.map((value) => [value, overrides[value] ?? base]),
		),
	};
}

const catalog: Partial<
	Record<WebProjectedContentKey, WebLocalizedCatalogEntry>
> = {};

function add(
	key: WebProjectedContentKey,
	en: WebContentTemplate,
	zhCN: WebContentTemplate,
): void {
	if (catalog[key]) throw new Error(`duplicate projected content key: ${key}`);
	catalog[key] = entry(key, en, zhCN);
}

add("task.working", "Task in progress", "任务正在进行");
add(
	"task.working-multiple",
	"Several steps are in progress",
	"多个步骤正在进行",
);
add("task.waiting-to-start", "Task is waiting to start", "任务正在等待开始");
add("task.needs-input", "This task needs your input", "这个任务需要你处理");
add("task.stopping", "Stopping the task", "正在停止任务");
add(
	"task.checking-execution",
	"Checking whether the task is still running",
	"正在确认任务是否仍在运行",
);
add("task.could-not-continue", "Task could not continue", "任务无法继续");
add("task.failed", "Task did not finish", "任务没有完成");
add("task.cancelled", "Task stopped", "任务已停止");
add("task.completed", "Task completed", "任务已完成");

add(
	"task.working.one.detail",
	"Taskflow is working on {activeStepCount, number} step: {activeStepLabels}. You do not need to do anything right now.",
	"Taskflow 正在处理 {activeStepCount, number} 个步骤：{activeStepLabels}。你暂时不需要操作。",
);
add(
	"task.working.many.detail",
	"Taskflow is working on {activeStepCount, number} steps: {activeStepLabels}. You do not need to do anything right now.",
	"Taskflow 正在处理 {activeStepCount, number} 个步骤：{activeStepLabels}。你暂时不需要操作。",
);
add(
	"task.waiting.generic.detail",
	"Taskflow will start this task when it is ready. You do not need to do anything.",
	"Taskflow 会在准备好后开始这个任务。你不需要操作。",
);
add(
	"task.waiting.capacity.detail",
	select(
		"capacityReason",
		WEB_CAPACITY_REASON_CODES,
		"Taskflow is waiting until this task can start. You do not need to retry it.",
		{
			"capacity-full":
				"Taskflow is waiting until another task finishes. You do not need to do anything.",
			"waiting-for-reservation":
				"Taskflow is confirming when this task can start. You do not need to retry it.",
			"coordinator-unavailable":
				"Taskflow cannot start this task until coordination is available. You do not need to retry it.",
		},
	),
	select(
		"capacityReason",
		WEB_CAPACITY_REASON_CODES,
		"Taskflow 正在等待开始条件。你不需要重新运行。",
		{
			"capacity-full": "当前并发任务已满。其他任务结束后，本任务会继续开始。",
			"waiting-for-reservation":
				"Taskflow 正在确认本任务何时可以开始。你不需要重新运行。",
			"coordinator-unavailable":
				"当前暂时无法协调任务启动。恢复前，你不需要重新运行。",
		},
	),
);
add(
	"task.waiting.policy.detail",
	"This task cannot start under the current workspace rules. Review the explanation before changing anything.",
	"当前工作区规则不允许这个任务开始。更改设置前，请先查看具体说明。",
);
add(
	"task.approval-required.detail",
	"Review the decision and its consequences before choosing.",
	"请先查看决定内容和两种选择的后果。",
);
add(
	"task.stopping.confirmation.detail",
	"Taskflow has requested a stop and is waiting for active work to end. Do not start the task again yet.",
	"Taskflow 已请求停止，正在等待仍在进行的工作结束。现在不要重新运行。",
);
add(
	"task.reconciling.ambiguous.detail",
	"Taskflow cannot yet confirm whether all work stopped. Some work may still be running; it will not mark the task as stopped until this is confirmed.",
	"Taskflow 还不能确认所有工作是否已经停止。部分工作可能仍在继续；确认前不会把任务标记为已停止。",
);
add(
	"task.blocked.reason.detail",
	select(
		"blockingReason",
		WEB_BLOCKING_REASON_CODES,
		"Taskflow stopped before completing this task. Open the explanation to see what can be changed.",
		{
			"policy-denied":
				"Workspace rules prevented the task from continuing. Review the explanation before changing the rules.",
			"dependency-failed":
				"A required earlier step did not finish, so Taskflow did not continue.",
			"approval-expired":
				"The requested decision expired before it was answered. Open the task to see the current options.",
			"provider-failed":
				"The external execution did not complete. Any preserved result remains available.",
			"verification-required":
				"Required result checks did not complete, so Taskflow did not continue.",
		},
	),
	select(
		"blockingReason",
		WEB_BLOCKING_REASON_CODES,
		"Taskflow 在任务完成前停止了。请打开说明，查看可以调整的内容。",
		{
			"policy-denied":
				"工作区规则阻止了任务继续。更改规则前，请先查看具体说明。",
			"dependency-failed": "前置步骤没有完成，因此 Taskflow 没有继续。",
			"approval-expired": "需要你的决定已经过期。请打开任务查看当前选项。",
			"provider-failed": "外部执行没有完成。已经保留的结果仍然可用。",
			"verification-required": "必要的结果检查没有完成，因此 Taskflow 没有继续。",
		},
	),
);
add(
	"task.failed.terminal.detail",
	{
		kind: "plural",
		arg: "preservedResultCount",
		one: "The task did not finish. One generated result is still available. Open the error details before running it again.",
		other:
			"The task did not finish. {preservedResultCount, number} generated results are still available. Open the error details before running it again.",
	},
	{
		kind: "plural",
		arg: "preservedResultCount",
		one: "任务没有完成。已生成的 1 项结果仍然保留。重新运行前，请先查看失败详情。",
		other:
			"任务没有完成。已生成的 {preservedResultCount, number} 项结果仍然保留。重新运行前，请先查看失败详情。",
	},
);
add(
	"task.cancelled.quiescent.detail",
	"Active work has stopped. Results created before the stop remain available.",
	"仍在进行的工作已经停止。停止前生成的结果仍然保留。",
);
add(
	"task.completed.verification.detail",
	select(
		"verificationReason",
		WEB_VERIFICATION_REASON_CODES,
		"The task finished. Check the separate result verification status before relying on the output.",
		{
			"all-required-checks-ok":
				"The task finished, and all required result checks passed.",
			"verification-in-progress":
				"The task finished, but result checks are still in progress.",
			"receipt-missing":
				"The task finished, but Taskflow cannot currently verify all result evidence.",
			"verifier-unavailable":
				"The task finished, but result verification is currently unavailable.",
			"lifecycle-not-applicable":
				"The task finished. This task does not require result verification.",
		},
	),
	select(
		"verificationReason",
		WEB_VERIFICATION_REASON_CODES,
		"任务已经完成。依赖结果前，请另外查看结果验证状态。",
		{
			"all-required-checks-ok": "任务已经完成，所有必要的结果检查均已通过。",
			"verification-in-progress": "任务已经完成，但结果检查仍在进行。",
			"receipt-missing": "任务已经完成，但 Taskflow 目前无法验证全部结果证据。",
			"verifier-unavailable": "任务已经完成，但目前无法进行结果验证。",
			"lifecycle-not-applicable": "任务已经完成。这个任务不需要验证结果。",
		},
	),
);

add(
	"attention.project-unavailable",
	"One workspace could not be checked. Some tasks may be missing from this list. Refresh the workspace status; this will not run a task.",
	"有一个工作区暂时无法检查，因此列表中可能缺少部分任务。请刷新工作区状态；这不会运行任务。",
);
add(
	"attention.decision-required",
	"This task is waiting for your decision. Review both outcomes before choosing.",
	"这个任务正在等待你的决定。选择前，请先查看两种结果。",
);
add(
	"attention.execution-unconfirmed",
	"Taskflow cannot confirm whether this task stopped. Some work may still be running. Do not repeat the action yet.",
	"Taskflow 还不能确认这个任务是否已经停止。部分工作可能仍在继续，请暂时不要重复操作。",
);
add(
	"attention.review-required",
	"Taskflow needs someone to review this task before it can continue. Open the task to see the current evidence and safest next step.",
	"这个任务需要人工检查后才能继续。请打开任务，查看当前证据和最安全的下一步。",
);
add(
	"attention.execution-place-held",
	"Taskflow is keeping this task's place because it cannot confirm that execution stopped. Some work may still be running; review the evidence before retrying.",
	"Taskflow 仍在为这个任务保留位置，因为目前无法确认执行已经停止。部分工作可能仍在继续；重新尝试前，请先查看证据。",
);

add(
	"observation.live-updates-paused",
	"Live updates are paused. Refreshing the latest state will not run the task again.",
	"实时更新已暂停。刷新最新状态不会重新运行任务。",
);
add(
	"observation.source-coverage-partial",
	"Some workspaces could not be checked. The totals shown here do not include them.",
	"部分工作区暂时无法检查。当前数量不包含这些工作区。",
);
add(
	"observation.source-authority-unverified",
	"Taskflow cannot verify the latest saved state. State-changing actions are unavailable until it can.",
	"Taskflow 无法验证最新保存状态。在恢复验证前，不能执行会改变状态的操作。",
);
add(
	"observation.source-ready",
	"The latest saved state is available.",
	"已显示最新保存状态。",
);

const verificationCopy = {
	"verification.verified": ["Result verified", "结果已验证"],
	"verification.verified.detail": [
		"All required checks passed for the current result.",
		"当前结果的所有必要检查均已通过。",
	],
	"verification.partially-verified": [
		"Result partly verified",
		"结果已部分验证",
	],
	"verification.partially-verified.detail": [
		"Some required checks passed, but other evidence is still unavailable or incomplete.",
		"部分必要检查已通过，但其他证据仍不可用或不完整。",
	],
	"verification.unavailable": [
		"Result verification unavailable",
		"暂时无法验证结果",
	],
	"verification.unavailable.detail": [
		"Taskflow does not currently have enough evidence to verify this result.",
		"Taskflow 目前没有足够证据验证这个结果。",
	],
	"verification.failed": ["Result verification failed", "结果验证失败"],
	"verification.failed.detail": [
		"Current evidence conflicts with the recorded result. Review the failed checks before relying on it.",
		"当前证据与记录的结果不一致。依赖该结果前，请先查看失败的检查。",
	],
	"verification.not-yet-verified": [
		"Result not verified yet",
		"结果尚未验证",
	],
	"verification.not-yet-verified.detail": [
		"Required checks have not finished yet.",
		"必要检查尚未完成。",
	],
	"verification.not-applicable": [
		"Verification not required",
		"无需验证",
	],
	"verification.not-applicable.detail": [
		"This task does not require result verification.",
		"这个任务不需要验证结果。",
	],
} as const satisfies Record<
	(typeof WEB_VERIFICATION_CONTENT_KEYS)[number],
	readonly [string, string]
>;
for (const key of WEB_VERIFICATION_CONTENT_KEYS) {
	const [en, zhCN] = verificationCopy[key];
	add(
		key,
		select("verificationReason", WEB_VERIFICATION_REASON_CODES, en),
		select("verificationReason", WEB_VERIFICATION_REASON_CODES, zhCN),
	);
}

type DecisionCopy = Readonly<
	Record<
		WebContentLocale,
		{
			question: string;
			impact: string;
			allowLabel: string;
			denyLabel: string;
			allowConsequence: string;
			denyConsequence: string;
		}
	>
>;
const decisionCopies: Record<
	(typeof WEB_DECISION_OPERATION_CLASSES)[number],
	DecisionCopy
> = {
	"publish-files": {
		en: {
			question: "Allow this task to publish these files?",
			impact: "Publishing makes the selected files available outside this task.",
			allowLabel: "Allow publishing",
			denyLabel: "Do not publish",
			allowConsequence: "The task will continue and publish the selected files.",
			denyConsequence: "This publication will stop; existing results remain available.",
		},
		"zh-CN": {
			question: "是否允许这个任务发布这些文件？",
			impact: "发布后，所选文件会在本任务之外可用。",
			allowLabel: "允许发布",
			denyLabel: "不允许发布",
			allowConsequence: "任务会继续并发布所选文件。",
			denyConsequence: "本次发布会停止；已有结果仍然保留。",
		},
	},
	"change-files": {
		en: {
			question: "Allow this task to change these files?",
			impact: "The task will write changes into the workspace.",
			allowLabel: "Allow changes",
			denyLabel: "Do not change files",
			allowConsequence: "The task will continue and write the described changes.",
			denyConsequence: "The file changes will not be made.",
		},
		"zh-CN": {
			question: "是否允许这个任务修改这些文件？",
			impact: "任务会把更改写入工作区。",
			allowLabel: "允许修改",
			denyLabel: "不修改文件",
			allowConsequence: "任务会继续并写入上述更改。",
			denyConsequence: "不会写入这些文件更改。",
		},
	},
	"use-network": {
		en: {
			question: "Allow this task to connect to the network?",
			impact: "The task may send requests to the named external service.",
			allowLabel: "Allow connection",
			denyLabel: "Do not connect",
			allowConsequence: "The task will continue with the requested network access.",
			denyConsequence: "The network request will not be made.",
		},
		"zh-CN": {
			question: "是否允许这个任务连接网络？",
			impact: "任务可能向指定的外部服务发送请求。",
			allowLabel: "允许连接",
			denyLabel: "不允许连接",
			allowConsequence: "任务会获得所请求的网络访问并继续。",
			denyConsequence: "不会发出这次网络请求。",
		},
	},
	"run-tool": {
		en: {
			question: "Allow this task to use this tool?",
			impact: "The tool may affect the workspace as described.",
			allowLabel: "Allow tool",
			denyLabel: "Do not use tool",
			allowConsequence: "The task will continue and use the described tool.",
			denyConsequence: "The tool will not run.",
		},
		"zh-CN": {
			question: "是否允许这个任务使用该工具？",
			impact: "该工具可能按说明影响工作区。",
			allowLabel: "允许使用工具",
			denyLabel: "不使用工具",
			allowConsequence: "任务会继续并使用上述工具。",
			denyConsequence: "不会运行该工具。",
		},
	},
	"spend-budget": {
		en: {
			question: "Allow this task to use the additional budget?",
			impact: "Continuing may increase the task's recorded cost.",
			allowLabel: "Allow additional budget",
			denyLabel: "Do not increase budget",
			allowConsequence: "The task will continue within the new budget.",
			denyConsequence: "The task will not use additional budget.",
		},
		"zh-CN": {
			question: "是否允许这个任务使用额外预算？",
			impact: "继续后可能增加任务记录的费用。",
			allowLabel: "允许额外预算",
			denyLabel: "不增加预算",
			allowConsequence: "任务会在新的预算范围内继续。",
			denyConsequence: "任务不会使用额外预算。",
		},
	},
	"continue-task": {
		en: {
			question: "Allow this task to continue?",
			impact: "The task will resume from its current saved state.",
			allowLabel: "Allow task to continue",
			denyLabel: "Do not continue",
			allowConsequence: "The task will continue from the current state.",
			denyConsequence: "The task will remain stopped at this decision.",
		},
		"zh-CN": {
			question: "是否允许这个任务继续？",
			impact: "任务会从当前保存状态继续。",
			allowLabel: "允许任务继续",
			denyLabel: "不继续",
			allowConsequence: "任务会从当前状态继续。",
			denyConsequence: "任务会停留在这个决定处。",
		},
	},
	"apply-edit": {
		en: {
			question: "Apply the proposed edit and continue?",
			impact: "The task will use the reviewed edit for its remaining work.",
			allowLabel: "Apply edit",
			denyLabel: "Do not apply edit",
			allowConsequence: "The reviewed edit will be applied and the task will continue.",
			denyConsequence: "The edit will not be applied.",
		},
		"zh-CN": {
			question: "是否应用建议的更改并继续？",
			impact: "任务会在后续工作中使用你已查看的更改。",
			allowLabel: "应用更改",
			denyLabel: "不应用更改",
			allowConsequence: "会应用你已查看的更改，然后任务继续。",
			denyConsequence: "不会应用该更改。",
		},
	},
	"generic-action": {
		en: {
			question: "Allow this task to take the described action?",
			impact: "Review the task's quoted request before choosing.",
			allowLabel: "Allow action",
			denyLabel: "Do not allow action",
			allowConsequence: "The task will continue with the described action.",
			denyConsequence: "The described action will not be taken.",
		},
		"zh-CN": {
			question: "是否允许这个任务执行上述操作？",
			impact: "选择前，请查看任务请求的原文。",
			allowLabel: "允许操作",
			denyLabel: "不允许操作",
			allowConsequence: "任务会执行上述操作并继续。",
			denyConsequence: "不会执行上述操作。",
		},
	},
};

for (const operation of WEB_DECISION_OPERATION_CLASSES) {
	const copy = decisionCopies[operation];
	add(`decision.${operation}.question`, copy.en.question, copy["zh-CN"].question);
	add(`decision.${operation}.impact`, copy.en.impact, copy["zh-CN"].impact);
	add(
		`decision.${operation}.allow-label`,
		copy.en.allowLabel,
		copy["zh-CN"].allowLabel,
	);
	add(
		`decision.${operation}.do-not-allow-label`,
		copy.en.denyLabel,
		copy["zh-CN"].denyLabel,
	);
	add(
		`decision.${operation}.allow-consequence`,
		copy.en.allowConsequence,
		copy["zh-CN"].allowConsequence,
	);
	add(
		`decision.${operation}.do-not-allow-consequence`,
		copy.en.denyConsequence,
		copy["zh-CN"].denyConsequence,
	);
}

type ErrorCopy = Readonly<Record<WebContentLocale, readonly [string, string]>>;
const errorCopies: Record<TfErrorCode, ErrorCopy> = {
	TF_PROTOCOL_INCOMPATIBLE: {
		en: [
			"Taskflow needs an update",
			"The app and local service cannot safely work together. Update or reinstall Taskflow before continuing.",
		],
		"zh-CN": [
			"Taskflow 需要更新",
			"当前应用与本地服务无法安全协作。请更新或重新安装 Taskflow 后再继续。",
		],
	},
	TF_SCHEMA_UNSUPPORTED: {
		en: [
			"This saved data needs a newer Taskflow",
			"The current version cannot safely read this saved data. Update Taskflow before continuing.",
		],
		"zh-CN": [
			"这些保存数据需要新版 Taskflow",
			"当前版本无法安全读取这些保存数据。请更新 Taskflow 后再继续。",
		],
	},
	TF_FEATURE_REQUIRED: {
		en: [
			"This action is not available",
			"The current Taskflow installation does not support a required capability. Update it or choose another available action.",
		],
		"zh-CN": [
			"当前无法执行这个操作",
			"当前 Taskflow 安装缺少必要能力。请更新，或选择其他可用操作。",
		],
	},
	TF_POLICY_DENIED: {
		en: [
			"Workspace rules did not allow this action",
			"No changes were made. Review the rule explanation before changing the workspace settings.",
		],
		"zh-CN": [
			"工作区规则不允许这个操作",
			"没有产生更改。调整工作区设置前，请先查看规则说明。",
		],
	},
	TF_AUTHORITY_REVOKED: {
		en: [
			"Your access changed",
			"This action is no longer allowed in the current session. Refresh to see the actions still available.",
		],
		"zh-CN": [
			"你的访问权限已变化",
			"当前会话不再允许这个操作。请刷新，查看仍然可用的操作。",
		],
	},
	TF_STALE_VERSION: {
		en: [
			"This task changed",
			"Taskflow did not apply the action because a newer saved state exists. Refresh before deciding again.",
		],
		"zh-CN": [
			"这个任务已经发生变化",
			"存在更新的保存状态，因此 Taskflow 没有应用该操作。请刷新后重新决定。",
		],
	},
	TF_IDEMPOTENCY_CONFLICT: {
		en: [
			"This request conflicts with an earlier action",
			"The same action identifier was already used for different information. Nothing new was applied.",
		],
		"zh-CN": [
			"这个请求与之前的操作冲突",
			"同一个操作标识已经用于不同内容。本次没有应用新的更改。",
		],
	},
	TF_CROSS_PRINCIPAL_COMMAND: {
		en: [
			"This action belongs to another session",
			"Taskflow did not reuse an action created by a different user session.",
		],
		"zh-CN": [
			"这个操作属于另一个会话",
			"Taskflow 没有复用由其他用户会话创建的操作。",
		],
	},
	TF_LEGACY_CONFLICT: {
		en: [
			"This workspace needs attention",
			"Older and current task records conflict. Taskflow preserved both and will not choose one silently.",
		],
		"zh-CN": [
			"这个工作区需要处理",
			"旧任务记录与当前记录存在冲突。Taskflow 已保留两者，不会静默选择其中一个。",
		],
	},
	TF_PROVIDER_AMBIGUOUS: {
		en: [
			"The execution result is uncertain",
			"Taskflow cannot yet confirm what the external execution did. Do not repeat the action until the latest state is checked.",
		],
		"zh-CN": [
			"执行结果还不能确定",
			"Taskflow 还无法确认外部执行的实际结果。检查最新状态前，请不要重复操作。",
		],
	},
	TF_JOURNAL_UNAVAILABLE: {
		en: [
			"Task history is temporarily unavailable",
			"Taskflow cannot safely read the saved history right now. No new action was applied.",
		],
		"zh-CN": [
			"任务历史暂时不可用",
			"Taskflow 目前无法安全读取已保存的历史。本次没有应用新的操作。",
		],
	},
	TF_DURABILITY_FAILED: {
		en: [
			"The change was not saved",
			"Taskflow could not confirm that this change was stored safely. Treat the action as incomplete.",
		],
		"zh-CN": [
			"更改没有保存",
			"Taskflow 无法确认该更改已经安全保存。请把本次操作视为未完成。",
		],
	},
	TF_CURSOR_EXPIRED: {
		en: [
			"This page is out of date",
			"The saved list changed after this page was loaded. Refresh to continue from the latest records.",
		],
		"zh-CN": [
			"页面信息已过期",
			"加载页面后，保存的列表已经变化。请刷新并从最新记录继续。",
		],
	},
	TF_COMMAND_FAILED: {
		en: [
			"The action did not finish",
			"Taskflow could not complete this action. Preserved task results remain available; review the next action before trying again.",
		],
		"zh-CN": [
			"操作没有完成",
			"Taskflow 无法完成这个操作。已保留的任务结果仍然可用；重试前请查看下一步操作。",
		],
	},
	TF_BOOTSTRAP_FAILED: {
		en: [
			"Taskflow could not open this workspace",
			"The local service did not provide a safe initial state. Close this page and start Taskflow again.",
		],
		"zh-CN": [
			"Taskflow 无法打开这个工作区",
			"本地服务没有提供安全的初始状态。请关闭本页并重新启动 Taskflow。",
		],
	},
	TF_RECONCILE_REQUIRED: {
		en: [
			"Taskflow needs to confirm the latest state",
			"Some saved and live information may differ. State-changing actions remain unavailable until the check finishes.",
		],
		"zh-CN": [
			"Taskflow 需要确认最新状态",
			"部分保存信息与实时信息可能不同。检查完成前，不能执行会改变状态的操作。",
		],
	},
	TF_CAPACITY_EXCEEDED: {
		en: [
			"All task slots are currently in use",
			"This task did not start. It can continue when another active task finishes.",
		],
		"zh-CN": [
			"当前任务名额已满",
			"这个任务尚未开始。其他活动任务结束后，它可以继续。",
		],
	},
	TF_NOT_FOUND: {
		en: [
			"This item is no longer available",
			"It may have moved or been removed. Refresh to see the current list.",
		],
		"zh-CN": [
			"这个项目已不可用",
			"它可能已移动或移除。请刷新以查看当前列表。",
		],
	},
	TF_INVALID_ARGUMENT: {
		en: [
			"Some information could not be used",
			"Taskflow did not apply the action. Review the highlighted fields and try again.",
		],
		"zh-CN": [
			"部分信息无法使用",
			"Taskflow 没有应用该操作。请检查标出的字段后重试。",
		],
	},
	TF_IDENTITY_MISMATCH: {
		en: [
			"This workspace does not match its saved identity",
			"Taskflow will not write changes until the workspace identity is resolved.",
		],
		"zh-CN": [
			"这个工作区与保存的身份不一致",
			"在工作区身份问题解决前，Taskflow 不会写入更改。",
		],
	},
};

for (const code of TF_ERROR_CODES) {
	const copy = errorCopies[code];
	add(`error.${code}.headline`, copy.en[0], copy["zh-CN"][0]);
	add(`error.${code}.detail`, copy.en[1], copy["zh-CN"][1]);
}

add("recovery.retry-same-command", "Retry the same action", "重试同一操作");
add("recovery.retry-new-command", "Try the action again", "重新执行操作");
add("recovery.refresh", "Refresh the latest state", "刷新最新状态");
add("recovery.reconcile", "Check and restore the latest state", "检查并恢复最新状态");
add("recovery.operator", "Ask the workspace administrator for help", "请工作区管理员协助");
add("recovery.none", "You do not need to do anything right now", "你目前不需要操作");
add("risk.none", "No additional work is expected to be running.", "预计没有其他工作仍在运行。");
add(
	"risk.possible-live-side-effects",
	"Some work may still be running. Do not repeat the action until Taskflow confirms the latest state.",
	"部分工作可能仍在继续。在 Taskflow 确认最新状态前，请不要重复操作。",
);
add(
	"risk.unknown-side-effects",
	"Taskflow cannot yet determine whether work is still running. Repeating the action may cause it to run twice.",
	"Taskflow 还不能确定是否仍有工作在运行。重复操作可能导致工作执行两次。",
);
add(
	"empty.home.no-tasks",
	"No tasks yet. Run a workflow from a supported coding tool, and it will appear here.",
	"还没有任务。通过支持的编程工具运行工作流后，任务会出现在这里。",
);
add(
	"empty.task.no-result",
	"This task does not have a result yet.",
	"这个任务暂时还没有结果。",
);
add(
	"empty.tasks.no-results",
	"No tasks match the current filters. Change or clear the filters to see more tasks.",
	"没有符合当前筛选条件的任务。更改或清除筛选条件可查看更多任务。",
);
add(
	"empty.needs-input.none",
	"No tasks need your input right now.",
	"目前没有需要你处理的任务。",
);
add(
	"empty.workspaces.none",
	"No workspaces are available in this Taskflow session.",
	"当前 Taskflow 会话中没有可用工作区。",
);
add(
	"system.cursor-expired",
	"This page is out of date. Refresh to continue from the latest records.",
	"页面信息已过期。刷新后会从最新记录继续。",
);
add(
	"system.cursor-expired.refresh",
	"Refresh the latest records. This will not run the task again.",
	"刷新最新记录。这不会重新运行任务。",
);
add(
	"system.partial-workspaces",
	{
		kind: "plural",
		arg: "omittedWorkspaceCount",
		one: "One workspace could not be checked. The totals below do not include it.",
		other:
			"{omittedWorkspaceCount, number} workspaces could not be checked. The totals below do not include them.",
	},
	"{omittedWorkspaceCount, number} 个工作区暂时无法检查。下面的数量不包括它们。",
);
add(
	"system.no-action-required",
	"You do not need to do anything right now.",
	"你目前不需要操作。",
);

const actualKeys = Object.keys(catalog).sort((a, b) => a.localeCompare(b, "en"));
const expectedKeys = [...WEB_PROJECTED_CONTENT_KEYS].sort((a, b) =>
	a.localeCompare(b, "en"),
);
if (
	actualKeys.length !== expectedKeys.length ||
	actualKeys.some((key, index) => key !== expectedKeys[index])
) {
	const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
	const extra = actualKeys.filter((key) => !expectedKeys.includes(key as WebProjectedContentKey));
	throw new Error(
		`projected content catalog mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`,
	);
}

export const WEB_PROJECTED_CONTENT_CATALOG = Object.freeze(catalog) as Readonly<
	Record<WebProjectedContentKey, WebLocalizedCatalogEntry>
>;
