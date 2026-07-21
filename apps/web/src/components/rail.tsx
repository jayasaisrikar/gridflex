'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * N3 Side-rail, operator variant.
 *
 * Hallmark's N3 is a thin editorial strip with dot indicators. An operator
 * console needs named destinations — a dot cannot tell you whether you are
 * looking at Telemetry or Audit at 3am. The archetype's *structure* (fixed
 * left rail, persistent, section-indexed) is kept; the labels are made explicit.
 *
 * Navigation is spec §16.1, in order.
 */
const DESTINATIONS = [
  { href: '/console', label: 'Overview' },
  { href: '/console/telemetry', label: 'Telemetry' },
  { href: '/console/envelope', label: 'Envelope' },
  { href: '/console/drills', label: 'Drills' },
  { href: '/console/passport', label: 'Passport' },
  { href: '/console/facility', label: 'Facility & Safety' },
  { href: '/console/connectors', label: 'Connectors' },
  { href: '/console/audit', label: 'Audit' },
] as const;

export function Rail() {
  const pathname = usePathname();

  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail__brand">
        <Link href="/" className="rail__wordmark" style={{ textDecoration: 'none' }}>GridFlex</Link>
        <span className="rail__version">v1</span>
      </div>

      <ul className="rail__nav">
        {DESTINATIONS.map((destination) => {
          const isCurrent =
            destination.href === '/console'
              ? pathname === '/console'
              : pathname.startsWith(destination.href);

          return (
            <li key={destination.href}>
              <Link
                className="rail__link"
                href={destination.href}
                {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
              >
                {destination.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="rail__foot">
        <div className="rail__version" style={{ lineHeight: 1.6 }}>
          Lone Star Compute
          <br />
          ERCOT · America/Chicago
        </div>
      </div>
    </nav>
  );
}
