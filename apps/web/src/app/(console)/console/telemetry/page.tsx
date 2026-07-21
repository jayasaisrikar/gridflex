import { Chip } from '@/components/chip';
import { LoadChart } from '@/components/load-chart';
import { api } from '@/lib/api';
import { ageFrom, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

export default async function TelemetryPage() {
  const facility = await requireFacility();
  const [series, quality] = await Promise.all([
    api.telemetry(facility.id),
    api.telemetryQuality(facility.id),
  ]);

  const values = series.points.map((point) => Number(point.value));
  const latest = values.at(-1) ?? null;
  const floor = facility.minimum_safe_load_kw ? Number(facility.minimum_safe_load_kw) : null;

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Telemetry</h1>
            <p className="pagehead__sub">
              facility.active_power_kw · {quality.interval_seconds}s intervals · last 24 hours
            </p>
          </div>
          <div className="row">
            <Chip kind="simulated">Simulated</Chip>
            {quality.is_stale ? (
              <Chip kind="violation">Stale</Chip>
            ) : (
              <Chip kind="tested">Fresh · {ageFrom(quality.last_reading_at)}</Chip>
            )}
          </div>
        </div>
      </header>

      <section className="grid-metrics">
        <div className="panel">
          <span className="metric__label">Current load</span>
          <div className="metric__value">
            {latest === null ? '—' : latest.toFixed(3)}
            <span className="metric__unit">kW</span>
          </div>
          <div className="metric__foot">{ageFrom(quality.last_reading_at)}</div>
        </div>
        <div className="panel">
          <span className="metric__label">Completeness</span>
          <div className="metric__value">
            {(quality.completeness * 100).toFixed(1)}
            <span className="metric__unit">%</span>
          </div>
          <div className="metric__foot">
            {quality.observed_intervals} / {quality.expected_intervals} intervals
          </div>
        </div>
        <div className="panel">
          <span className="metric__label">Observed range</span>
          <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
            {values.length ? Math.min(...values).toFixed(0) : '—'}
            <span className="metric__unit">
              – {values.length ? Math.max(...values).toFixed(0) : '—'} kW
            </span>
          </div>
          <div className="metric__foot">min – max over the window</div>
        </div>
        <div className="panel">
          <span className="metric__label">Drill readiness</span>
          <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
            {quality.meets_drill_threshold ? 'Ready' : 'Blocked'}
          </div>
          <div className="metric__foot">
            <Chip kind={quality.meets_drill_threshold ? 'tested' : 'violation'}>
              {quality.meets_drill_threshold ? '≥90% and fresh' : 'below threshold'}
            </Chip>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Facility load · 24 hours</span>
          <span className="sheet__note tnum">{series.points.length} points</span>
        </div>
        {series.points.length === 0 ? (
          <p className="muted">No telemetry in this window.</p>
        ) : (
          <LoadChart
            points={series.points}
            minimumSafeLoadKw={floor}
            normalLoadKw={facility.normal_load_kw ? Number(facility.normal_load_kw) : null}
          />
        )}
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Quality gates</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <thead>
              <tr>
                <th>Gate</th>
                <th className="num">Threshold</th>
                <th className="num">Actual</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Completeness for envelope</th>
                <td className="num">≥ 90%</td>
                <td className="num">{(quality.completeness * 100).toFixed(1)}%</td>
                <td>
                  <Chip kind={quality.completeness >= 0.9 ? 'tested' : 'violation'}>
                    {quality.completeness >= 0.9 ? 'Pass' : 'Blocked'}
                  </Chip>
                </td>
              </tr>
              <tr>
                <th scope="row">Completeness for Passport</th>
                <td className="num">≥ 95% over 14d</td>
                <td className="num">{(quality.completeness * 100).toFixed(1)}% over 1d</td>
                <td>
                  <Chip kind="declared">Window too short</Chip>
                </td>
              </tr>
              <tr>
                <th scope="row">Staleness</th>
                <td className="num">2 intervals + 60s</td>
                <td className="num">{ageFrom(quality.last_reading_at)}</td>
                <td>
                  <Chip kind={quality.is_stale ? 'violation' : 'tested'}>
                    {quality.is_stale ? 'Stale' : 'Fresh'}
                  </Chip>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sheet__note" style={{ marginTop: 'var(--space-md)' }}>
          A 14-day window is required for a production-quality Passport. This
          deployment has 24 hours of history, so that gate cannot pass yet — it is
          shown as unmet rather than hidden.
        </p>
      </section>
    </main>
  );
}
