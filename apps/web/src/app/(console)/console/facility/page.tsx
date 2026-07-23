import type { Metadata } from 'next';
import { Chip } from '@/components/chip';
import { OperatorForm } from '@/components/operator-form';
import { api, type Mechanism } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';
import {
  createConstraintsAction,
  createMechanismAction,
  updateFacilityAction,
  updateMechanismAction,
} from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Facility & Safety' };

export default async function FacilityPage() {
  const selected = await requireFacility();
  const { facility, constraints, mechanisms } = await api.facility(selected.id);
  const enabledMechanisms = mechanisms.filter((mechanism) => mechanism.enabled);
  const safetyReady = Boolean(constraints && enabledMechanisms.length > 0);

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Facility & safety</h1>
            <p className="pagehead__sub">
              Configuration is evidence: every safety revision is versioned and every
              mechanism change is audited.
            </p>
          </div>
          <div className="row">
            <Chip kind={facility.status === 'ACTIVE' ? 'neutral' : 'violation'}>
              {facility.status}
            </Chip>
            <Chip kind={safetyReady ? 'neutral' : 'violation'}>
              {safetyReady ? 'Setup complete' : 'Setup incomplete'}
            </Chip>
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Readiness gates</span>
        </div>
        <ul className="checklist">
          <Gate done={Boolean(facility.normal_load_kw)} label="Normal facility load is declared" />
          <Gate done={Boolean(constraints)} label="An active safety-constraint version exists" />
          <Gate done={enabledMechanisms.length > 0} label="At least one mechanism is enabled" />
          <Gate
            done={mechanisms.every((mechanism) =>
              !mechanism.enabled || Boolean(mechanism.declared_reducible_kw),
            )}
            label="Every enabled mechanism has a declared reduction cap"
          />
        </ul>
      </section>

      <div className="workbench-grid">
        <div className="stack">
          <section className="panel">
            <div className="panel__head">
              <span className="panel__title">
                Active safety limits {constraints ? `· version ${constraints.version}` : ''}
              </span>
              {constraints ? <Chip kind="declared">Operator declared</Chip> : null}
            </div>
            {constraints ? (
              <dl className="definition-list tnum">
                <Definition label="Minimum safe load" value={`${formatKw(constraints.minimum_safe_load_kw)} kW`} />
                <Definition label="Maximum curtailment" value={`${formatKw(constraints.maximum_curtailment_kw)} kW`} />
                <Definition label="Maximum ramp" value={`${formatKw(constraints.maximum_ramp_kw_per_min)} kW/min`} />
                <Definition label="Maximum duration" value={`${constraints.maximum_duration_min} min`} />
                <Definition label="Minimum recovery" value={`${constraints.minimum_recovery_min} min`} />
                <Definition label="Maximum rebound" value={`${formatKw(constraints.maximum_rebound_kw)} kW`} />
                <Definition label="Thermal limit" value={constraints.thermal_limit_c ? `${constraints.thermal_limit_c} °C` : 'Not set'} />
                <Definition label="Effective from" value={constraints.effective_from} />
                <Definition label="Source note" value={constraints.source_note ?? 'No source note recorded'} />
              </dl>
            ) : (
              <div className="empty-state">
                <span className="empty-state__mark" aria-hidden="true">S0</span>
                <h2>No safety limits</h2>
                <p>Create the first immutable constraint version before computing an envelope.</p>
              </div>
            )}
          </section>

          <section className="stack" aria-labelledby="mechanisms-title">
            <div className="section-intro">
              <div>
                <h2 id="mechanisms-title">Flexibility mechanisms</h2>
                <p>{enabledMechanisms.length} enabled · {mechanisms.length} configured</p>
              </div>
            </div>
            {mechanisms.length === 0 ? (
              <div className="panel empty-state">
                <span className="empty-state__mark" aria-hidden="true">M0</span>
                <h2>No mechanisms</h2>
                <p>Add the operational sources that can safely reduce facility load.</p>
              </div>
            ) : (
              <div className="mechanism-list">
                {mechanisms.map((mechanism) => (
                  <MechanismEditor
                    key={mechanism.id}
                    facilityId={facility.id}
                    mechanism={mechanism}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="workbench-aside">
          <details className="disclosure" open>
            <summary>Facility identity & load</summary>
            <div className="disclosure__body">
              <OperatorForm
                action={updateFacilityAction}
                buttonLabel="Save facility"
                pendingLabel="Saving facility…"
                hidden={{ facility_id: facility.id }}
              >
                <div className="form-grid">
                  <Field scope="facility" label="Facility name" name="name" value={facility.name} required />
                  <Field scope="facility" label="Slug" name="slug" value={facility.slug} required />
                  <Field scope="facility" label="IANA timezone" name="timezone" value={facility.timezone} required />
                  <Field scope="facility" label="Country code" name="country_code" value={facility.country_code} maxLength={2} />
                  <Field scope="facility" label="Region" name="region" value={facility.region} />
                  <Field scope="facility" label="Market" name="market" value={facility.market} />
                  <Field scope="facility" label="Normal load (kW)" name="normal_load_kw" value={facility.normal_load_kw} type="number" step="0.001" />
                  <Field scope="facility" label="Minimum safe load (kW)" name="minimum_safe_load_kw" value={facility.minimum_safe_load_kw} type="number" step="0.001" />
                  <Field scope="facility" label="Maximum curtailment (kW)" name="maximum_curtailment_kw" value={facility.maximum_curtailment_kw} type="number" step="0.001" />
                  <Field scope="facility" label="Ramp limit (kW/min)" name="ramp_rate_kw_per_min" value={facility.ramp_rate_kw_per_min} type="number" step="0.001" />
                  <Field scope="facility" label="Cooling reserve (kW)" name="cooling_reserve_kw" value={facility.cooling_reserve_kw} type="number" step="0.001" />
                </div>
              </OperatorForm>
            </div>
          </details>

          <details className="disclosure">
            <summary>Create safety revision</summary>
            <div className="disclosure__body">
              <p className="sheet__note">
                This creates a new version. Existing versions remain unchanged so
                old envelopes and drills stay reproducible.
              </p>
              <OperatorForm
                action={createConstraintsAction}
                buttonLabel="Create constraint version"
                pendingLabel="Creating version…"
                showSuccess
                hidden={{ facility_id: facility.id }}
              >
                <div className="form-grid">
                  <Field scope="constraint" label="Minimum safe load (kW)" name="minimum_safe_load_kw" value={constraints?.minimum_safe_load_kw ?? facility.minimum_safe_load_kw} type="number" step="0.001" required />
                  <Field scope="constraint" label="Maximum curtailment (kW)" name="maximum_curtailment_kw" value={constraints?.maximum_curtailment_kw ?? facility.maximum_curtailment_kw} type="number" step="0.001" required />
                  <Field scope="constraint" label="Maximum ramp (kW/min)" name="maximum_ramp_kw_per_min" value={constraints?.maximum_ramp_kw_per_min ?? facility.ramp_rate_kw_per_min} type="number" step="0.001" required />
                  <Field scope="constraint" label="Maximum duration (min)" name="maximum_duration_min" value={String(constraints?.maximum_duration_min ?? 60)} type="number" step="1" required />
                  <Field scope="constraint" label="Minimum recovery (min)" name="minimum_recovery_min" value={String(constraints?.minimum_recovery_min ?? 30)} type="number" step="1" required />
                  <Field scope="constraint" label="Maximum rebound (kW)" name="maximum_rebound_kw" value={constraints?.maximum_rebound_kw} type="number" step="0.001" />
                  <Field scope="constraint" label="Thermal limit (°C)" name="thermal_limit_c" value={constraints?.thermal_limit_c} type="number" step="0.001" />
                </div>
                <div className="field">
                  <label htmlFor="excluded-workloads">Excluded workloads</label>
                  <textarea id="excluded-workloads" name="excluded_workloads" defaultValue={constraints?.excluded_workloads.join('\n') ?? ''} />
                  <p className="field__help">One workload per line.</p>
                </div>
                <div className="field">
                  <label htmlFor="source-note">Source note</label>
                  <textarea id="source-note" name="source_note" defaultValue={constraints?.source_note ?? ''} required />
                  <p className="field__help">Name the approved operating procedure or reviewer.</p>
                </div>
              </OperatorForm>
            </div>
          </details>

          <details className="disclosure">
            <summary>Add mechanism</summary>
            <div className="disclosure__body">
              <MechanismForm facilityId={facility.id} />
            </div>
          </details>
        </aside>
      </div>
    </main>
  );
}

function Gate({ done, label }: { done: boolean; label: string }) {
  return (
    <li data-state={done ? 'done' : 'blocked'}>
      <span className="checklist__state" aria-hidden="true">{done ? '✓' : '×'}</span>
      <span><span className="sr-only">{done ? 'Passed: ' : 'Blocked: '}</span>{label}</span>
    </li>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function Field({
  label,
  name,
  value,
  scope,
  type = 'text',
  step,
  required = false,
  maxLength,
}: {
  label: string;
  name: string;
  value: string | null | undefined;
  scope?: string;
  type?: string;
  step?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const id = scope ? `${scope}-${name}` : name;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={value ?? ''}
        {...(step ? { step } : {})}
        {...(maxLength ? { maxLength } : {})}
        required={required}
      />
      <p className="field__help" />
    </div>
  );
}

function MechanismEditor({
  facilityId,
  mechanism,
}: {
  facilityId: string;
  mechanism: Mechanism;
}) {
  return (
    <details className="disclosure mechanism-card">
      <summary>
        <span>
          <strong>{mechanism.name}</strong>
          <small>{mechanism.code} · {mechanism.mechanism_type.toLowerCase()}</small>
        </span>
        <span className="row">
          <Chip kind={mechanism.enabled ? 'declared' : 'neutral'}>
            {mechanism.enabled ? 'Enabled' : 'Disabled'}
          </Chip>
          <span className="tnum">{formatKw(mechanism.declared_reducible_kw)} kW</span>
        </span>
      </summary>
      <div className="disclosure__body">
        <OperatorForm
          action={updateMechanismAction}
          buttonLabel="Save mechanism"
          pendingLabel="Saving mechanism…"
          hidden={{ facility_id: facilityId, mechanism_id: mechanism.id }}
        >
          <MechanismFields mechanism={mechanism} />
        </OperatorForm>
      </div>
    </details>
  );
}

function MechanismForm({ facilityId }: { facilityId: string }) {
  return (
    <OperatorForm
      action={createMechanismAction}
      buttonLabel="Add mechanism"
      pendingLabel="Adding mechanism…"
      showSuccess
      hidden={{ facility_id: facilityId }}
    >
      <div className="form-grid">
        <Field scope="mechanism-new" label="Code" name="code" value="" required />
        <Field scope="mechanism-new" label="Name" name="name" value="" required />
      </div>
      <MechanismFields />
    </OperatorForm>
  );
}

function MechanismFields({ mechanism }: { mechanism?: Mechanism }) {
  const scope = `mechanism-${mechanism?.id ?? 'new'}`;
  return (
    <>
      <div className="field">
        <label htmlFor={`mechanism-type-${mechanism?.id ?? 'new'}`}>Mechanism type</label>
        <select id={`mechanism-type-${mechanism?.id ?? 'new'}`} name="mechanism_type" defaultValue={mechanism?.mechanism_type ?? 'WORKLOAD'}>
          <option value="WORKLOAD">Workload</option>
          <option value="COOLING">Cooling</option>
          <option value="STORAGE">Storage</option>
          <option value="OTHER">Other</option>
        </select>
        <p className="field__help" />
      </div>
      <div className="form-grid">
        <Field scope={scope} label="Declared reduction (kW)" name="declared_reducible_kw" value={mechanism?.declared_reducible_kw} type="number" step="0.001" />
        <Field scope={scope} label="Minimum load (kW)" name="minimum_load_kw" value={mechanism?.minimum_load_kw} type="number" step="0.001" />
        <Field scope={scope} label="Ramp (kW/min)" name="ramp_rate_kw_per_min" value={mechanism?.ramp_rate_kw_per_min} type="number" step="0.001" />
        <Field scope={scope} label="Maximum duration (min)" name="maximum_duration_min" value={mechanism?.maximum_duration_min === null || mechanism?.maximum_duration_min === undefined ? '' : String(mechanism.maximum_duration_min)} type="number" step="1" />
        <Field scope={scope} label="Rebound window (min)" name="rebound_window_min" value={mechanism?.rebound_window_min === null || mechanism?.rebound_window_min === undefined ? '' : String(mechanism.rebound_window_min)} type="number" step="1" />
        <Field scope={scope} label="Control reference" name="control_reference" value={mechanism?.control_reference} />
      </div>
      <div className="field">
        <label htmlFor={`mechanism-description-${mechanism?.id ?? 'new'}`}>Description</label>
        <textarea id={`mechanism-description-${mechanism?.id ?? 'new'}`} name="description" defaultValue={mechanism?.description ?? ''} />
        <p className="field__help">Describe what changes operationally when this mechanism is used.</p>
      </div>
      <label className="check-field">
        <input type="checkbox" name="enabled" defaultChecked={mechanism?.enabled ?? true} />
        <span><strong>Enabled for envelope calculation</strong><small>Disabled mechanisms stay in the audit record but contribute no capacity.</small></span>
      </label>
    </>
  );
}
