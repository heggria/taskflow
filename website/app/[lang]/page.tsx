// biome-ignore-all lint/security/noDangerouslySetInnerHtml: JSON-LD uses dangerouslySetInnerHTML
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AuthoringSwitcher } from "@/components/home/authoring-switcher";
import { CompilerBench } from "@/components/home/compiler-bench";
import { HomeHeader } from "@/components/home/home-header";
import { InstallRail } from "@/components/home/install-rail";
import { sampleFlowIR, sampleJson, sampleTs } from "@/lib/home-samples";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/i18n";

export function generateStaticParams() {
	return i18n.languages.map((lang) => ({ lang }));
}

const SITE = "https://heggria.github.io/taskflow";

const copy = {
	en: {
		header: {
			docs: "Docs",
			examples: "Examples",
			github: "GitHub",
			localeEn: "EN",
			localeZh: "中文",
		},
		hero: {
			eyebrow: "taskflow 0.2",
			title: [
				"Verify before spend.",
				"Resume across sessions.",
				"Recompute only what changed.",
			],
			sub: "taskflow turns multi-agent coding work into a compiled runtime: declared graphs, isolated execution, deterministic replay, and incremental recompute across Pi, Codex, Claude Code, OpenCode, and Grok.",
			noteKicker: "Compiled runtime for coding agents",
			noteBody:
				"0.2 is not a nicer prompt ritual. It is a verifiable orchestration runtime with a real intermediate representation, resumable runs, and minimal frontier reruns.",
			micro:
				"Intermediates stay in the runtime. Only the result returns to the host.",
			hosts: "Pi · Codex · Claude Code · OpenCode · Grok",
			primary: "Read the docs",
			secondary: "Install",
			tertiary: "GitHub",
		},
		bench: {
			eyebrow: "Compiler Bench",
			title: "One surface. Four invariants.",
			sub: "Declared graph, verified execution, isolated return, minimal recompute.",
			aria: "Compiler Bench showing a declared task graph, host return, verification checks, resumable execution, and incremental recompute.",
			modeVerify: "verify",
			modeRun: "run",
			modeRecompute: "recompute",
			graphLabel: "Declared graph",
			hostLabel: "Host return",
			hostTitle: "Prioritized risk summary",
			hostBody:
				"Auth boundary verified. 7 phases reused from cache. Re-ran only the changed frontier before returning the final answer.",
			verifyLabel: "Verify",
			resumeLabel: "Resume",
			recomputeLabel: "Recompute",
			verifyRows: [
				{ key: "cycles", value: "0" },
				{ key: "dead ends", value: "0" },
				{ key: "refs", value: "resolved" },
				{ key: "budget", value: "pass" },
			],
			resumeRows: [
				{ key: "run state", value: "detached + resumable" },
				{ key: "trace", value: "stored" },
				{ key: "cache hits", value: "7 phases" },
				{ key: "host output", value: "final only" },
			],
			recomputeRows: [
				{ key: "changed inputs", value: "1 file" },
				{ key: "stale frontier", value: "2 nodes" },
				{ key: "reused", value: "discover + 6 reviews" },
				{ key: "new spend", value: "minimal" },
			],
		},
		install: {
			label: "Install on the host you already use.",
			copy: "Copy",
			copied: "Copied",
			guide: "Guide",
		},
		capabilities: {
			title: "A runtime, not a prompt ritual.",
			sub: "The page should prove contract, not list features.",
			items: [
				{
					title: "Verify",
					body: "Static checks happen before any model call: cycles, dead ends, dangling refs, impossible budgets.",
				},
				{
					title: "Resume",
					body: "Runs survive failures and survive sessions. Detached execution, trace storage, and resumable state are part of the runtime contract.",
				},
				{
					title: "Recompute",
					body: "When inputs change, taskflow re-runs the stale frontier instead of replaying the whole flow from zero.",
				},
			],
		},
		ledger: {
			title: "0.2 is the compiler turn.",
			sub: "The graph is no longer only run. It is compiled, resumed, replayed, and incrementally recomputed.",
			items: [
				{
					tag: "S4",
					title: "TypeScript DSL compiles to FlowIR",
					body: "Author in .tf.ts, then erase into a canonical intermediate form.",
				},
				{
					tag: "Core",
					title: "Verify + trace + replay + detached runs",
					body: "The runtime can check structure before spend and persist the whole operating envelope.",
				},
				{
					tag: "Cache",
					title: "Cross-run content addressing",
					body: "Unchanged work is reused instead of repurchased.",
				},
				{
					tag: "Delta",
					title: "why-stale + minimal frontier rerun",
					body: "Change a file, then re-run only the affected phases.",
				},
				{
					tag: "Hosts",
					title: "Five host adapters",
					body: "Pi, Codex, Claude Code, OpenCode, and Grok share one engine.",
				},
				{
					tag: "Return",
					title: "Intermediates stay inside the runtime",
					body: "The host only receives the final result, not the operational sludge.",
				},
			],
		},
		authoring: {
			title: "Same runtime. Three surfaces.",
			sub: "JSON for transport. TypeScript for authoring. FlowIR for the compiled contract.",
			json: "JSON",
			ts: "TypeScript",
			flowir: "FlowIR",
			noteTitle: "What stays invariant",
			notes: [
				"The graph is explicit and versionable.",
				"Verification happens before spend.",
				"Phase identity can be fingerprinted and cached.",
				"The host still receives only finalOutput.",
			],
		},
		difference: {
			title: "What changes when the graph is data.",
			sub: "Not a category lecture — an operating difference.",
			rows: [
				{
					label: "plan",
					a: "declared and versioned",
					b: "re-derived in prose",
				},
				{
					label: "spend",
					a: "verified first",
					b: "discovered during execution",
				},
				{ label: "failure", a: "resumed", b: "restarted" },
				{ label: "change", a: "minimally recomputed", b: "broadly rerun" },
			],
			left: "taskflow",
			right: "ad-hoc",
		},
		cta: {
			title: "Build the graph once. Rerun it precisely.",
			body: "Verify before spend. Resume across sessions. Return only the result.",
			primary: "Read the docs",
			secondary: "Install",
		},
	},
	"zh-cn": {
		header: {
			docs: "文档",
			examples: "示例",
			github: "GitHub",
			localeEn: "EN",
			localeZh: "中文",
		},
		hero: {
			eyebrow: "taskflow 0.2",
			title: ["花 token 前先验证。", "跨会话续跑。", "只重算变化部分。"],
			sub: "taskflow 把多代理编程工作变成可编译的运行时：声明式图、隔离执行、确定性 replay，以及跨 Pi、Codex、Claude Code、OpenCode、Grok 的增量重算。",
			noteKicker: "面向 coding agents 的 compiled runtime",
			noteBody:
				"0.2 不是更好看的 prompt 仪式，而是一套可验证的编排运行时：有中间表示、有续跑、有最小重算。",
			micro: "中间过程留在运行时里。回到宿主的，只有结果。",
			hosts: "Pi · Codex · Claude Code · OpenCode · Grok",
			primary: "阅读文档",
			secondary: "安装",
			tertiary: "GitHub",
		},
		bench: {
			eyebrow: "Compiler Bench",
			title: "一个台面，四个不变量。",
			sub: "声明式图、可验证执行、隔离回传、最小重算。",
			aria: "Compiler Bench：展示声明式任务图、宿主回传、验证检查、可续跑执行与增量重算。",
			modeVerify: "verify",
			modeRun: "run",
			modeRecompute: "recompute",
			graphLabel: "声明式图",
			hostLabel: "宿主回传",
			hostTitle: "优先级风险摘要",
			hostBody:
				"Auth 边界已验证。7 个阶段命中缓存。只重跑变化前沿后，把最终答案带回宿主。",
			verifyLabel: "验证",
			resumeLabel: "续跑",
			recomputeLabel: "重算",
			verifyRows: [
				{ key: "环路", value: "0" },
				{ key: "死路", value: "0" },
				{ key: "引用", value: "已解析" },
				{ key: "预算", value: "通过" },
			],
			resumeRows: [
				{ key: "运行态", value: "detached + resumable" },
				{ key: "trace", value: "已持久化" },
				{ key: "缓存命中", value: "7 个阶段" },
				{ key: "宿主输出", value: "仅 final" },
			],
			recomputeRows: [
				{ key: "变化输入", value: "1 个文件" },
				{ key: "陈旧前沿", value: "2 个节点" },
				{ key: "复用", value: "discover + 6 个 review" },
				{ key: "新增花费", value: "最小" },
			],
		},
		install: {
			label: "装到你已经在用的宿主上。",
			copy: "复制",
			copied: "已复制",
			guide: "指南",
		},
		capabilities: {
			title: "这是一套运行时，不是一次 prompt 仪式。",
			sub: "这里要证明合同，而不是罗列功能。",
			items: [
				{
					title: "验证",
					body: "在任何模型调用前完成静态检查：环路、死路、悬空引用、不可能的预算。",
				},
				{
					title: "续跑",
					body: "运行能穿越失败，也能穿越会话。detached 执行、trace 持久化、可恢复状态都是运行时合同的一部分。",
				},
				{
					title: "重算",
					body: "当输入变化时，taskflow 只重跑陈旧前沿，而不是把整条流从零重放。",
				},
			],
		},
		ledger: {
			title: "0.2 是编译器转身。",
			sub: "图不再只是被运行；它开始被编译、被续跑、被 replay、被增量重算。",
			items: [
				{
					tag: "S4",
					title: "TypeScript DSL 编译到 FlowIR",
					body: "在 .tf.ts 中编写，再擦除成规范化中间表示。",
				},
				{
					tag: "Core",
					title: "Verify + trace + replay + detached runs",
					body: "运行时能在花费前检查结构，并持久化完整的运行包络。",
				},
				{
					tag: "Cache",
					title: "跨 run 内容寻址复用",
					body: "未变化的工作被复用，而不是被重新付费。",
				},
				{
					tag: "Delta",
					title: "why-stale + 最小前沿重跑",
					body: "改一个文件，再只重跑受影响的阶段。",
				},
				{
					tag: "Hosts",
					title: "五个宿主适配器",
					body: "Pi、Codex、Claude Code、OpenCode、Grok 共用同一套引擎。",
				},
				{
					tag: "Return",
					title: "中间态留在运行时里",
					body: "宿主收到的是最终结果，不是运行污泥。",
				},
			],
		},
		authoring: {
			title: "同一运行时，三种表面。",
			sub: "JSON 用于传输。TypeScript 用于编写。FlowIR 用于编译合同。",
			json: "JSON",
			ts: "TypeScript",
			flowir: "FlowIR",
			noteTitle: "不变的东西",
			notes: [
				"图是显式的、可版本化的。",
				"验证先于花费发生。",
				"阶段身份可以被指纹化和缓存。",
				"回到宿主的仍只有 finalOutput。",
			],
		},
		difference: {
			title: "当图成为数据，事情会怎么变。",
			sub: "不是品类讲解，而是运行差异。",
			rows: [
				{ label: "plan", a: "声明并版本化", b: "每次重推为 prose" },
				{ label: "spend", a: "先验证", b: "运行中才发现" },
				{ label: "failure", a: "可续跑", b: "从头再来" },
				{ label: "change", a: "最小重算", b: "大范围重跑" },
			],
			left: "taskflow",
			right: "ad-hoc",
		},
		cta: {
			title: "图只搭一次，之后精确重跑。",
			body: "先验证，能续跑，只把结果带回宿主。",
			primary: "阅读文档",
			secondary: "安装",
		},
	},
} as const;

