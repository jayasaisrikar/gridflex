import type { InputHTMLAttributes } from 'react';
import { redirect } from 'next/navigation';
import { OperatorForm } from '@/components/operator-form';
import { api, ApiError, UNAUTHENTICATED } from '@/lib/api';
import { createFirstFacilityAction } from '../(console)/actions';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  try {
    const { facilities } = await api.facilities();
    if (facilities.length > 0) redirect('/console');
  } catch (error) {
    if (error instanceof ApiError && error.code === UNAUTHENTICATED) redirect('/login');
    throw error;
  }

  return (
    <main className="auth-shell auth-shell--wide">
      <header className="auth-intro">
        <p className="eyebrow">Workspace setup · 01</p>
        <h1>Define the facility boundary</h1>
        <p>
          Start with the values operators already use to protect the site. GridFlex
          will not claim flexibility until safety constraints, a mechanism, and
          telemetry are added next.
        </p>
      </header>

      <section className="panel auth-panel" aria-labelledby="facility-setup-title">
        <div className="panel__head">
          <div>
            <span className="panel__title" id="facility-setup-title">Facility identity &amp; guardrails</span>
            <p className="panel__meta">All power values are kW. You can revise these audited fields later.</p>
          </div>
          <span className="chip chip--neutral">Required</span>
        </div>

        <OperatorForm
          action={createFirstFacilityAction}
          buttonLabel="Create facility & continue"
          pendingLabel="Creating facility…"
          className="stack setup-form"
        >
          <div className="form-grid">
            <SetupField label="Facility name" name="name" autoComplete="organization" required help="The name operators use on shift." />
            <SetupField label="Facility slug" name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="blr-01" required help="Lowercase letters, numbers, and hyphens." />
            <SetupField label="IANA timezone" name="timezone" defaultValue="UTC" placeholder="Asia/Kolkata" required help="Used for schedules; evidence is stored in UTC." />
            <SetupField label="Country code" name="country_code" maxLength={2} placeholder="IN" help="Two-letter ISO code." />
            <SetupField label="Region" name="region" placeholder="Karnataka" />
            <SetupField label="Market" name="market" placeholder="Pilot / bilateral" />
          </div>

          <div className="setup-divider">
            <span>Operating guardrails</span>
            <p>Use approved operating values—not aspirational targets.</p>
          </div>

          <div className="form-grid">
            <SetupField label="Normal facility load" name="normal_load_kw" type="number" min="0" step="0.001" required suffix="kW" help="Representative stable operating load." />
            <SetupField label="Minimum safe load" name="minimum_safe_load_kw" type="number" min="0" step="0.001" required suffix="kW" help="The site must remain at or above this load." />
            <SetupField label="Maximum curtailment" name="maximum_curtailment_kw" type="number" min="0" step="0.001" required suffix="kW" help="Hard upper limit before constraint modeling." />
            <SetupField label="Ramp limit" name="ramp_rate_kw_per_min" type="number" min="0" step="0.001" required suffix="kW/min" help="Maximum approved rate of reduction." />
            <SetupField label="Cooling reserve" name="cooling_reserve_kw" type="number" min="0" step="0.001" required suffix="kW" help="Capacity reserved for cooling protection; enter 0 if not applicable." />
          </div>

          <div className="notice" role="note">
            <span aria-hidden="true">i</span>
            <span>Next, create an immutable safety-constraint version and at least one controllable mechanism.</span>
          </div>
        </OperatorForm>
      </section>

      <footer className="auth-ledger">
        Pilot boundary · simulation execution only · no automatic control commands
      </footer>
    </main>
  );
}

function SetupField({
  label,
  name,
  help,
  suffix,
  ...inputProps
}: {
  label: string;
  name: string;
  help?: string;
  suffix?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = `setup-${name}`;
  const helpId = `${id}-help`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}{suffix ? ` (${suffix})` : ''}</label>
      <input id={id} name={name} aria-describedby={help ? helpId : undefined} {...inputProps} />
      {help ? <p className="field__help" id={helpId}>{help}</p> : null}
    </div>
  );
}
