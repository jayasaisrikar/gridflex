import type { ReactNode } from 'react';

/**
 * Status chip — spec §16.4.
 *
 * The colour law is a safety constraint:
 *   tested    → green   (verified by an actual drill)
 *   declared  → amber   (operator assertion or model, not tested; also STALE)
 *   violation → red     (violations, aborts, blockers ONLY)
 *   simulated → violet  (data came from the simulator, not equipment)
 *
 * "Never rely on colour alone." Every chip carries a glyph AND a text label, so
 * the state survives greyscale, colour-vision deficiency, and a bad monitor.
 * The glyph is aria-hidden — the label already says it for a screen reader.
 */
export type ChipKind = 'tested' | 'declared' | 'violation' | 'simulated' | 'neutral';

const GLYPH: Record<ChipKind, string> = {
  tested: '✓',
  declared: '◐',
  violation: '✕',
  simulated: '◈',
  neutral: '·',
};

export function Chip({
  kind,
  children,
  title,
}: {
  kind: ChipKind;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip--${kind}`} {...(title ? { title } : {})}>
      <i className="chip__glyph" aria-hidden="true">
        {GLYPH[kind]}
      </i>
      {children}
    </span>
  );
}

/**
 * Provenance badge (spec §12). Every envelope field must declare where its
 * number came from. TESTED is the only one that earns green.
 */
export function Provenance({ value }: { value: 'DECLARED' | 'MODELED' | 'TESTED' }) {
  if (value === 'TESTED') return <Chip kind="tested">Tested</Chip>;
  if (value === 'MODELED') return <Chip kind="declared">Modeled</Chip>;
  return <Chip kind="declared">Declared</Chip>;
}
