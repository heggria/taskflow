import Link from 'next/link';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import {
  Network,
  ShieldCheck,
  Zap,
  RefreshCw,
  GitBranch,
  Globe,
  Terminal,
  Layers,
} from 'lucide-react';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

const translations = {
  en: {
    title: 'taskflow',
    subtitle: 'A declarative, verifiable graph of task nodes for coding-agent subagents.',
    description:
      'Not a workflow you script — a DAG you declare. Fan out, gate, loop, tournament, resume, and save as a command. Runs on Pi and Codex with zero runtime dependencies.',
    getStarted: 'Get Started',
    readDocs: 'Read the Docs',
    github: 'GitHub',
    sections: {
      why: 'Why taskflow?',
      whyDesc: 'Move the plan out of prose and into a verifiable graph.',
      imperative: {
        title: 'Imperative workflow',
        body: 'The model writes a script: await agent(), if, for, another await. The graph is hidden inside control flow and only exists as the code runs.',
      },
      declarative: {
        title: 'Declarative taskflow',
        body: 'You declare a graph of discrete task nodes connected by dependsOn edges. The runtime verifies that graph before it spends a single token.',
      },
      features: 'Everything you need to orchestrate agents',
      cta: 'Ready to declare your first DAG?',
      ctaDesc: 'Install on Pi or Codex and run a multi-phase workflow in seconds.',
    },
    badge: 'Zero runtime dependencies',
    codeCaption: 'A declarative DAG with fan-out, gate, and resume.',
  },
  'zh-cn': {
    title: 'taskflow',
    subtitle: '面向编程智能体子代理的声明式、可验证任务节点图。',
    description:
      '不是脚本化的 workflow，而是声明式的 DAG。支持 fan-out、gate、loop、tournament、断点续跑，并保存为命令。支持 Pi 与 Codex，零运行时依赖。',
    getStarted: '开始使用',
    readDocs: '阅读文档',
    github: 'GitHub',
    sections: {
      why: '为什么用 taskflow？',
      whyDesc: '把计划从自然语言搬进可验证的图。',
      imperative: {
        title: '命令式 workflow',
        body: '模型写出一个脚本：await agent()、if、for、又一个 await。图隐藏在控制流中，只有在代码运行时才存在。',
      },
      declarative: {
        title: '声明式 taskflow',
        body: '你声明一个由 dependsOn 边连接的离散任务节点图。运行时在消耗任何 token 之前就验证该图。',
      },
      features: '编排智能体所需的一切',
      cta: '准备好声明你的第一个 DAG 了吗？',
      ctaDesc: '在 Pi 或 Codex 上安装，几秒即可运行多阶段工作流。',
    },
    badge: '零运行时依赖',
    codeCaption: '一个声明式 DAG：fan-out、gate、断点续跑。',
  },
};

const features = {
  en: [
    {
      icon: Network,
      title: 'Declarative DAG',
      description: 'Define multi-phase workflows as data, not imperative scripts.',
    },
    {
      icon: ShieldCheck,
      title: 'Static Verification',
      description: 'Catch cycles, dead ends, dangling refs, and budget overflow before execution.',
    },
    {
      icon: Zap,
      title: 'Context Isolation',
      description: 'Only the final phase reaches your conversation; intermediates stay in the runtime.',
    },
    {
      icon: RefreshCw,
      title: 'Cross-session Resume',
      description: 'Re-run flows; cached phases auto-skip.',
    },
    {
      icon: GitBranch,
      title: 'Dynamic Fan-out',
      description: 'Map over arrays, route with conditions, and join branches with `any`/`all`.',
    },
    {
      icon: Globe,
      title: 'Multi-host',
      description: 'Runs on the Pi coding agent and on OpenAI Codex via MCP.',
    },
    {
      icon: Terminal,
      title: 'Save as Command',
      description: 'Persist flows as `/tf:<name>` on Pi or by name on Codex.',
    },
    {
      icon: Layers,
      title: 'Zero Runtime Deps',
      description: 'The core engine has no runtime dependencies.',
    },
  ],
  'zh-cn': [
    {
      icon: Network,
      title: '声明式 DAG',
      description: '将多阶段工作流定义为数据，而非命令式脚本。',
    },
    {
      icon: ShieldCheck,
      title: '静态验证',
      description: '在执行前捕获循环、死胡同、悬空引用和预算溢出。',
    },
    {
      icon: Zap,
      title: '上下文隔离',
      description: '只有最终阶段的结果进入对话上下文，中间结果留在运行时。',
    },
    {
      icon: RefreshCw,
      title: '跨会话续跑',
      description: '重新运行工作流时自动跳过已缓存阶段。',
    },
    {
      icon: GitBranch,
      title: '动态 Fan-out',
      description: '对数组做 map、按条件路由、用 any/all 合并分支。',
    },
    {
      icon: Globe,
      title: '多宿主',
      description: '运行在 Pi 编程智能体上，也通过 MCP 运行在 OpenAI Codex 上。',
    },
    {
      icon: Terminal,
      title: '保存为命令',
      description: '在 Pi 上保存为 /tf:<name>，在 Codex 上按名称调用。',
    },
    {
      icon: Layers,
      title: '零运行时依赖',
      description: '核心引擎没有任何运行时依赖。',
    },
  ],
};

