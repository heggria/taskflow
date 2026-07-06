import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './globals.css';

/*
 * Fonts are loaded via next/font/google. The CSS variables (--font-sans /
 * --font-mono) are applied to <html> below and cascade to body/code; fumadocs
 * applies the `font-mono` utility to code blocks, so the variables are used.
 *
 * The browser console warning "... preloaded using link preload but not used"
 * is a known, harmless next/font behavior: next/font emits a preload <link>
 * for the font file, but `display: 'swap'` defers applying it until render.
 * `adjustFontFallback: false` disables the extra metric-override preload that
 * next/font injects, reducing preload overhead. We keep `display: 'swap'`.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  adjustFontFallback: false,
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  adjustFontFallback: false,
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="flex flex-col min-h-screen antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
