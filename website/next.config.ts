import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const withMDX = createMDX({
  configPath: './source.config.ts',
});

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'dist',
  basePath: process.env.TASKFLOW_BASE_PATH || '',
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: workspaceRoot,
  },
  trailingSlash: true,
};

export default withMDX(nextConfig);
