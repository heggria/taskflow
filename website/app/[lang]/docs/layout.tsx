import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';

export default async function DocsLayoutPage({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const tree = source.pageTree[lang];

  return (
    <DocsLayout
      tree={tree}
      nav={{
        title: 'taskflow',
        url: `/${lang}`,
      }}
      githubUrl="https://github.com/heggria/taskflow"
      sidebar={{
        defaultOpenLevel: 1,
      }}
      i18n
    >
      {children}
    </DocsLayout>
  );
}
