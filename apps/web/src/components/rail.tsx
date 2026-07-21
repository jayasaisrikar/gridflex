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
  { href: '/', label: 'Overview' },
  { href: '/telemetry', label: 'Telemetry' },
  { href: '/envelope', label: 'Envelope' },
  { href: '/drills', label: 'Drills' },
  { href: '/passport', label: 'Passport' },
  { href: '/facility', label: 'Facility & Safety' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/audit', label: 'Audit' },
] as const;

export function Rail() {
  const pathname = usePathname();

  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail__brand">
        <span className="rail__wordmark">GridFlex</span>
        <span className="rail__version">v1</span>
      </div>

      <ul className="rail__nav">
        {DESTINATIONS.map((destination) => {
          const isCurrent =
            destination.href === '/'
              ? pathname === '/'
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
