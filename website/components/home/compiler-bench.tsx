"use client";

import { useMemo, useState } from "react";

const GRAPH_NODES = [
	{ id: "input", title: "Input", meta: "args / files", x: 12, y: 50 },
	{ id: "compile", title: "Compile", meta: "FlowIR build", x: 37, y: 26 },
	{
		id: "verify",
		title: "Verify",
		meta: "cycles · refs · budget",
		x: 37,
		y: 74,
	},
	{ id: "fanout", title: "Fan-out", meta: "parallel review", x: 62, y: 26 },
	{ id: "gate", title: "Gate", meta: "quality / policy", x: 62, y: 74 },
	{ id: "cache", title: "Cache", meta: "content addressed", x: 87, y: 26 },
	{ id: "final", title: "Return", meta: "finalOutput", x: 87, y: 74 },
] as const;

type GraphNode = (typeof GRAPH_NODES)[number];
type NodeId = GraphNode["id"];

const NODE_BY_ID = Object.fromEntries(
	GRAPH_NODES.map((node) => [node.id, node]),
) as Record<NodeId, GraphNode>;

const GRAPH_EDGES: ReadonlyArray<{ from: NodeId; to: NodeId }> = [
	{ from: "input", to: "compile" },
	{ from: "input", to: "verify" },
	{ from: "compile", to: "fanout" },
	{ from: "verify", to: "gate" },
	{ from: "fanout", to: "cache" },
	{ from: "gate", to: "final" },
	{ from: "cache", to: "final" },
];

type BenchMode = "verify" | "run" | "recompute";

export function CompilerBench({
	labels,
}: {
	labels: {
		eyebrow: string;
		title: string;
		sub: string;
		aria: string;
		modeVerify: string;
		modeRun: string;
		modeRecompute: string;
		graphLabel: string;
		hostLabel: string;
		hostTitle: string;
		hostBody: string;
		verifyLabel: string;
		resumeLabel: string;
		recomputeLabel: string;
		verifyRows: ReadonlyArray<{ key: string; value: string }>;
		resumeRows: ReadonlyArray<{ key: string; value: string }>;
		recomputeRows: ReadonlyArray<{ key: string; value: string }>;
	};
}) {
	const [mode, setMode] = useState<BenchMode>("verify");

	const highlighted = useMemo(() => {
		if (mode === "verify") {
			return {
				nodes: new Set<NodeId>(["compile", "verify", "gate"]),
				edges: new Set(["input:compile", "input:verify", "verify:gate"]),
			};
		}
		if (mode === "run") {
			return {
				nodes: new Set<NodeId>(["fanout", "gate", "final"]),
				edges: new Set([
					"compile:fanout",
					"verify:gate",
					"gate:final",
					"cache:final",
				]),
			};
		}
		return {
			nodes: new Set<NodeId>(["cache", "final", "verify"]),
			edges: new Set(["fanout:cache", "cache:final", "input:verify"]),
		};
	}, [mode]);

	const rails = [
		{
			id: "verify" as const,
			title: labels.verifyLabel,
			rows: labels.verifyRows,
		},
		{ id: "run" as const, title: labels.resumeLabel, rows: labels.resumeRows },
		{
			id: "recompute" as const,
			title: labels.recomputeLabel,
			rows: labels.recomputeRows,
		},
	];

	return (
		<section className="compiler-bench" aria-label={labels.aria}>
			<div className="compiler-bench__head">
				<div>
					<p className="home-kicker">{labels.eyebrow}</p>
					<h2 className="compiler-bench__title">{labels.title}</h2>
					<p className="compiler-bench__sub">{labels.sub}</p>
				</div>

				<div className="compiler-bench__modes">
					{(
						[
							["verify", labels.modeVerify],
							["run", labels.modeRun],
							["recompute", labels.modeRecompute],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							className="compiler-bench__mode"
							data-active={mode === value}
							aria-pressed={mode === value}
							onClick={() => setMode(value)}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			<div className="compiler-bench__body">
				<section
					className="compiler-bench__graph"
					aria-label={labels.graphLabel}
				>
					<div className="compiler-bench__grid" aria-hidden="true" />
					<svg
						className="compiler-bench__edges"
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						{GRAPH_EDGES.map((edge) => {
							const from = NODE_BY_ID[edge.from];
							const to = NODE_BY_ID[edge.to];
							return (
								<line
									key={`${edge.from}-${edge.to}`}
									x1={from.x}
									y1={from.y}
									x2={to.x}
									y2={to.y}
									vectorEffect="non-scaling-stroke"
									data-active={highlighted.edges.has(`${edge.from}:${edge.to}`)}
								/>
							);
						})}
					</svg>

					{GRAPH_NODES.map((node) => (
						<div
							key={node.id}
							className="bench-node"
							data-id={node.id}
							data-active={highlighted.nodes.has(node.id)}
							data-kind={
								node.id === "final"
									? "final"
									: node.id === "cache"
										? "cache"
										: undefined
							}
							style={{ left: `${node.x}%`, top: `${node.y}%` }}
						>
							<div className="bench-node__title">{node.title}</div>
							<div className="bench-node__meta">{node.meta}</div>
						</div>
					))}
				</section>

				<section className="compiler-bench__host" aria-label={labels.hostLabel}>
					<div className="compiler-bench__host-top">
						<span className="home-kicker">{labels.hostLabel}</span>
						<span className="compiler-bench__status" data-mode={mode}>
							{mode}
						</span>
					</div>
					<div className="compiler-bench__host-card">
						<div className="compiler-bench__host-label">finalOutput</div>
						<div className="compiler-bench__host-title">{labels.hostTitle}</div>
						<p className="compiler-bench__host-body">{labels.hostBody}</p>
					</div>
				</section>

				{rails.map((rail) => (
					<div
						key={rail.id}
						className="compiler-bench__rail"
						data-rail={rail.id}
						data-active={mode === rail.id}
					>
						<div className="compiler-bench__rail-title">{rail.title}</div>
						<dl className="compiler-bench__ledger">
							{rail.rows.map((row) => (
								<div key={row.key}>
									<dt>{row.key}</dt>
									<dd>{row.value}</dd>
								</div>
							))}
						</dl>
					</div>
				))}
			</div>
		</section>
	);
}
