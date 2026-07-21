import Link from 'next/link';
import type { CSSProperties } from 'react';
import { GridInfrastructureScene } from '@/components/grid-infrastructure-scene';
import { LandingMotion } from '@/components/landing-motion';
import { MarketingNav } from '@/components/marketing-nav';
import './marketing.css';

const painPoints = [
  {
    index: '01',
    title: 'Static engineering studies',
    copy: 'One-off studies become outdated as workloads, equipment, tenants, and operating constraints change.',
    signal: 'Snapshot expires',
  },
  {
    index: '02',
    title: 'Unverified capacity claims',
    copy: 'Declared flexibility figures are rarely tested under real operating conditions.',
    signal: 'Claim ≠ proof',
  },
  {
    index: '03',
    title: 'Fragmented operational data',
    copy: 'Metering, cooling, UPS, BMS, DCIM, and workload-scheduler data remain separated across systems.',
    signal: 'Six data planes',
  },
  {
    index: '04',
    title: 'Qualification and trust delays',
    copy: 'Utilities, aggregators, lenders, and tenants struggle to verify whether a facility can reliably reduce load without creating operational risk.',
    signal: 'Review blocked',
  },
] as const;

const solutionSteps = [
  {
    number: '01',
    title: 'Connect',
    copy: 'Ingest read-only interval-meter data and selected DCIM, BMS, UPS, battery, or workload-scheduler telemetry.',
    detail: 'No control path required',
  },
  {
    number: '02',
    title: 'Validate',
    copy: 'Model the facility’s flexibility envelope and confirm it through safe, operator-approved drills.',
    detail: 'Hard limits remain in code',
  },
  {
    number: '03',
    title: 'Prove',
    copy: 'Generate a versioned Flexibility Passport with deterministic calculations, evidence provenance, drill history, and downloadable reports.',
    detail: 'Every field keeps its source',
  },
] as const;

const trustStages = [
  ['01', 'Read-only telemetry', 'Observe facility state without writing setpoints.', true],
  ['02', 'Shadow recommendations', 'Compare a safe operating recommendation with real outcomes.', true],
  ['03', 'Operator-approved drills', 'Validate the envelope through named, reversible actions.', true],
  ['04', 'Supervised dispatch', 'A later stage, after repeated evidence and operating approval.', false],
  ['05', 'Bounded automation', 'Only inside explicit constraints, with emergency stop intact.', false],
] as const;

const facilityTypes = [
  ['AI training clusters', 'Defer or reschedule non-critical batch workloads.'],
  ['GPU-cloud operators', 'Reduce selected compute capacity during constrained periods.'],
  ['High-performance computing', 'Move flexible jobs between queues or time windows.'],
  ['Bitcoin-mining facilities', 'Temporarily curtail explicitly interruptible mining load.'],
  ['Data-centre campuses', 'Use cooling headroom and coordinate capacity across buildings.'],
  ['UPS and battery-backed facilities', 'Dispatch approved battery capacity without crossing resilience limits.'],
] as const;

const stakeholders = [
  'Facility operators',
  'Utilities and grid planners',
  'QSEs and aggregators',
  'Lenders and investors',
  'Tenants and workload customers',
  'Energy consultants',
] as const;

const integrations = [
  'Interval meters',
  'DCIM platforms',
  'BMS systems',
  'UPS and battery systems',
  'Compute schedulers',
  'Demand-response aggregators',
  'Utility export formats',
] as const;

const platformFeatures = [
  ['TypeScript platform', 'Shared contracts across interface, engine, and API.'],
  ['PostgreSQL + time-series telemetry', 'Append-only readings with explicit quality flags.'],
  ['Secure connector framework', 'Read-only first, scoped credentials, observable health.'],
  ['Versioned evidence schemas', 'Old records remain independently checkable.'],
  ['Deterministic MRV', 'Exact integer energy arithmetic, no invented intervals.'],
  ['Exportable JSON and PDF Passports', 'Structured records for machines and engineering review.'],
  ['API-first architecture', 'Facility data and counterparties stay decoupled.'],
  ['Coolify-compatible deployment', 'A practical path to private infrastructure.'],
] as const;

