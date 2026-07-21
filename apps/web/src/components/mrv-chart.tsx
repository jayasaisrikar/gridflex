'use client';

import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

/**
 * Baseline versus actual load (spec §16.3).
 *
 * Encoding decisions, per the dataviz procedure:
 *
 * - This is ONE series plus a REFERENCE, not two categorical series. The actual
 *   load is the measurement; the baseline is a computed counterfactual. Treating
 *   them as two equal categories would need two chroma-≥0.10 hues, and the only
 *   ones left after the semantic law reserves green/amber/red would read as
 *   status colours. Encoding the baseline as a dashed reference line is both
 *   truer to the data and passes the palette validator (single slot, all checks).
 *
 * - The SHADED AREA between the two lines is the delivered energy. That is the
 *   whole claim the drill makes, so it is drawn rather than left to inference.
 *
 * - No dual axis. Both quantities are kW on one scale.
 *
 * - Colours come from tokens only. Validated against the dark surface #0c1116:
 *   lightness band PASS · chroma floor PASS · contrast PASS.
 */

export interface SeriesPoint {
  measured_at: string;
  value: string | null;
}

export function MrvChart({
  baseline,
  actual,
  intervalSeconds,
}: {
  baseline: SeriesPoint[];
  actual: SeriesPoint[];
  intervalSeconds: number;
}) {
  // Align index-for-index; the API guarantees equal length.
  const data = baseline.map((point, index) => {
    const baselineKw = point.value === null ? null : Number(point.value);
    const actualRaw = actual[index]?.value;
    const actualKw = actualRaw === null || actualRaw === undefined ? null : Number(actualRaw);

    return {
      minute: index,
      label: `+${Math.round((index * intervalSeconds) / 60)}m`,
      baseline: baselineKw,
      actual: actualKw,
      // The reduction band is drawn from actual up to baseline.
      band:
        baselineKw !== null && actualKw !== null ? [actualKw, baselineKw] : undefined,
      reduction:
        baselineKw !== null && actualKw !== null
          ? Math.max(0, baselineKw - actualKw)
          : null,
    };
  });

  const values = data.flatMap((d) => [d.baseline, d.actual]).filter((v): v is number => v !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || 50;

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="var(--color-rule-2)" vertical={false} />

            <XAxis
              dataKey="label"
              interval={Math.max(0, Math.floor(data.length / 6) - 1)}
              tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              stroke="var(--color-rule)"
              tickLine={false}
            />
            <YAxis
              domain={[Math.floor(min - pad), Math.ceil(max + pad)]}
              tick={{ fill: 'var(--color-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              stroke="var(--color-rule)"
              tickLine={false}
              width={56}
              label={{
                value: 'kW',
                position: 'insideTopLeft',
                fill: 'var(--color-muted)',
                fontSize: 11,
              }}
            />

            {/* Delivered energy — the area between actual and baseline. */}
            <Area
              dataKey="band"
              stroke="none"
              fill="var(--color-accent)"
              fillOpacity={0.16}
              isAnimationActive={false}
              activeDot={false}
            />

            {/* Baseline: a computed reference, drawn dashed and recessive. */}
            <Line
              dataKey="baseline"
              stroke="var(--color-ink-2)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
              name="Baseline (counterfactual)"
            />

            {/* Actual: the measurement. The one true series. */}
            <Line
              dataKey="actual"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              // connectNulls false: a gap in telemetry must READ as a gap.
              connectNulls={false}
              isAnimationActive={false}
              name="Actual load"
            />

            <Tooltip
              cursor={{ stroke: 'var(--color-rule-strong)', strokeWidth: 1 }}
              contentStyle={{
                background: 'var(--color-paper-sunk)',
                border: '1px solid var(--color-rule-strong)',
                borderRadius: 3,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--color-muted)' }}
              formatter={(value, name) => {
                // The band series carries a [low, high] tuple used only for the
                // shaded area — showing it in the tooltip would read as a third
                // measurement that does not exist.
                if (name === 'band' || value === null || value === undefined) {
                  return ['', ''];
                }
                return [`${Number(value).toFixed(3)} kW`, String(name)];
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend is markup, not canvas — identity never rests on colour alone. */}
      <figcaption
        className="row"
        style={{ marginTop: 'var(--space-sm)', fontSize: 'var(--text-xs)' }}
      >
        <span className="row" style={{ gap: 'var(--space-2xs)' }}>
          <svg width="18" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke="var(--color-ink-2)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          </svg>
          <span className="muted">Baseline — median of 5 eligible days</span>
        </span>
        <span className="row" style={{ gap: 'var(--space-2xs)' }}>
          <svg width="18" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="18" y2="4" stroke="var(--color-accent)" strokeWidth="2" />
          </svg>
          <span className="muted">Actual measured load</span>
        </span>
        <span className="row" style={{ gap: 'var(--space-2xs)' }}>
          <svg width="14" height="10" aria-hidden="true">
            <rect width="14" height="10" fill="var(--color-accent)" fillOpacity="0.16" />
          </svg>
          <span className="muted">Delivered energy</span>
        </span>
      </figcaption>
    </figure>
  );
}
