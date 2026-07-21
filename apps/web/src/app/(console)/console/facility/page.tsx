import { Chip } from '@/components/chip';
import { api } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

/** Renders a decimal string as-is, never through a JS number (spec §4.1). */
function value(raw: string | null | undefined, unit: string): string {
  return raw === null || raw === undefined ? '—' : `${raw} ${unit}`;
}

function minutes(raw: number | null | undefined): string {
  return raw === null || raw === undefined ? '—' : `${raw} min`;
}

export default async function FacilityPage() {
  const summary = await requireFacility();
  const { facility, constraints, mechanisms } = await api.facility(summary.id);

  if (facility === null) {
    return (
      <main className="content stack">
        <header className="pagehead">
          <h1>Facility</h1>
          <p className="pagehead__sub">Facility not found.</p>
        </header>
      </main>
    );
  }

  const enabled = mechanisms.filter((mechanism) => mechanism.enabled);
  const declaredTotal = enabled.reduce(
    (sum, mechanism) => sum + Number(mechanism.declared_reducible_kw ?? '0'),
    0,
  );

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>{facility.name}</h1>
            <p className="pagehead__sub">
              {facility.slug} · {facility.timezone}
              {facility.region === null ? '' : ` · ${facility.region}`}
              {facility.market === null ? '' : ` · ${facility.market}`}
            </p>
          </div>
          <div className="row">
            {constraints === null ? (
              <Chip kind="violation">No active constraints</Chip>
            ) : (
              <Chip kind="tested">Constraints v{constraints.version}</Chip>
            )}
          </div>
        </div>
      </header>

      <section className="grid-metrics">
        <div className="panel">
          <span className="metric__label">Normal load</span>
          <div className="metric__value">{formatKw(facility.normal_load_kw, 0)}</div>
        </div>
        <div className="panel">
          <span className="metric__label">Minimum safe load</span>
          <div className="metric__value">{formatKw(facility.minimum_safe_load_kw, 0)}</div>
        </div>
        <div className="panel">
          <span className="metric__label">Maximum curtailment</span>
          <div className="metric__value">{formatKw(facility.maximum_curtailment_kw, 0)}</div>
        </div>
        <div className="panel">
          <span className="metric__label">Declared reducible</span>
          <div className="metric__value">
            {declaredTotal.toFixed(0)}
            <span className="metric__unit">kW</span>
          </div>
          <span className="metric__foot">
            {enabled.length} of {mechanisms.length} mechanisms enabled
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Safety constraints</span>
        </div>
        {constraints === null ? (
          <p>
            No active constraint record. The envelope engine cannot compute a capacity without
            one, so nothing is shown here rather than an unbounded figure.
          </p>
        ) : (
          <>
            <div className="sheet-wrap">
              <table className="sheet tnum">
                <tbody>
                <tr>
                  <th scope="row">Minimum safe load</th>
                  <td>{value(constraints.minimum_safe_load_kw, 'kW')}</td>
                </tr>
                <tr>
                  <th scope="row">Maximum curtailment</th>
                  <td>{value(constraints.maximum_curtailment_kw, 'kW')}</td>
                </tr>
                <tr>
                  <th scope="row">Maximum ramp</th>
                  <td>{value(constraints.maximum_ramp_kw_per_min, 'kW/min')}</td>
                </tr>
                <tr>
                  <th scope="row">Maximum duration</th>
                  <td>{minutes(constraints.maximum_duration_min)}</td>
                </tr>
                <tr>
                  <th scope="row">Minimum recovery</th>
                  <td>{minutes(constraints.minimum_recovery_min)}</td>
                </tr>
                <tr>
                  <th scope="row">Maximum rebound</th>
                  <td>{value(constraints.maximum_rebound_kw, 'kW')}</td>
                </tr>
                <tr>
                  <th scope="row">Thermal limit</th>
                  <td>{value(constraints.thermal_limit_c, '°C')}</td>
                </tr>
                </tbody>
              </table>
            </div>
            <p className="sheet__note">
              Version {constraints.version}, effective from {constraints.effective_from}
              {constraints.effective_to === null ? ' (current)' : ` to ${constraints.effective_to}`}.
              {constraints.source_note === null ? '' : ` ${constraints.source_note}`}
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Flexibility mechanisms</span>
        </div>
        {mechanisms.length === 0 ? (
          <p>No mechanisms are configured for this facility.</p>
        ) : (
          <div className="sheet-wrap">
            <table className="sheet tnum">
              <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Type</th>
                <th scope="col" className="num">Declared</th>
                <th scope="col" className="num">Ramp</th>
                <th scope="col" className="num">Max duration</th>
                <th scope="col" className="num">Rebound window</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {mechanisms.map((mechanism) => (
                <tr key={mechanism.id}>
                  <th scope="row">{mechanism.code}</th>
                  <td>{mechanism.mechanism_type}</td>
                  <td className="num">{value(mechanism.declared_reducible_kw, 'kW')}</td>
                  <td className="num">{value(mechanism.ramp_rate_kw_per_min, 'kW/min')}</td>
                  <td className="num">{minutes(mechanism.maximum_duration_min)}</td>
                  <td className="num">{minutes(mechanism.rebound_window_min)}</td>
                  <td>
                    {mechanism.enabled ? (
                      <Chip kind="tested">Enabled</Chip>
                    ) : (
                      <Chip kind="violation">Disabled</Chip>
                    )}
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sheet__note">
          A mechanism whose maximum duration is shorter than a planned drill is excluded from that
          drill entirely — one that drops out partway converts a pass into a failure.
        </p>
      </section>
    </main>
  );
}
