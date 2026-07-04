import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

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
  trailingSlash: true,
};

export default withMDX(nextConfig);
