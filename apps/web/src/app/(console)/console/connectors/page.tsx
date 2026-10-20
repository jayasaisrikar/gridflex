import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip, type ChipKind } from '@/components/chip';
import { OperatorForm } from '@/components/operator-form';
import { api, type Connector } from '@/lib/api';
import { ageFrom, requireFacility } from '@/lib/load';
import {
  createConnectorAction,
  syncConnectorAction,
  testConnectorAction,
  toggleConnectorAction,
} from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connectors' };

export default async function ConnectorsPage() {
  const facility = await requireFacility();
  const { connectors } = await api.connectors(facility.id);
  const active = connectors.filter((connector) => connector.status === 'ACTIVE');

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Connectors</h1>
            <p className="pagehead__sub">
              Establish where each reading came from, test the source, then ingest.
            </p>
          </div>
          <div className="row">
            <Chip kind={active.length > 0 ? 'tested' : 'violation'}>
              {active.length > 0 ? `${active.length} active` : 'No active source'}
            </Chip>
            <Chip kind="neutral">{connectors.length} configured</Chip>
          </div>
        </div>
      </header>

      <div className="workbench-grid">
        <section className="stack" aria-labelledby="sources-title">
          <div className="section-intro">
            <div>
              <h2 id="sources-title">Source ledger</h2>
              <p>Credentials remain encrypted and are never returned to this screen.</p>
            </div>
          </div>

          {connectors.length === 0 ? (
            <div className="panel empty-state">
              <span className="empty-state__mark" aria-hidden="true">C0</span>
              <h2>No telemetry source</h2>
              <p>Add the simulator for a pilot walkthrough or a CSV source for meter data.</p>
            </div>
          ) : (
            <div className="connector-list">
              {connectors.map((connector) => (
                <ConnectorCard key={connector.id} connector={connector} />
              ))}
            </div>
          )}
        </section>

        <aside className="workbench-aside">
          <section className="panel stack">
            <div>
              <h2 style={{ fontSize: 'var(--text-xl)' }}>Add a pilot source</h2>
              <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
                Simulator and previewed CSV imports are operational in this build.
                Other connector types remain provenance records only.
              </p>
            </div>
            <OperatorForm
              action={createConnectorAction}
              buttonLabel="Add connector"
              pendingLabel="Adding connector…"
              showSuccess
              hidden={{ facility_id: facility.id }}
            >
              <div className="field">
                <label htmlFor="connector-name">Source name</label>
                <input
                  id="connector-name"
                  name="name"
                  required
                  defaultValue="Pilot simulator"
                  maxLength={200}
                />
                <p className="field__help">Use the meter or system name reviewers will recognize.</p>
              </div>
              <div className="field">
                <label htmlFor="connector-type">Source type</label>
                <select id="connector-type" name="connector_type" defaultValue="SIMULATOR">
                  <option value="SIMULATOR">Deterministic simulator</option>
                  <option value="CSV_UPLOAD">Previewed CSV upload</option>
                </select>
                <p className="field__help">Simulated readings are always labelled in the console.</p>
              </div>
              <div className="field">
                <label htmlFor="poll-interval">Poll interval (seconds)</label>
                <input
                  className="tnum"
                  id="poll-interval"
                  name="poll_interval_seconds"
                  type="number"
                  min="30"
                  max="86400"
                  step="1"
                  defaultValue="60"
                />
                <p className="field__help">Minimum 30 seconds. CSV sources ignore this setting.</p>
              </div>
              <details className="field-details">
                <summary>Advanced configuration</summary>
                <div className="field">
                  <label htmlFor="connector-config">Configuration JSON</label>
                  <textarea
                    className="tnum"
                    id="connector-config"
                    name="configuration_json"
                    placeholder={'{"seed": 20260721}'}
                  />
                  <p className="field__help">Stored with authenticated encryption; never echoed back.</p>
                </div>
              </details>
            </OperatorForm>
          </section>

          <section className="panel stack">
            <span className="panel__title">CSV workflow</span>
            <p>
              CSV data is never inserted on upload. GridFlex previews its window,
              interval, and rejected rows first; you explicitly confirm the exact bytes.
            </p>
            <Link className="btn" href="/console/telemetry#csv-import">Open CSV import</Link>
          </section>
        </aside>
      </div>
    </main>
  );
}

function ConnectorCard({ connector }: { connector: Connector }) {
  const canSync = connector.status === 'ACTIVE' && connector.connector_type === 'SIMULATOR';
  return (
    <article className="panel stack">
      <div className="panel__head">
        <div>
          <h2 style={{ fontSize: 'var(--text-lg)' }}>{connector.name}</h2>
          <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
            {connector.connector_type.replace(/_/g, ' ').toLowerCase()}
          </p>
        </div>
        <div className="row">
          {connector.connector_type === 'SIMULATOR' ? <Chip kind="simulated">Simulated</Chip> : null}
          <Chip kind={connectorKind(connector.status)}>{connector.status}</Chip>
        </div>
      </div>

      <dl className="definition-list">
        <Definition label="Last success" value={connector.last_success_at ? ageFrom(connector.last_success_at) : 'Never'} />
        <Definition label="Last sync" value={connector.last_sync_at ? ageFrom(connector.last_sync_at) : 'Never'} />
        <Definition label="Poll interval" value={connector.poll_interval_seconds ? `${connector.poll_interval_seconds}s` : 'Manual'} />
        <Definition label="Encrypted config" value={connector.has_configuration ? 'Present' : 'Not required'} />
      </dl>

      {connector.last_error ? (
        <div className="notice notice--error" role="alert">
          <span aria-hidden="true">×</span><span>{connector.last_error}</span>
        </div>
      ) : null}

      <div className="connector-actions">
        {connector.status !== 'DISABLED' ? (
          <OperatorForm
            action={testConnectorAction}
            buttonLabel="Test source"
            pendingLabel="Testing…"
            showSuccess
            buttonTone="neutral"
            hidden={{ connector_id: connector.id }}
          />
        ) : null}
        {canSync ? (
          <OperatorForm
            action={syncConnectorAction}
            buttonLabel="Queue simulator sync"
            pendingLabel="Queueing…"
            showSuccess
            hidden={{ connector_id: connector.id }}
          />
        ) : null}
        {connector.status === 'DISABLED' ? (
          <OperatorForm
            action={toggleConnectorAction}
            buttonLabel="Enable source"
            pendingLabel="Enabling…"
            buttonTone="neutral"
            hidden={{ connector_id: connector.id, enabled: 'true' }}
          />
        ) : (
          <details className="disclosure">
            <summary>Review source disable</summary>
            <div className="disclosure__body stack">
              <p className="sheet__note">
                Disable <strong>{connector.name}</strong>? New readings from this source will
                stop, which can make telemetry, envelopes, and Proofs stale.
              </p>
              <OperatorForm
                action={toggleConnectorAction}
                buttonLabel="Confirm disable"
                pendingLabel="Disabling…"
                buttonTone="stop"
                hidden={{ connector_id: connector.id, enabled: 'false' }}
              />
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function connectorKind(status: Connector['status']): ChipKind {
  if (status === 'ACTIVE') return 'tested';
  if (status === 'ERROR') return 'violation';
  if (status === 'DISABLED') return 'neutral';
  return 'declared';
}
