import { ImageResponse } from 'next/og';
import { i18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'taskflow';

const og = {
  en: {
    tagline: 'Declarative agent orchestration',
    value: 'A verifiable DAG of task nodes for coding-agent subagents.',
  },
  'zh-cn': {
    tagline: '声明式智能体编排',
    value: '面向编程智能体子代理的可验证任务节点 DAG。',
  },
} as const;

export default async function Image({
  params,
}: {
  params: Promise<{ lang: Locale }>;
}) {
  const { lang } = await params;
  const t = og[lang] ?? og.en;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'hsl(40 33% 96%)',
          color: 'hsl(30 10% 10%)',
          padding: 64,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 24,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 18,
              background: '#e07b39',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 24px rgba(224, 123, 57, 0.25)',
            }}
          >
            <svg
              width="44"
              height="44"
              viewBox="0 0 100 100"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="28" cy="35" r="10" fill="#fff" />
              <circle cx="72" cy="35" r="10" fill="#fff" />
              <circle cx="50" cy="72" r="12" fill="#fff" />
              <line
                x1="36"
                y1="40"
                x2="42"
                y2="63"
                stroke="#fff"
                strokeWidth="6"
                strokeLinecap="round"
              />
              <line
                x1="64"
                y1="40"
                x2="58"
                y2="63"
                stroke="#fff"
                strokeWidth="6"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span
            style={{
              fontSize: 64,
              fontWeight: 800,
              letterSpacing: '-0.04em',
              color: 'hsl(30 10% 10%)',
            }}
          >
            taskflow
          </span>
        </div>

        <p
          style={{
            fontSize: 40,
            fontWeight: 700,
            color: 'hsl(30 100% 42%)',
            marginBottom: 16,
          }}
        >
          {t.tagline}
        </p>

        <p
          style={{
            fontSize: 28,
            color: 'hsl(30 5% 35%)',
            maxWidth: 900,
            lineHeight: 1.4,
          }}
        >
          {t.value}
        </p>
      </div>
    ),
    { ...size }
  );
}