const codeExample = `{
  "name": "audit-and-fix",
  "budget": { "maxUSD": 2.0 },
  "phases": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "scout",
      "output": "json",
      "task": "List routes under src/routes as JSON [{route,file}]."
    },
    {
      "id": "audit",
      "type": "map",
      "over": "{steps.discover.json}",
      "as": "item",
      "agent": "analyst",
      "dependsOn": ["discover"],
      "task": "Audit {item.route} for missing auth."
    },
    {
      "id": "review",
      "type": "gate",
      "agent": "reviewer",
      "dependsOn": ["audit"],
      "task": "Review findings. End with VERDICT: PASS or BLOCK."
    },
    {
      "id": "report",
      "type": "reduce",
      "from": ["review"],
      "agent": "writer",
      "dependsOn": ["review"],
      "final": true,
      "task": "Write a final report."
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
  const feats = features[lang] ?? features.en;

  return (
    <HomeLayout i18n githubUrl="https://github.com/heggria/taskflow">
      <div className="relative overflow-hidden">
        <div className="bg-hero-glow absolute inset-x-0 top-0 h-[600px]" />
        <div className="bg-grid absolute inset-0 opacity-50" />

        <section className="relative mx-auto flex max-w-[1400px] flex-col items-center px-6 pb-24 pt-24 text-center md:pt-32">
          <div className="inline-flex items-center gap-2 rounded-full border bg-fd-card px-4 py-1.5 text-sm text-fd-muted-foreground shadow-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fd-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-fd-primary" />
            </span>
            {t.badge}
          </div>

          <h1 className="mt-8 text-6xl font-bold tracking-tight sm:text-7xl md:text-8xl">
            <span className="text-gradient">{t.title}</span>
          </h1>

          <p className="mt-6 max-w-3xl text-xl text-fd-muted-foreground md:text-2xl">
            {t.subtitle}
          </p>
          <p className="mt-4 max-w-2xl text-base text-fd-muted-foreground/80 md:text-lg">
            {t.description}
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-4">
            <Link
              href={`/${lang}/docs`}
              className="inline-flex h-11 items-center justify-center rounded-full bg-fd-primary px-8 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 transition-all hover:bg-fd-primary/90 hover:shadow-fd-primary/40"
            >
              {t.getStarted}
            </Link>
            <Link
              href={`/${lang}/docs`}
              className="inline-flex h-11 items-center justify-center rounded-full border bg-fd-background/50 px-8 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent"
            >
              {t.readDocs}
            </Link>
            <a
              href="https://github.com/heggria/taskflow"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center rounded-full border bg-fd-background/50 px-8 text-sm font-semibold backdrop-blur-sm transition-colors hover:bg-fd-accent"
            >
              {t.github}
            </a>
          </div>

          <div className="mt-16 w-full max-w-3xl overflow-hidden rounded-2xl border bg-fd-card shadow-2xl">
            <div className="flex items-center gap-2 border-b bg-fd-muted/50 px-4 py-3">
              <div className="h-3 w-3 rounded-full bg-red-400" />
              <div className="h-3 w-3 rounded-full bg-amber-400" />
              <div className="h-3 w-3 rounded-full bg-green-400" />
              <span className="ml-2 text-xs text-fd-muted-foreground">taskflow.json</span>
            </div>
            <pre className="overflow-x-auto p-5 text-left text-sm leading-relaxed">
              <code className="font-mono text-fd-foreground">{codeExample}</code>
            </pre>
          </div>
          <p className="mt-3 text-sm text-fd-muted-foreground">{t.codeCaption}</p>
        </section>
      </div>

      <section className="mx-auto max-w-[1400px] px-6 py-24">
        <div className="text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">{t.sections.why}</h2>
          <p className="mt-4 text-lg text-fd-muted-foreground">{t.sections.whyDesc}</p>
        </div>

        <div className="mt-16 grid gap-8 md:grid-cols-2">
          <div className="rounded-2xl border bg-fd-card p-8">
            <h3 className="text-xl font-semibold">{t.sections.imperative.title}</h3>
            <p className="mt-3 text-fd-muted-foreground">{t.sections.imperative.body}</p>
          </div>
          <div className="rounded-2xl border bg-fd-primary/5 p-8 ring-1 ring-fd-primary/20">
            <h3 className="text-xl font-semibold text-fd-primary">{t.sections.declarative.title}</h3>
            <p className="mt-3 text-fd-muted-foreground">{t.sections.declarative.body}</p>
          </div>
        </div>
      </section>

      <section className="border-y bg-fd-muted/30">
        <div className="mx-auto max-w-[1400px] px-6 py-24">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              {t.sections.features}
            </h2>
          </div>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {feats.map((feature) => (
              <div
                key={feature.title}
                className="group rounded-xl border bg-fd-card p-6 transition-shadow hover:shadow-lg"
              >
                <div className="inline-flex rounded-lg bg-fd-primary/10 p-3 text-fd-primary">
                  <feature.icon className="size-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
                <p className="mt-2 text-sm text-fd-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1400px] px-6 py-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">{t.sections.cta}</h2>
        <p className="mt-4 text-lg text-fd-muted-foreground">{t.sections.ctaDesc}</p>
        <div className="mt-8 flex justify-center gap-4">
          <Link
            href={`/${lang}/docs/getting-started`}
            className="inline-flex h-11 items-center justify-center rounded-full bg-fd-primary px-8 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 transition-all hover:bg-fd-primary/90"
          >
            {t.getStarted}
          </Link>
        </div>
      </section>
    </HomeLayout>
  );
}
