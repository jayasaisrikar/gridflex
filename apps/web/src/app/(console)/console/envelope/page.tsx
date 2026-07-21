import { Chip, Provenance } from '@/components/chip';
import { MechanismBars } from '@/components/mechanism-bars';
import { api } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

/**
 * Envelope — spec §16 / §12.
 *
 * The page's job is to make the number explainable, not just visible. Every
 * mechanism shows its provenance, and the aggregation shows which cap actually
 * bound the result.
 */
export default async function EnvelopePage() {
  const facility = await requireFacility();
  const { envelope, mechanisms } = await api.currentEnvelope(facility.id);

  if (!envelope) {
    return (
      <main className="content stack">
        <header className="pagehead">
          <h1>Envelope</h1>
          <p className="pagehead__sub">No envelope has been computed.</p>
        </header>
        <section className="panel">
          <p>
            This facility has no current flexibility envelope. One is created by a
            recompute, which validates data quality, computes per-mechanism caps,
            and records the reasoning behind every number.
          </p>
        </section>
      </main>
    );
  }

  const binding = String(envelope.summary?.binding_constraint ?? 'UNKNOWN');
  const adjustments =
    (envelope.summary?.confidence_adjustments as
      | { code: string; delta: number; reason: string }[]
      | undefined) ?? [];

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Flexibility envelope</h1>
            <p className="pagehead__sub">
              version {envelope.version} · {envelope.methodology_version} ·
              constraints v{envelope.constraints_version}
            </p>
          </div>
          <div className="row">
            <Chip kind={envelope.status === 'CURRENT' ? 'tested' : 'declared'}>
              {envelope.status}
            </Chip>
          </div>
        </div>
      </header>

      {envelope.blocked_reasons.length > 0 ? (
        <section
          className="panel"
          style={{
            borderColor: 'var(--color-violation)',
            background: 'var(--color-violation-wash)',
          }}
        >
          <div className="panel__head">
            <span className="panel__title" style={{ color: 'var(--color-violation)' }}>
              Blocked
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            {envelope.blocked_reasons.map((reason) => (
              <li key={reason.code}>
                <strong className="tnum">{reason.code}</strong> — {reason.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid-metrics">
        <div className="panel">
          <span className="metric__label">Total reducible</span>
          <div className="metric__value">
            {formatKw(envelope.total_reducible_kw)}
            <span className="metric__unit">kW</span>
          </div>
          <div className="metric__foot">
            bound by {binding.replace(/_/g, ' ').toLowerCase()}
          </div>
        </div>
        <div className="panel">
          <span className="metric__label">Aggregate ramp</span>
          <div className="metric__value">
            {formatKw(envelope.aggregate_ramp_kw_per_min)}
            <span className="metric__unit">kW/min</span>
          </div>
          <div className="metric__foot">capped by facility limit</div>
        </div>
        <div className="panel">
          <span className="metric__label">Sustainable duration</span>
          <div className="metric__value">
            {envelope.sustainable_duration_min}
            <span className="metric__unit">min</span>
          </div>
          <div className="metric__foot">shortest contributing mechanism</div>
        </div>
        <div className="panel">
          <span className="metric__label">Confidence</span>
          <div className="metric__value">{envelope.confidence_score.toFixed(2)}</div>
          <div className="metric__foot">
            <Chip kind={envelope.confidence_score >= 0.6 ? 'tested' : 'declared'}>
              {envelope.confidence_score >= 0.85
                ? 'Tested basis'
                : envelope.confidence_score >= 0.6
                  ? 'Modeled basis'
                  : 'Declared basis'}
            </Chip>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Capacity by mechanism</span>
          <span className="sheet__note">bar length is reducible kW</span>
        </div>
        <MechanismBars
          mechanisms={mechanisms.map((m) => ({
            code: m.mechanism_code,
            name: m.mechanism_name,
            kw: Number(m.reducible_kw),
            provenance: m.provenance,
          }))}
          totalKw={Number(envelope.total_reducible_kw)}
        />
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Per-mechanism detail</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet tnum">
            <thead>
              <tr>
                <th>Mechanism</th>
                <th>Provenance</th>
                <th className="num">Reducible</th>
                <th className="num">Ramp</th>
                <th className="num">Duration</th>
                <th className="num">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {mechanisms.map((mechanism) => (
                <tr key={mechanism.mechanism_id}>
                  <td>
                    {mechanism.mechanism_name}
                    <div className="sheet__note">{mechanism.mechanism_code}</div>
                  </td>
                  <td>
                    <Provenance value={mechanism.provenance} />
                  </td>
                  <td className="num">{mechanism.reducible_kw} kW</td>
                  <td className="num">{mechanism.ramp_kw_per_min} kW/min</td>
                  <td className="num">{mechanism.duration_min} min</td>
                  <td className="num">{mechanism.confidence_score.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {adjustments.length > 0 ? (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">How confidence was derived</span>
            <span className="sheet__note">every adjustment, in order</span>
          </div>
          <div className="sheet-wrap">
            <table className="sheet tnum">
              <thead>
                <tr>
                  <th>Adjustment</th>
                  <th className="num">Delta</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment, index) => (
                  <tr key={`${adjustment.code}-${index}`}>
                    <td>{adjustment.code.replace(/_/g, ' ').toLowerCase()}</td>
                    <td
                      className="num"
                      style={{
                        color:
                          adjustment.delta < 0
                            ? 'var(--color-declared)'
                            : 'var(--color-ink)',
                      }}
                    >
                      {adjustment.delta > 0 ? '+' : ''}
                      {adjustment.delta.toFixed(2)}
                    </td>
                    <td className="sheet__note">{adjustment.reason}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Final</strong>
                  </td>
                  <td className="num">
                    <strong>{envelope.confidence_score.toFixed(2)}</strong>
                  </td>
                  <td className="sheet__note">
                    Capped at 0.95 until an external reviewer or production event
                    is recorded.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
