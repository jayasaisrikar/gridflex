import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Chip, type ChipKind } from '@/components/chip';
import { DrillArmControl } from '@/components/drill-arm-control';
import { MrvChart } from '@/components/mrv-chart';
import { OperatorForm } from '@/components/operator-form';
import { api, ApiError } from '@/lib/api';
import { formatKw, requireFacility, whToKwh } from '@/lib/load';
import {
  abortDrillAction,
  emergencyStopAction,
  startDrillAction,
  stopDrillAction,
  validateDrillAction,
  verifyDrillAction,
} from '../../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Drill proof chain' };

/**
 * The proof chain — spec §16.3.
 *
 * Stages are derived from the drill's IMMUTABLE event timeline, not from a
 * hardcoded list. If an event was never written, its stage shows as not reached.
 * The page cannot claim a step happened that the database has no record of.
 */

type StageSpec = {
  readonly stage: string;
  readonly title: string;
  readonly eventType: string | null;
  readonly detail: (context: Context) => string;
  readonly verified?: (context: Context) => boolean;
};

type Context = {
  drill: Awaited<ReturnType<typeof api.drill>>['drill'];
  mrv: Awaited<ReturnType<typeof api.drill>>['mrv'];
  evidence: Awaited<ReturnType<typeof api.drill>>['evidence'];
};

const STAGES: readonly StageSpec[] = [
  {
    stage: '1.0',
    title: 'Plan',
    eventType: 'CREATED',
    detail: (c) =>
      `Requested ${formatKw(c.drill.requested_reduction_kw, 3)} kW reduction. Baseline method ${c.drill.baseline_method}.`,
  },
  {
    stage: '2.0',
    title: 'Validation',
    eventType: 'VALIDATED',
    detail: () =>
      'A safety-validation event was recorded. The event reason below identifies the engine decision; no editable status flag is treated as proof.',
  },
  {
    stage: '3.0',
    title: 'Operator arming',
    eventType: 'ARMED',
    detail: () =>
      'An arming event exists. API-created drills write this only after a single-use challenge with a frozen constraint snapshot is confirmed.',
  },
  {
    stage: '4.0',
    title: 'Execution',
    eventType: 'STARTED',
    detail: () =>
      'Execution start was recorded. This event proves only that execution began; delivery and safety outcomes require completion telemetry and MRV.',
  },
  {
    stage: '5.0',
    title: 'Telemetry',
    eventType: 'COMPLETED',
    detail: (c) =>
      c.mrv
        ? `${(c.mrv.telemetry_completeness * 100).toFixed(1)}% complete, longest gap ${c.mrv.maximum_gap_intervals} intervals. The MRV input refers to append-only readings.`
        : 'A completion event exists, but no MRV quality summary is available yet.',
  },
  {
    stage: '6.0',
    title: 'MRV',
    eventType: 'MRV_GENERATED',
    verified: (c) => Boolean(c.mrv),
    detail: (c) =>
      c.mrv
        ? `Delivered ${whToKwh(c.mrv.delivered_energy_wh)} kWh against ${whToKwh(c.mrv.committed_energy_wh)} kWh committed. Summed in exact integer watt-hours; no interval interpolated.`
        : 'No MRV report has been generated.',
  },
  {
    stage: '7.0',
    title: 'Evidence hash',
    eventType: null,
    verified: (c) => Boolean(c.evidence),
    detail: (c) =>
      c.evidence
        ? `Canonical JSON sealed under ${c.evidence.schema_version}. SHA-256 computed over the canonical bytes and stored with the document.`
        : 'No evidence bundle has been sealed for this drill.',
  },
  {
    stage: '8.0',
    title: 'Passport',
    eventType: 'PASSPORT_ISSUED',
    detail: () =>
      'Issuance requires a current envelope, successful canonicalisation, telemetry quality above threshold, and an MRV report.',
  },
];

