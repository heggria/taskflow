import Link from 'next/link';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import {
  Network,
  Zap,
  RefreshCw,
  ArrowRight,
  ExternalLink,
  Terminal,
  Server,
  Layers,
  Package,
  History,
  Quote,
  BookOpen,
  FolderOpen,
  Users,
} from 'lucide-react';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

const translations = {
  en: {
    title: 'taskflow',
    tagline: 'Declarative agent orchestration.',
    valueProp:
      'Describe multi-step coding-agent work as a DAG, verify it before a token is spent, and return only the final result to your context window.',
    badge: 'Zero runtime dependencies',
    getStarted: 'Get Started',
    whatIs: 'What is taskflow?',
    github: 'GitHub',
    featureHeading: 'Built for real agent workflows',
    features: {
      dag: {
        title: 'Declarative DAGs',
        body: 'Define phases, dependencies, and fan-out as data. The runtime turns your graph into isolated subagent calls.',
      },
      isolation: {
        title: 'Context Isolation',
        body: 'Intermediate transcripts stay inside the runtime. Only the final phase reaches your conversation.',
      },
      resume: {
        title: 'Cross-Session Resume',
        body: 'Paused or failed runs pick up where they left off. Cached phases skip automatically on re-run.',
      },
    },
    code: {
      label: 'review-changes.json',
      caption: 'A complete review flow: discover files, fan out reviews, then summarize.',
    },
    stats: {
      heading: 'By the numbers',
      hosts: {
        value: '4 hosts',
        label: 'Pi, Codex, Claude Code, OpenCode',
      },
      phases: {
        value: '10 phase types',
        label: 'agent, map, gate, reduce, and more',
      },
      deps: {
        value: '0 runtime deps',
        label: 'No production dependencies',
      },
      resume: {
        value: 'Cross-session resume',
        label: 'Pick up where you left off',
      },
    },
    comparison: {
      heading: 'Declarative vs imperative',
      subheading:
        'Why declare your agent workflows as data instead of scripting them?',
      aspectHeader: 'Aspect',
      declarativeHeader: 'Declarative',
      imperativeHeader: 'Imperative',
      link: 'Learn more',
      rows: [
        {
          aspect: 'Verifiable before tokens',
          declarative: 'DAG checked for cycles, dead ends, and budget before any model call.',
          imperative: 'Bugs surface at runtime, after you have already paid.',
        },
        {
          aspect: 'Context cost',
          declarative: 'Only the final output returns to your context.',
          imperative: 'Every transcript floods the host conversation.',
        },
        {
          aspect: 'Resume after failure',
          declarative: 'Cached phases auto-skip on re-run.',
          imperative: 'Start over from the beginning.',
        },
        {
          aspect: 'Reusability',
          declarative: 'Save, version, and call by name.',
          imperative: 'Copy-paste scripts between runs.',
        },
      ],
    },
    testimonials: {
      heading: 'What early users say',
      quotes: [
        {
          body: 'We turned a 50-file security review from a context-window disaster into a 10-minute taskflow.',
          role: 'Platform Engineer, Series B startup',
        },
        {
          body: 'Cross-session resume alone saved us hours. A run dies at the summary step and we just continue it.',
          role: 'Staff Engineer, AI infrastructure',
        },
        {
          body: 'The tournament phase consistently beats our single-shot headline and release-note drafts.',
          role: 'Developer Advocate, open-source tooling',
        },
      ],
    },
    cta: {
      title: 'Ready to declare your first DAG?',
      body: 'Install on Pi or Codex and run a multi-phase workflow in minutes.',
      docs: 'Read the docs',
      templates: 'Browse templates',
      community: 'Join community',
    },
  },
  'zh-cn': {
    title: 'taskflow',
    tagline: '声明式智能体编排。',
    valueProp:
      '把多步骤编程智能体工作描述成 DAG，在花费 token 之前验证它，并且只把最终结果返回到你的上下文窗口。',
    badge: '零运行时依赖',
    getStarted: '开始使用',
    whatIs: '什么是 taskflow？',
    github: 'GitHub',
    featureHeading: '为真实智能体工作流而建',
    features: {
      dag: {
        title: '声明式 DAG',
        body: '将阶段、依赖和 fan-out 定义为数据。运行时把你的图变成隔离的子代理调用。',
      },
      isolation: {
        title: '上下文隔离',
        body: '中间记录留在运行时内部。只有最终阶段的结果会进入你的对话。',
      },
      resume: {
        title: '跨会话续跑',
        body: '暂停或失败的运行从断点继续。重新运行时自动跳过已缓存阶段。',
      },
    },
    code: {
      label: 'review-changes.json',
      caption: '一个完整的审查工作流：发现文件、并行审查、然后汇总。',
    },
    stats: {
      heading: '数据一览',
      hosts: {
        value: '4 个宿主',
        label: 'Pi、Codex、Claude Code、OpenCode',
      },
      phases: {
        value: '10 种阶段类型',
        label: 'agent、map、gate、reduce 等',
      },
      deps: {
        value: '0 个运行时依赖',
        label: '零生产依赖',
      },
      resume: {
        value: '跨会话续跑',
        label: '从断点继续运行',
      },
    },
    comparison: {
      heading: '声明式 vs 命令式',
      subheading: '为什么把智能体工作流声明为数据，而不是写成脚本？',
      aspectHeader: '维度',
      declarativeHeader: '声明式',
      imperativeHeader: '命令式',
      link: '了解更多',
      rows: [
        {
          aspect: '花费 token 前可验证',
          declarative: '在任何模型调用前检查 DAG 的循环、死路和预算。',
          imperative: 'bug 在运行时才暴露，此时已经花了钱。',
        },
        {
          aspect: '上下文成本',
          declarative: '只有最终结果返回上下文。',
          imperative: '每次子代理的完整记录都会涌入宿主对话。',
        },
        {
          aspect: '失败后续跑',
          declarative: '重新运行时自动跳过已缓存阶段。',
          imperative: '从头开始重新运行。',
        },
        {
          aspect: '可复用性',
          declarative: '保存、版本化并按名称调用。',
          imperative: '每次运行之间复制粘贴脚本。',
        },
      ],
    },
    testimonials: {
      heading: '早期用户反馈',
      quotes: [
        {
          body: '我们把一份 50 个文件的安全审查，从上下文窗口灾难变成了 10 分钟的 taskflow。',
          role: '平台工程师，B 轮初创公司',
        },
        {
          body: '光是跨会话续跑就帮我们省了几个小时。运行死在汇总阶段时，我们只需继续它。',
          role: '资深工程师，AI 基础设施',
        },
        {
          body: '锦标赛阶段生成的标题和发布说明草稿，始终优于我们的单轮生成。',
          role: '开发者布道师，开源工具',
        },
      ],
    },
    cta: {
      title: '准备好声明你的第一个 DAG 了吗？',
      body: '在 Pi 或 Codex 上安装，几分钟内运行多阶段工作流。',
      docs: '阅读文档',
      templates: '浏览模板',
      community: '加入社区',
    },
  },
};

