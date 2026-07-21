import { Chip } from '@/components/chip';
import { api } from '@/lib/api';
import { requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

function pct(ratio: string): string {
  return `${(Number(ratio) * 100).toFixed(1)}%`;
}

export default async function PassportPage() {
  const facility = await requireFacility();
  const { passport } = await api.passport(facility.id);

  if (passport === null) {
    return (
      <main className="content stack">
        <header className="pagehead">
          <h1>Flexibility Passport</h1>
          <p className="pagehead__sub">No Passport has been issued for this facility.</p>
        </header>
        <section className="panel">
          <p>
            A Passport is issued from a computed envelope and a sealed evidence bundle. Nothing is
            shown here rather than a draft that could be mistaken for an issued record.
          </p>
        </section>
      </main>
    );
  }

  const doc = passport.document;
  const verification = await api.passportVerify(passport.id);
  const intact = verification.passport_hash_matches && verification.evidence_hash_matches;

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Flexibility Passport v{passport.version}</h1>
            <p className="pagehead__sub">
              {doc.facility.name} · {doc.methodology_version} · issued {passport.issued_at ?? '—'}
            </p>
          </div>
          <div className="row">
            {doc.data_quality.contains_simulated_data ? (
              <Chip kind="simulated">Simulated</Chip>
            ) : null}
            {passport.status === 'ISSUED' ? (
              <Chip kind="tested">Issued</Chip>
            ) : (
              <Chip kind="declared">{passport.status}</Chip>
            )}
          </div>
        </div>
      </header>

      <section className="grid-metrics">
        <div className="panel">
          <span className="metric__label">Reducible capacity</span>
          <div className="metric__value">
            {doc.envelope.total_reducible_kw}
            <span className="metric__unit">kW</span>
          </div>
          <span className="metric__foot">for {doc.envelope.sustainable_duration_min} min</span>
        </div>
        <div className="panel">
          <span className="metric__label">Confidence</span>
          <div className="metric__value">{pct(doc.envelope.confidence_score)}</div>
          <span className="metric__foot">assurance grade, not a forecast</span>
        </div>
        <div className="panel">
          <span className="metric__label">Response time</span>
          <div className="metric__value">
            {doc.envelope.response_time_seconds}
            <span className="metric__unit">s</span>
          </div>
          <span className="metric__foot">at {doc.envelope.aggregate_ramp_kw_per_min} kW/min</span>
        </div>
        <div className="panel">
          <span className="metric__label">Telemetry completeness</span>
          <div className="metric__value">{pct(doc.data_quality.completeness)}</div>
          <span className="metric__foot">{doc.data_quality.modeling_window_days} day window</span>
        </div>
      </section>

      {/* Verification first: a reader should be able to trust the numbers above
          before studying them. */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Independent verification</span>
          {intact ? <Chip kind="tested">Hashes match</Chip> : <Chip kind="violation">Mismatch</Chip>}
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <tbody>
              <tr>
                <th scope="row">Passport SHA-256</th>
                <td className="num">{verification.stored_passport_sha256}</td>
                <td>
                  {verification.passport_hash_matches ? (
                    <Chip kind="tested">Matches</Chip>
                  ) : (
                    <Chip kind="violation">Altered</Chip>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Evidence SHA-256</th>
                <td className="num">{verification.stored_evidence_sha256}</td>
                <td>
                  {verification.evidence_hash_matches ? (
                    <Chip kind="tested">Matches</Chip>
                  ) : (
                    <Chip kind="violation">Altered</Chip>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sheet__note">
          Recomputed {verification.verified_at} using {verification.canonicalization_schema_version}.{' '}
          {verification.instructions}
        </p>
      </section>

      {/* Limitations sit above the detail deliberately. They are derived from the
          same evidence as the headline figures, and burying them would let a
          reader take the capacity number without its caveats. */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Limitations</span>
        </div>
        <ol className="stack">
          {doc.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Capacity by mechanism</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <thead>
              <tr>
                <th>Mechanism</th>
                <th>Provenance</th>
                <th className="num">Reducible</th>
                <th className="num">Tests</th>
              </tr>
            </thead>
            <tbody>
              {doc.envelope.mechanisms.map((mechanism) => (
                <tr key={mechanism.code}>
                  <td>
                    {mechanism.name}
                    <br />
                    <span className="sheet__note">{mechanism.code}</span>
                  </td>
                  <td>
                    {mechanism.provenance === 'TESTED' ? (
                      <Chip kind="tested">Tested</Chip>
                    ) : mechanism.provenance === 'MODELED' ? (
                      <Chip kind="declared">Modeled</Chip>
                    ) : (
                      <Chip kind="declared">Declared</Chip>
                    )}
                  </td>
                  <td className="num">{mechanism.reducible_kw} kW</td>
                  <td className="num">{mechanism.test_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Safety constraints</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <tbody>
              <tr>
                <th scope="row">Minimum safe load</th>
                <td className="num">{doc.safety.minimum_safe_load_kw} kW</td>
              </tr>
              <tr>
                <th scope="row">Maximum curtailment</th>
                <td className="num">{doc.safety.maximum_curtailment_kw} kW</td>
              </tr>
              <tr>
                <th scope="row">Maximum ramp</th>
                <td className="num">{doc.safety.maximum_ramp_kw_per_min} kW/min</td>
              </tr>
              <tr>
                <th scope="row">Maximum duration</th>
                <td className="num">{doc.safety.maximum_duration_min} min</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sheet__note">Constraints version {doc.safety.constraints_version}.</p>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Drill history</span>
        </div>
        {doc.drill_history.length === 0 ? (
          <p>No drills have been completed at this facility.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet tnum">
              <thead>
                <tr>
                  <th>Drill</th>
                  <th>Status</th>
                  <th className="num">Requested</th>
                  <th className="num">Delivered</th>
                  <th className="num">Performance</th>
                </tr>
              </thead>
              <tbody>
                {doc.drill_history.map((drill) => (
                  <tr key={drill.drill_id}>
                    <td>
                      {drill.name}
                      {drill.simulation_mode ? (
                        <>
                          {' '}
                          <Chip kind="simulated">Simulated</Chip>
                        </>
                      ) : null}
                    </td>
                    <td>{drill.status}</td>
                    <td className="num">{drill.requested_reduction_kw} kW</td>
                    <td className="num">
                      {drill.delivered_energy_wh === null
                        ? '—'
                        : `${(Number(drill.delivered_energy_wh) / 1000).toFixed(3)} kWh`}
                    </td>
                    <td className="num">
                      {drill.performance_bps === null
                        ? '—'
                        : `${(drill.performance_bps / 100).toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Data provenance</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <thead>
              <tr>
                <th>Connector</th>
                <th>Type</th>
                <th>Last success</th>
              </tr>
            </thead>
            <tbody>
              {doc.data_quality.connector_provenance.map((connector) => (
                <tr key={`${connector.name}-${connector.connector_type}`}>
                  <td>{connector.name}</td>
                  <td>
                    {connector.connector_type === 'SIMULATOR' ? (
                      <Chip kind="simulated">{connector.connector_type}</Chip>
                    ) : (
                      connector.connector_type
                    )}
                  </td>
                  <td>{connector.last_success_at ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sheet__note">
          Window {doc.data_quality.window_start} to {doc.data_quality.window_end}.
        </p>
      </section>
    </main>
  );
}
