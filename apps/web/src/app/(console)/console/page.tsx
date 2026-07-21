import Link from 'next/link';
import { Chip } from '@/components/chip';
import { api } from '@/lib/api';
import { ageFrom, formatKw, requireFacility, whToKwh } from '@/lib/load';

export const dynamic = 'force-dynamic';

/**
 * Overview — spec §16.2, now reading live API data.
 *
 * The reducible-capacity figures are split by provenance rather than summed.
 * A single "600 kW available" headline would blend a tested measurement with an
 * operator's assertion — the most useful-looking and least honest element the
 * page could carry.
 */
export default async function OverviewPage() {
  const facility = await requireFacility();

  const [{ envelope, mechanisms }, quality, { drills }] = await Promise.all([
    api.currentEnvelope(facility.id),
    api.telemetryQuality(facility.id),
    api.drills(facility.id),
  ]);

  // Group envelope capacity by the evidence that backs it.
  const byProvenance = { TESTED: 0, MODELED: 0, DECLARED: 0 };
  for (const mechanism of mechanisms) {
    byProvenance[mechanism.provenance] += Number(mechanism.reducible_kw);
  }

  const latestDrill = drills[0] ?? null;
  const mrv = latestDrill ? await api.drill(latestDrill.id).then((d) => d.mrv) : null;
  const anySimulated = drills.some((drill) => drill.simulation_mode);

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>{facility.name}</h1>
            <p className="pagehead__sub">
              {facility.region} · {facility.market} · {facility.timezone}
            </p>
          </div>
          <div className="row">
            {anySimulated ? <Chip kind="simulated">Simulated</Chip> : null}
            {quality.is_stale ? (
              <Chip kind="violation">Telemetry stale</Chip>
            ) : (
              <Chip kind="tested">Telemetry fresh</Chip>
            )}
          </div>
        </div>
      </header>

      {/* ---- Capacity by evidence class ---- */}
      <section className="stack" aria-labelledby="capacity-heading">
        <h2 id="capacity-heading" className="panel__title">
          Reducible capacity by evidence class
        </h2>
        <div className="grid-metrics">
          <ProvenancePanel
            label="Tested"
            value={byProvenance.TESTED}
            kind={byProvenance.TESTED > 0 ? 'tested' : 'declared'}
            badge={byProvenance.TESTED > 0 ? 'Verified by drill' : 'No verified drill'}
            note={
              byProvenance.TESTED > 0
                ? 'Proven by a completed drill with an MRV report.'
                : 'No mechanism has been proven by a completed drill. Until one is, nothing here can be claimed as tested.'
            }
          />
          <ProvenancePanel
            label="Modeled"
            value={byProvenance.MODELED}
            kind="declared"
            badge={byProvenance.MODELED > 0 ? 'From telemetry' : 'Insufficient history'}
            note="Derived from observed low-load intervals, independent of the declared figure."
          />
          <ProvenancePanel
            label="Declared"
            value={byProvenance.DECLARED}
            kind="declared"
            badge="Operator assertion"
            note="Configured by an operator. Not independently verified."
          />
        </div>
      </section>

      {/* ---- Envelope + data quality ---- */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
          gap: 'var(--space-md)',
        }}
      >
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">
              Current envelope {envelope ? `· v${envelope.version}` : ''}
            </span>
            {envelope ? (
              <Chip kind={envelope.confidence_score >= 0.6 ? 'tested' : 'declared'}>
                Confidence {envelope.confidence_score.toFixed(2)}
              </Chip>
            ) : null}
          </div>

          {envelope ? (
            <>
              <div className="metric metric--readout">
                <div className="metric__value">
                  {formatKw(envelope.total_reducible_kw)}
                  <span className="metric__unit">kW</span>
                </div>
              </div>
              <div className="sheet-wrap" style={{ marginTop: 'var(--space-md)' }}>
                <table className="sheet tnum">
                  <tbody>
                    <tr>
                      <th scope="row">Binding constraint</th>
                      <td className="num">
                        {String(envelope.summary?.binding_constraint ?? '—')
                          .replace(/_/g, ' ')
                          .toLowerCase()}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Aggregate ramp</th>
                      <td className="num">{envelope.aggregate_ramp_kw_per_min} kW/min</td>
                    </tr>
                    <tr>
                      <th scope="row">Sustainable duration</th>
                      <td className="num">{envelope.sustainable_duration_min} min</td>
                    </tr>
                    <tr>
                      <th scope="row">Response time</th>
                      <td className="num">{envelope.response_time_seconds} s</td>
                    </tr>
                    <tr>
                      <th scope="row">Methodology</th>
                      <td className="num">{envelope.methodology_version}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="sheet__note" style={{ marginTop: 'var(--space-md)' }}>
                <Link href="/console/envelope">See the full calculation →</Link>
              </p>
            </>
          ) : (
            <>
              <p>No envelope has been computed yet.</p>
              <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
                Recompute one from the Envelope page to establish a current
                flexibility position.
              </p>
              <div className="row" style={{ marginTop: 'var(--space-md)' }}>
                <Link className="btn btn--primary" href="/console/envelope">
                  Go to Envelope →
                </Link>
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">Data quality · last 24h</span>
            {quality.meets_drill_threshold ? (
              <Chip kind="tested">Above threshold</Chip>
            ) : (
              <Chip kind="violation">Below threshold</Chip>
            )}
          </div>

          <div className="grid-metrics">
            <div>
              <span className="metric__label">Completeness</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {(quality.completeness * 100).toFixed(1)}
                <span className="metric__unit">%</span>
              </div>
              <div className="metric__foot">90% required to arm</div>
            </div>
            <div>
              <span className="metric__label">Last reading</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {ageFrom(quality.last_reading_at)}
              </div>
              <div className="metric__foot">
                {quality.observed_intervals} / {quality.expected_intervals} intervals
              </div>
            </div>
          </div>

          <p className="sheet__note" style={{ marginTop: 'var(--space-lg)' }}>
            <Link href="/console/telemetry">Inspect the load curve →</Link>
          </p>
        </div>
      </section>

      {/* ---- Latest drill ---- */}
      {latestDrill && mrv ? (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Most recent drill</span>
            <div className="row">
              {latestDrill.simulation_mode ? <Chip kind="simulated">Simulated</Chip> : null}
              <Chip kind={latestDrill.status === 'COMPLETED' ? 'tested' : 'declared'}>
                {latestDrill.status}
              </Chip>
            </div>
          </div>
          <div className="grid-metrics">
            <div>
              <span className="metric__label">Delivered</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {whToKwh(mrv.delivered_energy_wh)}
                <span className="metric__unit">kWh</span>
              </div>
              <div className="metric__foot">
                of {whToKwh(mrv.committed_energy_wh)} committed
              </div>
            </div>
            <div>
              <span className="metric__label">Performance</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {(mrv.performance_bps / 100).toFixed(2)}
                <span className="metric__unit">%</span>
              </div>
              <div className="metric__foot tnum">{mrv.performance_bps} bps</div>
            </div>
            <div>
              <span className="metric__label">Average delivered</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {mrv.average_delivered_kw}
                <span className="metric__unit">kW</span>
              </div>
              <div className="metric__foot">
                of {formatKw(latestDrill.requested_reduction_kw)} requested
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 'var(--space-md)' }}>
            <Link className="btn" href={`/console/drills/${latestDrill.id}`}>
              Follow the proof chain →
            </Link>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Next safe action</span>
          </div>
          <p style={{ fontSize: 'var(--text-lg)' }}>
            Run a drill to convert declared capacity into tested capacity.
          </p>
        </section>
      )}
    </main>
  );
}

function ProvenancePanel({
  label,
  value,
  kind,
  badge,
  note,
}: {
  label: string;
  value: number;
  kind: 'tested' | 'declared';
  badge: string;
  note: string;
}) {
  return (
    <div className="panel">
      <span className="metric__label">{label}</span>
      <div className="metric__value">
        {value.toLocaleString('en-US')}
        <span className="metric__unit">kW</span>
      </div>
      <div className="metric__foot">
        <Chip kind={kind}>{badge}</Chip>
      </div>
      <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
        {note}
      </p>
    </div>
  );
}
