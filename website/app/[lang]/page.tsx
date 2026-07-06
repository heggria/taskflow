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
    cta: {
      title: 'Ready to declare your first DAG?',
      body: 'Install on Pi or Codex and run a multi-phase workflow in minutes.',
      action: 'Read the docs',
    },
  },
  'zh-cn': {
    title: 'taskflow',
    tagline: '声明式智能体编排。',
    valueProp:
      '把多步骤编程智能体工作描述成 DAG，在花费 token 之前验证它，并且只把最终结果返回到你的上下文窗口。',
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
    cta: {
      title: '准备好声明你的第一个 DAG 了吗？',
      body: '在 Pi 或 Codex 上安装，几分钟内运行多阶段工作流。',
      action: '阅读文档',
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
            <span>Zero runtime dependencies</span>
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

      <section className="border-y bg-fd-muted/30">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center px-6 py-20 text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            {t.cta.title}
          </h2>
          <p className="mt-4 max-w-xl text-lg text-fd-muted-foreground">
            {t.cta.body}
          </p>
          <div className="mt-8">
            <Link
              href={`/${lang}/docs`}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-fd-primary px-8 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 transition-all hover:bg-fd-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {t.cta.action}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>
    </HomeLayout>
  );
}
