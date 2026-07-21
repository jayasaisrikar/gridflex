import { Chip } from '@/components/chip';
import { DRILL, EVIDENCE, bpsToPercent } from '@/lib/facility';

/**
 * Drill page — spec §16.3.
 *
 *   "The drill page must read as one proof chain:
 *    Plan → Validation → Operator arming → Execution → Telemetry → MRV →
 *    Evidence hash → Passport"
 *
 * This is why the macrostructure is Narrative Workflow (F4 step sequence). The
 * eight stages are not cards or tabs — a card grid would let a reader inspect
 * stage 6 without stage 3, and the whole point is that each stage DEPENDS on the
 * one above it. Numbered stages in a single vertical column, each carrying its
 * own timestamp, actor, and reason code, make the dependency legible.
 *
 * Every stage shows immutable event data: when, who, and under which methodology.
 */

type Stage = {
  readonly stage: string;
  readonly title: string;
  readonly state: 'done' | 'blocked' | 'pending';
  readonly detail: string;
  readonly meta: readonly string[];
  readonly chip?: { kind: 'tested' | 'declared' | 'violation' | 'simulated'; label: string };
};

const CHAIN: readonly Stage[] = [
  {
    stage: '1.0',
    title: 'Plan',
    state: 'done',
    detail:
      'Requested 500.000 kW reduction for 30 minutes against envelope v1. Target load 1,100 kW, 200 kW above the 900 kW safe floor.',
    meta: ['2026-07-21T11:42:08Z', 'actor: owner@gridflex.test', 'simulation_mode: true'],
    chip: { kind: 'simulated', label: 'Simulated' },
  },
  {
    stage: '2.0',
    title: 'Validation',
    state: 'done',
    detail:
      'Plan checked against facility limits. Reduction within maximum curtailment (600 kW), ramp within 100 kW/min, duration within 60 min, target above minimum safe load.',
    meta: ['4 invariants checked', '0 refusals', 'constraints v1'],
    chip: { kind: 'tested', label: 'Passed' },
  },
  {
    stage: '3.0',
    title: 'Operator arming',
    state: 'done',
    detail:
      'Two-step arm. Challenge issued with the exact constraint snapshot and expected effects, then confirmed by typed phrase. Challenge was single-use and expired in 5 minutes.',
    meta: ['challenge consumed', 'ttl: 300s', 'telemetry fresh at arm'],
    chip: { kind: 'tested', label: 'Armed' },
  },
  {
    stage: '4.0',
    title: 'Execution',
    state: 'done',
    detail:
      'Sustain window held for 30 intervals of 60 seconds. No thermal excursion, no ramp violation, no emergency stop. Setpoint never fell below the safe floor.',
    meta: ['30/30 intervals', 'min load 1,096 kW', 'floor 900 kW'],
    chip: { kind: 'tested', label: 'No violations' },
  },
  {
    stage: '5.0',
    title: 'Telemetry',
    state: 'done',
    detail:
      'Every interval recorded to append-only storage. Completeness 100%, longest gap 0 intervals. Readings cannot be edited or deleted after write.',
    meta: ['completeness 100.0%', 'max gap 0', 'append-only enforced'],
    chip: { kind: 'tested', label: 'Complete' },
  },
  {
    stage: '6.0',
    title: 'MRV',
    state: 'done',
    detail:
      'Baseline taken as the median of the same relative interval across 5 eligible days. Delivered energy summed in exact integer watt-hours; no interval interpolated.',
    meta: [
      `method: ${DRILL.baselineMethod}`,
      `methodology: ${DRILL.methodologyVersion}`,
      'rebound reported separately',
    ],
    chip: { kind: 'tested', label: 'Generated' },
  },
  {
    stage: '7.0',
    title: 'Evidence hash',
    state: 'done',
    detail:
      'Canonical JSON sealed: keys sorted recursively, timestamps normalised to UTC, decimals as strings. SHA-256 computed over the canonical bytes and stored with the document.',
    meta: [`schema: ${EVIDENCE.schemaVersion}`, 'independently recomputable'],
    chip: { kind: 'tested', label: 'Sealed' },
  },
  {
    stage: '8.0',
    title: 'Passport',
    state: 'pending',
    detail:
      'Not yet issued. Issuance requires a current envelope, successful canonicalisation, telemetry quality above threshold, and an MRV report for the associated drill.',
    meta: ['3 of 4 preconditions met', 'awaiting operator issuance'],
    chip: { kind: 'declared', label: 'Not issued' },
  },
];

