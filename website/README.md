# taskflow website

Documentation site for taskflow, built with [Fumadocs](https://fumadocs.vercel.app) + [Next.js](https://nextjs.org).

## Tech stack

- Next.js 16 (App Router, static export)
- React 19
- Fumadocs 16 + Fumadocs MDX
- Tailwind CSS 4
- TypeScript 6

## Development

This site is part of the npm workspace. Run commands from the monorepo root:

```bash
npm install
npm run dev -w taskflow-website
```

## Build

```bash
npm run build -w taskflow-website
```

Static output is written to `website/dist`.

## Internationalization

Content lives in `content/docs/<locale>/`. Currently:

- `en` — English
- `zh-cn` — 简体中文

Add a new locale by:

1. Adding it to `lib/i18n.ts`.
2. Creating a matching docs collection in `source.config.ts`.
3. Adding translated content under `content/docs/<locale>/`.

## Deployment

GitHub Pages via `.github/workflows/deploy-website.yml`.

The site is deployed to `https://heggria.github.io/taskflow/`.
