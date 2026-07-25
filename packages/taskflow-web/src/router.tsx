import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ChevronRight,
	Circle,
	Clock3,
	Command,
	FileCheck2,
	FolderKanban,
	Home,
	Languages,
	LayoutList,
	LoaderCircle,
	Menu,
	Moon,
	RefreshCw,
	Settings,
	ShieldCheck,
	Sparkles,
	SquareActivity,
	Sun,
	X,
} from "lucide-react";
import {
	lazy,
	Suspense,
	type ComponentType,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	Button,
	Dialog,
	DialogTrigger,
	type Key,
	Modal,
	ModalOverlay,
	Tab,
	TabList,
	TabPanel,
	Tabs,
	ToggleButton,
	ToggleButtonGroup,
} from "react-aria-components";
import {
	WebClientFailureError,
	type WebApprovalSummary,
	type WebAvailableAction,
	type WebCommandRequest,
	type WebGeneratedClient,
	type WebRunDetail,
	type WebRunSummary,
	type WebSourceObservation,
} from "taskflow-control/web-protocol";
import {
	projectControlErrorPresentation,
	projectObservationPresentation,
} from "taskflow-control/web-presentation-client";
import type {
	WebAuthoritativeResourceIdentity,
	WebAuthorityRefreshStamp,
	WebLiveState,
} from "taskflow-control/web-presentation-schema";
import { useApp } from "./app-context.tsx";
import { WEB_APP_ROUTE_PATHS } from "./app-routes.ts";
import {
	segmentCursorPages,
	WEB_TASK_PAGE_LIMIT,
} from "./segmented-list.ts";
import {
	type DurableCommandState,
	useDurableCommand,
	type WebCommandRequestBase,
} from "./use-durable-command.ts";

const ProTaskPanels = lazy(() =>
	import("./views/pro-task-panels.tsx").then((module) => ({
		default: module.ProTaskPanels,
	})),
);

type IconComponent = ComponentType<{ size?: number; strokeWidth?: number }>;
type RunPage = Awaited<ReturnType<WebGeneratedClient["runs"]>>;
type ProjectPage = Awaited<ReturnType<WebGeneratedClient["projects"]>>;
type ApprovalPage = Awaited<ReturnType<WebGeneratedClient["approvals"]>>;
type AttentionPage = Awaited<ReturnType<WebGeneratedClient["attention"]>>;
type CommandOf<Kind extends WebCommandRequest["kind"]> = Extract<
	WebCommandRequest,
	{ kind: Kind }
>;
type AvailableAction<Kind extends WebCommandRequest["kind"]> = {
	readonly kind: Kind;
	readonly state: "available";
	readonly requestBase: Omit<CommandOf<Kind>, "commandId">;
};
const PRO_TASK_TABS = [
	["summary", "nav.pro.overview"],
	["graph", "nav.pro.graph"],
	["timeline", "nav.pro.timeline"],
	["evidence", "nav.pro.evidence"],
	["replay", "nav.pro.replay"],
	["technical", "nav.pro.technical"],
] as const;
type ProTaskTab = (typeof PRO_TASK_TABS)[number][0];

function isProTaskTab(value: string): value is ProTaskTab {
	return PRO_TASK_TABS.some(([candidate]) => candidate === value);
}

function initialProTaskTab(): ProTaskTab {
	const value = new URLSearchParams(window.location.search).get("tab");
	return value && isProTaskTab(value) ? value : "summary";
}

function availableAction<Kind extends WebCommandRequest["kind"]>(
	actions: readonly WebAvailableAction[],
	kind: Kind,
): AvailableAction<Kind> | undefined {
	return actions.find(
		(action) => action.kind === kind && action.state === "available",
	) as AvailableAction<Kind> | undefined;
}

function ShellLink({
	to,
	icon: Icon,
	label,
	badge,
}: {
	readonly to: string;
	readonly icon: IconComponent;
	readonly label: string;
	readonly badge?: number;
}): React.JSX.Element {
	return (
		<Link
			to={to}
			className="shell-link"
			activeProps={{ className: "shell-link is-active" }}
			activeOptions={{ exact: to === "/" }}
		>
			<Icon size={18} strokeWidth={1.8} />
			<span>{label}</span>
			{badge ? <span className="nav-badge">{badge}</span> : null}
		</Link>
	);
}

function BrandMark(): React.JSX.Element {
	return (
		<span className="brand-mark" aria-hidden="true">
			<span />
			<span />
			<span />
		</span>
	);
}

function SessionEndedScreen({
	scope,
}: {
	readonly scope: "current" | "all";
}): React.JSX.Element {
	const { t } = useApp();
	const title = t("session.ended.headline");
	useDocumentTitle(title);
	return (
		<main className="boot-page">
			<section className="boot-card" aria-labelledby="session-ended-title">
				<BrandMark />
				<h1 id="session-ended-title">{title}</h1>
				<p>
					{t(
						scope === "all"
							? "session.ended.all-detail"
							: "session.ended.current-detail",
					)}
				</p>
				<p>{t("session.ended.next")}</p>
			</section>
		</main>
	);
}

function DisplayModeSwitch(): React.JSX.Element {
	const { mode, setMode, t } = useApp();
	return (
		<button
			type="button"
			className="mode-switch"
			role="switch"
			aria-checked={mode === "pro"}
			onClick={() => setMode(mode === "pro" ? "simple" : "pro")}
		>
			<span className="switch-track">
				<span className="switch-thumb" />
			</span>
			<span>{t(mode === "pro" ? "mode.pro.label" : "mode.simple.label")}</span>
		</button>
	);
}

