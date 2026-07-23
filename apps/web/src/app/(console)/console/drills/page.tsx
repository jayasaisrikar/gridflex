import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip, type ChipKind } from '@/components/chip';
import { OperatorForm } from '@/components/operator-form';
import { api } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';
import { createDrillAction } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Drills' };

export default async function DrillsPage() {
  const facility = await requireFacility();
  const [{ drills }, { envelope }, quality] = await Promise.all([
    api.drills(facility.id),
    api.currentEnvelope(facility.id),
    api.telemetryQuality(facility.id),
  ]);
  const start = new Date(Date.now() + 5 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const suggestedReduction = envelope
    ? Math.min(500, Number(envelope.total_reducible_kw)).toFixed(3)
    : '500.000';

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Drill workbench</h1>
            <p className="pagehead__sub">
              Plan, validate, arm, and prove one operator-controlled capability test.
            </p>
          </div>
          <div className="row">
            <Chip kind={quality.meets_drill_threshold ? 'tested' : 'violation'}>
              {quality.meets_drill_threshold ? 'Telemetry ready' : 'Telemetry blocks arming'}
            </Chip>
            <Chip kind="neutral">{drills.length} total</Chip>
          </div>
        </div>
      </header>

      <div className="workbench-grid">
        <section className="stack" aria-labelledby="drill-ledger-title">
          <div className="section-intro">
            <div>
              <h2 id="drill-ledger-title">Drill ledger</h2>
              <p>Every transition is timestamped; no status can be edited directly.</p>
            </div>
          </div>

          {drills.length === 0 ? (
            <div className="panel empty-state">
              <span className="empty-state__mark" aria-hidden="true">D0</span>
              <h2>No drill plans yet</h2>
              <p>Create a simulation plan to test the complete approval and evidence path.</p>
            </div>
          ) : (
            <ol className="record-list">
              {drills.map((drill) => (
                <li key={drill.id} className="record-list__item">
                  <div className="record-list__main">
                    <div className="row">
                      <h3>{drill.name}</h3>
                      <Chip kind={statusKind(drill.status)}>{drill.status}</Chip>
                      {drill.simulation_mode ? <Chip kind="simulated">Simulated</Chip> : null}
                    </div>
                    <p>
                      <span className="tnum">{formatKw(drill.requested_reduction_kw)} kW</span>
                      {' · '}{drill.baseline_method.replace(/_/g, ' ').toLowerCase()}
                    </p>
                  </div>
                  <Link className="btn" href={`/console/drills/${drill.id}`}>
                    Open proof chain
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className="workbench-aside" aria-labelledby="new-drill-title">
          <section className="panel stack">
            <div>
              <h2 id="new-drill-title" style={{ fontSize: 'var(--text-xl)' }}>
                Plan a drill
              </h2>
              <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
                Planning does not arm or start equipment. Those remain separate,
                explicit actions.
              </p>
            </div>

            {!envelope ? (
              <div className="notice notice--warning">
                <span aria-hidden="true">!</span>
                <span>
                  Compute a current envelope before planning a drill.{' '}
                  <Link href="/console/envelope">Open Envelope</Link>.
                </span>
              </div>
            ) : (
              <OperatorForm
                action={createDrillAction}
                buttonLabel="Create drill plan"
                pendingLabel="Creating plan…"
                showSuccess
                hidden={{ facility_id: facility.id, envelope_id: envelope.id }}
              >
                <div className="field">
                  <label htmlFor="drill-name">Plan name</label>
                  <input
                    id="drill-name"
                    name="name"
                    required
                    defaultValue="Pilot capability drill"
                    maxLength={120}
                  />
                  <p className="field__help">Use a name an external reviewer will understand.</p>
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="requested-reduction">Requested reduction (kW)</label>
                    <input
                      className="tnum"
                      id="requested-reduction"
                      name="requested_reduction_kw"
                      type="number"
                      min="0.001"
                      max={envelope.total_reducible_kw}
                      step="0.001"
                      required
                      defaultValue={suggestedReduction}
                    />
                    <p className="field__help">
                      Current envelope: {formatKw(envelope.total_reducible_kw)} kW.
                    </p>
                  </div>
                  <div className="field">
                    <label htmlFor="planned-ramp">Planned ramp (kW/min)</label>
                    <input
                      className="tnum"
                      id="planned-ramp"
                      name="planned_ramp_kw_per_min"
                      type="number"
                      min="0.001"
                      step="0.001"
                      defaultValue={facility.ramp_rate_kw_per_min ?? ''}
                    />
                    <p className="field__help">Leave blank to derive it from the envelope.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="planned-start">Start (UTC)</label>
                    <input
                      className="tnum"
                      id="planned-start"
                      name="planned_start_at"
                      type="datetime-local"
                      required
                      defaultValue={utcLocalValue(start)}
                    />
                    <p className="field__help">Displayed and stored as UTC.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="planned-end">End (UTC)</label>
                    <input
                      className="tnum"
                      id="planned-end"
                      name="planned_end_at"
                      type="datetime-local"
                      required
                      defaultValue={utcLocalValue(end)}
                    />
                    <p className="field__help">Must be after the planned start.</p>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="operator-notes">Operator notes</label>
                  <textarea
                    id="operator-notes"
                    name="operator_notes"
                    placeholder="Scope, shift handoff, and expected operational impact"
                  />
                  <p className="field__help">These notes become part of the review record.</p>
                </div>
                <div className="notice" role="note" aria-label="Pilot execution mode">
                  <span aria-hidden="true">SIM</span>
                  <span>
                    <strong>Simulation-only pilot mode</strong>
                    <small className="sheet__note">
                      Locked for this release. No physical equipment command can be sent.
                    </small>
                  </span>
                </div>
              </OperatorForm>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

function statusKind(status: string): ChipKind {
  if (status === 'COMPLETED') return 'tested';
  if (status === 'FAILED' || status === 'ABORTED' || status === 'CANCELLED') {
    return 'violation';
  }
  return 'declared';
}

function utcLocalValue(date: Date) {
  return date.toISOString().slice(0, 16);
}
