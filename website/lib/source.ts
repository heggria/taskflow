import { docs_en, docs_zh } from '@/.source/server';
import { loader } from 'fumadocs-core/source';
import { i18n } from './i18n';

export const source = loader({
  baseUrl: '/docs',
  i18n,
  source: {
    en: docs_en.toFumadocsSource(),
    'zh-cn': docs_zh.toFumadocsSource(),
  },
});
