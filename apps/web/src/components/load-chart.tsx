'use client';

import { useId } from 'react';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * 24-hour facility load curve.
 *
 * One series (measured load). The safety floor and normal load are REFERENCE
 * LINES, not series — they are declared constants, not measurements, and drawing
 * them as series would imply they were observed.
 *
 * The floor line is the one place a semantic colour appears in a chart: it is
 * drawn in the violation red because crossing it IS a violation. It carries a
 * text label too, so the meaning does not rest on colour.
 */
export function LoadChart({
  points,
  minimumSafeLoadKw,
  normalLoadKw,
}: {
  points: { measured_at: string; value: string }[];
  minimumSafeLoadKw: number | null;
  normalLoadKw: number | null;
}) {
  const data = points.map((point) => ({
    t: point.measured_at,
    label: point.measured_at.slice(11, 16),
    kw: Number(point.value),
  }));

  const values = data.map((d) => d.kw);
  const min = Math.min(...values, minimumSafeLoadKw ?? Infinity);
  const max = Math.max(...values, normalLoadKw ?? -Infinity);
  const pad = (max - min) * 0.1 || 50;
  const descriptionId = useId();
  const latest = data.at(-1)?.kw;
  const crossedFloor = minimumSafeLoadKw !== null && values.some((value) => value < minimumSafeLoadKw);
  const described = `Facility load chart with ${data.length} accepted points. Range ${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)} kW; latest ${latest?.toFixed(3) ?? 'not available'} kW. ${minimumSafeLoadKw === null ? 'No minimum safe load is recorded.' : crossedFloor ? `At least one point is below the ${minimumSafeLoadKw.toFixed(3)} kW minimum safe load.` : `No point is below the ${minimumSafeLoadKw.toFixed(3)} kW minimum safe load.`}`;
  const tablePoints = data.slice(-120);

  return (
    <figure style={{ margin: 0 }} aria-describedby={descriptionId}>
      <div style={{ width: '100%', height: 280 }} aria-hidden="true">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="var(--color-rule-2)" vertical={false} />
            <XAxis
              dataKey="label"
              interval={Math.max(0, Math.floor(data.length / 8) - 1)}
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
            />

            <Area
              dataKey="kw"
              stroke="var(--color-accent)"
              strokeWidth={2}
              fill="var(--color-accent)"
              fillOpacity={0.1}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="Facility load"
            />

            {minimumSafeLoadKw !== null ? (
              <ReferenceLine
                y={minimumSafeLoadKw}
                stroke="var(--color-violation)"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{
                  value: `minimum safe load ${minimumSafeLoadKw} kW`,
                  position: 'insideBottomLeft',
                  fill: 'var(--color-violation)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                }}
              />
            ) : null}

            {normalLoadKw !== null ? (
              <ReferenceLine
                y={normalLoadKw}
                stroke="var(--color-ink-2)"
                strokeDasharray="2 5"
                strokeWidth={1}
                label={{
                  value: `declared normal ${normalLoadKw} kW`,
                  position: 'insideTopLeft',
                  fill: 'var(--color-muted)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                }}
              />
            ) : null}

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
              formatter={(value: unknown) => [`${Number(value).toFixed(3)} kW`, 'Load']}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <figcaption className="stack" style={{ marginTop: 'var(--space-sm)', fontSize: 'var(--text-xs)' }}>
        <span className="sr-only" id={descriptionId}>{described}</span>
        <span className="row">
          <span className="row" style={{ gap: 'var(--space-2xs)' }}>
          <svg width="18" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="18" y2="4" stroke="var(--color-accent)" strokeWidth="2" />
          </svg>
          <span className="muted">Measured facility load</span>
          </span>
          <span className="row" style={{ gap: 'var(--space-2xs)' }}>
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke="var(--color-violation)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
            </svg>
            <span className="muted">Minimum safe load — crossing this is a violation</span>
          </span>
        </span>
        <details className="disclosure">
          <summary>Inspect recent chart values</summary>
          <div className="disclosure__body stack">
            <p className="sheet__note">Showing the most recent {tablePoints.length} of {data.length} accepted points.</p>
            <div className="sheet-wrap">
              <table className="sheet tnum">
                <thead><tr><th>Measured at (UTC)</th><th className="num">Load (kW)</th></tr></thead>
                <tbody>
                  {tablePoints.map((point) => (
                    <tr key={point.t}><td>{point.t}</td><td className="num">{point.kw.toFixed(3)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </figcaption>
    </figure>
  );
}
