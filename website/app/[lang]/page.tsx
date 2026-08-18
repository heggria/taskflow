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
			eyebrow: "taskflow 0.3.0-beta.2 · Trusted Effects beta",
			title: [
				"Declare the effect.",
				"Verify the path.",
				"Commit through one authority.",
			],
			sub: "taskflow turns coding-agent work into a verifiable runtime: explicit graphs, typed effect declarations, isolated execution, resource-controlled filesystem commits, and ledger-backed explanations across six hosts.",
			noteKicker: "0.3.0-beta.2 · beta channel · not GA",
			noteBody:
				"An agent can propose content. For admitted declared targets, the resources transaction is the only finalizer. The ControlHost scaffold exists; stores, approvals, receipts, and WebUI remain future follow-on stages, not shipped GA claims.",
			micro:
				"Resolve-only is not an OS sandbox. Undeclared writes remain host-policy dependent.",
			hosts: "Pi · Codex · Claude Code · OpenCode · Grok · Hermes",
			primary: "Read the docs",
			secondary: "Install",
			tertiary: "GitHub",
		},
		bench: {
			eyebrow: "Trusted Effects Bench",
			title: "One contract. Four checkpoints.",
			sub: "Declare, admit, transact, explain.",
			aria: "Trusted Effects bench showing an effect declaration, path admission, resource transaction, and ledger explanation.",
			modeVerify: "admit",
			modeRun: "commit",
			modeRecompute: "explain",
			graphLabel: "Trusted Effects contract",
			hostLabel: "Evidence return",
			hostTitle: "Declared report write",
			hostBody:
				"PathRef admitted. Resource intent committed. why-effect can explain the principal, capability, lifecycle, and generation.",
			verifyLabel: "Admit",
			resumeLabel: "Commit",
			recomputeLabel: "Explain",
			verifyRows: [
				{ key: "effect", value: "fs.write" },
				{ key: "PathRef", value: "resolved" },
				{ key: "labels", value: "pass" },
				{ key: "overlap", value: "checked" },
			],
			resumeRows: [
				{ key: "snapshot", value: "durable" },
				{ key: "intent", value: "journaled" },
				{ key: "lifecycle", value: "commit | restore" },
				{ key: "authority", value: "resources" },
			],
			recomputeRows: [
				{ key: "why-effect", value: "read-only" },
				{ key: "principal", value: "derived" },
				{ key: "capability", value: "bound" },
				{ key: "status", value: "committed" },
			],
		},
		install: {
			label: "0.3.0-beta.2 host installs — select the beta channel.",
			copy: "Copy",
			copied: "Copied",
			guide: "Guide",
		},
		capabilities: {
			title: "A mutation boundary, not a prompt promise.",
			sub: "The candidate makes side effects explicit without claiming a sandbox it does not have.",
			items: [
				{
					title: "Declare",
					body: "EffectIR names the kind, target, purpose, confidentiality, and integrity of a phase effect.",
				},
				{
					title: "Admit",
					body: "PathRef resolution, label flow, and mutating-path overlap are checked before the resource transaction proceeds.",
				},
				{
					title: "Explain",
					body: "A durable ledger backs why-authorized, why-context, and why-effect explanations without spending model tokens.",
				},
			],
		},
		ledger: {
			title: "0.3 is the trusted-effects turn.",
			sub: "The 0.2 runtime remains the graph engine; the candidate adds a typed, inspectable boundary around declared filesystem effects.",
			items: [
				{
					tag: "EffectIR",
					title: "Effects become data",
					body: "Closed effect kinds, typed refs, and labels travel through validation, FlowIR, hashing, and runtime admission.",
				},
				{
					tag: "Resources",
					title: "One mutation authority",
					body: "Snapshot, lease, intent, stage, commit — or restore and reject when the transaction cannot complete.",
				},
				{
					tag: "why-*",
					title: "Evidence is queryable",
					body: "why-effect explains authorization and lifecycle from durable resource records, not from model prose.",
				},
				{
					tag: "Boundary",
					title: "Security claims stay narrow",
					body: "Declared targets are protected by the MVP path; undeclared writes and OS-level sandboxing remain outside the claim.",
				},
				{
					tag: "0.3-C",
					title: "Control Plane follows",
					body: "The ControlHost scaffold exists; stores, receipts, approvals, and WebUI are future 0.3-C stages, not shipped 0.3 GA surface yet.",
				},
				{
					tag: "Hosts",
					title: "Six hosts · one flow contract",
					body: "Pi, Codex, Claude Code, OpenCode, Grok, and Hermes share the taskflow runtime while retaining host-specific policy.",
				},
			],
		},
		authoring: {
			title: "Same runtime. Three contract surfaces.",
			sub: "JSON for transport. TypeScript for authoring. FlowIR and EffectIR for the compiled contract.",
			json: "JSON",
			ts: "TypeScript",
			flowir: "FlowIR",
			noteTitle: "What stays invariant",
			notes: [
				"The graph is explicit and versionable.",
				"Effects are declared, not inferred from prose.",
				"The resources layer is the only finalizer for admitted declared targets.",
				"The host still receives only finalOutput unless evidence is requested.",
			],
		},
		difference: {
			title: "What changes when effects are data.",
			sub: "Not a sandbox claim — an operating boundary.",
			rows: [
				{
					label: "authority",
					a: "one resource finalizer",
					b: "ambient command writes",
				},
				{
					label: "target",
					a: "typed PathRef + admission",
					b: "implicit path string",
				},
				{ label: "failure", a: "restore + reject", b: "partial mutation" },
				{ label: "evidence", a: "ledger-backed why-effect", b: "model explanation" },
			],
			left: "taskflow",
			right: "ad-hoc",
		},
		cta: {
			title: "Make the side effect explicit.",
			body: "Declare the target, verify the boundary, commit through one authority, and keep the claim honest.",
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
			eyebrow: "taskflow 0.3.0-beta.2 · Trusted Effects beta",
			title: ["声明 effect。", "验证路径。", "让一个 authority 负责提交。"],
			sub: "taskflow 把 coding-agent 工作变成可验证的运行时：显式任务图、类型化 effect 声明、隔离执行、受 resources 控制的文件提交，以及覆盖六个宿主的 ledger-backed 解释。",
			noteKicker: "0.3.0-beta.2 · beta channel · 尚未 GA",
			noteBody:
				"智能体可以提出内容。对于已准入的已声明目标，resources transaction 是唯一最终提交者。ControlHost 目前是脚手架；store、审批、receipt 与 WebUI 仍是后续阶段，不是已交付的 GA 表面。",
			micro: "Resolve-only 不是 OS sandbox。未声明写入仍取决于宿主策略。",
			hosts: "Pi · Codex · Claude Code · OpenCode · Grok · Hermes",
			primary: "阅读文档",
			secondary: "安装",
			tertiary: "GitHub",
		},
		bench: {
			eyebrow: "Trusted Effects Bench",
			title: "一份合同，四个检查点。",
			sub: "声明、准入、事务、解释。",
			aria: "Trusted Effects Bench：展示 effect 声明、路径准入、resource transaction 与 ledger 解释。",
			modeVerify: "准入",
			modeRun: "提交",
			modeRecompute: "解释",
			graphLabel: "Trusted Effects 合同",
			hostLabel: "Evidence 回传",
			hostTitle: "已声明的报告写入",
			hostBody:
				"PathRef 已准入。Resource intent 已提交。why-effect 可以解释 principal、capability、lifecycle 与 generation。",
			verifyLabel: "准入",
			resumeLabel: "提交",
			recomputeLabel: "解释",
			verifyRows: [
				{ key: "effect", value: "fs.write" },
				{ key: "PathRef", value: "已解析" },
				{ key: "labels", value: "通过" },
				{ key: "重叠", value: "已检查" },
			],
			resumeRows: [
				{ key: "snapshot", value: "durable" },
				{ key: "intent", value: "已记账" },
				{ key: "lifecycle", value: "commit | restore" },
				{ key: "authority", value: "resources" },
			],
			recomputeRows: [
				{ key: "why-effect", value: "只读" },
				{ key: "principal", value: "已推导" },
				{ key: "capability", value: "已绑定" },
				{ key: "status", value: "committed" },
			],
		},
		install: {
			label: "0.3.0-beta.2 宿主安装；请显式选择 beta channel。",
			copy: "复制",
			copied: "已复制",
			guide: "指南",
		},
		capabilities: {
			title: "这是修改边界，不是 prompt 承诺。",
			sub: "candidate 把副作用显式化，但不声称不存在的 sandbox。",
			items: [
				{
					title: "声明",
					body: "EffectIR 写出阶段 effect 的 kind、target、purpose、confidentiality 与 integrity。",
				},
				{
					title: "准入",
					body: "Resource transaction 继续前，先检查 PathRef 解析、标签流与 mutating-path 重叠。",
				},
				{
					title: "解释",
					body: "Durable ledger 支撑 why-authorized、why-context 与 why-effect，不消耗模型 token。",
				},
			],
		},
		ledger: {
			title: "0.3 是 Trusted Effects 转身。",
			sub: "0.2 运行时仍是图引擎；candidate 在声明的文件 effect 周围增加类型化、可检查的边界。",
			items: [
				{
					tag: "EffectIR",
					title: "让 effect 成为数据",
					body: "封闭 effect kind、类型化 ref 与 labels 贯穿校验、FlowIR、哈希与运行时准入。",
				},
				{
					tag: "Resources",
					title: "只有一个修改权威",
					body: "Snapshot、lease、intent、stage、commit；事务不能完成时就 restore and reject。",
				},
				{
					tag: "why-*",
					title: "Evidence 可以查询",
					body: "why-effect 从 durable resource records 解释授权与生命周期，而不是复述模型 prose。",
				},
				{
					tag: "Boundary",
					title: "安全声明保持窄",
					body: "MVP 路径保护已声明目标；未声明写入与 OS-level sandbox 不在声明范围内。",
				},
				{
					tag: "0.3-C",
					title: "Control Plane 在后面",
					body: "ControlHost 目前是脚手架；store、receipt、审批与 WebUI 属于后续 0.3-C 阶段，还不是已发布的 0.3 GA 表面。",
				},
				{
					tag: "Hosts",
					title: "六个宿主 · 一份 flow 合同",
					body: "Pi、Codex、Claude Code、OpenCode、Grok、Hermes 共用 taskflow runtime，同时保留宿主策略差异。",
				},
			],
		},
		authoring: {
			title: "同一运行时，三种合同表面。",
			sub: "JSON 用于传输。TypeScript 用于编写。FlowIR 与 EffectIR 用于编译合同。",
			json: "JSON",
			ts: "TypeScript",
			flowir: "FlowIR",
			noteTitle: "不变的东西",
			notes: [
				"图是显式的、可版本化的。",
				"Effect 是声明出来的，不是从 prose 猜出来的。",
				"Resources 层是已声明准入目标的唯一最终提交者。",
				"除非请求 evidence，回到宿主的仍只有 finalOutput。",
			],
		},
		difference: {
			title: "当 effect 成为数据，事情会怎么变。",
			sub: "不是 sandbox 宣言，而是运行边界。",
			rows: [
				{ label: "authority", a: "一个 resource finalizer", b: "ambient command writes" },
				{ label: "target", a: "typed PathRef + admission", b: "隐式 path string" },
				{ label: "failure", a: "restore + reject", b: "partial mutation" },
				{ label: "evidence", a: "ledger-backed why-effect", b: "model explanation" },
			],
			left: "taskflow",
			right: "ad-hoc",
		},
		cta: {
			title: "把副作用写进合同。",
			body: "声明目标，验证边界，让一个 authority 负责提交，并诚实地写出安全边界。",
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
		softwareVersion: "0.3.0-beta.2",
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
							<p className="home-kicker">taskflow 0.3 · candidate</p>
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
