import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Geist, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted at build time via next/font. A control-room UI must not
 * depend on a third-party CDN at runtime, and spec §18 requires a strict CSP.
 */
const geist = Geist({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-geist',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
});

/** Marketing display face: a technical grotesk with enough character for large type. */
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'GridFlex — Flexibility Assurance',
  description:
    'Prove how much load a data centre can safely shed, how fast, for how long — with every number traceable to telemetry, constraints, and immutable evidence.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
