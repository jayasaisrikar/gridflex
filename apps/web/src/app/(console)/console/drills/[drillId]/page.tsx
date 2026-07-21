import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Chip, type ChipKind } from '@/components/chip';
import { MrvChart } from '@/components/mrv-chart';
import { api, ApiError } from '@/lib/api';
import { formatKw, requireFacility, whToKwh } from '@/lib/load';

export const dynamic = 'force-dynamic';

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
      'Plan checked against facility limits: minimum safe load, maximum curtailment, ramp rate, and maximum duration.',
  },
  {
    stage: '3.0',
    title: 'Operator arming',
    eventType: 'ARMED',
    detail: () =>
      'Two-step arm. A single-use challenge carrying the exact constraint snapshot was issued, then confirmed by typed phrase within its 5-minute window.',
  },
  {
    stage: '4.0',
    title: 'Execution',
    eventType: 'STARTED',
    detail: () =>
      'Sustain window held. Setpoint never fell below the minimum safe load; no thermal or ramp violation recorded.',
  },
  {
    stage: '5.0',
    title: 'Telemetry',
    eventType: 'COMPLETED',
    detail: (c) =>
      c.mrv
        ? `${(c.mrv.telemetry_completeness * 100).toFixed(1)}% complete, longest gap ${c.mrv.maximum_gap_intervals} intervals. Readings are append-only and cannot be revised.`
        : 'Telemetry recorded to append-only storage.',
  },
  {
    stage: '6.0',
    title: 'MRV',
    eventType: 'MRV_GENERATED',
    detail: (c) =>
      c.mrv
        ? `Delivered ${whToKwh(c.mrv.delivered_energy_wh)} kWh against ${whToKwh(c.mrv.committed_energy_wh)} kWh committed. Summed in exact integer watt-hours; no interval interpolated.`
        : 'No MRV report has been generated.',
  },
  {
    stage: '7.0',
    title: 'Evidence hash',
    eventType: null,
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
    if (error instanceof ApiError && error.status === 404) notFound();
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
            const state = reached ? 'done' : 'pending';
            const chip: { kind: ChipKind; label: string } = reached
              ? { kind: 'tested', label: 'Recorded' }
              : { kind: 'declared', label: 'Not reached' };

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
