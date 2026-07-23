'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  armConfirmAction,
  armIntentAction,
} from '@/app/(console)/actions';
import { INITIAL_ACTION_RESULT, type ActionResult } from '@/lib/action-result';

export function DrillArmControl({ drillId }: { drillId: string }) {
  const [intent, requestChallenge] = useActionState(
    armIntentAction,
    INITIAL_ACTION_RESULT,
  );

  if (intent.status !== 'success') {
    return (
      <div className="stack">
        <p className="sheet__note">
          First generate a five-minute challenge. It freezes the exact safety
          limits and expected effect you are approving.
        </p>
        <form action={requestChallenge}>
          <input type="hidden" name="drill_id" value={drillId} />
          <ArmButton label="Review arming effects" pendingLabel="Checking safety gates…" />
        </form>
        {intent.status === 'error' ? <ActionError result={intent} /> : null}
      </div>
    );
  }

  return <ChallengeConfirmation intent={intent} />;
}

function ChallengeConfirmation({ intent }: { intent: ActionResult }) {
  const [confirmation, confirm] = useActionState(
    armConfirmAction,
    INITIAL_ACTION_RESULT,
  );
  const details = intent.details;

  return (
    <div className="stack">
      <div className="notice notice--warning" role="status">
        <span aria-hidden="true">!</span>
        <span>
          This approval expires at {formatTime(details.expires_at)}. It can be used
          once and applies only to the effects below.
        </span>
      </div>

      <dl className="definition-list tnum">
        <div><dt>Reduction</dt><dd>{details.reduction_kw} kW</dd></div>
        <div><dt>Target load</dt><dd>{details.target_load_kw} kW</dd></div>
        <div><dt>Sustain</dt><dd>{details.duration_min} min</dd></div>
        <div><dt>Estimated energy</dt><dd>{details.estimated_energy_kwh} kWh</dd></div>
        <div><dt>Ramp duration</dt><dd>{details.ramp_duration_min} min</dd></div>
      </dl>

      {details.warnings ? (
        <div className="notice notice--warning">
          <span aria-hidden="true">!</span><span>{details.warnings}</span>
        </div>
      ) : null}

      <form action={confirm} className="stack">
        <input type="hidden" name="drill_id" value={details.drill_id} />
        <input type="hidden" name="challenge_id" value={details.challenge_id} />
        <div className="field">
          <label htmlFor="confirmation_phrase">
            Type <strong>{details.confirmation_phrase}</strong> to arm
          </label>
          <input
            id="confirmation_phrase"
            name="confirmation_phrase"
            required
            autoComplete="off"
            spellCheck={false}
            aria-describedby="confirmation-help"
          />
          <p className="field__help" id="confirmation-help">
            The phrase must match exactly. Starting the drill remains a separate action.
          </p>
        </div>
        <ArmButton label="Arm drill" pendingLabel="Arming drill…" />
        {confirmation.status === 'error' ? <ActionError result={confirmation} /> : null}
      </form>
    </div>
  );
}

function ArmButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--primary" type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

function ActionError({ result }: { result: ActionResult }) {
  return (
    <div className="notice notice--error" role="alert">
      <span aria-hidden="true">×</span>
      <span>{result.message}</span>
    </div>
  );
}

function formatTime(value: string | undefined) {
  if (!value) return 'an unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}
