import {
	agent,
	expand,
	flow,
	gate,
	json,
	loop,
	map,
	parallel,
	race,
	reduce,
	script,
	subflow,
	tournament,
} from "taskflow-dsl";

export default flow(
	"comprehensive-release-review",
	{
		description: "Adversarial, evidence-backed review of the taskflow 0.2.0 release branch",
		version: 2,
		agentScope: "both",
		strictInterpolation: true,
	},
	(ctx) => {
		ctx.concurrency(6);
		ctx.budget({ maxTokens: 100_000_000, maxUSD: 12 });

		const repoState = script(
			[
				"sh",
				"-lc",
				"git status --short && git log --oneline -5 && git diff --check origin/main...HEAD && git diff --shortstat origin/main...HEAD",
			],
			{ id: "repo-state", timeout: 30_000 },
		);

		const reviewPlan = agent(
			`Inspect the taskflow 0.2.0 branch and the repository evidence below.
	Return ONLY a JSON array with exactly four objects. Each object must contain:
	{"area": string, "paths": string, "focus": string}.
	Cover these distinct surfaces: runtime/process semantics, TypeScript DSL compiler,
	host/MCP delivery, and website/release automation. Use real repository paths.

	Repository evidence:
	${repoState.output}`,
			{
				id: "review-plan",
				agent: "scout",
				tools: ["read", "grep", "ls"],
				output: json<{ area: string; paths: string; focus: string }[]>(),
				retry: { max: 2, backoffMs: 0 },
				timeout: 900_000,
			},
		);

		const moduleAudits = map(
			reviewPlan,
			(item) =>
				agent(
					`Act as an adversarial code reviewer for ${item.area}.
	Paths: ${item.paths}
	Focus: ${item.focus}
	Inspect the actual files and tests. Review correctness, failure semantics, backward
	compatibility, security, performance, observability, and missing boundary tests.
	Every finding must include severity, file:line evidence, exploit/failure scenario,
	and the smallest safe fix. Explicitly say NO BLOCKER when none is proven.`,
					{
						agent: "risk-reviewer",
						tools: ["read", "grep", "ls"],
						timeout: 900_000,
					},
				),
			{
				id: "module-audits",
				as: "surface",
				concurrency: 4,
				cache: { scope: "off" },
			},
		);

		const crossCutting = parallel(
			[
				agent(
					`Audit cancellation, budgets, races, retries, trace durability, child-process
	cleanup, and resume invariants. Prove issues from code and tests; do not speculate.
	Repository evidence:
	${repoState.output}`,
					{ agent: "critic" },
				),
				agent(
					`Audit the public 0.2.0 DSL for typecheck/build/decompile/FlowIR parity,
	strict fail-closed diagnostics, hostile literals, all phase kinds, and docs accuracy.
	Repository evidence:
	${repoState.output}`,
					{ agent: "reviewer" },
				),
				agent(
					`Audit supply-chain and delivery closure: package exports, dist contents,
	publish tag-to-SHA validation, CI required checks, host argv contracts, and base-path
	website export correctness. Cite exact evidence.
	Repository evidence:
	${repoState.output}`,
					{ agent: "security-reviewer" },
				),
			],
			{
				id: "cross-cutting",
				concurrency: 3,
				tools: ["read", "grep", "ls"],
				timeout: 900_000,
			},
		);

		const rapidTriage = race(
			[
				agent(
					`Find the single highest-confidence merge blocker in origin/main...HEAD.
	If none is provable, return NO PROVEN BLOCKER with the strongest supporting checks.`,
					{ agent: "reviewer" },
				),
				agent(
					`Attack the 0.2.0 changes from malformed input, abort timing, crash recovery,
	and release rerun angles. Return the first concrete blocker with file:line proof,
	or NO PROVEN BLOCKER.`,
					{ agent: "risk-reviewer" },
				),
			],
			{
				id: "rapid-triage",
				cancelLosers: true,
				dependsOn: [repoState],
				tools: ["read", "grep", "ls"],
				timeout: 900_000,
			},
		);

		const strategyTournament = tournament({
			id: "strategy-tournament",
			mode: "best",
			judgeAgent: "final-arbiter",
			dependsOn: [repoState],
			tools: ["read", "grep", "ls"],
			timeout: 900_000,
			judge:
				"Select the review with the strongest code-backed evidence, counterexample quality, and actionable closure. Return ONLY JSON {\"winner\":1|2|3,\"reason\":\"...\"}.",
			branches: [
				agent(
					`Review origin/main...HEAD conservatively: search only for correctness and data-loss blockers.
	Use actual source and tests. ${repoState.output}`,
					{ agent: "analyst" },
				),
				agent(
					`Review origin/main...HEAD as a hostile integrator: find compatibility, packaging,
	and operational failures that happy-path tests miss. ${repoState.output}`,
					{ agent: "critic" },
				),
				agent(
					`Review origin/main...HEAD as a release engineer: verify tests actually prove the
	claims, artifacts are publishable, and reruns are safe. ${repoState.output}`,
					{ agent: "verifier" },
				),
			],
		});

		const synthesis = reduce(
			[moduleAudits, crossCutting, rapidTriage, strategyTournament],
			(parts) =>
				agent(
					`Synthesize an evidence ledger for merge readiness. Deduplicate findings,
	reject speculation, reconcile contradictions, and separate BLOCKER / IMPORTANT /
	NON-BLOCKING. For every retained issue cite file:line and a reproducer or invariant.
	End with one of: MERGE_READY or NOT_MERGE_READY.

	MODULE AUDITS:
	${parts.moduleAudits.output}

	CROSS-CUTTING:
	${parts.crossCutting.output}

	RAPID TRIAGE:
	${parts.rapidTriage.output}

	BEST ADVERSARIAL REVIEW:
	${parts.strategyTournament.output}`,
					{ agent: "final-arbiter", timeout: 900_000 },
				),
			{ id: "synthesis" },
		);

		const machineQuality = gate.scored(synthesis, {
			id: "machine-quality",
			dependsOn: [synthesis],
			target: "{steps.synthesis.output}",
			scorers: [
				{ type: "length-range", name: "substantive", min: 500, max: 30_000 },
				{ type: "contains", name: "has-verdict", value: "MERGE_READY" },
				{ type: "regex", name: "no-draft-markers", pattern: "TODO|TBD|PLACEHOLDER", negate: true },
			],
			combine: "all",
		});

		const evidenceGate = gate(
			synthesis,
			{
				id: "evidence-gate",
				agent: "reviewer",
				output: "json",
				expect: {
					type: "object",
					properties: {
						verdict: { enum: ["pass", "block"] },
						reason: { type: "string" },
					},
					required: ["verdict", "reason"],
				},
				retry: { max: 2, backoffMs: 0 },
			},
			(input) => `Judge the review REPORT QUALITY, not whether the code is flawless.
	PASS only if every blocker is evidence-backed, contradictions are resolved, and the
	merge verdict follows from the evidence. Return ONLY JSON:
	{"verdict":"pass"|"block","reason":"..."}

	REPORT:
	${input.output}`,
		);

		const refined = loop({
			id: "refined",
			agent: "final-arbiter",
			dependsOn: [synthesis, machineQuality, evidenceGate],
			maxIterations: 3,
			convergence: true,
			reflexion: true,
			until: "{steps.refined.json.done} == true",
			output: json<{ done: boolean; report: string }>(),
			task: `Produce ONLY JSON {"done":boolean,"report":"..."}.
	Set done=true only when the report is concise, preserves all proven blockers,
	states exact verification evidence, and ends in MERGE_READY or NOT_MERGE_READY.
	Do not invent evidence. This is refinement round {loop.iteration}/{loop.maxIterations}.

	SYNTHESIS:
	${synthesis.output}

	MACHINE QUALITY:
	${machineQuality.output}

	EVIDENCE GATE:
	${evidenceGate.output}

	PRIOR ROUND:
	{loop.lastOutput}

	{reflexion}`,
		});

		const nestedChallenge = subflow.def(
			{
				name: "nested-challenge",
				phases: [
					{
						id: "challenge",
						type: "agent",
						agent: "critic",
						task: "Try to falsify the report below. Return only code-backed counterexamples or NO COUNTEREXAMPLE.\n{args.report}",
						final: true,
					},
				],
			},
			{
				id: "nested-challenge",
				with: { report: "{steps.refined.output}" },
				dependsOn: [refined],
			},
		);

		const expandedEvidence = expand.nested(
			{
				name: "expanded-evidence-check",
				phases: [
					{
						id: "verify-claims",
						type: "agent",
						agent: "verifier",
						task: "Check the final report against the repository. List unsupported claims, or VERIFIED if all material claims hold.\n{args.report}",
						final: true,
					},
				],
			},
			{
				id: "expanded-evidence",
				with: { report: "{steps.refined.output}" },
				dependsOn: [refined],
				maxNodes: 8,
			},
		);

		return reduce(
			[refined, nestedChallenge, expandedEvidence],
			(parts) =>
				agent(
					`Issue the final merge-readiness decision. Preserve proven blockers; discard
	unsupported claims. Include: verdict, blocker count, exact evidence, checks run,
	remaining uncertainty, and the DSL/runtime features exercised by this workflow.

	REFINED REPORT:
	${parts.refined.output}

	NESTED ADVERSARIAL CHALLENGE:
	${parts.nestedChallenge.output}

	EXPANDED EVIDENCE VERIFICATION:
					${parts.expandedEvidence.output}`,
					{ agent: "final-arbiter", timeout: 900_000 },
					),
				{ id: "final-decision", final: true },
			);
	},
);