function AppShell(): React.JSX.Element {
	const { boot, mode, t } = useApp();
	const [mobileOpen, setMobileOpen] = useState(false);

	if (boot.status === "booting") return <BootScreen />;
	if (boot.status === "terminated") {
		return <SessionEndedScreen scope={boot.scope} />;
	}
	if (boot.status === "failed") {
		return (
			<main className="boot-page">
				<div className="boot-card">
					<BrandMark />
					<ErrorPanel error={boot.error} surface="bootstrap" />
				</div>
			</main>
		);
	}

	const sidebar = (
		<>
			<div className="brand-row">
				<BrandMark />
				<span>{t("app.brand")}</span>
				<Button
					className="icon-button mobile-close"
					aria-label={t("action.close")}
					onPress={() => setMobileOpen(false)}
				>
					<X size={19} />
				</Button>
			</div>
			<nav aria-label={t("nav.primary-label")}>
				<div className="nav-group">
					<ShellLink to="/" icon={Home} label={t("nav.home")} />
					<ShellLink
						to="/tasks"
						icon={LayoutList}
						label={t("nav.tasks")}
					/>
					<ShellLink
						to="/needs-input"
						icon={Command}
						label={t("nav.needs-input")}
					/>
					<ShellLink
						to="/workspaces"
						icon={FolderKanban}
						label={t("nav.workspaces")}
					/>
				</div>
				{mode === "pro" ? (
					<div className="nav-group pro-nav">
						<span className="nav-eyebrow">{t("mode.pro.label")}</span>
						<ShellLink
							to="/"
							icon={SquareActivity}
							label={t("nav.pro.overview")}
						/>
						<ShellLink
							to="/policy"
							icon={ShieldCheck}
							label={t("nav.pro.policy")}
						/>
						<ShellLink
							to="/diagnostics"
							icon={FileCheck2}
							label={t("nav.pro.diagnostics")}
						/>
					</div>
				) : null}
			</nav>
			<div className="sidebar-footer">
				<DisplayModeSwitch />
				<ShellLink
					to="/settings"
					icon={Settings}
					label={t("nav.settings")}
				/>
			</div>
		</>
	);

	return (
		<div className="app-frame">
			<a className="skip-link" href="#main-content">
				{t("app.skip-to-content")}
			</a>
			<header className="mobile-header">
				<Button
					className="icon-button"
					aria-label={t("nav.open-navigation")}
					onPress={() => setMobileOpen(true)}
				>
					<Menu size={20} />
				</Button>
				<div className="brand-row compact">
					<BrandMark />
					<span>{t("app.brand")}</span>
				</div>
				<span className="connection-dot" title={t("app.connected")} />
			</header>
			<aside className="sidebar">{sidebar}</aside>
			{mobileOpen ? (
				<div className="mobile-nav-layer">
					<Button
						className="nav-scrim"
						aria-label={t("action.close")}
						onPress={() => setMobileOpen(false)}
					/>
					<aside className="mobile-sidebar">{sidebar}</aside>
				</div>
			) : null}
			<main id="main-content" className="main-content">
				<Outlet />
			</main>
			<div
				className="sr-only"
				role="status"
				aria-atomic="true"
				aria-live="polite"
			>
				<span>{t("settings.mode.label")}</span>{" "}
				<span>{t(mode === "pro" ? "mode.pro.label" : "mode.simple.label")}</span>
			</div>
		</div>
	);
}

function BootScreen(): React.JSX.Element {
	const { t } = useApp();
	return (
		<main className="boot-page" aria-busy="true">
			<div className="boot-card">
				<BrandMark />
				<LoaderCircle className="spin" size={22} />
				<p>{t("app.opening-workspace")}</p>
			</div>
		</main>
	);
}

function useDocumentTitle(title: string): void {
	const { t } = useApp();
	const brand = t("app.brand");
	useEffect(() => {
		document.title = title === brand ? brand : `${title} · ${brand}`;
	}, [brand, title]);
}

