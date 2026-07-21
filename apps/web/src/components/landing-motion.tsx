'use client';

import { useEffect } from 'react';

type CountElement = HTMLElement & {
  dataset: DOMStringMap & {
    count?: string;
    decimals?: string;
    prefix?: string;
    suffix?: string;
  };
};

const easeOutExpo = (value: number) => (value === 1 ? 1 : 1 - 2 ** (-10 * value));

export function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.mk-premium');
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('mk-motion-ready');
    window.requestAnimationFrame(() => root.classList.add('mk-mounted'));

    if (reduced) {
      root.querySelectorAll<HTMLElement>('[data-reveal]').forEach((element) => {
        element.classList.add('is-visible');
      });
      return;
    }

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          (entry.target as HTMLElement).classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );

    root.querySelectorAll<HTMLElement>('[data-reveal]').forEach((element) => {
      revealObserver.observe(element);
    });

    const countObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const element = entry.target as CountElement;
          const target = Number(element.dataset.count ?? 0);
          const decimals = Number(element.dataset.decimals ?? 0);
          const prefix = element.dataset.prefix ?? '';
          const suffix = element.dataset.suffix ?? '';
          const startedAt = performance.now();
          const duration = 1200;

          const tick = (now: number) => {
            const progress = Math.min(1, (now - startedAt) / duration);
            const value = target * easeOutExpo(progress);
            element.textContent = `${prefix}${value.toFixed(decimals)}${suffix}`;
            if (progress < 1) window.requestAnimationFrame(tick);
          };

          window.requestAnimationFrame(tick);
          countObserver.unobserve(element);
        });
      },
      { threshold: 0.75 },
    );

    root.querySelectorAll<CountElement>('[data-count]').forEach((element) => {
      countObserver.observe(element);
    });

    return () => {
      revealObserver.disconnect();
      countObserver.disconnect();
    };
  }, []);

  return null;
}
