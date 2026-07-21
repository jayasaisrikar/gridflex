import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Geist, JetBrains_Mono } from 'next/font/google';
import { Rail } from '@/components/rail';
import './globals.css';

/**
 * Fonts are self-hosted at build time via next/font.
 *
 * Not just for zero-CLS: a control-room UI must not depend on a third-party CDN
 * at runtime, and spec §18 requires a strict CSP. Self-hosting keeps the font
 * origin the same as the app.
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

export const metadata: Metadata = {
  title: 'GridFlex — Flexibility Assurance',
  description:
    'Deterministic, evidence-backed flexibility assurance for large digital loads.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="shell">
          <Rail />
          <div className="main">
            {/*
              Spec 11 / 24: simulated data must be unmistakably labelled everywhere
              it appears. This bar is not dismissible while the facility is on the
              simulator connector.
            */}
            <div className="simbar" role="status">
              <span aria-hidden="true">◈</span>
              <span>
                SIMULATED — Lone Star Compute Facility is running the deterministic
                simulator. No value on this screen comes from physical equipment.
              </span>
            </div>
            {children}
            <footer className="foot-line">
              <span>GridFlex V1 · stages 1–3 of the trust ladder</span>
              <span>engine gridflex-envelope-1.0.0</span>
              <span>mrv gridflex-mrv-1.0.0</span>
              <span>canonical gridflex-canonical-1</span>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
