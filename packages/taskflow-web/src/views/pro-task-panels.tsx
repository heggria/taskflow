import {
	useInfiniteQuery,
	useMutation,
	useQuery,
} from "@tanstack/react-query";
import {
	AlertTriangle,
	Download,
	FileCheck2,
	GitBranch,
	History,
	LoaderCircle,
	Minus,
	Play,
	Plus,
	RotateCcw,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
	Button,
	Disclosure,
	DisclosurePanel,
	ListBox,
	ListBoxItem,
} from "react-aria-components";
import type {
	WebGeneratedClient,
	WebRunDetail,
} from "taskflow-control/web-protocol";
import { useApp } from "../app-context.tsx";
import {
	collectWebReceiptExport,
	serializeWebReceiptExport,
	webReceiptExportFileName,
} from "../receipt-export.ts";

type GraphPosition = { readonly x: number; readonly y: number };
type ArtifactRef = WebRunDetail["artifacts"][number];
type RunParams = {
	readonly projectId: string;
	readonly controlDomainId: string;
	readonly runId: string;
};

function runParams(detail: WebRunDetail): RunParams {
	return {
		projectId: detail.run.projectId,
		controlDomainId: detail.run.controlDomainId,
		runId: detail.run.runId,
	};
}

function nodePosition(index: number): GraphPosition {
	return {
		x: 35 + (index % 3) * 250,
		y: 35 + Math.floor(index / 3) * 120,
	};
}

function PanelState({
	children,
	error,
	pending,
}: {
	readonly children: ReactNode;
	readonly error: unknown;
	readonly pending: boolean;
}): React.JSX.Element {
	const { t } = useApp();
	if (pending) {
		return (
			<div className="loading-block" aria-busy="true">
				<LoaderCircle className="spin" size={18} />
				<span>{t("app.opening-workspace")}</span>
			</div>
		);
	}
	if (error) {
		return (
			<div className="error-panel" role="alert">
				<AlertTriangle size={18} />
				<div>
					<strong>{t("error.fallback-headline")}</strong>
					<p>{t("error.fallback-detail")}</p>
				</div>
			</div>
		);
	}
	return <>{children}</>;
}

function LoadMore({
	disabled,
	onPress,
	pending,
}: {
	readonly disabled: boolean;
	readonly onPress: () => void;
	readonly pending: boolean;
}): React.JSX.Element {
	const { t } = useApp();
	return (
		<Button
			className="secondary-button"
			isDisabled={disabled || pending}
			onPress={onPress}
		>
			{pending ? <LoaderCircle className="spin" size={15} /> : null}
			{t("action.load-more")}
		</Button>
	);
}

function GraphPanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { client, t } = useApp();
	const params = runParams(detail);
	const graph = useInfiniteQuery({
		queryKey: [
			"run-graph",
			params.projectId,
			params.controlDomainId,
			params.runId,
			detail.run.runVersion,
		],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.runGraph({
				params,
				query: {
					expectedRunVersion: detail.run.runVersion,
					limit: 200,
					cursor: pageParam,
				},
				body: {},
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	const nodes = useMemo(() => {
		const unique = new Map<
			string,
			Awaited<
				ReturnType<WebGeneratedClient["runGraph"]>
			>["nodes"][number]
		>();
		for (const page of graph.data?.pages ?? []) {
			for (const node of page.nodes) unique.set(node.nodeInstanceId, node);
		}
		return [...unique.values()];
	}, [graph.data]);
	const edges = useMemo(() => {
		const unique = new Map<
			string,
			Awaited<
				ReturnType<WebGeneratedClient["runGraph"]>
			>["edges"][number]
		>();
		for (const page of graph.data?.pages ?? []) {
			for (const edge of page.edges) {
				unique.set(
					`${edge.fromNodeInstanceId}\u0000${edge.toNodeInstanceId}\u0000${edge.kind}`,
					edge,
				);
			}
		}
		return [...unique.values()];
	}, [graph.data]);
	const [selectedId, setSelectedId] = useState<string>();
	const [zoom, setZoom] = useState(1);
	const effectiveSelectedId = selectedId ?? nodes[0]?.nodeInstanceId;
	const positions = useMemo(
		() =>
			new Map(
				nodes.map((node, index) => [
					node.nodeInstanceId,
					nodePosition(index),
				]),
			),
		[nodes],
	);
	const selected = nodes.find(
		(node) => node.nodeInstanceId === effectiveSelectedId,
	);
	const nodeDetail = useQuery({
		queryKey: [
			"node-detail",
			params.projectId,
			params.controlDomainId,
			params.runId,
			effectiveSelectedId,
			detail.run.runVersion,
		],
		enabled: effectiveSelectedId !== undefined,
		queryFn: () => {
			if (!effectiveSelectedId) {
				throw new Error("node selection is required");
			}
			return client.nodeDetail({
				params: {
					...params,
					nodeInstanceId: effectiveSelectedId,
				},
				query: {},
				body: {},
			});
		},
	});
	const attempts = useInfiniteQuery({
		queryKey: [
			"node-attempts",
			params.projectId,
			params.controlDomainId,
			params.runId,
			effectiveSelectedId,
			detail.run.runVersion,
		],
		enabled: effectiveSelectedId !== undefined,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => {
			if (!effectiveSelectedId) {
				throw new Error("node selection is required");
			}
			return client.nodeAttempts({
				params: {
					...params,
					nodeInstanceId: effectiveSelectedId,
				},
				query: {
					expectedRunVersion: detail.run.runVersion,
					limit: 100,
					cursor: pageParam,
				},
				body: {},
			});
		},
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	const dependencies = selected
		? edges
				.filter(
					(edge) =>
						edge.toNodeInstanceId === selected.nodeInstanceId,
				)
				.map((edge) => edge.fromNodeInstanceId)
		: [];
	const rowCount = Math.max(1, Math.ceil(nodes.length / 3));
	const graphWidth = 760;
	const graphHeight = Math.max(200, 70 + rowCount * 120);

	return (
		<section className="pro-panel">
			<div className="section-heading">
				<h2>
					<GitBranch size={17} />
					{t("section.pro.graph")}
				</h2>
				<span>
					{t("pro.graph.node-count", {
						count:
							graph.data?.pages[0]?.matchedNodeCount ??
							nodes.length,
					})}
				</span>
			</div>
			<PanelState pending={graph.isPending} error={graph.error}>
				<div
					className={`flow-canvas graph-rows-${Math.min(rowCount, 3)}`}
				>
					<div className="graph-controls">
						<Button
							className="icon-button"
							aria-label={t("pro.graph.zoom-out")}
							isDisabled={zoom <= 0.6}
							onPress={() =>
								setZoom((value) =>
									Math.max(0.6, value - 0.2),
								)
							}
						>
							<Minus size={15} />
						</Button>
						<Button
							className="icon-button"
							aria-label={t("pro.graph.reset-view")}
							onPress={() => setZoom(1)}
						>
							<RotateCcw size={14} />
						</Button>
						<Button
							className="icon-button"
							aria-label={t("pro.graph.zoom-in")}
							isDisabled={zoom >= 1.4}
							onPress={() =>
								setZoom((value) =>
									Math.min(1.4, value + 0.2),
								)
							}
						>
							<Plus size={15} />
						</Button>
					</div>
					<svg
						className="graph-svg"
						viewBox={`0 0 ${graphWidth / zoom} ${graphHeight / zoom}`}
						aria-hidden="true"
						focusable="false"
					>
						<defs>
							<marker
								id="graph-arrow"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="5"
								markerHeight="5"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" />
							</marker>
						</defs>
						<g className="graph-edges">
							{edges.map((edge) => {
								const source = positions.get(
									edge.fromNodeInstanceId,
								);
								const target = positions.get(
									edge.toNodeInstanceId,
								);
								if (!source || !target) return null;
								return (
									<path
										key={`${edge.fromNodeInstanceId}-${edge.toNodeInstanceId}-${edge.kind}`}
										d={`M ${source.x + 170} ${source.y + 30} C ${source.x + 210} ${source.y + 30}, ${target.x - 40} ${target.y + 30}, ${target.x} ${target.y + 30}`}
										markerEnd="url(#graph-arrow)"
									/>
								);
							})}
						</g>
						<g className="graph-nodes">
							{nodes.map((node) => {
								const position = positions.get(
									node.nodeInstanceId,
								);
								if (!position) return null;
								return (
									<g
										key={node.nodeInstanceId}
										className={`graph-node graph-${node.status} ${effectiveSelectedId === node.nodeInstanceId ? "is-selected" : ""}`}
										transform={`translate(${position.x} ${position.y})`}
										onClick={() =>
											setSelectedId(
												node.nodeInstanceId,
											)
										}
									>
										<rect
											width="170"
											height="60"
											rx="9"
										/>
										<text x="14" y="25">
											{node.phaseId}
										</text>
										<text
											className="graph-node-status"
											x="14"
											y="44"
										>
											{node.status}
										</text>
									</g>
								);
							})}
						</g>
					</svg>
				</div>
				<Disclosure className="semantic-graph">
					<Button
						slot="trigger"
						className="semantic-graph-trigger"
					>
						{t("pro.graph.accessible-list")}
					</Button>
					<DisclosurePanel
						className="semantic-graph-list"
						role="region"
					>
						<ListBox
							aria-label={t(
								"pro.graph.read-only-label",
							)}
							className="graph-node-listbox"
							selectionMode="single"
							selectionBehavior="replace"
							selectedKeys={
								effectiveSelectedId
									? new Set([
											effectiveSelectedId,
										])
									: new Set()
							}
							onSelectionChange={(keys) => {
								if (keys === "all") return;
								const next = [...keys][0];
								if (
									typeof next === "string"
								) {
									setSelectedId(next);
								}
							}}
						>
							{nodes.map((node) => {
								const nodeDependencies = edges
									.filter(
										(edge) =>
											edge.toNodeInstanceId ===
											node.nodeInstanceId,
									)
									.map(
										(edge) =>
											edge.fromNodeInstanceId,
									);
								return (
									<ListBoxItem
										key={node.nodeInstanceId}
										id={node.nodeInstanceId}
										textValue={node.phaseId}
										className="graph-node-option"
										aria-label={t(
											"pro.graph.open-step",
											{
												phaseId:
													node.phaseId,
											},
										)}
									>
										<strong>
											{node.phaseId}
										</strong>
										<span>{node.status}</span>
										<small>
											{t(
												"pro.graph.depends-on",
											)}
											:{" "}
											{nodeDependencies.join(
												", ",
											) ||
												t(
													"pro.graph.no-dependencies",
												)}
										</small>
									</ListBoxItem>
								);
							})}
						</ListBox>
					</DisclosurePanel>
				</Disclosure>
				{graph.hasNextPage ? (
					<LoadMore
						disabled={!graph.hasNextPage}
						pending={graph.isFetchingNextPage}
						onPress={() => void graph.fetchNextPage()}
					/>
				) : null}
				{selected ? (
					<section
						className="graph-inspector"
						aria-live="polite"
					>
						<h3>{t("section.pro.node")}</h3>
						<strong>{selected.phaseId}</strong>
						<span>{selected.status}</span>
						<small>
							{t("pro.graph.depends-on")}:{" "}
							{dependencies.join(", ") ||
								t("pro.graph.no-dependencies")}
						</small>
						<PanelState
							pending={nodeDetail.isPending}
							error={nodeDetail.error}
						>
							{nodeDetail.data ? (
								<dl>
									<dt>{t("pro.field.definition")}</dt>
									<dd>
										{nodeDetail.data.definitionId}
									</dd>
									<dt>{t("pro.field.provider")}</dt>
									<dd>
										{nodeDetail.data
											.providerObservation
											.provider ??
											t(
												"pro.value.not-recorded",
											)}
									</dd>
									<dt>{t("pro.field.cache")}</dt>
									<dd>
										{
											nodeDetail.data
												.cacheExplanation
										}
									</dd>
								</dl>
							) : null}
						</PanelState>
						{attempts.data ? (
							<div className="attempt-list">
								{attempts.data.pages
									.flatMap((page) => page.items)
									.map((attempt) => (
										<div
											key={attempt.attemptId}
											className="artifact-row"
										>
											<History size={15} />
											<div>
												<strong>
													{attempt.attemptId}
												</strong>
												<small>
													{attempt.provider} ·{" "}
													{attempt.status}
												</small>
											</div>
										</div>
									))}
								{attempts.hasNextPage ? (
									<LoadMore
										disabled={
											!attempts.hasNextPage
										}
										pending={
											attempts.isFetchingNextPage
										}
										onPress={() =>
											void attempts.fetchNextPage()
										}
									/>
								) : null}
							</div>
						) : null}
					</section>
				) : null}
			</PanelState>
		</section>
	);
}

function TimelinePanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { client, t } = useApp();
	const params = runParams(detail);
	const timeline = useInfiniteQuery({
		queryKey: [
			"run-timeline",
			params.projectId,
			params.controlDomainId,
			params.runId,
			detail.run.runVersion,
		],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.runTimeline({
				params,
				query: {
					expectedRunVersion: detail.run.runVersion,
					limit: 100,
					cursor: pageParam,
				},
				body: {},
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	return (
		<section className="pro-panel">
			<div className="section-heading">
				<h2>
					<History size={17} />
					{t("section.pro.timeline")}
				</h2>
			</div>
			<PanelState
				pending={timeline.isPending}
				error={timeline.error}
			>
				<ol className="timeline-list">
					{timeline.data?.pages
						.flatMap((page) => page.items)
						.map((event) => (
							<li key={event.eventId}>
								<time>
									{new Intl.DateTimeFormat(
										undefined,
										{
											dateStyle: "medium",
											timeStyle: "medium",
										},
									).format(event.recordedAt)}
								</time>
								<strong>{event.kind}</strong>
								<p>{event.summary}</p>
								<small>
									{t("pro.timeline.commit", {
										commitSeq:
											event.commitSeq,
									})}
								</small>
							</li>
						))}
				</ol>
				{timeline.hasNextPage ? (
					<LoadMore
						disabled={!timeline.hasNextPage}
						pending={timeline.isFetchingNextPage}
						onPress={() =>
							void timeline.fetchNextPage()
						}
					/>
				) : null}
			</PanelState>
		</section>
	);
}

function EvidencePanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { client, message, t } = useApp();
	const params = runParams(detail);
	const artifacts = useInfiniteQuery({
		queryKey: [
			"run-artifacts",
			params.projectId,
			params.controlDomainId,
			params.runId,
			detail.run.runVersion,
			detail.receipt?.receiptId,
		],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.runArtifacts({
				params,
				query: {
					expectedRunVersion: detail.run.runVersion,
					expectedReceiptId: detail.receipt?.receiptId,
					limit: 100,
					cursor: pageParam,
				},
				body: {},
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	const receipt = useInfiniteQuery({
		queryKey: [
			"run-receipt",
			params.projectId,
			params.controlDomainId,
			params.runId,
			detail.run.runVersion,
			detail.receipt?.receiptId,
		],
		enabled: detail.receipt !== undefined,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) => {
			if (!detail.receipt) {
				throw new Error("receipt is required");
			}
			return client.runReceipt({
				params,
				query: {
					expectedRunVersion: detail.run.runVersion,
					expectedReceiptId:
						detail.receipt.receiptId,
					limit: 100,
					cursor: pageParam,
				},
				body: {},
			});
		},
		getNextPageParam: (lastPage) =>
			lastPage.eventManifest.nextCursor,
	});
	const verification =
		receipt.data?.pages[0]?.verification ??
		detail.presentation.verification;
	const download = useMutation({
		mutationFn: async (artifact: ArtifactRef) => {
			const result = await client.artifact({
				params: {
					projectId: params.projectId,
					controlDomainId: params.controlDomainId,
					digest: artifact.digest,
				},
				query: {},
				body: {},
			});
			const bytes = new Uint8Array(result.body);
			const blob = new Blob([bytes], {
				type: result.metadata.mediaType,
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download =
				result.metadata.fileName ?? artifact.artifactId;
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		},
	});
	const receiptExport = useMutation({
		mutationFn: async () => {
			const receiptId = detail.receipt?.receiptId;
			if (!receiptId) {
				throw new Error("Receipt is unavailable");
			}
			const exportDocument = await collectWebReceiptExport({
				client,
				params,
				expectedRunVersion: detail.run.runVersion,
				expectedReceiptId: receiptId,
			});
			const blob = new Blob(
				[serializeWebReceiptExport(exportDocument)],
				{ type: "application/json" },
			);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download =
				webReceiptExportFileName(receiptId);
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		},
	});
	const whyStaleTargets = detail.nodes
		.slice(0, 200)
		.map((node) => node.nodeInstanceId);
	const whyStale = useQuery({
		queryKey: [
			"run-why-stale",
			params.projectId,
			params.controlDomainId,
			params.runId,
			...whyStaleTargets,
		],
		enabled: whyStaleTargets.length > 0,
		queryFn: () =>
			client.runWhyStale({
				params,
				query: { targetIds: whyStaleTargets },
				body: {},
			}),
	});
	return (
		<section className="pro-panel">
			<div className="section-heading">
				<h2>
					<FileCheck2 size={17} />
					{t("section.pro.evidence")}
				</h2>
			</div>
			<div className="evidence-summary">
				<strong>{message(verification.label)}</strong>
				<p>{message(verification.detail)}</p>
			</div>
			<dl className="check-grid">
				<dt>{t("pro.field.event-manifest")}</dt>
				<dd>{verification.eventManifest}</dd>
				<dt>{t("pro.field.journal-continuity")}</dt>
				<dd>{verification.journalContinuity}</dd>
				<dt>{t("pro.field.provenance")}</dt>
				<dd>{verification.provenance}</dd>
				<dt>{t("pro.field.artifact-integrity")}</dt>
				<dd>{verification.artifactIntegrity}</dd>
				<dt>{t("pro.field.provider-consistency")}</dt>
				<dd>{verification.providerConsistency.check}</dd>
			</dl>
			{receipt.data?.pages[0] ? (
				<section className="technical-card">
					<h3>{t("evidence.immutable-record")}</h3>
					<dl>
						<dt>{t("pro.field.receipt")}</dt>
						<dd>
							{
								receipt.data.pages[0].receipt
									.receiptId
							}
						</dd>
						<dt>{t("pro.field.commit-seq")}</dt>
						<dd>
							{
								receipt.data.pages[0].receipt
									.endCommitSeq
							}
						</dd>
					</dl>
					<div className="receipt-export">
						<div>
							<h4>
								{t(
									"evidence.export-check-title",
								)}
							</h4>
							<p>
								{t(
									"evidence.export-check-detail",
								)}
							</p>
						</div>
						<Button
							className="secondary-button"
							isDisabled={receiptExport.isPending}
							onPress={() =>
								receiptExport.mutate()
							}
						>
							{receiptExport.isPending ? (
								<LoaderCircle
									className="spin"
									size={15}
								/>
							) : (
								<Download size={15} />
							)}
							{t("action.download-receipt-json")}
						</Button>
					</div>
					{receiptExport.isSuccess ? (
						<p
							className="receipt-export-status"
							role="status"
						>
							{t("evidence.export-downloaded")}
						</p>
					) : null}
					{receiptExport.error ? (
						<div className="error-panel" role="alert">
							<AlertTriangle size={18} />
							<p>{t("evidence.export-failed")}</p>
						</div>
					) : null}
					<ol className="timeline-list">
						{receipt.data.pages
							.flatMap(
								(page) =>
									page.eventManifest.items,
							)
							.map((entry) => (
								<li key={entry.eventId}>
									<strong>
										{entry.eventKind}
									</strong>
									<small>{entry.eventId}</small>
								</li>
							))}
					</ol>
					{receipt.hasNextPage ? (
						<LoadMore
							disabled={!receipt.hasNextPage}
							pending={
								receipt.isFetchingNextPage
							}
							onPress={() =>
								void receipt.fetchNextPage()
							}
						/>
					) : null}
				</section>
			) : null}
			<PanelState
				pending={artifacts.isPending}
				error={artifacts.error}
			>
				<div className="artifact-list">
					{artifacts.data?.pages
						.flatMap((page) => page.items)
						.map((artifact) => (
							<div
								className="artifact-row"
								key={artifact.artifactId}
							>
								<FileCheck2 size={17} />
								<div>
									<strong>{artifact.role}</strong>
									<small>
										{artifact.mediaType} ·{" "}
										{artifact.integrity}
									</small>
								</div>
								<code>
									{artifact.digest.slice(0, 22)}…
								</code>
								<Button
									className="icon-button"
									aria-label={t(
										"action.download-artifact",
										{
											artifactId:
												artifact.artifactId,
										},
									)}
									isDisabled={download.isPending}
									onPress={() =>
										download.mutate(artifact)
									}
								>
									<Download size={15} />
								</Button>
							</div>
						))}
				</div>
				{artifacts.hasNextPage ? (
					<LoadMore
						disabled={!artifacts.hasNextPage}
						pending={artifacts.isFetchingNextPage}
						onPress={() =>
							void artifacts.fetchNextPage()
						}
					/>
				) : null}
				{download.error ? (
					<div className="error-panel" role="alert">
						<AlertTriangle size={18} />
						<p>{t("error.fallback-detail")}</p>
					</div>
				) : null}
			</PanelState>
			{whyStale.data ? (
				<section className="technical-card">
					<h3>{t("section.pro.why-stale")}</h3>
					<ul>
						{whyStale.data.targets.map((target) => (
							<li key={target.targetId}>
								<strong>{target.targetId}</strong>
								<span>{target.reuseDecision}</span>
								{target.unavailableReason ? (
									<small>
										{target.unavailableReason}
									</small>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</section>
	);
}

function ReplayPanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { client, t } = useApp();
	const params = runParams(detail);
	const traceDigest = detail.replay.traceArtifact?.digest;
	const replay = useMutation({
		mutationFn: () => {
			if (!traceDigest) {
				throw new Error("trace artifact is unavailable");
			}
			return client.runReplay({
				params,
				query: {},
				body: {
					traceArtifactDigest: traceDigest,
					overrides: [],
				},
			});
		},
	});
	return (
		<section className="pro-panel">
			<div className="section-heading">
				<h2>
					<RotateCcw size={17} />
					{t("section.pro.replay")}
				</h2>
			</div>
			<div className="replay-note">
				<strong>
					{detail.replay.replayable
						? t("pro.replay.available")
						: t("pro.replay.unavailable")}
				</strong>
				{detail.replay.unreplayableReasons.map((reason) => (
					<p key={reason}>{reason}</p>
				))}
				<small>{t("pro.replay-zero-write")}</small>
			</div>
			{detail.replay.replayable && traceDigest ? (
				<Button
					className="primary-button"
					isDisabled={replay.isPending}
					onPress={() => replay.mutate()}
				>
					{replay.isPending ? (
						<LoaderCircle className="spin" size={15} />
					) : (
						<Play size={15} />
					)}
					{t("action.run-replay")}
				</Button>
			) : null}
			{replay.data ? (
				<section className="technical-card">
					<h3>{t("pro.replay.result")}</h3>
					{replay.data.resultPreview ? (
						<pre>{replay.data.resultPreview}</pre>
					) : null}
					<dl>
						<dt>{t("pro.field.provider-calls")}</dt>
						<dd>{replay.data.proof.providerCalls}</dd>
						<dt>{t("pro.field.durable-writes")}</dt>
						<dd>{replay.data.proof.durableWrites}</dd>
					</dl>
					{replay.data.warnings.map((warning) => (
						<p key={warning}>{warning}</p>
					))}
				</section>
			) : null}
			{replay.error ? (
				<div className="error-panel" role="alert">
					<AlertTriangle size={18} />
					<p>{t("error.fallback-detail")}</p>
				</div>
			) : null}
		</section>
	);
}

function TechnicalPanel({
	detail,
}: {
	readonly detail: WebRunDetail;
}): React.JSX.Element {
	const { client, t } = useApp();
	const params = runParams(detail);
	const fragments = useInfiniteQuery({
		queryKey: [
			"run-fragments",
			params.projectId,
			params.controlDomainId,
			params.runId,
			detail.run.runVersion,
		],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.runFragments({
				params,
				query: {
					expectedRunVersion: detail.run.runVersion,
					limit: 100,
					cursor: pageParam,
				},
				body: {},
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
	return (
		<section className="technical-card">
			<h2>{t("section.pro.technical")}</h2>
			<dl>
				<dt>{t("pro.field.run")}</dt>
				<dd>{detail.run.runId}</dd>
				<dt>{t("pro.field.run-status")}</dt>
				<dd>{detail.run.status}</dd>
				<dt>{t("pro.field.run-stage")}</dt>
				<dd>{detail.run.stage}</dd>
				<dt>{t("pro.field.provider")}</dt>
				<dd>
					{detail.run.provider ??
						t("pro.value.not-recorded")}
				</dd>
				<dt>{t("pro.field.bound-plan")}</dt>
				<dd>{detail.boundPlan.boundPlanHash}</dd>
				<dt>{t("pro.field.commit-seq")}</dt>
				<dd>{detail.run.commitSeq}</dd>
				<dt>{t("pro.field.run-version")}</dt>
				<dd>{detail.run.runVersion}</dd>
			</dl>
			<h3>{t("section.pro.fragments")}</h3>
			<PanelState
				pending={fragments.isPending}
				error={fragments.error}
			>
				<ul>
					{fragments.data?.pages
						.flatMap((page) => page.items)
						.map((fragment) => (
							<li key={fragment.boundFragmentHash}>
								<strong>
									{fragment.originPhaseId}
								</strong>
								<small>
									{fragment.linkKind} ·{" "}
									{fragment.dynamicNodeCount}
								</small>
							</li>
						))}
				</ul>
				{fragments.hasNextPage ? (
					<LoadMore
						disabled={!fragments.hasNextPage}
						pending={fragments.isFetchingNextPage}
						onPress={() =>
							void fragments.fetchNextPage()
						}
					/>
				) : null}
			</PanelState>
		</section>
	);
}

export function ProTaskPanels({
	detail,
	tab,
}: {
	readonly detail: WebRunDetail;
	readonly tab: string;
}): React.JSX.Element | null {
	switch (tab) {
		case "graph":
			return <GraphPanel detail={detail} />;
		case "timeline":
			return <TimelinePanel detail={detail} />;
		case "evidence":
			return <EvidencePanel detail={detail} />;
		case "replay":
			return <ReplayPanel detail={detail} />;
		case "technical":
			return <TechnicalPanel detail={detail} />;
		default:
			return null;
	}
}
