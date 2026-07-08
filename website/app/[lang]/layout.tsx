import type { ReactNode } from 'react';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

const site = {
  en: {
    // Full SEO title for the homepage / OG cards. Subpages use `brand` in the
    // `%s | taskflow` template below, so individual pages stay short.
    title: 'taskflow — Declarative DAG Orchestration for Coding Agents',
    brand: 'taskflow',
    description:
      'A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command.',
  },
  'zh-cn': {
    title: 'taskflow — 面向编程智能体的声明式 DAG 任务编排',
    brand: 'taskflow',
    description:
      '面向编程智能体子代理的声明式、可验证任务节点图。支持 fan-out、gate、loop、断点续跑，并保存为命令。',
  },
} as const;

// Google Search Console ownership verification (HTML-tag method). This value is
// public by design — it is safe to commit. Overridable via env for builds that
// want to keep it out of the repo.
const GOOGLE_SITE_VERIFICATION =
  process.env.GOOGLE_SITE_VERIFICATION ||
  'iBm6KBJfiBJLOmW6jAtJCJlCbTiP7W9PhrDW6afMltw';

// The site is deployed under a GitHub Pages subpath (/taskflow), so every
// metadata asset URL (favicon, apple-touch-icon, manifest, icon PNGs) must be
// prefixed with the configured basePath. Next.js does NOT apply basePath to
// <link rel="icon"> / <link rel="manifest"> under `output: export`, so we do
// it explicitly here. Locally (TASKFLOW_BASE_PATH unset) this is just ''.
const base = process.env.TASKFLOW_BASE_PATH || '';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: Locale }>;
}) {
  const { lang } = await params;
  const meta = site[lang] ?? site.en;

  return {
    metadataBase: new URL('https://heggria.github.io/taskflow'),
    title: {
      default: meta.title,
      template: `%s | ${meta.brand}`,
    },
    description: meta.description,
    alternates: {
      canonical: `/${lang}/`,
      languages: {
        en: '/en/',
        'zh-CN': '/zh-cn/',
        'x-default': '/en/',
      },
    },
    icons: {
      // Explicit basePath — Next.js omits it for <link> under output:export.
      icon: [{ url: `${base}/favicon.svg`, type: 'image/svg+xml' }],
      apple: [{ url: `${base}/apple-icon`, sizes: '180x180', type: 'image/png' }],
    },
    // themeColor + appleWebApp pair with app/manifest.ts and app/apple-icon.tsx
    // so Safari/iOS/Android render a branded tab, splash, and home-screen icon.
    themeColor: [
      { media: '(prefers-color-scheme: light)', color: '#fff7ed' },
      { media: '(prefers-color-scheme: dark)', color: '#1c1917' },
    ],
    appleWebApp: {
      title: 'taskflow',
      statusBarStyle: 'default',
      capable: true,
    },
    manifest: `${base}/manifest.webmanifest`,
    verification: GOOGLE_SITE_VERIFICATION
      ? { google: GOOGLE_SITE_VERIFICATION }
      : undefined,
    openGraph: {
      title: meta.title,
      description: meta.description,
      images: '/opengraph-image',
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      images: '/opengraph-image',
    },
  };
}

export default async function LangLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  return (
    <I18nProvider {...i18n.provider(lang)}>
      {children}
    </I18nProvider>
  );
}
