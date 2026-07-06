import type { ReactNode } from 'react';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

const site = {
  en: {
    title: 'taskflow',
    description:
      'A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command.',
  },
  'zh-cn': {
    title: 'taskflow',
    description:
      '面向编程智能体子代理的声明式、可验证任务节点图。支持 fan-out、gate、loop、断点续跑，并保存为命令。',
  },
} as const;

// Replace this with the actual content from Google Search Console HTML tag verification.
// Example: 'abc123...'
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';

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
      template: `%s | ${meta.title}`,
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
      icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    },
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