const SITE_URL = 'https://heggria.github.io/taskflow';

const codeExample = `{
  "name": "review-changes",
  "concurrency": 4,
  "phases": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "scout",
      "output": "json",
      "task": "List changed source files under src/. Output ONLY a JSON array of {path} objects."
    },
    {
      "id": "review-each",
      "type": "map",
      "over": "{steps.discover.json}",
      "as": "file",
      "agent": "security-reviewer",
      "dependsOn": ["discover"],
      "task": "Review {file.path} for security risks. Return one paragraph."
    },
    {
      "id": "summarize",
      "type": "reduce",
      "from": ["review-each"],
      "agent": "writer",
      "dependsOn": ["review-each"],
      "final": true,
      "task": "Combine these reviews into one prioritized risk summary."
    }
  ]
}`;

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: Locale }>;
}) {
  const { lang } = await params;
  const t = translations[lang] ?? translations.en;

  const featureList = [
    {
      icon: Network,
      title: t.features.dag.title,
      body: t.features.dag.body,
    },
    {
      icon: Zap,
      title: t.features.isolation.title,
      body: t.features.isolation.body,
    },
    {
      icon: RefreshCw,
      title: t.features.resume.title,
      body: t.features.resume.body,
    },
  ] as const;

  const statsList = [
    { icon: Server, value: t.stats.hosts.value, label: t.stats.hosts.label },
    { icon: Layers, value: t.stats.phases.value, label: t.stats.phases.label },
    { icon: Package, value: t.stats.deps.value, label: t.stats.deps.label },
    { icon: History, value: t.stats.resume.value, label: t.stats.resume.label },
  ] as const;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'taskflow',
    description: t.valueProp,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    url: `${SITE_URL}/${lang}/`,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Organization',
      name: 'heggria',
      url: 'https://github.com/heggria',
    },
  };

  return (
    <HomeLayout
      i18n
      githubUrl="https://github.com/heggria/taskflow"
      nav={{
        title: 'taskflow',
        url: `/${lang}`,
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="relative overflow-hidden">
        <div className="bg-hero-glow absolute inset-x-0 top-0 h-[600px]" />
        <div className="bg-grid absolute inset-0 opacity-50" />

        <section className="relative mx-auto flex max-w-[1200px] flex-col items-center px-6 pb-20 pt-24 text-center md:pt-32">
          <div className="inline-flex items-center gap-2 rounded-full border bg-fd-card px-4 py-1.5 text-sm text-fd-muted-foreground shadow-sm">
            <Terminal className="size-4" aria-hidden="true" />
            <span>{t.badge}</span>
          </div>

          <h1 className="mt-8 text-5xl font-bold tracking-tight sm:text-6xl md:text-7xl">
            <span className="text-gradient">{t.title}</span>
          </h1>

          <p className="mt-5 max-w-2xl text-2xl font-semibold tracking-tight text-fd-foreground md:text-3xl">
            {t.tagline}
          </p>

          <p className="mt-4 max-w-2xl text-base text-fd-muted-foreground md:text-lg">
            {t.valueProp}
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`/${lang}/docs/getting-started`}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-fd-primary px-7 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 transition-all hover:bg-fd-primary/90 hover:shadow-fd-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {t.getStarted}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href={`/${lang}/docs/what-is-taskflow`}
              className="inline-flex h-11 items-center justify-center rounded-full border bg-fd-background/50 px-7 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {t.whatIs}
            </Link>
            <a
              href="https://github.com/heggria/taskflow"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full border bg-fd-background/50 px-7 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {t.github}
            </a>
          </div>

          <figure
            className="mt-16 w-full max-w-3xl overflow-hidden rounded-2xl border bg-fd-card text-left shadow-2xl"
            aria-label={t.code.label}
          >
            <figcaption className="flex items-center gap-2 border-b bg-fd-muted/50 px-4 py-3">
              <div className="flex gap-1.5" aria-hidden="true">
                <div className="size-3 rounded-full bg-red-400" />
                <div className="size-3 rounded-full bg-amber-400" />
                <div className="size-3 rounded-full bg-green-400" />
              </div>
              <span className="ml-2 text-xs font-medium text-fd-muted-foreground">
                {t.code.label}
              </span>
            </figcaption>
            <pre className="overflow-x-auto p-5 text-sm leading-relaxed">
              <code className="font-mono text-fd-foreground">{codeExample}</code>
            </pre>
          </figure>
          <p className="mt-3 max-w-xl text-sm text-fd-muted-foreground">
            {t.code.caption}
          </p>
        </section>
      </div>

      <section
        className="mx-auto max-w-[1200px] px-6 py-12"
        aria-labelledby="stats-heading"
      >
        <h2
          id="stats-heading"
          className="text-center text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t.stats.heading}
        </h2>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statsList.map((stat) => (
            <div
              key={stat.label}
              className="rounded-2xl border bg-fd-card p-6 text-center transition-shadow hover:shadow-md"
            >
              <div className="mx-auto inline-flex rounded-xl bg-fd-primary/10 p-3 text-fd-primary">
                <stat.icon className="size-6" aria-hidden="true" />
              </div>
              <p className="mt-4 text-2xl font-bold">{stat.value}</p>
              <p className="mt-1 text-sm text-fd-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        className="mx-auto max-w-[1200px] px-6 py-20"
        aria-labelledby="features-heading"
      >
        <h2
          id="features-heading"
          className="text-center text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t.featureHeading}
        </h2>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {featureList.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-2xl border bg-fd-card p-7 transition-shadow hover:shadow-lg"
            >
              <div className="inline-flex rounded-xl bg-fd-primary/10 p-3 text-fd-primary transition-colors group-hover:bg-fd-primary/15">
                <feature.icon className="size-7" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-xl font-semibold">{feature.title}</h3>
              <p className="mt-2 text-fd-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        className="mx-auto max-w-[1200px] px-6 py-20"
        aria-labelledby="comparison-heading"
      >
        <div className="text-center">
          <h2
            id="comparison-heading"
            className="text-3xl font-bold tracking-tight md:text-4xl"
          >
            {t.comparison.heading}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-fd-muted-foreground">
            {t.comparison.subheading}
          </p>
        </div>

        <div className="mt-10 overflow-x-auto rounded-2xl border bg-fd-card">
          <table className="w-full min-w-[600px] text-left">
            <thead>
              <tr className="border-b bg-fd-muted/50">
                <th className="px-6 py-4 text-sm font-semibold">
                  {t.comparison.aspectHeader}
                </th>
                <th className="px-6 py-4 text-sm font-semibold">
                  {t.comparison.declarativeHeader}
                </th>
                <th className="px-6 py-4 text-sm font-semibold">
                  {t.comparison.imperativeHeader}
                </th>
              </tr>
            </thead>
            <tbody>
              {t.comparison.rows.map((row, index) => (
                <tr key={index} className="border-b last:border-b-0">
                  <td className="px-6 py-4 font-medium">{row.aspect}</td>
                  <td className="px-6 py-4 text-fd-muted-foreground">
                    {row.declarative}
                  </td>
                  <td className="px-6 py-4 text-fd-muted-foreground">
                    {row.imperative}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 text-center">
          <Link
            href={`/${lang}/docs/what-is-taskflow`}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full border bg-fd-background/50 px-7 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            {t.comparison.link}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section
        className="mx-auto max-w-[1200px] px-6 py-20"
        aria-labelledby="testimonials-heading"
      >
        <h2
          id="testimonials-heading"
          className="text-center text-3xl font-bold tracking-tight md:text-4xl"
        >
          {t.testimonials.heading}
        </h2>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {t.testimonials.quotes.map((quote, index) => (
            <div
              key={index}
              className="flex flex-col rounded-2xl border bg-fd-card p-7"
            >
              <Quote
                className="size-8 text-fd-primary/40"
                aria-hidden="true"
              />
              <p className="mt-4 flex-1 text-lg font-medium leading-relaxed">
                {quote.body}
              </p>
              <p className="mt-6 text-sm text-fd-muted-foreground">{quote.role}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y bg-fd-muted/30">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center px-6 py-20 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            {t.cta.title}
          </h2>
          <p className="mt-4 max-w-xl text-lg text-fd-muted-foreground">
            {t.cta.body}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`/${lang}/docs`}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-fd-primary px-7 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 transition-all hover:bg-fd-primary/90 hover:shadow-fd-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <BookOpen className="size-4" aria-hidden="true" />
              {t.cta.docs}
            </Link>
            <a
              href="https://github.com/heggria/taskflow/tree/main/examples"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full border bg-fd-background/50 px-7 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              {t.cta.templates}
            </a>
            <a
              href="https://github.com/heggria/taskflow/discussions"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full border bg-fd-background/50 px-7 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              <Users className="size-4" aria-hidden="true" />
              {t.cta.community}
            </a>
          </div>
        </div>
      </section>
    </HomeLayout>
  );
}
