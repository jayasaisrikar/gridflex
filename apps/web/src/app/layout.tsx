import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

/**
 * The font binaries ship with the pinned Next runtime and are emitted as local
 * assets by next/font. Builds therefore remain reproducible without Google Font
 * network access, and the strict runtime CSP needs no third-party font origin.
 */
const bodyFont = localFont({
  src: '../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2',
  weight: '100 900',
  variable: '--font-geist',
  display: 'swap',
});

const monoFont = localFont({
  src: '../../node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2',
  weight: '100 900',
  variable: '--font-jetbrains',
  display: 'swap',
});

const displayFont = localFont({
  src: '../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2',
  weight: '100 900',
  variable: '--font-space-grotesk',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'GridFlex — Flexibility Assurance',
    template: '%s · GridFlex',
  },
  description:
    'Prove how much load a data centre can safely shed, how fast, for how long — with every number traceable to telemetry, constraints, and immutable evidence.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${bodyFont.variable} ${monoFont.variable} ${displayFont.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