export default function LandingPage() {
  return (
    <div className="mk-premium">
      <MarketingNav />

      <main>
        <section className="mk-hero" id="product" aria-labelledby="hero-title">
          <div className="mk-hero__copy">
            <p className="mk-hero__context">
              <span aria-hidden="true" /> Flexibility assurance for digital infrastructure
            </p>
            <h1 id="hero-title">
              Prove how much power your data centre can safely give back to the grid.
            </h1>
            <p className="mk-hero__statement">
              The flexibility assurance layer for large digital loads.
            </p>
            <p className="mk-hero__lede">
              GridFlex converts live facility telemetry into a verified flexibility envelope,
              validates it through controlled drills, and produces utility- and market-ready
              evidence that operators, aggregators, lenders, and energy partners can trust.
            </p>
            <div className="mk-hero__actions">
              <a className="mk-button mk-button--primary" href="#pilot">
                Request a pilot <Arrow />
              </a>
              <a className="mk-button mk-button--secondary" href="#passport">
                Explore the Flexibility Passport
              </a>
            </div>
            <Link className="mk-text-link" href="/console/drills">
              View a sample drill <span aria-hidden="true">↗</span>
            </Link>
          </div>

          <GridInfrastructureScene />
        </section>

        <OperationalStatus />

        <section className="mk-problem mk-section" aria-labelledby="problem-title">
          <header className="mk-section-head" data-reveal>
            <h2 id="problem-title">
              Large power users are being asked to prove flexibility—not merely promise it.
            </h2>
            <p>
              A spreadsheet can state a number. It cannot show whether that number survives a
              thermal constraint, a workload change, or a real operating event.
            </p>
          </header>

          <div className="mk-problem__grid" data-reveal>
            {painPoints.map((point) => (
              <article className="mk-problem-card" key={point.index} tabIndex={0}>
                <div className="mk-problem-card__signal">
                  <span>{point.index}</span>
                  <span>{point.signal}</span>
                </div>
                <h3>{point.title}</h3>
                <p>{point.copy}</p>
                <div className="mk-problem-card__trace" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </article>
            ))}
          </div>

          <FragmentationDiagram />
        </section>

        <section className="mk-solution mk-section" id="how-it-works" aria-labelledby="solution-title">
          <div className="mk-solution__pin">
            <div data-reveal>
              <h2 id="solution-title">One continuously maintained source of truth for facility flexibility.</h2>
              <p>
                The Passport stays useful because the evidence path remains attached to the
                operating state that produced it.
              </p>
            </div>
            <a className="mk-text-link" href="#passport">
              Inspect the record <span aria-hidden="true">↘</span>
            </a>
          </div>

          <ol className="mk-solution__steps">
            {solutionSteps.map((step) => (
              <li key={step.number} data-reveal>
                <div className="mk-solution__number">{step.number}</div>
                <div className="mk-solution__pulse" aria-hidden="true"><i /></div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mk-passport mk-section" id="passport" aria-labelledby="passport-title">
          <header className="mk-passport__intro" data-reveal>
            <h2 id="passport-title">From an operational claim to independently checkable evidence.</h2>
            <p>
              Every value in the Passport is linked to its source, methodology, test history,
              and confidence level. GridFlex never allows an AI model to invent telemetry or
              operational results.
            </p>
            <a className="mk-button mk-button--primary" href="#passport-record">
              View sample Passport <Arrow />
            </a>
          </header>

          <SamplePassport />
        </section>

        <section className="mk-standards mk-section" aria-labelledby="standards-title">
          <header className="mk-section-head mk-section-head--compact" data-reveal>
            <h2 id="standards-title">Acceptance standards are visible before a claim is issued.</h2>
            <p>These are product acceptance standards—not current commercial performance claims.</p>
          </header>
          <div className="mk-standards__grid" data-reveal>
            <Standard value="95" suffix="%+" label="Required telemetry completeness" />
            <Standard value="20" prefix="±" suffix="%" label="Target prediction-versus-delivery accuracy" />
            <Standard value="100" suffix="%" label="Provenance coverage for Passport fields" />
            <Standard value="5" suffix="-stage" label="Operational trust ladder" />
            <Standard value="SHA-256" label="Evidence integrity" />
            <Standard value="Read-only" label="First deployment model" />
          </div>
        </section>

        <section className="mk-trust mk-section" id="security" aria-labelledby="trust-title">
          <div className="mk-trust__copy" data-reveal>
            <h2 id="trust-title">Automation is earned through evidence.</h2>
            <p>
              GridFlex begins with observation, progresses through operator-reviewed
              recommendations, and only moves toward automation after repeated, measurable,
              and safe performance.
            </p>
            <div className="mk-trust__scope">
              <span>Initial product scope</span>
              <strong>Stages 1–3 only</strong>
            </div>
          </div>

          <ol className="mk-trust__ladder" data-reveal>
            {trustStages.map(([number, title, copy, active]) => (
              <li key={number} data-active={active}>
                <span className="mk-trust__orbit" aria-hidden="true"><i /></span>
                <span className="mk-trust__index">{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <span className="mk-trust__state">{active ? 'Shipping scope' : 'Evidence gate'}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mk-use-cases mk-section" id="use-cases" aria-labelledby="use-cases-title">
          <header className="mk-section-head" data-reveal>
            <h2 id="use-cases-title">Built for facilities where load is large, dynamic, and constrained.</h2>
            <p>
              Flexibility can come from compute, cooling, storage, scheduling, or a bounded
              combination. GridFlex keeps the mechanism and its limits visible.
            </p>
          </header>
          <div className="mk-use-cases__grid" data-reveal>
            {facilityTypes.map(([title, copy], index) => (
              <article key={title} tabIndex={0} style={{ '--case-index': index } as CSSProperties}>
                <SignalGlyph index={index} />
                <h3>{title}</h3>
                <p>{copy}</p>
                <span>Inspect mechanism <span aria-hidden="true">↗</span></span>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-stakeholders mk-section" aria-labelledby="stakeholders-title">
          <header className="mk-section-head mk-section-head--compact" data-reveal>
            <h2 id="stakeholders-title">One evidence layer. Multiple trusted counterparties.</h2>
            <p>The same record can be inspected from different risk and operational perspectives.</p>
          </header>
          <StakeholderNetwork />
        </section>

        <section className="mk-integrations mk-section" aria-labelledby="integrations-title">
          <div className="mk-integrations__copy" data-reveal>
            <h2 id="integrations-title">Vendor-neutral by design.</h2>
            <p>
              GridFlex sits between facility telemetry, workload systems, electrical
              infrastructure, and energy-market counterparties without replacing the systems
              that already operate them.
            </p>
          </div>
          <div className="mk-integrations__rail" aria-label="Integration categories" tabIndex={0}>
            <div>
              {[...integrations, ...integrations].map((item, index) => (
                <span key={`${item}-${index}`} aria-hidden={index >= integrations.length}>
                  {item} <i aria-hidden="true" />
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="mk-architecture mk-section" id="architecture" aria-labelledby="architecture-title">
          <div className="mk-architecture__pin" data-reveal>
            <h2 id="architecture-title">Operational facts move through a deterministic evidence chain.</h2>
            <p>
              Calculations happen in tested code. AI may explain verified outputs; it cannot
              create measurements, safety limits, drill results, or hashes.
            </p>
            <ul>
              <li>Deterministic calculations first</li>
              <li>No fabricated AI-generated measurements</li>
              <li>Append-only telemetry</li>
              <li>Operator-approved drills</li>
              <li>Hard safety constraints enforced in code</li>
              <li>Emergency-stop controls</li>
              <li>Evidence hashing and version history</li>
              <li>Clear labels for simulated and replayed data</li>
            </ul>
          </div>
          <ArchitectureDiagram />
        </section>

        <section className="mk-platform mk-section" id="about" aria-labelledby="platform-title">
          <header className="mk-platform__intro" data-reveal>
            <h2 id="platform-title">Built for operators. Legible to engineers.</h2>
            <p>
              GridFlex continuously collects operational data, calculates how much load a
              facility could safely reduce, validates that estimate through controlled tests,
              and packages the result into a trusted digital record.
            </p>
            <a className="mk-text-link" href="#architecture">
              Read the platform architecture <span aria-hidden="true">↗</span>
            </a>
          </header>
          <div className="mk-platform__spec" data-reveal>
            {platformFeatures.map(([title, copy], index) => (
              <article key={title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mk-final" id="pilot" aria-labelledby="final-title">
          <div className="mk-final__grid" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div className="mk-final__copy" data-reveal>
            <h2 id="final-title">Turn flexibility into infrastructure-grade evidence.</h2>
            <p>
              Connect facility telemetry, validate the operating envelope, and give utilities,
              energy partners, lenders, and tenants proof they can evaluate.
            </p>
            <div>
              <a
                className="mk-button mk-button--primary"
                href="mailto:admin@gridflex.com?subject=GridFlex%20design-partner%20pilot"
              >
                Request a design-partner pilot <Arrow />
              </a>
              <Link className="mk-button mk-button--secondary" href="/login">
                See the demo
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mk-footer">
        <div className="mk-footer__brand">
          <span className="mk-wordmark__mark" aria-hidden="true"><i /><i /><i /></span>
          <strong>GridFlex</strong>
        </div>
        <p>
          Flexibility assurance for large digital loads. Read-only telemetry first. Operator
          approval before drills. Evidence before automation.
        </p>
        <div className="mk-footer__meta">
          <span>Demo values are simulated and illustrative</span>
          <span>No regulatory certification implied</span>
          <Link href="/login">Operator sign in</Link>
        </div>
      </footer>

      <LandingMotion />
    </div>
  );
}

function OperationalStatus() {
  return (
    <section className="mk-status mk-section" aria-labelledby="status-title">
      <header className="mk-status__head" data-reveal>
        <div>
          <span className="mk-demo-label"><i aria-hidden="true" /> Demo facility data</span>
          <h2 id="status-title">A live operating picture—not a static claim.</h2>
        </div>
        <div className="mk-status__verified">
          <span>Passport status</span>
          <strong><i aria-hidden="true" /> Verified</strong>
        </div>
      </header>

      <div className="mk-status__layout" data-reveal>
        <div className="mk-status__metrics">
          <Metric label="Current facility load" value="1.60" unit="MW" count="1.6" decimals="2" />
          <Metric label="Tested flexibility" value="0.49" unit="MW" count="0.49" decimals="2" accent />
          <Metric label="Maximum declared" value="0.60" unit="MW" count="0.6" decimals="2" />
          <Metric label="Response time" value="5" unit="minutes" count="5" />
          <Metric label="Sustainable duration" value="30" unit="minutes" count="30" />
          <Metric label="Telemetry completeness" value="99.8" unit="%" count="99.8" decimals="1" />
          <Metric label="Last validated drill" value="98" unit="% delivered" count="98" accent />
        </div>
        <TelemetryChart />
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  unit,
  count,
  decimals = '0',
  accent = false,
}: {
  label: string;
  value: string;
  unit: string;
  count: string;
  decimals?: string;
  accent?: boolean;
}) {
  return (
    <div className="mk-metric" data-accent={accent}>
      <span>{label}</span>
      <strong>
        <span data-count={count} data-decimals={decimals}>{value}</span>
        <small>{unit}</small>
      </strong>
    </div>
  );
}

function TelemetryChart() {
  return (
    <figure className="mk-chart" aria-labelledby="chart-title">
      <div className="mk-chart__head">
        <div>
          <span id="chart-title">Facility response trace</span>
          <strong>14:00–14:45 · controlled drill</strong>
        </div>
        <span>30 s intervals</span>
      </div>
      <svg viewBox="0 0 760 360" role="img" aria-label="Animated telemetry curves for a simulated facility drill">
        <defs>
          <linearGradient id="mk-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--mk-color-accent)" stopOpacity="0.2" />
            <stop offset="1" stopColor="var(--mk-color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="mk-chart__grid">
          {[72, 132, 192, 252, 312].map((y) => <line key={y} x1="44" x2="736" y1={y} y2={y} />)}
          {[44, 182, 320, 458, 596, 736].map((x) => <line key={x} x1={x} x2={x} y1="32" y2="312" />)}
        </g>
        <path className="mk-chart__area" d="M44 96 C150 90 236 94 316 105 C388 116 430 228 522 235 C606 241 666 140 736 125 L736 312 L44 312 Z" />
        <path className="mk-chart__line mk-chart__line--baseline" pathLength="100" d="M44 96 C150 90 236 94 316 105 C410 116 510 102 614 110 C666 114 704 106 736 108" />
        <path className="mk-chart__line mk-chart__line--actual" pathLength="100" d="M44 99 C151 96 235 97 316 108 C388 122 430 234 522 239 C606 242 664 143 736 127" />
        <path className="mk-chart__line mk-chart__line--committed" pathLength="100" d="M44 250 L316 250 L316 178 L548 178 L548 250 L736 250" />
        <path className="mk-chart__line mk-chart__line--delivered" pathLength="100" d="M44 266 L316 266 C360 263 370 186 410 184 L540 184 C580 188 586 262 630 264 L736 264" />
        <path className="mk-chart__line mk-chart__line--cooling" pathLength="100" d="M44 292 C160 286 245 288 330 292 C416 297 504 286 600 291 C655 294 698 288 736 289" />
        <path className="mk-chart__line mk-chart__line--rebound" pathLength="100" d="M44 304 L552 304 C592 302 604 274 636 271 C670 269 694 301 736 303" />
        <g className="mk-chart__cursor">
          <line x1="548" x2="548" y1="32" y2="312" />
          <circle cx="548" cy="239" r="5" />
        </g>
      </svg>
      <figcaption className="mk-chart__legend">
        <span data-line="baseline"><i /> Baseline load</span>
        <span data-line="actual"><i /> Actual load</span>
        <span data-line="committed"><i /> Committed reduction</span>
        <span data-line="delivered"><i /> Delivered reduction</span>
        <span data-line="cooling"><i /> Cooling reserve</span>
        <span data-line="rebound"><i /> Recovery and rebound</span>
      </figcaption>
    </figure>
  );
}

function FragmentationDiagram() {
  return (
    <figure className="mk-fragment" data-reveal aria-label="Disconnected facility systems consolidated into one Flexibility Passport">
      <div className="mk-fragment__sources">
        {['Meter', 'DCIM', 'BMS', 'UPS', 'Scheduler', 'Drill log'].map((item) => (
          <span key={item}>{item}<i aria-hidden="true" /></span>
        ))}
      </div>
      <div className="mk-fragment__flow" aria-hidden="true"><i /><i /><i /></div>
      <div className="mk-fragment__passport">
        <span>GridFlex</span>
        <strong>Flexibility Passport</strong>
        <small>Versioned · Evidence-backed · Verifiable</small>
      </div>
    </figure>
  );
}

function SamplePassport() {
  return (
    <article className="mk-passport-card" id="passport-record" data-reveal>
      <div className="mk-passport-card__head">
        <div>
          <span>GridFlex Flexibility Passport</span>
          <strong>Demo Compute Facility</strong>
        </div>
        <div className="mk-passport-card__status">
          <span><i aria-hidden="true" /> Verified</span>
          <small>Demo facility data</small>
        </div>
      </div>

      <div className="mk-passport-card__primary">
        <div>
          <span>Tested reducible capacity</span>
          <strong>0.49 <small>MW</small></strong>
          <p>Validated through the latest controlled drill.</p>
        </div>
        <div className="mk-capacity-stack" aria-label="Declared, modelled, and tested capacity comparison">
          <Capacity provenance="Declared" value="0.60 MW" width="100%" />
          <Capacity provenance="Modelled" value="0.53 MW" width="88%" />
          <Capacity provenance="Tested" value="0.49 MW" width="82%" />
        </div>
      </div>

      <div className="mk-passport-card__body">
        <dl className="mk-passport-card__specs">
          <PassportField label="Response time" value="5 minutes" provenance="Tested" />
          <PassportField label="Maximum duration" value="30 minutes" provenance="Tested" />
          <PassportField label="Minimum safe facility load" value="Constraint linked" provenance="Declared" />
          <PassportField label="Cooling reserve" value="Telemetry linked" provenance="Modelled" />
          <PassportField label="Tenant and SLA exclusions" value="Policy linked" provenance="Declared" />
          <PassportField label="Rebound energy" value="Reported separately" provenance="Tested" />
          <PassportField label="Telemetry completeness" value="99.8%" provenance="Tested" />
          <PassportField label="Confidence" value="Source-aware" provenance="Modelled" />
        </dl>

        <div className="mk-passport-card__evidence">
          <div>
            <span>Drill history</span>
            <strong>Latest result · 98% delivered</strong>
            <small>Controlled drill · operator approved</small>
          </div>
          <div>
            <span>Evidence hash</span>
            <code>8f9c…31a7</code>
            <small>SHA-256 · shortened for display</small>
          </div>
          <div>
            <span>Passport version</span>
            <strong>Demo v1.4</strong>
            <small>Illustrative record · not a production issue</small>
          </div>
        </div>
      </div>

      <div className="mk-passport-card__foot">
        <div className="mk-provenance-key">
          <span data-kind="declared"><i /> Declared</span>
          <span data-kind="modelled"><i /> Modelled</span>
          <span data-kind="tested"><i /> Tested</span>
        </div>
        <span>All operational values retain source, method, and evidence context.</span>
      </div>
    </article>
  );
}

function Capacity({ provenance, value, width }: { provenance: string; value: string; width: string }) {
  return (
    <div className="mk-capacity" data-kind={provenance.toLowerCase()}>
      <span>{provenance}</span>
      <div><i style={{ '--capacity': width } as CSSProperties} /></div>
      <strong>{value}</strong>
    </div>
  );
}

function PassportField({ label, value, provenance }: { label: string; value: string; provenance: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <span data-kind={provenance.toLowerCase()}>{provenance}</span>
    </div>
  );
}

function Standard({ value, label, prefix = '', suffix = '' }: { value: string; label: string; prefix?: string; suffix?: string }) {
  const numeric = /^\d+$/.test(value);
  return (
    <article>
      <strong>
        {numeric ? (
          <span data-count={value} data-prefix={prefix} data-suffix={suffix}>{prefix}{value}{suffix}</span>
        ) : value}
      </strong>
      <p>{label}</p>
    </article>
  );
}

function StakeholderNetwork() {
  return (
    <figure className="mk-network" data-reveal aria-label="Flexibility Passport connected to six stakeholder groups">
      <svg viewBox="0 0 980 540" aria-hidden="true">
        <g className="mk-network__lines">
          <path d="M490 270 C350 210 280 105 145 86" />
          <path d="M490 270 C350 250 250 248 108 270" />
          <path d="M490 270 C350 330 280 425 145 454" />
          <path d="M490 270 C630 210 700 105 835 86" />
          <path d="M490 270 C630 250 730 248 872 270" />
          <path d="M490 270 C630 330 700 425 835 454" />
        </g>
        <g className="mk-network__packets">
          <circle r="4"><animateMotion dur="4s" repeatCount="indefinite" path="M490 270 C350 210 280 105 145 86" /></circle>
          <circle r="4"><animateMotion dur="4.8s" repeatCount="indefinite" path="M490 270 C630 250 730 248 872 270" /></circle>
          <circle r="4"><animateMotion dur="5.4s" repeatCount="indefinite" path="M490 270 C350 330 280 425 145 454" /></circle>
        </g>
      </svg>
      <div className="mk-network__core">
        <span>GridFlex</span>
        <strong>Passport</strong>
        <small>One verifiable record</small>
      </div>
      {stakeholders.map((stakeholder, index) => (
        <div className="mk-network__node" key={stakeholder} style={{ '--node': index } as CSSProperties}>
          <i aria-hidden="true" />
          <span>{stakeholder}</span>
        </div>
      ))}
    </figure>
  );
}

function ArchitectureDiagram() {
  const nodes = [
    ['Facility telemetry', 'Meters · DCIM · BMS'],
    ['Read-only connectors', 'Scoped · observable'],
    ['Append-only time series', 'Quality preserved'],
    ['Envelope engine', 'Constraints applied'],
    ['Drill + deterministic MRV', 'Operator approved'],
    ['Evidence bundle', 'Canonical JSON · SHA-256'],
    ['Flexibility Passport', 'Versioned record'],
    ['Counterparty exports', 'JSON · PDF · API'],
  ] as const;
  return (
    <div className="mk-architecture__diagram" data-reveal>
      {nodes.map(([title, copy], index) => (
        <div className="mk-architecture__node" key={title} style={{ '--arch-index': index } as CSSProperties}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{title}</strong><small>{copy}</small></div>
          {index < nodes.length - 1 ? <i aria-hidden="true" /> : null}
        </div>
      ))}
    </div>
  );
}

function SignalGlyph({ index }: { index: number }) {
  return (
    <svg className="mk-signal-glyph" viewBox="0 0 120 72" aria-hidden="true">
      <path d={`M4 ${52 - index * 2} C24 ${18 + index * 3} 39 ${62 - index * 2} 60 34 C78 12 92 ${48 - index} 116 ${16 + index * 2}`} />
      <line x1="4" x2="116" y1="62" y2="62" />
      <circle cx={20 + index * 14} cy={32 + (index % 2) * 10} r="3" />
    </svg>
  );
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