export default async function HomePage({
	params,
}: {
	params: Promise<{ lang: Locale }>;
}) {
	const { lang } = await params;
	const t = copy[lang] ?? copy.en;

	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "taskflow",
		softwareVersion: "0.2.0",
		description: t.hero.sub,
		applicationCategory: "DeveloperApplication",
		operatingSystem: "Any",
		url: `${SITE}/${lang}/`,
		offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
		author: {
			"@type": "Organization",
			name: "heggria",
			url: "https://github.com/heggria",
		},
	};

	return (
		<div className="home-shell">
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
			/>
			<HomeHeader lang={lang} labels={t.header} />

			<main>
				<section className="home-hero-section">
					<div className="home-frame">
						<div className="home-hero">
							<div className="home-hero__copy">
								<p className="home-kicker">{t.hero.eyebrow}</p>
								<h1 className="home-hero__title">
									{t.hero.title.map((line) => (
										<span key={line}>{line}</span>
									))}
								</h1>
								<p className="home-hero__sub">{t.hero.sub}</p>
							</div>

							<aside className="home-hero__note">
								<p className="home-kicker">{t.hero.noteKicker}</p>
								<p className="home-note">{t.hero.noteBody}</p>
								<p className="home-note home-note--micro">{t.hero.micro}</p>
								<p className="home-note home-note--hosts">{t.hero.hosts}</p>
								<div className="home-actions">
									<Link
										href={`/${lang}/docs`}
										className="home-btn home-btn--primary"
									>
										{t.hero.primary}
										<ArrowRight className="size-4" aria-hidden="true" />
									</Link>
									<a href="#install" className="home-btn home-btn--secondary">
										{t.hero.secondary}
									</a>
									<a
										href="https://github.com/heggria/taskflow"
										target="_blank"
										rel="noreferrer"
										className="home-text-link"
									>
										{t.hero.tertiary}
										<ArrowUpRight className="size-4" aria-hidden="true" />
									</a>
								</div>
							</aside>
						</div>

						<div className="home-stage-wrap">
							<CompilerBench labels={t.bench} />
							<div className="home-stage-dock" id="install">
								<p className="home-stage-dock__label">{t.install.label}</p>
								<InstallRail lang={lang} labels={t.install} />
							</div>
						</div>
					</div>
				</section>

				<section className="home-section">
					<div className="home-frame">
						<div className="home-section__head">
							<p className="home-kicker">Runtime contract</p>
							<h2>{t.capabilities.title}</h2>
							<p>{t.capabilities.sub}</p>
						</div>
						<div className="capability-grid">
							{t.capabilities.items.map((item) => (
								<article key={item.title} className="capability-grid__item">
									<h3>{item.title}</h3>
									<p>{item.body}</p>
								</article>
							))}
						</div>
					</div>
				</section>

				<section className="home-section home-section--tinted">
					<div className="home-frame home-ledger">
						<div className="home-section__head home-section__head--narrow">
							<p className="home-kicker">Release ledger</p>
							<h2>{t.ledger.title}</h2>
							<p>{t.ledger.sub}</p>
						</div>
						<div className="ledger-list">
							{t.ledger.items.map((item) => (
								<div key={item.title} className="ledger-list__row">
									<div className="ledger-list__tag">{item.tag}</div>
									<div className="ledger-list__body">
										<h3>{item.title}</h3>
										<p>{item.body}</p>
									</div>
								</div>
							))}
						</div>
					</div>
				</section>

				<section className="home-section">
					<div className="home-frame">
						<div className="home-section__head">
							<p className="home-kicker">Authoring surface</p>
							<h2>{t.authoring.title}</h2>
							<p>{t.authoring.sub}</p>
						</div>
						<AuthoringSwitcher
							labels={t.authoring}
							jsonCode={sampleJson}
							tsCode={sampleTs}
							flowirCode={sampleFlowIR}
						/>
					</div>
				</section>

				<section className="home-section home-section--difference">
					<div className="home-frame">
						<div className="home-section__head home-section__head--narrow">
							<p className="home-kicker">Difference ledger</p>
							<h2>{t.difference.title}</h2>
							<p>{t.difference.sub}</p>
						</div>
						<div className="difference-ledger">
							<div className="difference-ledger__head">
								<span />
								<span>{t.difference.left}</span>
								<span>{t.difference.right}</span>
							</div>
							{t.difference.rows.map((row) => (
								<div key={row.label} className="difference-ledger__row">
									<div className="difference-ledger__label">{row.label}</div>
									<div>{row.a}</div>
									<div>{row.b}</div>
								</div>
							))}
						</div>
					</div>
				</section>

				<section className="home-final">
					<div className="home-frame home-final__inner">
						<div>
							<p className="home-kicker">taskflow 0.2</p>
							<h2>{t.cta.title}</h2>
							<p>{t.cta.body}</p>
						</div>
						<div className="home-actions">
							<Link
								href={`/${lang}/docs`}
								className="home-btn home-btn--primary"
							>
								{t.cta.primary}
								<ArrowRight className="size-4" aria-hidden="true" />
							</Link>
							<a href="#install" className="home-btn home-btn--secondary">
								{t.cta.secondary}
							</a>
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}
