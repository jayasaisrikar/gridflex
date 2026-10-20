import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip } from '@/components/chip';
import { CopyValue } from '@/components/copy-value';
import { OperatorForm } from '@/components/operator-form';
import { PassportExportControl } from '@/components/passport-export-control';
import { api } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';
import { issuePassportAction } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Proof' };

export default async function PassportPage() {
  const facility = await requireFacility();
  const [{ passports }, { envelope }, quality, { drills }] = await Promise.all([
    api.passports(facility.id),
    api.currentEnvelope(facility.id),
    api.telemetryQuality(facility.id),
    api.drills(facility.id),
  ]);
  const current = passports[0] ?? null;
  const completedDrills = drills.filter((drill) => drill.status === 'COMPLETED');
  const [record, verification] = current
    ? await Promise.all([
        api.passport(current.id).then((result) => result.passport),
        api.verifyPassport(current.id),
      ])
    : [null, null];
  const issuanceReady = Boolean(
    envelope?.status === 'CURRENT' &&
      envelope.telemetry_completeness >= 0.9 &&
      quality.completeness >= 0.9 &&
      !quality.is_stale,
  );

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>GridFlex Proof</h1>
            <p className="pagehead__sub">
              A versioned, independently hash-verifiable record of capability,
              safety limits, data quality, and test history.
            </p>
          </div>
          <div className="row">
            {current ? (
              <Chip
                kind={
                  verification?.passport_hash_matches && verification.evidence_hash_matches
                    ? 'tested'
                    : 'neutral'
                }
              >
                {verification?.passport_hash_matches && verification.evidence_hash_matches
                  ? `Verified · v${current.version}`
                  : `Proof v${current.version}`}
              </Chip>
            ) : null}
            {current?.contains_simulated_data ? <Chip kind="simulated">Contains simulation</Chip> : null}
            {!current ? <Chip kind="declared">Not issued</Chip> : null}
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Issuance gates</span>
          <Chip kind={issuanceReady ? 'tested' : 'violation'}>
            {issuanceReady ? 'Ready to issue' : 'Blocked'}
          </Chip>
        </div>
        <ul className="checklist">
          <Gate done={envelope?.status === 'CURRENT'} label="A current envelope exists" />
          <Gate done={Boolean(envelope && envelope.telemetry_completeness >= 0.9)} label="Envelope telemetry completeness is at least 90%" />
          <Gate done={quality.completeness >= 0.9 && !quality.is_stale} label="Current telemetry window is complete and fresh" />
          <Gate done={completedDrills.length > 0} optional label="A verified drill can be associated for stronger evidence" />
        </ul>
      </section>

      {!record || !current || !verification ? (
        <div className="workbench-grid">
          <section className="panel empty-state">
            <span className="empty-state__mark" aria-hidden="true">P0</span>
            <h2>No Proof issued</h2>
            <p>
              Issue the first version once the current envelope and telemetry gates
              pass. The resulting JSON is sealed before it is stored.
            </p>
          </section>
          <IssuePanel
            facilityId={facility.id}
            envelopeId={envelope?.id ?? null}
            drills={completedDrills}
            ready={issuanceReady}
          />
        </div>
      ) : (
        <>
          <section className="grid-metrics">
            <div className="panel">
              <span className="metric__label">Current capability</span>
              <div className="metric__value">
                {formatKw(record.document.envelope.total_reducible_kw)}
                <span className="metric__unit">kW</span>
              </div>
              <div className="metric__foot">envelope v{record.document.envelope.version}</div>
            </div>
            <div className="panel">
              <span className="metric__label">Data completeness</span>
              <div className="metric__value">
                {(Number(record.document.data_quality.completeness) * 100).toFixed(1)}
                <span className="metric__unit">%</span>
              </div>
              <div className="metric__foot">sealed at issuance</div>
            </div>
            <div className="panel">
              <span className="metric__label">Drill history</span>
              <div className="metric__value">{record.document.drill_history.length}</div>
              <div className="metric__foot">included records</div>
            </div>
            <div className="panel">
              <span className="metric__label">Status</span>
              <div className="metric__value" style={{ fontSize: 'var(--text-2xl)' }}>
                {record.status}
              </div>
              <div className="metric__foot">issued {record.document.issued_at}</div>
            </div>
          </section>

          <div className="workbench-grid">
            <div className="stack">
              <section className="panel stack">
                <div className="panel__head">
                  <span className="panel__title">Independent verification</span>
                  <Chip
                    kind={
                      verification.passport_hash_matches && verification.evidence_hash_matches
                        ? 'tested'
                        : 'violation'
                    }
                  >
                    {verification.passport_hash_matches && verification.evidence_hash_matches
                      ? 'Hashes match'
                      : 'Verification failed'}
                  </Chip>
                </div>
                <HashRow label="Proof SHA-256" value={record.passport_sha256} />
                <HashRow label="Evidence SHA-256" value={record.document.evidence_sha256} />
                <p className="sheet__note">{verification.instructions}</p>
              </section>

              <section className="panel">
                <div className="panel__head">
                  <span className="panel__title">Capability provenance</span>
                </div>
                <div className="sheet-wrap">
                  <table className="sheet tnum">
                    <thead>
                      <tr>
                        <th>Mechanism</th><th>Evidence class</th>
                        <th className="num">Reducible</th><th className="num">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {record.document.envelope.mechanisms.map((mechanism) => (
                        <tr key={mechanism.mechanism_id}>
                          <td>{mechanism.mechanism_name}<div className="sheet__note">{mechanism.mechanism_code}</div></td>
                          <td><Chip kind={mechanism.provenance === 'TESTED' ? 'tested' : 'declared'}>{mechanism.provenance}</Chip></td>
                          <td className="num">{mechanism.reducible_kw} kW</td>
                          <td className="num">{mechanism.confidence_score}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel">
                <div className="panel__head">
                  <span className="panel__title">Limitations carried with this version</span>
                </div>
                <ul className="limitations-list">
                  {record.document.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </section>
            </div>

            <aside className="workbench-aside">
              <section className="panel stack">
                <div>
                  <h2 style={{ fontSize: 'var(--text-xl)' }}>Reviewer export</h2>
                  <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
                    Every export is audited and expires after seven days.
                  </p>
                </div>
                <PassportExportControl passportId={current.id} />
                <Link className="btn" href={`/api/passports/${current.id}/download`} download>
                  Download canonical JSON
                </Link>
              </section>

              <IssuePanel
                facilityId={facility.id}
                envelopeId={envelope?.id ?? null}
                drills={completedDrills}
                ready={issuanceReady}
                nextVersion={current.version + 1}
              />
            </aside>
          </div>

          <section className="stack" aria-labelledby="versions-title">
            <div className="section-intro">
              <div><h2 id="versions-title">Version ledger</h2><p>Superseded documents remain verifiable.</p></div>
            </div>
            <ol className="record-list">
              {passports.map((passport) => (
                <li className="record-list__item" key={passport.id}>
                  <div className="record-list__main">
                    <div className="row">
                      <h3>Proof v{passport.version}</h3>
                      <Chip kind="neutral">{passport.status}</Chip>
                      {passport.contains_simulated_data ? <Chip kind="simulated">Simulated</Chip> : null}
                    </div>
                    <p className="tnum">{passport.issued_at ?? 'Not issued'} · {passport.passport_sha256.slice(0, 16)}…</p>
                  </div>
                  <Link className="btn" href={`/api/passports/${passport.id}/download`} download>
                    Download JSON
                  </Link>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </main>
  );
}

function IssuePanel({
  facilityId,
  envelopeId,
  drills,
  ready,
  nextVersion = 1,
}: {
  facilityId: string;
  envelopeId: string | null;
  drills: Awaited<ReturnType<typeof api.drills>>['drills'];
  ready: boolean;
  nextVersion?: number;
}) {
  return (
    <section className="panel stack">
      <div>
        <h2 style={{ fontSize: 'var(--text-xl)' }}>Issue version {nextVersion}</h2>
        <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
          Issuance never edits the previous version.
        </p>
      </div>
      {!ready || !envelopeId ? (
        <div className="notice notice--warning">
          <span aria-hidden="true">!</span>
          <span>Resolve the failed issuance gates before creating a new version.</span>
        </div>
      ) : (
        <OperatorForm
          action={issuePassportAction}
          buttonLabel={`Issue Proof v${nextVersion}`}
          pendingLabel="Sealing Proof…"
          showSuccess
          hidden={{ facility_id: facilityId, envelope_id: envelopeId }}
        >
          <div className="field">
            <label htmlFor={`passport-drill-${nextVersion}`}>Associated verified drill</label>
            <select id={`passport-drill-${nextVersion}`} name="drill_id" defaultValue={drills[0]?.id ?? ''}>
              <option value="">No associated drill — record a limitation</option>
              {drills.map((drill) => (
                <option value={drill.id} key={drill.id}>{drill.name}</option>
              ))}
            </select>
            <p className="field__help">Only completed drills appear here.</p>
          </div>
          <div className="field">
            <label htmlFor={`passport-notes-${nextVersion}`}>Reviewer note</label>
            <textarea
              id={`passport-notes-${nextVersion}`}
              name="notes"
              placeholder="Scope and intended pilot counterparty"
            />
            <p className="field__help">This note becomes part of the hashed document.</p>
          </div>
        </OperatorForm>
      )}
    </section>
  );
}

function Gate({
  done,
  label,
  optional = false,
}: {
  done: boolean;
  label: string;
  optional?: boolean;
}) {
  return (
    <li data-state={done ? 'done' : optional ? 'pending' : 'blocked'}>
      <span className="checklist__state" aria-hidden="true">{done ? '✓' : optional ? '◇' : '×'}</span>
      <span>
        <span className="sr-only">
          {done ? 'Passed: ' : optional ? 'Optional pending: ' : 'Blocked: '}
        </span>
        {label}{optional && !done ? ' (optional)' : ''}
      </span>
    </li>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hash-row">
      <div><span className="metric__label">{label}</span><code>{value}</code></div>
      <CopyValue value={value} label={`Copy ${label}`} />
    </div>
  );
}
