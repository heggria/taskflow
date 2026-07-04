import { defineI18n } from 'fumadocs-core/i18n';
import { defineI18nUI } from 'fumadocs-ui/i18n';

const coreI18n = defineI18n({
  languages: ['en', 'zh-cn'],
  defaultLanguage: 'en',
});

export const i18n = defineI18nUI(coreI18n, {
  en: {
    search: 'Search',
    toc: 'On this page',
    language: 'Language',
    lastUpdated: 'Last updated',
    editOnGithub: 'Edit on GitHub',
    displayName: 'English',
  },
  'zh-cn': {
    search: '搜索',
    toc: '本页目录',
    language: '语言',
    lastUpdated: '最后更新',
    editOnGithub: '在 GitHub 上编辑',
    displayName: '简体中文',
  },
});

export type Locale = (typeof coreI18n)['languages'][number];
