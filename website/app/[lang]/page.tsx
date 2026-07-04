import Link from 'next/link';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

const translations = {
  en: {
    title: 'taskflow',
    subtitle: 'A declarative, verifiable graph of task nodes for coding-agent subagents.',
    description:
      'Not a workflow you script — a DAG you declare. Fan out, gate, loop, tournament, resume, and save as a command. Runs on Pi and Codex.',
    getStarted: 'Get Started',
    viewDocs: 'View Docs',
    features: [
      {
        title: 'Declarative DAG',
        description: 'Define multi-phase workflows as data, not imperative scripts.',
      },
      {
        title: 'Static Verification',
        description: 'Catch cycles, dead ends, and dangling refs before spending a token.',
      },
      {
        title: 'Context Isolation',
        description: 'Only the final phase reaches your conversation.',
      },
      {
        title: 'Cross-session Resume',
        description: 'Cached phases auto-skip when you resume a run.',
      },
    ],
  },
  'zh-cn': {
    title: 'taskflow',
    subtitle: '面向编程智能体子代理的声明式、可验证任务节点图。',
    description:
      '不是脚本化的 workflow，而是声明式的 DAG。支持 fan-out、gate、loop、tournament、断点续跑，并保存为命令。支持 Pi 与 Codex。',
    getStarted: '开始使用',
    viewDocs: '查看文档',
    features: [
      {
        title: '声明式 DAG',
        description: '将多阶段工作流定义为数据，而非命令式代码。',
      },
      {
        title: '静态验证',
        description: '在消耗任何 token 之前捕获循环、死胡同和悬空引用。',
      },
      {
        title: '上下文隔离',
        description: '只有最终阶段的结果进入你的对话上下文。',
      },
      {
        title: '跨会话续跑',
        description: '恢复运行时自动跳过已缓存阶段。',
      },
    ],
  },
};

export default async function HomePage({
  params,
}: {
  params: Promise<{ lang: Locale }>;
}) {
  const { lang } = await params;
  const t = translations[lang] ?? translations.en;

  return (
    <HomeLayout i18n githubUrl="https://github.com/heggria/taskflow">
      <main className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">
          {t.title}
        </h1>
        <p className="mt-6 max-w-2xl text-xl text-fd-muted-foreground">
          {t.subtitle}
        </p>
        <p className="mt-4 max-w-2xl text-base text-fd-muted-foreground">
          {t.description}
        </p>
        <div className="mt-10 flex gap-4">
          <Link
            href={`/${lang}/docs`}
            className="inline-flex items-center justify-center rounded-lg bg-fd-primary px-6 py-3 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            {t.getStarted}
          </Link>
          <Link
            href={`/${lang}/docs`}
            className="inline-flex items-center justify-center rounded-lg border px-6 py-3 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            {t.viewDocs}
          </Link>
        </div>

        <div className="mt-20 grid max-w-4xl gap-6 sm:grid-cols-2">
          {t.features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border bg-fd-card p-6 text-left"
            >
              <h3 className="text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>
    </HomeLayout>
  );
}
