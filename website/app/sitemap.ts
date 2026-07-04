import { MetadataRoute } from 'next';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

const baseUrl = 'https://heggria.github.io/taskflow';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = source.getPages();

  const docsUrls = pages.map((page) => ({
    url: `${baseUrl}${page.url}/`,
    lastModified: new Date(),
    changeFrequency: 'weekly' as const,
    priority: page.url === '/docs' || page.url === '/en/docs' || page.url === '/zh-cn/docs' ? 0.9 : 0.7,
  }));

  return [
    { url: `${baseUrl}/`, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: `${baseUrl}/en/`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    { url: `${baseUrl}/zh-cn/`, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.9 },
    ...docsUrls,
  ];
}
