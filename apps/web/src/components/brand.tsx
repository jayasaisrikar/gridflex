type BrandMarkProps = {
  className?: string;
  label?: string;
};

type BrandLockupProps = {
  className?: string;
  markClassName?: string;
};

/**
 * The GridFlex mark is intentionally geometric so it remains legible at
 * favicon size. The frame inherits the surrounding foreground colour for
 * contrast on light and dark surfaces; the signal square remains brand teal.
 */
export function BrandMark({ className, label }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...(label
        ? { role: 'img' as const, 'aria-label': label }
        : { 'aria-hidden': true as const })}
    >
      <path
        d="M6 24h10v24h32V34H34V24h24v34H6V24Z"
        fill="currentColor"
      />
      <path d="M22 6h36v10H22V6Z" fill="currentColor" />
      <path d="M6 6h10v10H6V6Z" fill="#0A9DA3" />
    </svg>
  );
}

export function BrandLockup({ className, markClassName }: BrandLockupProps) {
  return (
    <span
      className={['brand-lockup', className].filter(Boolean).join(' ')}
      aria-label="GridFlex"
    >
      <BrandMark className={markClassName ?? 'brand-lockup__mark'} />
      <span className="brand-lockup__name" aria-hidden="true">
        <span>GRID</span>
        <span>FLEX</span>
      </span>
    </span>
  );
}
