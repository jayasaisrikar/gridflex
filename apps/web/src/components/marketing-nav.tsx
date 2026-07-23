'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BrandLockup } from '@/components/brand';

const links = [
  { href: '#product', label: 'Product' },
  { href: '#passport', label: 'Flexibility Passport' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#ai', label: 'Forecast R&D' },
  { href: '#security', label: 'Security' },
  { href: '#use-cases', label: 'Use cases' },
  { href: '#architecture', label: 'Architecture' },
] as const;

export function MarketingNav() {
  const [floating, setFloating] = useState(false);
  const [open, setOpen] = useState(false);
  const floatingRef = useRef(false);

  useEffect(() => {
    let ticking = false;

    const update = () => {
      const next = window.scrollY > 80;
      if (next !== floatingRef.current) {
        floatingRef.current = next;
        setFloating(next);
      }
      ticking = false;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <header className={`mk-nav${floating ? ' is-floating' : ''}`}>
      <nav className="mk-nav__inner" aria-label="Primary navigation">
        <Link className="mk-wordmark" href="/" aria-label="GridFlex home">
          <BrandLockup />
        </Link>

        <div className="mk-nav__links" aria-label="Landing-page sections">
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>

        <a className="mk-button mk-button--nav" href="#pilot">
          Request a pilot
          <span aria-hidden="true">↗</span>
        </a>

        <button
          className="mk-menu-button"
          type="button"
          aria-expanded={open}
          aria-controls="mk-mobile-menu"
          aria-label={open ? 'Close navigation' : 'Open navigation'}
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
        </button>

        <div className="mk-mobile-menu" id="mk-mobile-menu" data-open={open}>
          {links.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
              <span aria-hidden="true">↘</span>
            </a>
          ))}
          <a className="mk-mobile-menu__cta" href="#pilot" onClick={() => setOpen(false)}>
            Request a pilot
          </a>
        </div>
      </nav>
    </header>
  );
}
