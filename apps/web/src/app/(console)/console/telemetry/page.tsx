import type { Metadata } from 'next';
import { Chip } from '@/components/chip';
import { CsvImportControl } from '@/components/csv-import-control';
import { LoadChart } from '@/components/load-chart';
import { api } from '@/lib/api';
import { ageFrom, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Telemetry' };

export default async function TelemetryPage() {
  const facility = await requireFacility();
  const [series, quality, { connectors }, { quarantine }] = await Promise.all([
    api.telemetry(facility.id),
    api.telemetryQuality(facility.id),
    api.connectors(facility.id),
    api.quarantine(facility.id),
  ]);

  const acceptedPoints = series.points.filter(
    (point) => point.quality === 'GOOD' || point.quality === 'ESTIMATED',
  );
  const excludedPointCount = series.points.length - acceptedPoints.length;
  const values = acceptedPoints.map((point) => Number(point.value));
  const latest = values.at(-1) ?? null;
  const floor = facility.minimum_safe_load_kw ? Number(facility.minimum_safe_load_kw) : null;
  const passportPilotReady = quality.completeness >= 0.9 && !quality.is_stale;

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
            {quality.contains_simulated_data ? <Chip kind="simulated">Simulated data present</Chip> : null}
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
          <div className="row">
            <span className="sheet__note tnum">{acceptedPoints.length} accepted points</span>
            {series.truncated ? (
              <Chip kind="declared">Latest 5,000 samples shown</Chip>
            ) : null}
            {excludedPointCount > 0 ? (
              <Chip kind="declared">{excludedPointCount} suspect excluded</Chip>
            ) : null}
          </div>
        </div>
        {acceptedPoints.length === 0 ? (
          <p className="muted">No telemetry in this window.</p>
        ) : (
          <LoadChart
            points={acceptedPoints}
            minimumSafeLoadKw={floor}
            normalLoadKw={facility.normal_load_kw ? Number(facility.normal_load_kw) : null}
          />
        )}
        {series.truncated ? (
          <p className="sheet__note" role="status" style={{ marginTop: 'var(--space-md)' }}>
            This 24-hour window contains more than 5,000 samples. The chart and
            observed range use the latest 5,000; earlier samples are omitted.
          </p>
        ) : null}
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
                <th scope="row">Completeness for Passport (pilot)</th>
                <td className="num">≥ 90% over 24h, fresh</td>
                <td className="num">{(quality.completeness * 100).toFixed(1)}% over 24h</td>
                <td>
                  <Chip kind={passportPilotReady ? 'tested' : 'violation'}>
                    {passportPilotReady ? 'Pass' : 'Blocked'}
                  </Chip>
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
          Pilot issuance uses a fresh 24-hour window at 90% completeness. A
          production certification profile should extend this to at least 14 days
          and a stricter completeness target; that profile is not claimed here.
        </p>
      </section>

      <section className="panel stack" id="csv-import" aria-labelledby="csv-import-title">
        <div className="panel__head">
          <div>
            <span className="panel__title" id="csv-import-title">Previewed CSV import</span>
            <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
              Required columns: metric_key, measured_at, value, unit. Optional:
              quality and source_sequence.
            </p>
          </div>
          <Chip kind="neutral">Preview before write</Chip>
        </div>
        <CsvImportControl facilityId={facility.id} connectors={connectors} />
      </section>

      <section className="stack" aria-labelledby="quarantine-title">
        <div className="section-intro">
          <div>
            <h2 id="quarantine-title">Quarantine</h2>
            <p>Rejected or conflicting rows remain inspectable and never enter calculations.</p>
          </div>
          <Chip kind={quarantine.length > 0 ? 'declared' : 'tested'}>
            {quarantine.length > 0 ? `${quarantine.length} review` : 'No rejected rows'}
          </Chip>
        </div>
        {quarantine.length === 0 ? (
          <div className="panel empty-state">
            <span className="empty-state__mark" aria-hidden="true">Q0</span>
            <h2>No quarantined readings</h2>
            <p>Conflicting duplicates and invalid CSV rows will appear here with a reason.</p>
          </div>
        ) : (
          <div className="mechanism-list">
            {quarantine.map((row) => (
              <details className="disclosure" key={row.id}>
                <summary>
                  <span>
                    <strong>{row.reason_code.replace(/_/g, ' ').toLowerCase()}</strong>
                    <small className="sheet__note">{row.received_at}</small>
                  </span>
                  <Chip kind="declared">Quarantined</Chip>
                </summary>
                <div className="disclosure__body stack">
                  <p>{row.reason_detail ?? 'No additional reason detail was recorded.'}</p>
                  <pre className="hash">{JSON.stringify(row.raw_payload, null, 2)}</pre>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
