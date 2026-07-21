import { Chip } from './chip';

/**
 * Per-mechanism capacity bars.
 *
 * A horizontal bar chart, hand-built rather than pulled from a chart library:
 * three categories with labels is a job for markup, and this way each bar can
 * carry its provenance chip inline instead of relying on a colour legend.
 *
 * Encoding notes (dataviz procedure):
 * - Bars are anchored to a zero baseline; length is the only magnitude channel.
 * - Colour encodes PROVENANCE, which is a status, not a series identity — so it
 *   uses the reserved semantic palette deliberately: green only where a drill
 *   has proven the number, amber where it is declared or modeled.
 * - Every bar is directly labelled, so identity never rests on colour.
 * - 2px surface gap between bars per the mark spec.
 */
export function MechanismBars({
  mechanisms,
  totalKw,
}: {
  mechanisms: {
    code: string;
    name: string;
    kw: number;
    provenance: 'DECLARED' | 'MODELED' | 'TESTED';
  }[];
  totalKw: number;
}) {
  const scaleMax = Math.max(totalKw, ...mechanisms.map((m) => m.kw), 1);

  return (
    <div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {mechanisms.map((mechanism) => {
          const pct = (mechanism.kw / scaleMax) * 100;
          const colour =
            mechanism.provenance === 'TESTED'
              ? 'var(--color-tested)'
              : 'var(--color-declared)';

          return (
            <li key={mechanism.code} style={{ padding: '6px 0' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-sm)',
                  marginBottom: 4,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)' }}>{mechanism.name}</span>
                <span
                  className="tnum"
                  style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-2)' }}
                >
                  {mechanism.kw.toFixed(0)} kW
                </span>
              </div>

              <div
                style={{
                  background: 'var(--color-paper-sunk)',
                  borderRadius: 'var(--radius-xs)',
                  height: 10,
                  overflow: 'hidden',
                }}
                role="img"
                aria-label={`${mechanism.name}: ${mechanism.kw} kilowatts, ${mechanism.provenance.toLowerCase()}`}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: colour,
                    // 4px rounded data-end, anchored flat at the baseline.
                    borderRadius: '0 4px 4px 0',
                  }}
                />
              </div>

              <div style={{ marginTop: 4 }}>
                <Chip kind={mechanism.provenance === 'TESTED' ? 'tested' : 'declared'}>
                  {mechanism.provenance}
                </Chip>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="sheet__note" style={{ marginTop: 'var(--space-md)' }}>
        Colour encodes provenance, not identity: green marks capacity proven by a
        completed drill; amber marks capacity that is declared or modeled. Each
        bar is labelled, so the distinction never rests on colour alone.
      </p>
    </div>
  );
}
