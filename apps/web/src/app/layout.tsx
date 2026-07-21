import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DM_Sans, IBM_Plex_Mono, Manrope } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted at build time via next/font. A control-room UI must not
 * depend on a third-party CDN at runtime, and spec §18 requires a strict CSP.
 */
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['normal'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

/** Professional display face with precise geometry and calmer proportions. */
const manrope = Manrope({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal'],
  variable: '--font-manrope',
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
      className={`${dmSans.variable} ${ibmPlexMono.variable} ${manrope.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
