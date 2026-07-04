import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs_en = defineDocs({
  dir: 'content/docs/en',
});

export const docs_zh = defineDocs({
  dir: 'content/docs/zh-cn',
});

export default defineConfig();
