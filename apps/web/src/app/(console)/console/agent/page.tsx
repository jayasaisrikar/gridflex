import type { Metadata } from 'next';
import { Chip } from '@/components/chip';
import { CopyValue } from '@/components/copy-value';
import { api, type AgentSession } from '@/lib/api';
import { ageFrom, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Agent' };

type AgentStatus = AgentSession['status'];

const STATUS_KIND: Record<AgentStatus, 'tested' | 'declared' | 'violation' | 'neutral'> = {
  COMPLETED: 'tested',
  RUNNING: 'declared',
  AWAITING_APPROVAL: 'declared',
  STEP_BUDGET_EXHAUSTED: 'neutral',
  REFUSED: 'violation',
  ABORTED: 'violation',
};

const STATUS_COPY: Record<AgentStatus, string> = {
  RUNNING: 'Running',
  AWAITING_APPROVAL: 'Awaiting approval',
  COMPLETED: 'Completed',
  REFUSED: 'Refused',
  ABORTED: 'Aborted',
  STEP_BUDGET_EXHAUSTED: 'Budget exhausted',
};

export default async function AgentPage() {
  const facility = await requireFacility();
  const [{ sessions }, { reports }] = await Promise.all([
    api.agentSessions(facility.id),
    api.carbonReports(facility.id),
  ]);

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Agent sessions</h1>
            <p className="pagehead__sub">
              Every model proposal, the deterministic authorization verdict, and the
              operator decision — recorded and replayable. The model cannot raise a
              safety limit, invent a megawatt, or act without an approval bound to
              the exact plan.
            </p>
          </div>
        </div>
      </header>

      <section className="panel" aria-labelledby="agent-sessions-title">
        <div className="panel__head">
          <span className="panel__title" id="agent-sessions-title">
            Recent sessions
          </span>
        </div>
        {sessions.length === 0 ? (
          <p className="standalone-state__copy">
            No agent session has run yet. Sessions appear here when the model-driven
            harness plans an event.
          </p>
        ) : (
          <div className="stack">
            {sessions.map((session) => (
              <article key={session.id} className="panel">
                <div className="panel__head">
                  <span className="panel__title">
                    {STATUS_COPY[session.status]} · {session.model_id}
                  </span>
                  <Chip kind={STATUS_KIND[session.status]}>{session.status}</Chip>
                </div>
                <p className="standalone-state__copy">{session.situation}</p>
                <dl className="kv">
                  <div className="kv__row">
                    <dt>Started</dt>
                    <dd>{ageFrom(session.started_at)}</dd>
                  </div>
                  <div className="kv__row">
                    <dt>Steps</dt>
                    <dd>
                      {session.steps.length} · {session.steps.filter((s) => s.authorized).length} authorized
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt>Harness</dt>
                    <dd>{session.harness_version}</dd>
                  </div>
                  {session.plan_fingerprint ? (
                    <div className="kv__row">
                      <dt>Plan fingerprint</dt>
                      <dd>
                        <CopyValue value={session.plan_fingerprint} label="Copy fingerprint" />
                      </dd>
                    </div>
                  ) : null}
                  {session.approved_at ? (
                    <div className="kv__row">
                      <dt>Operator approval</dt>
                      <dd>Recorded · {ageFrom(session.approved_at)}</dd>
                    </div>
                  ) : null}
                </dl>
                {session.steps.length > 0 ? (
                  <details>
                    <summary>Model transcript ({session.steps.length} steps)</summary>
                    <ol className="stack">
                      {session.steps.map((step) => (
                        <li key={step.step}>
                          <span className="mono">
                            {step.step}. {step.proposed.name}
                          </span>{' '}
                          {step.authorized ? (
                            <Chip kind="tested">authorized</Chip>
                          ) : (
                            <Chip kind="violation">refused · {step.refusalCodes.join(', ')}</Chip>
                          )}
                          {step.reasoning ? <p className="standalone-state__copy">{step.reasoning}</p> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="carbon-title">
        <div className="panel__head">
          <span className="panel__title" id="carbon-title">
            Scope 2 carbon reports
          </span>
        </div>
        {reports.length === 0 ? (
          <p className="standalone-state__copy">
            No carbon report issued yet. Reports are sealed from verified MRV energy
            with a declared, versioned grid emission factor.
          </p>
        ) : (
          <div className="stack">
            {reports.map((report) => (
              <article key={report.id} className="panel">
                <div className="panel__head">
                  <span className="panel__title">
                    {report.avoided_tco2e} tCO₂e avoided
                  </span>
                  <Chip kind="tested">Sealed</Chip>
                </div>
                <dl className="kv">
                  <div className="kv__row">
                    <dt>Delivered</dt>
                    <dd>{String(report.report.delivered_energy_kwh)} kWh</dd>
                  </div>
                  <div className="kv__row">
                    <dt>Emission factor</dt>
                    <dd>
                      {report.report.emission_factor.kg_co2e_per_kwh} kgCO₂e/kWh ·{' '}
                      {report.emission_factor_version}
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt>Counterfactual baseline</dt>
                    <dd>{report.baseline_tco2e} tCO₂e</dd>
                  </div>
                  <div className="kv__row">
                    <dt>Report SHA-256</dt>
                    <dd>
                      <CopyValue value={report.report_sha256} label="Copy report hash" />
                    </dd>
                  </div>
                  <div className="kv__row">
                    <dt>Issued</dt>
                    <dd>{ageFrom(report.created_at)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
