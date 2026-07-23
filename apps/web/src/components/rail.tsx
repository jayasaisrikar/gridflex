'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

const DESTINATIONS = [
  { href: '/console', label: 'Overview', hint: 'Readiness and next safe action' },
  { href: '/console/telemetry', label: 'Telemetry', hint: 'Load curve, quality, and quarantine' },
  { href: '/console/envelope', label: 'Envelope', hint: 'Capacity calculation and provenance' },
  { href: '/console/drills', label: 'Drills', hint: 'Plan, arm, run, and verify' },
  { href: '/console/passport', label: 'Passport', hint: 'Issue and export evidence' },
  { href: '/console/facility', label: 'Facility & Safety', hint: 'Constraints and mechanisms' },
  { href: '/console/connectors', label: 'Connectors', hint: 'Data sources and ingestion' },
  { href: '/console/audit', label: 'Audit', hint: 'Immutable operator activity' },
] as const;

type RailProps = {
  facilityName: string;
  facilityMeta: string;
  simulated: boolean;
};

export function Rail({ facilityName, facilityMeta, simulated }: RailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const menuRef = useRef<HTMLDialogElement>(null);
  const commandRef = useRef<HTMLDialogElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return DESTINATIONS;
    return DESTINATIONS.filter((destination) =>
      `${destination.label} ${destination.hint}`.toLocaleLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    const openCommand = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        showCommand();
      }
    };
    window.addEventListener('keydown', openCommand);
    return () => window.removeEventListener('keydown', openCommand);
  }, []);

  useEffect(() => {
    menuRef.current?.close();
    commandRef.current?.close();
  }, [pathname]);

  function showCommand() {
    setQuery('');
    setActiveIndex(0);
    commandRef.current?.showModal();
    window.requestAnimationFrame(() => commandInputRef.current?.focus());
  }

  function openResult(index: number) {
    const result = results[index];
    if (!result) return;
    commandRef.current?.close();
    router.push(result.href);
  }

  return (
    <>
      <aside className="rail" aria-label="Primary">
        <RailBrand />
        <button
          className="command-launcher"
          type="button"
          aria-haspopup="dialog"
          onClick={showCommand}
        >
          <span className="command-launcher__icon" aria-hidden="true" />
          <span>Go to…</span>
          <kbd>⌘K</kbd>
        </button>
        <DestinationList pathname={pathname} />
        <div className="rail__foot">
          <p className="rail__facility">{facilityName}</p>
          <p className="rail__version">{facilityMeta}</p>
          <SourceStatus simulated={simulated} />
          <form action="/logout" method="post">
            <button className="rail__signout" type="submit">Sign out</button>
          </form>
        </div>
      </aside>

      <header className="mobilebar">
        <button
          className="icon-control mobilebar__menu"
          type="button"
          aria-label="Open navigation"
          aria-haspopup="dialog"
          onClick={() => menuRef.current?.showModal()}
        >
          <span className="menu-glyph" aria-hidden="true" />
        </button>
        <Link href="/console" className="mobilebar__brand" prefetch={false}>GridFlex</Link>
        <button
          className="icon-control"
          type="button"
          aria-label="Open command menu"
          aria-haspopup="dialog"
          onClick={showCommand}
        >
          <span className="command-launcher__icon" aria-hidden="true" />
        </button>
      </header>

      <dialog
        className="mobile-sheet"
        ref={menuRef}
        aria-label="Console navigation"
        onClick={(event) => {
          if (event.target === event.currentTarget) menuRef.current?.close();
        }}
      >
        <div className="mobile-sheet__panel">
          <div className="mobile-sheet__head">
            <RailBrand />
            <button
              className="icon-control"
              type="button"
              aria-label="Close navigation"
              onClick={() => menuRef.current?.close()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <DestinationList pathname={pathname} onNavigate={() => menuRef.current?.close()} />
          <div className="mobile-sheet__facility">
            <strong>{facilityName}</strong>
            <span>{facilityMeta}</span>
            <SourceStatus simulated={simulated} />
            <form action="/logout" method="post">
              <button className="rail__signout" type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </dialog>

      <dialog
        className="command-dialog"
        ref={commandRef}
        aria-label="Search console pages"
        onClick={(event) => {
          if (event.target === event.currentTarget) commandRef.current?.close();
        }}
      >
        <div className="command-dialog__panel">
          <div className="command-dialog__field">
            <span className="command-launcher__icon" aria-hidden="true" />
            <label className="visually-hidden" htmlFor="console-command">Go to a console page</label>
            <input
              ref={commandInputRef}
              id="console-command"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.min(index + 1, results.length - 1));
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(index - 1, 0));
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  openResult(activeIndex);
                }
              }}
              placeholder="Search console pages"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="console-command-results"
              aria-activedescendant={results[activeIndex] ? `command-${activeIndex}` : undefined}
            />
            <kbd>esc</kbd>
          </div>
          <div className="command-dialog__group" id="console-command-results" role="listbox">
            <p className="command-dialog__label">
              {query ? `${results.length} matching pages` : 'Console pages'}
            </p>
            {results.map((destination, index) => (
              <button
                key={destination.href}
                id={`command-${index}`}
                className="command-dialog__result"
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => openResult(index)}
              >
                <span>{destination.label}</span>
                <small>{destination.hint}</small>
              </button>
            ))}
            {results.length === 0 ? (
              <p className="command-dialog__empty">No console page matches that search.</p>
            ) : null}
          </div>
          <div className="command-dialog__foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
      </dialog>
    </>
  );
}

function SourceStatus({ simulated }: { simulated: boolean }) {
  const label = simulated
    ? 'Source · simulated data present'
    : 'Source · manual upload or none';

  return (
    <div className="rail__session">
      <span
        className={`source-dot ${simulated ? 'source-dot--simulated' : ''}`}
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

function RailBrand() {
  return (
    <div className="rail__brand">
      <Link href="/console" className="rail__wordmark" prefetch={false}>GridFlex</Link>
      <span className="rail__version">pilot</span>
    </div>
  );
}

function DestinationList({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Console">
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
                prefetch={false}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
              >
                <span>{destination.label}</span>
                <span className="rail__current" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