export default async function DrillDetailPage({
  params,
}: {
  params: Promise<{ drillId: string }>;
}) {
  const { drillId } = await params;
  await requireFacility();

  let data: Awaited<ReturnType<typeof api.drill>>;
  try {
    data = await api.drill(drillId);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 404)) notFound();
    throw error;
  }

  const { drill, events, mrv, evidence } = data;
  const context: Context = { drill, mrv, evidence };
  const eventByType = new Map(events.map((event) => [event.event_type, event]));

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>{drill.name}</h1>
            <p className="pagehead__sub">
              <Link href="/console/drills">Drills</Link> · baseline {drill.baseline_method}
            </p>
          </div>
          <div className="row">
            {drill.simulation_mode ? <Chip kind="simulated">Simulated</Chip> : null}
            <Chip kind={drill.status === 'COMPLETED' ? 'tested' : 'declared'}>
              {drill.status}
            </Chip>
          </div>
        </div>
      </header>

      <OperationalControls drill={drill} />

      {mrv ? (
        <section className="grid-metrics" aria-label="Drill result">
          <Readout
            label="Delivered energy"
            value={whToKwh(mrv.delivered_energy_wh)}
            unit="kWh"
            foot={`of ${whToKwh(mrv.committed_energy_wh)} committed`}
          />
          <Readout
            label="Performance"
            value={(mrv.performance_bps / 100).toFixed(2)}
            unit="%"
            foot={`${mrv.performance_bps} bps`}
          />
          <Readout
            label="Average delivered"
            value={mrv.average_delivered_kw}
            unit="kW"
            foot={`of ${formatKw(drill.requested_reduction_kw)} requested`}
          />
          <Readout
            label="Completeness"
            value={(mrv.telemetry_completeness * 100).toFixed(1)}
            unit="%"
            foot={`max gap ${mrv.maximum_gap_intervals} intervals`}
          />
        </section>
      ) : null}

      {/* ---- Baseline vs actual ---- */}
      {mrv ? (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Baseline versus actual load</span>
            <span className="sheet__note">
              delivered energy is the area between the two lines
            </span>
          </div>
          <MrvChart
            baseline={mrv.baseline_series}
            actual={mrv.actual_series}
            intervalSeconds={mrv.interval_seconds}
          />
        </section>
      ) : null}

      {/* ---- Proof chain ---- */}
      <section aria-labelledby="chain-heading" className="panel">
        <div className="panel__head">
          <span className="panel__title" id="chain-heading">
            Proof chain
          </span>
          <span className="sheet__note">each stage depends on the one above it</span>
        </div>

        <ol className="chain">
          {STAGES.map((spec) => {
            const event = spec.eventType ? eventByType.get(spec.eventType) : undefined;
            const reached =
              spec.eventType === null ? Boolean(evidence) : Boolean(event);
            const verified = reached && Boolean(spec.verified?.(context));
            const state = verified ? 'done' : reached ? 'recorded' : 'pending';
            const chip: { kind: ChipKind; label: string } = !reached
              ? { kind: 'declared', label: 'Not reached' }
              : verified
                ? { kind: 'tested', label: 'Verified' }
                : { kind: 'neutral', label: 'Recorded' };

            return (
              <li key={spec.stage} className="chain__step" data-state={state}>
                <span className="chain__stage" aria-hidden="true">
                  {spec.stage}
                </span>
                <div className="chain__body">
                  <h3 className="chain__title">
                    {spec.title}
                    <Chip kind={chip.kind}>{chip.label}</Chip>
                  </h3>
                  <p className="chain__detail">{spec.detail(context)}</p>
                  <div className="chain__meta">
                    {event ? <span>{event.occurred_at}</span> : null}
                    {event ? <span>{event.actor_service ?? actorLabel(event.actor_user_id)}</span> : null}
                    {event?.reason_code ? <span>{event.reason_code}</span> : null}
                    {!reached ? <span>no event recorded</span> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ---- Evidence ---- */}
      {evidence ? (
        <section className="panel">
          <div className="panel__head">
            <span className="panel__title">Evidence digest</span>
            <Chip kind="tested">Verifiable</Chip>
          </div>
          <p className="sheet__note" style={{ marginBottom: 'var(--space-sm)' }}>
            SHA-256 over the canonical bytes. A reviewer can recompute this
            independently — keys sorted recursively, timestamps normalised to UTC,
            decimals as strings, no insignificant whitespace.
          </p>
          <div className="hash">{evidence.canonical_sha256}</div>
        </section>
      ) : null}

      {/* ---- Method ---- */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Method and limitations</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet">
            <tbody>
              <tr>
                <th scope="row">Baseline</th>
                <td>{drill.baseline_method.replace(/_/g, ' ').toLowerCase()}</td>
              </tr>
              <tr>
                <th scope="row">Missing intervals</th>
                <td>Contribute zero delivered energy. Never interpolated.</td>
              </tr>
              <tr>
                <th scope="row">Rebound</th>
                <td>Reported separately. Never netted off delivered energy.</td>
              </tr>
              <tr>
                <th scope="row">Arithmetic</th>
                <td>Exact integer watt-hours. No floating-point accumulation.</td>
              </tr>
              {drill.simulation_mode ? (
                <tr>
                  <th scope="row">Data source</th>
                  <td>
                    Deterministic simulator, not physical equipment. This drill
                    does not evidence real-world delivery.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function OperationalControls({
  drill,
}: {
  drill: Awaited<ReturnType<typeof api.drill>>['drill'];
}) {
  if (['COMPLETED', 'FAILED', 'ABORTED', 'CANCELLED'].includes(drill.status)) {
    return (
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Operational state</span>
          <Chip kind={drill.status === 'COMPLETED' ? 'tested' : 'violation'}>
            {drill.status}
          </Chip>
        </div>
        <p className="sheet__note">
          This drill is terminal. Its event chain is read-only; plan another drill to
          run a new test.
        </p>
      </section>
    );
  }

  return (
    <section className="panel stack" aria-labelledby="operational-action-title">
      <div className="panel__head">
        <div>
          <span className="panel__title" id="operational-action-title">Next controlled action</span>
          <p className="sheet__note" style={{ marginTop: 'var(--space-2xs)' }}>
            Current state: {drill.status}. Only the state machine’s next valid
            transition is offered.
          </p>
        </div>
        {drill.simulation_mode ? <Chip kind="simulated">Simulator only</Chip> : null}
      </div>

      {drill.status === 'DRAFT' ? (
        <OperatorForm
          action={validateDrillAction}
          buttonLabel="Validate safety gates"
          pendingLabel="Validating plan…"
          hidden={{ drill_id: drill.id }}
        >
          <p>
            Check the requested reduction, duration, ramp, current envelope,
            telemetry freshness, and active emergency-stop state.
          </p>
        </OperatorForm>
      ) : null}

      {drill.status === 'READY' ? <DrillArmControl drillId={drill.id} /> : null}

      {drill.status === 'ARMED' ? (
        <div className="workbench-grid">
          <OperatorForm
            action={startDrillAction}
            buttonLabel="Start drill"
            pendingLabel="Starting drill…"
            hidden={{ drill_id: drill.id }}
          >
            <p>
              The challenge was confirmed. Starting is the final explicit operator
              action before execution begins.
            </p>
          </OperatorForm>
          <OperatorForm
            action={abortDrillAction}
            buttonLabel="Abort armed drill"
            pendingLabel="Recording abort…"
            buttonTone="stop"
            hidden={{ drill_id: drill.id }}
          >
            <div className="field">
              <label htmlFor="armed-abort-reason">Abort reason code</label>
              <input
                id="armed-abort-reason"
                name="reason_code"
                required
                defaultValue="OPERATOR_ABORT"
              />
              <p className="field__help">The reason is appended to the evidence timeline.</p>
            </div>
          </OperatorForm>
        </div>
      ) : null}

      {drill.status === 'RUNNING' ? (
        <div className="workbench-grid">
          <OperatorForm
            action={stopDrillAction}
            buttonLabel="Complete sustain window"
            pendingLabel="Completing drill…"
            hidden={{ drill_id: drill.id }}
          >
            <p>Stop the planned execution and begin evidence and MRV processing.</p>
          </OperatorForm>
          <OperatorForm
            action={emergencyStopAction}
            buttonLabel="Emergency stop"
            pendingLabel="Activating stop…"
            buttonTone="stop"
            hidden={{ drill_id: drill.id }}
          >
            <p>
              Stop execution immediately. A standard audit reason is already
              supplied; add context only when it helps the operational handoff.
            </p>
            <div className="field">
              <label htmlFor="emergency-reason">Emergency reason code</label>
              <input
                id="emergency-reason"
                name="reason_code"
                defaultValue="OPERATOR_EMERGENCY_STOP"
              />
              <p className="field__help">
                The standard code is ready to submit; change it only when a runbook
                requires a more specific code.
              </p>
            </div>
            <div className="field">
              <label htmlFor="emergency-detail">Operator detail (optional)</label>
              <textarea
                id="emergency-detail"
                name="reason_detail"
                defaultValue="Operator activated emergency stop from the drill workbench."
              />
              <p className="field__help">
                A safe default is prefilled. Edit or clear it without delaying the stop.
              </p>
            </div>
          </OperatorForm>
        </div>
      ) : null}

      {drill.status === 'VERIFYING' ? (
        <OperatorForm
          action={verifyDrillAction}
          buttonLabel="Verify evidence"
          pendingLabel="Verifying evidence…"
          hidden={{ drill_id: drill.id }}
        >
          <p>
            Seal the completed simulator result, MRV calculation, and immutable
            timeline into the drill’s evidence bundle.
          </p>
        </OperatorForm>
      ) : null}
    </section>
  );
}

function actorLabel(actorUserId: string | null) {
  if (!actorUserId) return 'system';
  return `operator …${actorUserId.slice(-8)}`;
}

function Readout({
  label,
  value,
  unit,
  foot,
}: {
  label: string;
  value: string;
  unit: string;
  foot: string;
}) {
  return (
    <div className="panel">
      <span className="metric__label">{label}</span>
      <div className="metric__value">
        {value}
        <span className="metric__unit">{unit}</span>
      </div>
      <div className="metric__foot">{foot}</div>
    </div>
  );
}