export default function DrillPage() {
  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>{DRILL.name}</h1>
            <p className="pagehead__sub">
              Deterministic replay · seed{' '}
              <span className="tnum">{DRILL.seed}</span> · the same seed reproduces
              these figures exactly
            </p>
          </div>
          <div className="row">
            <Chip kind="simulated">Simulated</Chip>
            <Chip kind="tested">Completed</Chip>
          </div>
        </div>
      </header>

      {/* ---- Result readout ---- */}
      <section className="grid-metrics" aria-label="Drill result">
        <div className="panel">
          <span className="metric__label">Delivered energy</span>
          <div className="metric__value">
            {DRILL.deliveredEnergyKwh}
            <span className="metric__unit">kWh</span>
          </div>
          <div className="metric__foot">
            <Chip kind="tested">In range</Chip>
            <span>240–250 kWh required</span>
          </div>
        </div>

        <div className="panel">
          <span className="metric__label">Performance</span>
          <div className="metric__value">
            {bpsToPercent(DRILL.performanceBps)}
            <span className="metric__unit">%</span>
          </div>
          <div className="metric__foot">
            <Chip kind="tested">In range</Chip>
            <span className="tnum">{DRILL.performanceBps} bps</span>
          </div>
        </div>

        <div className="panel">
          <span className="metric__label">Average delivered</span>
          <div className="metric__value">
            {DRILL.averageDeliveredKw}
            <span className="metric__unit">kW</span>
          </div>
          <div className="metric__foot">
            <span>against {DRILL.requestedReductionKw} kW requested</span>
          </div>
        </div>

        <div className="panel">
          <span className="metric__label">Safety</span>
          <div className="metric__value" style={{ fontSize: 'var(--text-3xl)' }}>
            0<span className="metric__unit">violations</span>
          </div>
          <div className="metric__foot">
            <span>floor, ramp, thermal, duration</span>
          </div>
        </div>
      </section>

      {/* ---- The proof chain ---- */}
      <section aria-labelledby="chain-heading" className="panel">
        <div className="panel__head">
          <span className="panel__title" id="chain-heading">
            Proof chain
          </span>
          <span className="sheet__note">
            each stage depends on the one above it
          </span>
        </div>

        <ol className="chain">
          {CHAIN.map((step) => (
            <li key={step.stage} className="chain__step" data-state={step.state}>
              <span className="chain__stage" aria-hidden="true">
                {step.stage}
              </span>
              <div className="chain__body">
                <h3 className="chain__title">
                  {step.title}
                  {step.chip ? <Chip kind={step.chip.kind}>{step.chip.label}</Chip> : null}
                </h3>
                <p className="chain__detail">{step.detail}</p>
                <div className="chain__meta">
                  {step.meta.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ---- Evidence ---- */}
      <section className="panel" aria-labelledby="evidence-heading">
        <div className="panel__head">
          <span className="panel__title" id="evidence-heading">
            Evidence digest
          </span>
          <Chip kind="tested">Verifiable</Chip>
        </div>

        <p className="sheet__note" style={{ marginBottom: 'var(--space-sm)' }}>
          SHA-256 over the canonical bytes of the sealed MRV document. A reviewer
          can recompute this independently — sorted keys, UTC timestamps, decimals
          as strings, no insignificant whitespace.
        </p>

        <div className="hash">{EVIDENCE.sha256}</div>

        <div className="row" style={{ marginTop: 'var(--space-md)' }}>
          <button type="button" className="btn">
            Download canonical JSON
          </button>
          <button type="button" className="btn">
            Verify hash
          </button>
        </div>
      </section>

      {/* ---- Method disclosure ---- */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Method and limitations</span>
        </div>
        <div className="sheet-wrap">
          <table className="sheet">
            <tbody>
              <tr>
                <th scope="row">Baseline</th>
                <td>Median of the same relative interval across 5 eligible days</td>
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
                <td>
                  Exact integer watt-hours. No floating-point accumulation in any
                  certified value.
                </td>
              </tr>
              <tr>
                <th scope="row">Data source</th>
                <td>
                  Deterministic simulator, not physical equipment. This drill does
                  not evidence real-world delivery.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
