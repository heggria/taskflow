import type { ReactNode } from 'react';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import { i18n } from '@/lib/i18n';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
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
