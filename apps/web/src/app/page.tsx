import Link from 'next/link';
import { Chip } from '@/components/chip';
import { DRILL, ENVELOPE, FACILITY, MECHANISMS } from '@/lib/facility';

/**
 * Overview — spec §16.2.
 *
 * Required: current load and freshness · tested/modeled/declared reducible kW ·
 * Passport status and staleness · telemetry completeness · connector health ·
 * next safe action.
 *
 * The design decision that matters here: the three reducible-kW figures are
 * shown SEPARATELY by provenance rather than summed into one headline number.
 * A single "600 kW available" would be the most useful-looking and least honest
 * thing on the page — it would blend a tested figure with an operator's guess.
 */
export default function OverviewPage() {
  const declaredTotal = MECHANISMS.reduce(
    (sum, mechanism) => sum + Number(mechanism.declaredKw),
    0,
  );

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>{FACILITY.name}</h1>
            <p className="pagehead__sub">
              {FACILITY.region} · {FACILITY.market} · {FACILITY.timezone}
            </p>
          </div>
          <div className="row">
            <Chip kind="simulated">Simulator connector</Chip>
            <Chip kind="tested">Telemetry live</Chip>
          </div>
        </div>
      </header>

      {/* ---- Reducible capacity, split by provenance ---- */}
      <section className="stack" aria-labelledby="capacity-heading">
        <h2 id="capacity-heading" className="panel__title">
          Reducible capacity by evidence class
        </h2>

        <div className="grid-metrics">
          <div className="panel">
            <span className="metric__label">Tested</span>
            <div className="metric__value">
              0<span className="metric__unit">kW</span>
            </div>
            <div className="metric__foot">
              <Chip kind="declared">No verified drill</Chip>
            </div>
            <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
              No mechanism has been proven by a completed drill yet. Until one is,
              nothing here can be claimed as tested.
            </p>
          </div>

          <div className="panel">
            <span className="metric__label">Modeled</span>
            <div className="metric__value">
              0<span className="metric__unit">kW</span>
            </div>
            <div className="metric__foot">
              <Chip kind="declared">Insufficient history</Chip>
            </div>
            <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
              Telemetry has not yet covered enough low-load intervals to model an
              observed cap independently of the declared figure.
            </p>
          </div>

          <div className="panel">
            <span className="metric__label">Declared</span>
            <div className="metric__value">
              {declaredTotal.toFixed(0)}
              <span className="metric__unit">kW</span>
            </div>
            <div className="metric__foot">
              <Chip kind="declared">Operator assertion</Chip>
            </div>
            <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
              Sum of three enabled mechanisms as configured. Capped to{' '}
              <span className="tnum">{ENVELOPE.totalReducibleKw}</span> kW by the
              maximum-curtailment constraint.
            </p>
          </div>
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
            <span className="panel__title">Current envelope · v{ENVELOPE.version}</span>
            <Chip kind="declared">Confidence {ENVELOPE.confidenceScore.toFixed(2)}</Chip>
          </div>

          <div className="metric metric--readout">
            <div className="metric__value">
              {ENVELOPE.totalReducibleKw}
              <span className="metric__unit">kW</span>
            </div>
          </div>

          <div className="sheet-wrap" style={{ marginTop: 'var(--space-md)' }}>
            <table className="sheet tnum">
              <tbody>
                <tr>
                  <th scope="row">Binding constraint</th>
                  <td className="num">Maximum curtailment</td>
                </tr>
                <tr>
                  <th scope="row">Sum of mechanism caps</th>
                  <td className="num">{ENVELOPE.sumOfMechanismCapsKw} kW</td>
                </tr>
                <tr>
                  <th scope="row">Physical headroom</th>
                  <td className="num">{ENVELOPE.physicalHeadroomKw} kW</td>
                </tr>
                <tr>
                  <th scope="row">Aggregate ramp</th>
                  <td className="num">{ENVELOPE.aggregateRampKwPerMin} kW/min</td>
                </tr>
                <tr>
                  <th scope="row">Sustainable duration</th>
                  <td className="num">{ENVELOPE.sustainableDurationMin} min</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="sheet__note" style={{ marginTop: 'var(--space-md)' }}>
            Confidence is {ENVELOPE.confidenceScore.toFixed(2)} because every
            mechanism is DECLARED. The engine takes the weakest mechanism&rsquo;s
            provenance, not the average.{' '}
            <Link href="/envelope">See the full calculation →</Link>
          </p>
        </div>

        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">Data quality</span>
            <Chip kind="tested">Above threshold</Chip>
          </div>

          <div className="grid-metrics">
            <div>
              <span className="metric__label">Completeness</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {(ENVELOPE.telemetryCompleteness * 100).toFixed(1)}
                <span className="metric__unit">%</span>
              </div>
              <div className="metric__foot">90% required to arm</div>
            </div>
            <div>
              <span className="metric__label">Max gap</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                0<span className="metric__unit">intervals</span>
              </div>
              <div className="metric__foot">2 consecutive blocks certification</div>
            </div>
          </div>

          <div className="sheet-wrap" style={{ marginTop: 'var(--space-lg)' }}>
            <table className="sheet">
              <thead>
                <tr>
                  <th>Connector</th>
                  <th>Type</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Main meter</td>
                  <td className="sheet__note">SIMULATOR</td>
                  <td>
                    <Chip kind="simulated">Simulated</Chip>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- Next safe action ---- */}
      <section className="panel" aria-labelledby="next-action">
        <div className="panel__head">
          <span className="panel__title" id="next-action">
            Next safe action
          </span>
        </div>
        <p style={{ fontSize: 'var(--text-lg)', maxWidth: 'var(--measure)' }}>
          Run a drill to convert declared capacity into tested capacity.
        </p>
        <p className="sheet__note" style={{ marginTop: 'var(--space-sm)' }}>
          The envelope is currently built entirely from operator assertions. A
          completed drill promotes the exercised mechanism to TESTED and raises
          confidence from {ENVELOPE.confidenceScore.toFixed(2)} toward 0.85.
        </p>
        <div className="row" style={{ marginTop: 'var(--space-md)' }}>
          <Link className="btn btn--primary" href="/drills">
            Review the completed drill →
          </Link>
          <Link className="btn" href="/envelope">
            Inspect envelope
          </Link>
        </div>
      </section>

      {/* ---- Last drill summary ---- */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Most recent drill</span>
          <div className="row">
            <Chip kind="simulated">Simulated</Chip>
            <Chip kind="tested">Completed</Chip>
          </div>
        </div>
        <div className="grid-metrics">
          <div>
            <span className="metric__label">Delivered</span>
            <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
              {DRILL.deliveredEnergyKwh}
              <span className="metric__unit">kWh</span>
            </div>
            <div className="metric__foot">against {DRILL.committedEnergyKwh} committed</div>
          </div>
          <div>
            <span className="metric__label">Performance</span>
            <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
              {DRILL.performanceBps}
              <span className="metric__unit">bps</span>
            </div>
            <div className="metric__foot">9,600–10,000 required</div>
          </div>
          <div>
            <span className="metric__label">Average delivered</span>
            <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
              {DRILL.averageDeliveredKw}
              <span className="metric__unit">kW</span>
            </div>
            <div className="metric__foot">against 500 requested</div>
          </div>
        </div>
      </section>
    </main>
  );
}