function PageHeader({
	eyebrow,
	title,
	description,
	actions,
}: {
	readonly eyebrow?: string;
	readonly title: string;
	readonly description?: string;
	readonly actions?: ReactNode;
}): React.JSX.Element {
	useDocumentTitle(title);
	return (
		<header className="page-header">
			<div>
				{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
				<h1>{title}</h1>
				{description ? <p className="page-description">{description}</p> : null}
			</div>
			{actions ? <div className="header-actions">{actions}</div> : null}
		</header>
	);
}

function StatusStrip({
	observation,
	resource,
	response,
}: {
	readonly observation: WebSourceObservation;
	readonly resource?: WebAuthoritativeResourceIdentity;
	readonly response?: object;
}): React.JSX.Element | null {
	const { liveState, message, refreshStampFor } = useApp();
	const presentation = projectObservationPresentation({
		sourceObservation: observation,
		liveState,
		scope: resource
			? {
					kind: "authoritative-detail",
					resource,
					refreshStamp: response
						? refreshStampFor(resource, response)
						: undefined,
				}
			: { kind: "aggregate" },
	});
	if (presentation.message.key === "observation.source-ready") return null;
	return (
		<div className="status-strip" role="status">
			<AlertTriangle size={17} />
			<span>{message(presentation.message)}</span>
		</div>
	);
}

function stateSensitiveActionsAllowed(
	observation: WebSourceObservation,
	resource: WebAuthoritativeResourceIdentity,
	liveState: WebLiveState,
	refreshStamp: WebAuthorityRefreshStamp | undefined,
	hasCsrfToken: boolean,
): boolean {
	if (!hasCsrfToken) return false;
	return projectObservationPresentation({
		sourceObservation: observation,
		liveState,
		scope: {
			kind: "authoritative-detail",
			resource,
			refreshStamp,
		},
	}).stateSensitiveActionsAllowed;
}

function TaskStateIcon({
	status,
}: {
	readonly status: WebRunSummary["status"];
}): React.JSX.Element {
	if (status === "completed") return <Check size={16} />;
	if (status === "failed" || status === "blocked" || status === "unknown") {
		return <AlertTriangle size={16} />;
	}
	if (status === "running") return <LoaderCircle className="spin" size={16} />;
	return <Circle size={15} />;
}

function TaskRow({ run }: { readonly run: WebRunSummary }): React.JSX.Element {
	const { message, mode, t } = useApp();
	return (
		<Link
			to="/workspaces/$projectId/domains/$controlDomainId/tasks/$runId"
			params={{
				projectId: run.projectId,
				controlDomainId: run.controlDomainId,
				runId: run.runId,
			}}
			className="task-row"
		>
			<span className={`state-icon state-${run.status}`}>
				<TaskStateIcon status={run.status} />
			</span>
			<span className="task-row-copy">
				<strong>{run.displayTitle}</strong>
				<span>{message(run.presentation.headline)}</span>
				<small>
					{run.workspaceDisplayName} ·{" "}
					{t("summary.last-updated", { updatedAt: run.updatedAt })}
				</small>
			</span>
			{mode === "pro" ? (
				<span className="technical-pill">
					{run.status} · {run.stage}
				</span>
			) : null}
			<ChevronRight className="row-chevron" size={17} />
		</Link>
	);
}

function EmptyState({
	messageKey,
}: {
	readonly messageKey:
		| "empty.home.no-tasks"
		| "empty.task.no-result"
		| "empty.tasks.no-results"
		| "empty.needs-input.none"
		| "empty.workspaces.none";
}): React.JSX.Element {
	const { message } = useApp();
	return (
		<div className="empty-state">
			<Sparkles size={22} strokeWidth={1.5} />
			<p>
				{message({
					catalogVersion: "taskflow-content.v1",
					key: messageKey,
					args: [],
				})}
			</p>
		</div>
	);
}

function QueryState({
	isPending,
	error,
	children,
}: {
	readonly isPending: boolean;
	readonly error: unknown;
	readonly children: ReactNode;
}): React.JSX.Element {
	if (isPending) {
		return (
			<div className="loading-block" aria-busy="true">
				<LoaderCircle className="spin" size={19} />
			</div>
		);
	}
	if (error) return <ErrorPanel error={error} surface="aggregate-list" />;
	return <>{children}</>;
}

function ErrorPanel({
	error,
	surface,
	onRetry,
}: {
	readonly error: unknown;
	readonly surface:
		| "bootstrap"
		| "aggregate-list"
		| "authoritative-detail"
		| "command-submit"
		| "analysis";
	readonly onRetry?: () => void;
}): React.JSX.Element {
	const { boot, message, mode, retryBoot, t } = useApp();
	const fallback = {
		headline: t("error.fallback-headline"),
		detail: t("error.fallback-detail"),
		next: t("error.fallback-next"),
	};
	let copy = fallback;
	let technical: { code?: string; message?: string; requestId?: string } = {};
	if (error instanceof WebClientFailureError) {
		const bootstrap = boot.status === "ready" ? boot.bootstrap : undefined;
		const presentation = projectControlErrorPresentation({
			failure: error.failure,
			context: {
				surface,
				operation: "none",
				resourceState: { kind: "none" },
				sourceAuthority: "unverified",
				commandBodyState: "not-applicable",
				supportedFeatures: bootstrap?.supportedFeatures ?? [],
				supportedCommands: bootstrap?.supportedCommands ?? [],
				availableActions: [],
			},
		});
		copy = {
			headline: message(presentation.headline),
			detail: message(presentation.detail),
			next: message(presentation.nextAction),
		};
		technical = {
			code: presentation.technical.code,
			message: presentation.technical.sanitizedMessage,
			requestId: presentation.technical.requestId,
		};
	}
	return (
		<section className="error-panel" role="alert">
			<AlertTriangle size={20} />
			<div>
				<h2>{copy.headline}</h2>
				<p>{copy.detail}</p>
				<p>{copy.next}</p>
				<Button
					className="secondary-button"
					onPress={onRetry ?? (surface === "bootstrap" ? retryBoot : () => window.location.reload())}
				>
					<RefreshCw size={15} />
					{t("action.refresh-view")}
				</Button>
				{mode === "pro" && technical.code ? (
					<details className="technical-details">
						<summary>{t("section.pro.technical")}</summary>
						<dl>
							<dt>{t("pro.field.code")}</dt>
							<dd>{technical.code}</dd>
							<dt>{t("pro.field.request-id")}</dt>
							<dd>{technical.requestId}</dd>
							<dt>{t("pro.field.message")}</dt>
							<dd>{technical.message}</dd>
						</dl>
					</details>
				) : null}
			</div>
		</section>
	);
}

function CommandRecoveryPanel({
	state,
	checkAgain,
	retrySame,
	dismiss,
}: {
	readonly state: DurableCommandState;
	readonly checkAgain: () => Promise<void>;
	readonly retrySame: () => Promise<void>;
	readonly dismiss: () => void;
}): React.JSX.Element | null {
	const { t } = useApp();
	if (state.status === "idle" || state.status === "settled") return null;
	if (state.status === "failed") {
		return (
			<ErrorPanel
				error={state.error}
				surface="command-submit"
				onRetry={dismiss}
			/>
		);
	}
	const checking =
		state.status === "submitting" || state.status === "checking";
	const recorded = state.status === "recorded";
	return (
		<section
			className={checking ? "status-strip" : "error-panel"}
			role={checking || recorded ? "status" : "alert"}
		>
			{checking ? (
				<LoaderCircle className="spin" size={18} />
			) : (
				<AlertTriangle size={18} />
			)}
			<div>
				<h2>
					{t(
						checking
							? "command.checking.headline"
							: recorded
								? "command.recorded.headline"
								: "command.unknown.headline",
					)}
				</h2>
				<p>
					{t(
						checking
							? "command.checking.detail"
							: recorded
								? "command.recorded.detail"
								: state.request
									? "command.unknown.detail-retry"
									: "command.unknown.detail-refresh",
					)}
				</p>
				{state.status === "recorded" ||
				state.status === "unknown" ? (
					<div className="header-actions">
						<Button
							className="secondary-button"
							onPress={() => void checkAgain()}
						>
							<RefreshCw size={15} />
							{t("action.check-command")}
						</Button>
						{state.status === "unknown" &&
						state.request ? (
							<Button
								className="secondary-button"
								onPress={() => void retrySame()}
							>
								{t("action.retry-same-command")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		</section>
	);
}

function useRuns(limit = 50): ReturnType<typeof useQuery<RunPage>> {
	const { client } = useApp();
	return useQuery({
		queryKey: ["runs", limit],
		queryFn: () =>
			client.runs({
				params: {},
				query: {
					limit,
					sortKey: "updatedAt",
					sortDirection: "desc",
				},
				body: {},
			}),
	});
}

function HomePage(): React.JSX.Element {
	const { client, mode, t } = useApp();
	const runs = useRuns(16);
	const approvals = useQuery({
		queryKey: ["approvals", "pending", 8],
		queryFn: () =>
			client.approvals({
				params: {},
				query: { statuses: ["pending"], limit: 8 },
				body: {},
			}),
	});
	const overview = useQuery({
		queryKey: ["overview"],
		queryFn: () => client.overview({ params: {}, query: {}, body: {} }),
	});
	const active =
		runs.data?.items.filter((run) =>
			["running", "paused", "blocked", "unknown"].includes(run.status),
		) ?? [];
	const recent =
		runs.data?.items.filter((run) =>
			["completed", "failed", "cancelled"].includes(run.status),
		) ?? [];

	return (
		<div className="page">
			<PageHeader
				eyebrow={t("section.workspace")}
				title={
					overview.data
						? t("summary.home-activity", {
								activeCount: overview.data.runCounts.byStatus.running,
								inputCount: overview.data.attentionCounts.needsUserInput,
							})
						: t("nav.home")
				}
				description={t("description.home")}
			/>
			{overview.data ? <StatusStrip observation={overview.data.sourceObservation} /> : null}
			<QueryState
				isPending={runs.isPending || approvals.isPending}
				error={runs.error ?? approvals.error}
			>
				{(runs.data?.items.length ?? 0) === 0 ? (
					<EmptyState messageKey="empty.home.no-tasks" />
				) : (
					<div className="reading-flow">
						{approvals.data && approvals.data.items.length > 0 ? (
							<section className="section-block attention-section">
								<div className="section-heading">
									<h2>{t("nav.needs-input")}</h2>
									<span>{approvals.data.items.length}</span>
								</div>
								{approvals.data.items.map((approval) => (
									<ApprovalRow
										key={approval.approvalRequestId}
										approval={approval}
									/>
								))}
							</section>
						) : null}
						<section className="section-block">
							<div className="section-heading">
								<h2>{t("section.active-tasks")}</h2>
							</div>
							{active.slice(0, 8).map((run) => (
								<TaskRow key={`${run.projectId}/${run.runId}`} run={run} />
							))}
						</section>
						<section className="section-block">
							<div className="section-heading">
								<h2>{t("section.recent-tasks")}</h2>
							</div>
							{recent.slice(0, 8).map((run) => (
								<TaskRow key={`${run.projectId}/${run.runId}`} run={run} />
							))}
						</section>
						{mode === "pro" && overview.data ? (
							<ProOverviewSummary overview={overview.data} />
						) : null}
					</div>
				)}
			</QueryState>
		</div>
	);
}

function ProOverviewSummary({
	overview,
}: {
	readonly overview: Awaited<ReturnType<WebGeneratedClient["overview"]>>;
}): React.JSX.Element {
	const { t } = useApp();
	return (
		<section className="section-block pro-summary">
			<div className="section-heading">
				<h2>{t("section.pro.overview")}</h2>
			</div>
			<div className="compact-metrics">
				<div>
					<span>{t("pro.metric.capacity")}</span>
					<strong>
						{overview.coordinatorCapacity.occupied}/
						{overview.coordinatorCapacity.maxActiveRuns}
					</strong>
				</div>
				<div>
					<span>{t("pro.metric.healthy-workspaces")}</span>
					<strong>{overview.projectHealth.healthy}</strong>
				</div>
				<div>
					<span>{t("pro.metric.reused-nodes")}</span>
					<strong>{overview.reuse.estimatedReusedNodes}</strong>
				</div>
			</div>
		</section>
	);
}

function TasksPage(): React.JSX.Element {
	const { client, t } = useApp();
	const runs = useInfiniteQuery({
		queryKey: ["runs", "all", WEB_TASK_PAGE_LIMIT],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.runs({
				params: {},
				query: {
					limit: WEB_TASK_PAGE_LIMIT,
					cursor: pageParam,
					sortKey: "updatedAt",
					sortDirection: "desc",
				},
				body: {},
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	const segments = segmentCursorPages(runs.data?.pages ?? []);
	const itemCount = segments.reduce(
		(total, segment) => total + segment.items.length,
		0,
	);
	return (
		<div className="page">
			<PageHeader
				title={t("nav.tasks")}
				description={t("description.tasks")}
			/>
			<QueryState isPending={runs.isPending} error={runs.error}>
				{itemCount > 0 ? (
					<section
						className="section-block virtualized-task-list"
						aria-busy={runs.isFetchingNextPage}
					>
						{segments.map((segment) => (
							<div
								className="virtual-page-segment"
								data-page-index={segment.pageIndex}
								data-start-index={segment.startIndex}
								key={segment.pageIndex}
							>
								{segment.items.map((run) => (
									<TaskRow
										key={`${run.projectId}/${run.runId}`}
										run={run}
									/>
								))}
							</div>
						))}
						{runs.hasNextPage ? (
							<div className="list-pagination">
								<Button
									className="secondary-button"
									isDisabled={runs.isFetchingNextPage}
									onPress={() => void runs.fetchNextPage()}
								>
									{runs.isFetchingNextPage ? (
										<LoaderCircle className="spin" size={15} />
									) : null}
									{t("action.load-more")}
								</Button>
							</div>
						) : null}
					</section>
				) : (
					<EmptyState messageKey="empty.tasks.no-results" />
				)}
			</QueryState>
		</div>
	);
}

function ApprovalRow({
	approval,
}: {
	readonly approval: WebApprovalSummary;
}): React.JSX.Element {
	const { t } = useApp();
	return (
		<Link
			to="/workspaces/$projectId/domains/$controlDomainId/tasks/$runId/input/$approvalRequestId"
			params={{
				projectId: approval.projectId,
				controlDomainId: approval.controlDomainId,
				runId: approval.runId,
				approvalRequestId: approval.approvalRequestId,
			}}
			className="approval-row"
		>
			<span className="approval-symbol">
				<Command size={17} />
			</span>
			<span>
				<strong>{approval.message}</strong>
				<small>
					{approval.deadline
						? t("approval.decision-due", { dueAt: approval.deadline })
						: t("approval.review-impact")}
				</small>
			</span>
			<ChevronRight size={17} />
		</Link>
	);
}

function NeedsInputPage(): React.JSX.Element {
	const { client, message, t } = useApp();
	const approvals = useQuery<ApprovalPage>({
		queryKey: ["approvals", "all-pending"],
		queryFn: () =>
			client.approvals({
				params: {},
				query: { statuses: ["pending"], limit: 100 },
				body: {},
			}),
	});
	const attention = useQuery<AttentionPage>({
		queryKey: ["attention"],
		queryFn: () =>
			client.attention({ params: {}, query: { limit: 100 }, body: {} }),
	});
	return (
		<div className="page">
			<PageHeader
				title={t("nav.needs-input")}
				description={t("description.needs-input")}
			/>
			<QueryState
				isPending={approvals.isPending || attention.isPending}
				error={approvals.error ?? attention.error}
			>
				{(approvals.data?.items.length ?? 0) +
					(attention.data?.items.length ?? 0) ===
				0 ? (
					<EmptyState messageKey="empty.needs-input.none" />
				) : (
					<div className="reading-flow">
						{approvals.data?.items.length ? (
							<section className="section-block attention-section">
								<div className="section-heading">
									<h2>{t("section.required-input")}</h2>
								</div>
								{approvals.data.items.map((approval) => (
									<ApprovalRow
										key={approval.approvalRequestId}
										approval={approval}
									/>
								))}
							</section>
						) : null}
						{attention.data?.items.length ? (
							<section className="section-block">
								{attention.data.items.map((item) => (
									<div className="attention-row" key={item.attentionId}>
										<AlertTriangle size={17} />
										<div>
											<strong>{message(item.message)}</strong>
										</div>
									</div>
								))}
							</section>
						) : null}
					</div>
				)}
			</QueryState>
		</div>
	);
}

function WorkspacesPage(): React.JSX.Element {
	const { client, mode, t } = useApp();
	const projects = useQuery<ProjectPage>({
		queryKey: ["projects"],
		queryFn: () =>
			client.projects({ params: {}, query: { limit: 100 }, body: {} }),
	});
	return (
		<div className="page">
			<PageHeader
				title={t("nav.workspaces")}
				description={t("description.workspaces")}
			/>
			<QueryState isPending={projects.isPending} error={projects.error}>
				{projects.data?.items.length ? (
					<section className="workspace-grid">
						{projects.data.items.map((project) => (
							<Link
								key={`${project.projectId}/${project.controlDomainId}`}
								to="/workspaces/$projectId/domains/$controlDomainId"
								params={{
									projectId: project.projectId,
									controlDomainId: project.controlDomainId,
								}}
								className="workspace-card"
							>
								<div className="workspace-icon">
									<FolderKanban size={20} />
								</div>
								<div>
									<h2>{project.displayName}</h2>
									<p>
										{project.authorityVerified
											? t("workspace.history-ready")
											: t("description.workspace-unverified")}
									</p>
									{mode === "pro" ? (
										<small>
											{project.projectId} · {project.controlDomainId}
										</small>
									) : null}
								</div>
								<ChevronRight size={17} />
							</Link>
						))}
					</section>
				) : (
					<EmptyState messageKey="empty.workspaces.none" />
				)}
			</QueryState>
		</div>
	);
}

function WorkspacePage(): React.JSX.Element {
	const { projectId, controlDomainId } = useParams({
		from: "/workspaces/$projectId/domains/$controlDomainId",
	});
	const { client, mode, t } = useApp();
	const project = useQuery({
		queryKey: ["project", projectId, controlDomainId],
		queryFn: ({ signal }) =>
			client.projectDetail(
				{
					params: { projectId, controlDomainId },
					query: {},
					body: {},
				},
				{ signal },
			),
		structuralSharing: false,
	});
	return (
		<div className="page">
			<QueryState isPending={project.isPending} error={project.error}>
				{project.data ? (
					<>
						<PageHeader
							eyebrow={t("nav.workspaces")}
							title={project.data.displayName}
							description={
								project.data.header.verified
									? t("description.workspace-ready")
									: t("description.workspace-unverified")
							}
						/>
						<StatusStrip
							observation={project.data.sourceObservation}
							response={project.data}
							resource={{
								type: "project",
								projectId: project.data.projectId,
								controlDomainId: project.data.controlDomainId,
							}}
						/>
						<section className="section-block">
							<div className="section-heading">
								<h2>{t("section.recent-tasks")}</h2>
							</div>
							{project.data.recentRuns.map((run) => (
								<TaskRow key={run.runId} run={run} />
							))}
						</section>
						{mode === "pro" ? (
							<section className="technical-card">
								<h2>{t("section.pro.technical")}</h2>
								<dl>
									<dt>{t("pro.field.project")}</dt>
									<dd>{project.data.projectId}</dd>
									<dt>{t("pro.field.domain")}</dt>
									<dd>{project.data.controlDomainId}</dd>
									<dt>{t("pro.field.commit-seq")}</dt>
									<dd>{project.data.watermark.nextCommitSeq}</dd>
									<dt>{t("pro.field.binding")}</dt>
									<dd>{project.data.bindingState}</dd>
								</dl>
							</section>
						) : null}
					</>
				) : null}
			</QueryState>
		</div>
	);
}

function formatProgress(
	progress: WebRunDetail["presentation"]["progress"],
	t: ReturnType<typeof useApp>["t"],
): string {
	if (progress.semantics === "exact") {
		return t("progress.exact", {
			completed: progress.completed,
			total: progress.total,
		});
	}
	if (progress.semantics === "lower-bound") {
		return t("progress.lower-bound", { completed: progress.completed });
	}
	return t("progress.indeterminate");
}

function stepStateKey(
	state: WebRunDetail["presentation"]["stepGroups"][number]["state"],
):
	| "step-state.pending"
	| "step-state.running"
	| "step-state.waiting"
	| "step-state.completed"
	| "step-state.failed"
	| "step-state.cancelled"
	| "step-state.blocked" {
	return `step-state.${state}`;
}

function ResultPanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { t } = useApp();
	const result = detail.presentation.result;
	if (result.kind === "none") {
		return <EmptyState messageKey="empty.task.no-result" />;
	}
	return (
		<aside className="result-panel">
			<div className="section-heading">
				<h2>{t("section.result")}</h2>
			</div>
			{result.kind === "text" || result.kind === "json" || result.kind === "error" ? (
				<pre>{result.preview}</pre>
			) : (
				<div className="artifact-list">
					{result.artifacts.map((artifact) => (
						<div key={artifact.artifactId} className="artifact-row">
							<FileCheck2 size={17} />
							<span>{artifact.mediaType}</span>
							<small>{formatBytes(artifact.size)}</small>
						</div>
					))}
				</div>
			)}
		</aside>
	);
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function TaskDetailPage(): React.JSX.Element {
	const params = useParams({
		from: "/workspaces/$projectId/domains/$controlDomainId/tasks/$runId",
	});
	const {
		client,
		csrfToken,
		liveState,
		message,
		mode,
		refreshStampFor,
		setMode,
		t,
	} = useApp();
	const queryClient = useQueryClient();
	const detail = useQuery({
		queryKey: ["run", params.projectId, params.controlDomainId, params.runId],
		queryFn: ({ signal }) =>
			client.runDetail(
				{ params, query: {}, body: {} },
				{ signal },
			),
		structuralSharing: false,
	});
	const [tab, setTab] = useState<ProTaskTab>(initialProTaskTab);
	const [focusProTabs, setFocusProTabs] = useState(false);
	const proTabsRef = useRef<HTMLDivElement>(null);
	const runResource: WebAuthoritativeResourceIdentity | undefined = detail.data
		? {
				type: "run",
				projectId: detail.data.run.projectId,
				controlDomainId: detail.data.run.controlDomainId,
				runId: detail.data.run.runId,
			}
		: undefined;
	const actionsAllowed =
		detail.data && runResource
			? stateSensitiveActionsAllowed(
					detail.data.sourceObservation,
					runResource,
					liveState,
					refreshStampFor(runResource, detail.data),
					csrfToken !== undefined,
				)
			: false;
	const cancelAction = detail.data && actionsAllowed
		? availableAction(detail.data.availableActions, "cancel-run")
		: undefined;
	const command = useDurableCommand({
		client,
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["run"] });
			await queryClient.invalidateQueries({ queryKey: ["runs"] });
		},
	});
	const selectTab = (key: Key) => {
		const next = String(key);
		if (!isProTaskTab(next)) return;
		setTab(next);
		const url = new URL(window.location.href);
		if (next === "summary") url.searchParams.delete("tab");
		else url.searchParams.set("tab", next);
		window.history.replaceState(window.history.state, "", url.pathname + url.search);
	};
	useEffect(() => {
		if (mode !== "pro" || !focusProTabs) return;
		const frame = window.requestAnimationFrame(() => {
			const selectedTab = proTabsRef.current?.querySelector<HTMLElement>(
				'[role="tab"][tabindex="0"]',
			);
			selectedTab?.focus();
			setFocusProTabs(false);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [focusProTabs, mode]);
	useEffect(() => {
		const run = detail.data?.run;
		if (!run) return;
		let paintedFrame = 0;
		const committedFrame = window.requestAnimationFrame(() => {
			paintedFrame = window.requestAnimationFrame(() => {
				performance.mark(
					"taskflow:run-detail-visible",
					{
						detail: {
							runVersion:
								run.runVersion,
							status: run.status,
						},
					},
				);
			});
		});
		return () => {
			window.cancelAnimationFrame(
				committedFrame,
			);
			if (paintedFrame !== 0) {
				window.cancelAnimationFrame(
					paintedFrame,
				);
			}
		};
	}, [
		detail.data?.run.runVersion,
		detail.data?.run.status,
	]);

	return (
		<div className="page task-page">
			<QueryState isPending={detail.isPending} error={detail.error}>
				{detail.data ? (
					<>
						<Link
							to="/workspaces/$projectId/domains/$controlDomainId"
							params={{
								projectId: params.projectId,
								controlDomainId: params.controlDomainId,
							}}
							className="back-link"
						>
							<ArrowLeft size={15} />
							{detail.data.workspaceDisplayName}
						</Link>
						<PageHeader
							eyebrow={detail.data.workspaceDisplayName}
							title={detail.data.displayTitle}
							description={message(detail.data.presentation.headline)}
							actions={
								cancelAction ? (
									<Button
										className="secondary-button"
										isDisabled={command.isPending}
										onPress={() =>
											void command.execute(
												cancelAction.requestBase,
											)
										}
									>
										{command.isPending ? (
											<LoaderCircle className="spin" size={15} />
										) : (
											<X size={15} />
										)}
										{t("action.stop-task")}
									</Button>
								) : undefined
							}
						/>
						<StatusStrip
							observation={detail.data.sourceObservation}
							response={detail.data}
							resource={runResource}
						/>
						<div className="task-story-grid">
							<div className="task-story">
								<section className="hero-status">
									<span className={`state-icon state-${detail.data.run.status}`}>
										<TaskStateIcon status={detail.data.run.status} />
									</span>
									<div>
										<h2>{message(detail.data.presentation.headline)}</h2>
										<p>{message(detail.data.presentation.detail)}</p>
									</div>
								</section>
								{detail.data.presentation.decisionSet?.status === "actionable" ? (
									<DecisionCard
										detail={detail.data}
										execute={command.execute}
										isPending={command.isPending}
									/>
								) : null}
								<section className="section-block steps-section">
									<div className="section-heading">
										<h2>{t("section.steps")}</h2>
										<span>
											{formatProgress(detail.data.presentation.progress, t)}
										</span>
									</div>
									<ol className="step-list">
										{detail.data.presentation.stepGroups.map((step) => (
											<li key={step.groupId} className={`step-${step.state}`}>
												<span className="step-marker">
													{step.state === "completed" ? (
														<Check size={13} />
													) : step.state === "running" ? (
														<LoaderCircle className="spin" size={13} />
													) : (
														<Circle size={11} />
													)}
												</span>
												<div>
													<strong>{step.label}</strong>
													<small>{t(stepStateKey(step.state))}</small>
												</div>
											</li>
										))}
									</ol>
								</section>
								<section
									className={`verification-card verification-${detail.data.presentation.verification.state}`}
								>
									<ShieldCheck size={19} />
									<div>
										<h2>
											{message(detail.data.presentation.verification.label)}
										</h2>
										<p>
											{message(detail.data.presentation.verification.detail)}
										</p>
									</div>
								</section>
								{mode === "pro" ? (
									<Tabs
										ref={proTabsRef}
										className="pro-task-tabs"
										selectedKey={tab}
										onSelectionChange={selectTab}
									>
										<TabList
											className="pro-tabs"
											aria-label={t("section.task-details")}
										>
											{PRO_TASK_TABS.map(([value, labelKey]) => (
												<Tab
													key={value}
													id={value}
													className={({ isSelected }) =>
														`tab-button ${isSelected ? "is-active" : ""}`
													}
												>
													{t(labelKey)}
												</Tab>
											))}
										</TabList>
										{PRO_TASK_TABS.map(([value]) => (
											<TabPanel
												key={value}
												id={value}
												className={`pro-tab-panel ${
													value === "summary" ? "pro-tab-panel-summary" : ""
												}`}
											>
												{value === "summary" ? (
													<span className="sr-only">
														{t("section.task-details")}
													</span>
												) : (
													<Suspense
														fallback={
															<div className="loading-block">
																<LoaderCircle className="spin" size={18} />
															</div>
														}
													>
														<ProTaskPanels
															detail={detail.data}
															tab={value}
														/>
													</Suspense>
												)}
											</TabPanel>
										))}
									</Tabs>
								) : (
									<Button
										className="text-button"
										onPress={() => {
											setFocusProTabs(true);
											setMode("pro");
										}}
									>
										{t("action.show-pro")}
										<ChevronRight size={15} />
									</Button>
								)}
								<CommandRecoveryPanel
									state={command.state}
									checkAgain={command.checkAgain}
									retrySame={command.retrySame}
									dismiss={command.dismiss}
								/>
							</div>
							<ResultPanel detail={detail.data} />
						</div>
					</>
				) : null}
			</QueryState>
		</div>
	);
}

function DecisionCard({
	detail,
	execute,
	isPending,
}: {
	readonly detail: WebRunDetail;
	readonly execute: (
		request: WebCommandRequestBase,
	) => Promise<void>;
	readonly isPending: boolean;
}): React.JSX.Element | null {
	const {
		csrfToken,
		liveState,
		message,
		refreshStampFor,
		t,
	} = useApp();
	const resource: WebAuthoritativeResourceIdentity = {
		type: "run",
		projectId: detail.run.projectId,
		controlDomainId: detail.run.controlDomainId,
		runId: detail.run.runId,
	};
	const actionsAllowed = stateSensitiveActionsAllowed(
		detail.sourceObservation,
		resource,
		liveState,
		refreshStampFor(resource, detail),
		csrfToken !== undefined,
	);
	const decision = detail.presentation.decisionSet;
	if (!decision || decision.status !== "actionable") return null;
	return (
		<section className="decision-card">
			<p className="eyebrow">{t("section.required-input")}</p>
			<h2>{message(decision.presentation.question)}</h2>
			<p>{message(decision.presentation.impact)}</p>
			{decision.presentation.quotedContext ? (
				<blockquote>{decision.presentation.quotedContext}</blockquote>
			) : null}
			<div className="decision-actions">
				{decision.presentation.choices.map((choice) => (
					<Button
						key={choice.kind}
						className={
							choice.kind === "approve"
								? "decision-button allow"
								: "decision-button deny"
						}
						isDisabled={!actionsAllowed || isPending}
						onPress={() => {
							if (!actionsAllowed) return;
							const action =
								choice.kind === "approve"
									? availableAction(
											detail.availableActions,
											"approve",
										)
									: availableAction(
											detail.availableActions,
											"reject",
										);
							if (!action) return;
							void execute(action.requestBase);
						}}
					>
						<strong>{message(choice.label)}</strong>
						<span>{message(choice.consequence)}</span>
					</Button>
				))}
			</div>
		</section>
	);
}

function ApprovalDetailPage(): React.JSX.Element {
	const params = useParams({
		from: "/workspaces/$projectId/domains/$controlDomainId/tasks/$runId/input/$approvalRequestId",
	});
	const {
		client,
		csrfToken,
		liveState,
		message,
		mode,
		refreshStampFor,
		t,
	} = useApp();
	const queryClient = useQueryClient();
	const approval = useQuery({
		queryKey: ["approval", ...Object.values(params)],
		queryFn: ({ signal }) =>
			client.approvalDetail(
				{ params, query: {}, body: {} },
				{ signal },
			),
		structuralSharing: false,
	});
	const command = useDurableCommand({
		client,
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["approval"] });
			await queryClient.invalidateQueries({ queryKey: ["approvals"] });
		},
	});
	const approvalResource: WebAuthoritativeResourceIdentity | undefined =
		approval.data
			? {
					type: "approval",
					projectId: approval.data.summary.projectId,
					controlDomainId: approval.data.summary.controlDomainId,
					runId: approval.data.summary.runId,
					approvalRequestId:
						approval.data.summary.approvalRequestId,
				}
			: undefined;
	const actionsAllowed =
		approval.data && approvalResource
			? stateSensitiveActionsAllowed(
					approval.data.sourceObservation,
					approvalResource,
					liveState,
					refreshStampFor(approvalResource, approval.data),
					csrfToken !== undefined,
				)
			: false;
	return (
		<div className="page narrow-page">
			<QueryState isPending={approval.isPending} error={approval.error}>
				{approval.data ? (
					<>
						<PageHeader
							eyebrow={t("nav.needs-input")}
							title={
								approval.data.decisionPresentation
									? message(approval.data.decisionPresentation.question)
									: approval.data.summary.message
							}
							description={
								approval.data.decisionPresentation
									? message(approval.data.decisionPresentation.impact)
									: t("description.approval-status-only")
							}
						/>
						<StatusStrip
							observation={approval.data.sourceObservation}
							response={approval.data}
							resource={approvalResource}
						/>
						{approval.data.decisionPresentation ? (
							<section className="decision-card standalone">
								{approval.data.decisionPresentation.quotedContext ? (
									<blockquote>
										{approval.data.decisionPresentation.quotedContext}
									</blockquote>
								) : null}
								<div className="decision-actions">
									{approval.data.decisionPresentation.choices.map((choice) => {
										const action = approval.data && actionsAllowed
											? choice.kind === "approve"
												? availableAction(
														approval.data.availableActions,
														"approve",
													)
												: availableAction(
														approval.data.availableActions,
														"reject",
													)
											: undefined;
										return (
											<Button
												key={choice.kind}
												className={`decision-button ${choice.kind === "approve" ? "allow" : "deny"}`}
												isDisabled={!action || command.isPending}
												onPress={() => {
													if (action) {
														void command.execute(
															action.requestBase,
														);
													}
												}}
											>
												<strong>{message(choice.label)}</strong>
												<span>{message(choice.consequence)}</span>
											</Button>
										);
									})}
								</div>
							</section>
						) : null}
						<CommandRecoveryPanel
							state={command.state}
							checkAgain={command.checkAgain}
							retrySame={command.retrySame}
							dismiss={command.dismiss}
						/>
						{mode === "pro" ? (
							<section className="technical-card">
								<h2>{t("section.pro.technical")}</h2>
								<dl>
									<dt>{t("pro.field.approval-version")}</dt>
									<dd>{approval.data.approvalVersion}</dd>
									<dt>{t("pro.field.race-state")}</dt>
									<dd>{approval.data.decisionRaceState}</dd>
									<dt>{t("pro.field.dispatcher-handoff")}</dt>
									<dd>{approval.data.dispatcherHandoff}</dd>
									<dt>{t("pro.field.bound-plan")}</dt>
									<dd>{approval.data.boundPlanHash}</dd>
								</dl>
							</section>
						) : null}
					</>
				) : null}
			</QueryState>
		</div>
	);
}

function PolicyPage(): React.JSX.Element {
	const { client, mode, setMode, t } = useApp();
	const policy = useQuery({
		queryKey: ["policy"],
		queryFn: () =>
			client.policyExplanation({ params: {}, query: {}, body: {} }),
		enabled: mode === "pro",
	});
	if (mode !== "pro") {
		return <ProInvitation title={t("nav.pro.policy")} onOpen={() => setMode("pro")} />;
	}
	return (
		<div className="page">
			<PageHeader
				title={t("nav.pro.policy")}
				description={t("description.policy")}
			/>
			<QueryState isPending={policy.isPending} error={policy.error}>
				<section className="section-block">
					{policy.data?.decisions.map((decision, index) => (
						<div className="policy-row" key={`${decision.capability}-${index}`}>
							<span className={`policy-operation ${decision.operation}`}>
								{decision.operation}
							</span>
							<div>
								<strong>{decision.capability}</strong>
								<p>{decision.reason}</p>
							</div>
						</div>
					))}
				</section>
			</QueryState>
		</div>
	);
}

function DiagnosticsPage(): React.JSX.Element {
	const { client, message, mode, setMode, t } = useApp();
	const attention = useQuery({
		queryKey: ["diagnostics"],
		queryFn: () =>
			client.attention({ params: {}, query: { limit: 200 }, body: {} }),
		enabled: mode === "pro",
	});
	if (mode !== "pro") {
		return (
			<ProInvitation
				title={t("nav.pro.diagnostics")}
				onOpen={() => setMode("pro")}
			/>
		);
	}
	return (
		<div className="page">
			<PageHeader
				title={t("nav.pro.diagnostics")}
				description={t("description.diagnostics")}
			/>
			<QueryState isPending={attention.isPending} error={attention.error}>
				<section className="section-block">
					{attention.data?.items.map((item) => (
						<div className="attention-row" key={item.attentionId}>
							<AlertTriangle size={17} />
							<div>
								<strong>{message(item.message)}</strong>
								<small>
									{item.kind} · {item.disposition}
								</small>
							</div>
						</div>
					))}
				</section>
			</QueryState>
		</div>
	);
}

function ProInvitation({
	title,
	onOpen,
}: {
	readonly title: string;
	readonly onOpen: () => void;
}): React.JSX.Element {
	const { t } = useApp();
	useDocumentTitle(title);
	return (
		<div className="page narrow-page">
			<section className="pro-invitation">
				<Sparkles size={23} />
				<h1>{title}</h1>
				<p>{t("mode.pro.description")}</p>
				<Button className="primary-button" onPress={onOpen}>
					{t("action.show-pro")}
				</Button>
			</section>
		</div>
	);
}

function SessionTerminationDialog({
	action,
	error,
	isDisabled,
	isPending,
	onConfirm,
	onOpen,
	onRetry,
}: {
	readonly action: "current" | "all";
	readonly error: unknown;
	readonly isDisabled: boolean;
	readonly isPending: boolean;
	readonly onConfirm: () => void;
	readonly onOpen: () => void;
	readonly onRetry: () => void;
}): React.JSX.Element {
	const { t } = useApp();
	const allSessions = action === "all";
	return (
		<DialogTrigger>
			<Button
				className={allSessions ? "danger-button" : "secondary-button"}
				isDisabled={isDisabled}
				onPress={onOpen}
			>
				{t(allSessions ? "action.end-all-sessions" : "action.end-session")}
			</Button>
			<ModalOverlay
				className="modal-overlay"
				isDismissable={!isPending}
				isKeyboardDismissDisabled={isPending}
			>
				<Modal className="modal-shell">
					<Dialog
						className="decision-card standalone session-dialog"
						role="alertdialog"
						aria-labelledby={`session-dialog-title-${action}`}
					>
						{({ close }) => (
							<>
								<h2 id={`session-dialog-title-${action}`}>
									{t(
										allSessions
											? "settings.session.end-all-question"
											: "settings.session.end-question",
									)}
								</h2>
								<p>
									{t(
										allSessions
											? "settings.session.end-all-impact"
											: "settings.session.end-impact",
									)}
								</p>
								<div className="header-actions">
									<Button
										className="secondary-button"
										isDisabled={isPending}
										onPress={close}
									>
										{t("action.keep-session")}
									</Button>
									<Button
										className="danger-button"
										isDisabled={isPending}
										onPress={onConfirm}
									>
										{isPending ? (
											<LoaderCircle className="spin" size={15} />
										) : null}
										{t(
											allSessions
												? "action.end-all-sessions"
												: "action.end-session",
										)}
									</Button>
								</div>
								{error ? (
									<ErrorPanel
										error={error}
										surface="command-submit"
										onRetry={onRetry}
									/>
								) : null}
							</>
						)}
					</Dialog>
				</Modal>
			</ModalOverlay>
		</DialogTrigger>
	);
}

function SettingsPage(): React.JSX.Element {
	const {
		beginSessionTermination,
		boot,
		cancelSessionTermination,
		client,
		csrfToken,
		endSession,
		locale,
		mode,
		setLocale,
		setTheme,
		t,
		theme,
	} = useApp();
	const sessionMutation = useMutation({
		mutationFn: async (action: "current" | "all") => {
			if (!csrfToken) {
				throw new Error("session authorization is unavailable");
			}
			beginSessionTermination(action);
			try {
				if (action === "all") {
					return await client.sessionsRevokeAll({
						params: {},
						query: {},
						body: { csrfToken },
					});
				}
				return await client.sessionLogout({
					params: {},
					query: {},
					body: { csrfToken },
				});
			} catch (error) {
				cancelSessionTermination(action);
				throw error;
			}
		},
		onSuccess: (_response, action) => {
			endSession(action);
		},
	});
	return (
		<div className="page narrow-page">
			<PageHeader title={t("nav.settings")} />
			<section className="settings-section">
				<div className="settings-row">
					<div>
						<h2>{t("settings.mode.label")}</h2>
						<p>
							{t(
								mode === "pro"
									? "mode.pro.description"
									: "mode.simple.description",
							)}
						</p>
					</div>
					<DisplayModeSwitch />
				</div>
				<div className="settings-row">
					<div>
						<h2>
							<Languages size={17} />
							{t("settings.language.label")}
						</h2>
						<p>{t("description.settings-language")}</p>
					</div>
					<ToggleButtonGroup
						className="segmented-control"
						aria-label={t("settings.language.label")}
						selectionMode="single"
						disallowEmptySelection
						selectedKeys={[locale]}
						onSelectionChange={(keys) => {
							const next = [...keys][0];
							if (next === "en" || next === "zh-CN") {
								setLocale(next);
							}
						}}
					>
						<ToggleButton
							id="en"
							className={({ isSelected }) =>
								isSelected ? "is-selected" : ""
							}
						>
							{t("settings.language.en")}
						</ToggleButton>
						<ToggleButton
							id="zh-CN"
							className={({ isSelected }) =>
								isSelected ? "is-selected" : ""
							}
						>
							{t("settings.language.zh-cn")}
						</ToggleButton>
					</ToggleButtonGroup>
				</div>
				<div className="settings-row">
					<div>
						<h2>{t("settings.theme.label")}</h2>
						<p>{t("description.settings-theme")}</p>
					</div>
					<ToggleButtonGroup
						className="segmented-control icon-segments"
						aria-label={t("settings.theme.label")}
						selectionMode="single"
						disallowEmptySelection
						selectedKeys={[theme]}
						onSelectionChange={(keys) => {
							const next = [...keys][0];
							if (
								next === "system" ||
								next === "light" ||
								next === "dark"
							) {
								setTheme(next);
							}
						}}
					>
						{(
							[
								["system", Clock3, "settings.theme.system"],
								["light", Sun, "settings.theme.light"],
								["dark", Moon, "settings.theme.dark"],
							] as const
						).map(([value, Icon, key]) => (
							<ToggleButton
								key={value}
								id={value}
								className={({ isSelected }) =>
									isSelected ? "is-selected" : ""
								}
							>
								<Icon size={15} />
								{t(key)}
							</ToggleButton>
						))}
					</ToggleButtonGroup>
				</div>
				<div className="settings-row">
					<div>
						<h2>{t("section.session")}</h2>
						<p>{t("settings.session.description")}</p>
					</div>
					<div className="header-actions">
						<SessionTerminationDialog
							action="current"
							error={sessionMutation.error}
							isDisabled={!csrfToken || sessionMutation.isPending}
							isPending={sessionMutation.isPending}
							onOpen={sessionMutation.reset}
							onConfirm={() => sessionMutation.mutate("current")}
							onRetry={() => sessionMutation.mutate("current")}
						/>
						<SessionTerminationDialog
							action="all"
							error={sessionMutation.error}
							isDisabled={!csrfToken || sessionMutation.isPending}
							isPending={sessionMutation.isPending}
							onOpen={sessionMutation.reset}
							onConfirm={() => sessionMutation.mutate("all")}
							onRetry={() => sessionMutation.mutate("all")}
						/>
					</div>
				</div>
			</section>
			{boot.status === "ready" ? (
				<section className="technical-card about-card">
					<h2>{t("section.about")}</h2>
					<dl>
						<dt>{t("pro.field.version")}</dt>
						<dd>{boot.bootstrap.buildInfo.packageVersion}</dd>
						<dt>{t("pro.field.browser-protocol")}</dt>
						<dd>
							{boot.bootstrap.browserProtocolMajor}.
							{boot.bootstrap.browserProtocolMinor}
						</dd>
						<dt>{t("pro.field.session")}</dt>
						<dd>
							{t("settings.session-expires", {
								expiresAt: boot.bootstrap.sessionIdleExpiresAt,
							})}
						</dd>
					</dl>
				</section>
			) : null}
		</div>
	);
}

const rootRoute = createRootRoute({ component: AppShell });
const homeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.home,
	component: HomePage,
});
const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.tasks,
	component: TasksPage,
});
const needsInputRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.needsInput,
	component: NeedsInputPage,
});
const workspacesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.workspaces,
	component: WorkspacesPage,
});
const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.workspace,
	component: WorkspacePage,
});
const taskRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.task,
	component: TaskDetailPage,
});
const approvalRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.approval,
	component: ApprovalDetailPage,
});
const policyRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.policy,
	component: PolicyPage,
});
const diagnosticsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.diagnostics,
	component: DiagnosticsPage,
});
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: WEB_APP_ROUTE_PATHS.settings,
	component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
	homeRoute,
	tasksRoute,
	needsInputRoute,
	workspacesRoute,
	workspaceRoute,
	taskRoute,
	approvalRoute,
	policyRoute,
	diagnosticsRoute,
	settingsRoute,
]);

export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
