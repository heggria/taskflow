import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMDXComponents } from '@/components/mdx';

const SITE_URL = 'https://heggria.github.io/taskflow';

/**
 * Map a taskflow-website locale to a BCP-47 language tag for JSON-LD `inLanguage`.
 * `zh-cn` (used in URLs) maps to `zh-CN` (the canonical tag, matching the
 * `alternates.languages` entries emitted by the root layout).
 */
function bcp47Tag(lang: Locale): string {
  return lang === 'zh-cn' ? 'zh-CN' : 'en';
}

/** Title-case a slug segment as a last-resort label when no page exists for it. */
function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) =>
      part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part,
    )
    .join(' ');
}

export function generateStaticParams() {
  return source.generateParams();
}

export default async function Page({
  params,
}: {
  params: Promise<{ lang: Locale; slug?: string[] }>;
}) {
  const { lang, slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();

  const MDX = page.data.body;

  const canonicalUrl = `${SITE_URL}${page.url}/`;
  const language = bcp47Tag(lang);

  const techArticleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: page.data.title,
    description: page.data.description,
    url: canonicalUrl,
    inLanguage: language,
    author: {
      '@type': 'Organization',
      name: 'heggria',
      url: 'https://github.com/heggria',
    },
  };

  // Build the breadcrumb trail from the slug path:
  //   []                       → Home → Docs
  //   ['getting-started']      → Home → Docs → Getting Started
  //   ['concepts', 'phases']   → Home → Docs → Core Concepts → Phase Types
  // Intermediate segments resolve to their chapter index page (e.g.
  // `concepts/index.mdx`) so the label is the real page title, not invented.
  const segments = page.slugs;
  const homeLabel = lang === 'zh-cn' ? '首页' : 'Home';
  const docsLabel = lang === 'zh-cn' ? '文档' : 'Docs';

  const breadcrumbItems: { name: string; item: string }[] = [
    { name: homeLabel, item: `${SITE_URL}/${lang}/` },
    { name: docsLabel, item: `${SITE_URL}/${lang}/docs/` },
  ];

  // Intermediate segments (all but the last): look up the real page title.
  for (let i = 0; i < segments.length - 1; i++) {
    const segSlug = segments.slice(0, i + 1);
    const segSegment = segments[i];
    if (!segSegment) continue;
    const segPage = source.getPage(segSlug, lang);
    breadcrumbItems.push({
      name: segPage?.data.title ?? titleCaseSlug(segSegment),
      item: `${SITE_URL}${segPage?.url ?? `/${lang}/docs/${segSlug.join('/')}`}/`,
    });
  }

  // The last segment is the current page. Skip when there are no segments —
  // for the docs index, "Docs" is already the terminal item.
  if (segments.length > 0) {
    breadcrumbItems.push({
      name: page.data.title,
      item: canonicalUrl,
    });
  }

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbItems.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: entry.item,
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <DocsPage
        toc={page.data.toc}
        full={page.data.full}
      >
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    </>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: Locale; slug?: string[] }>;
}) {
  const { lang, slug } = await params;
  const page = source.getPage(slug, lang);
  if (!page) return {};

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
