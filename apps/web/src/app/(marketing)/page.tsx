import Link from 'next/link';
import './marketing.css';

/**
 * Landing page.
 *
 * Hallmark · macrostructure: Manifesto · nav: N9 edge-aligned · footer: Ft5 statement
 * theme: custom light — differs from the console on paper band AND display style.
 *
 * Why Manifesto and not Stat-Led: the only numbers this product has are
 * SIMULATED. Putting "97.89% delivered" on a marketing page as proof would be
 * an invented metric in everything but arithmetic. GridFlex has no customers
 * and no real drills yet, so the honest claim is about METHOD, not results —
 * and the sharpest thing about the method is what it refuses to do.
 *
 * Every factual statement below is traceable to the specification. There are no
 * customer counts, no logos, no testimonials, and no performance claims.
 */
export default function LandingPage() {
  return (
    <div className="mk">
      {/* N9 · edge-aligned minimal — the space between IS the design */}
      <header className="mk-nav">
        <span className="mk-wordmark">GridFlex</span>
        <Link className="mk-cta-outline" href="/console">
          Open console →
        </Link>
      </header>

      <main>
        {/* ---- Declaration ---- */}
        <section className="mk-hero">
          <h1 className="mk-display">
            A megawatt you cannot prove is a megawatt nobody will pay for.
          </h1>
          <p className="mk-lede">
            GridFlex measures how much electrical load a data centre, HPC cluster,
            or AI-compute facility can safely shed — how fast it responds, how long
            it sustains, and what rebound follows. The output is a signed,
            versioned Flexibility Passport a utility, lender, or tenant can verify
            without trusting us.
          </p>
        </section>

        {/* ---- Defined by refusal ---- */}
        <section className="mk-band">
          <h2 className="mk-h2">We are an assurance layer. We are not a market.</h2>
          <ul className="mk-refusals">
            <li>
              <span className="mk-no" aria-hidden="true">
                ✕
              </span>
              <div>
                <strong>No autonomous dispatch.</strong> Every drill is planned,
                validated, and armed by a named operator through a two-step
                confirmation. Nothing runs on its own.
              </div>
            </li>
            <li>
              <span className="mk-no" aria-hidden="true">
                ✕
              </span>
              <div>
                <strong>No blockchain, tokens, or settlement.</strong> Evidence is
                a SHA-256 hash over canonical JSON. Anyone can recompute it with
                standard tools and no dependency on us.
              </div>
            </li>
            <li>
              <span className="mk-no" aria-hidden="true">
                ✕
              </span>
              <div>
                <strong>No two-sided marketplace.</strong> We do not bid, clear,
                or take a position. Assurance is the product.
              </div>
            </li>
            <li>
              <span className="mk-no" aria-hidden="true">
                ✕
              </span>
              <div>
                <strong>No control of your equipment.</strong> V1 reads telemetry.
                It does not write setpoints to physical plant.
              </div>
            </li>
          </ul>
        </section>

        {/* ---- Method ---- */}
        <section className="mk-band mk-band--sunk">
          <h2 className="mk-h2">Every number carries its evidence.</h2>
          <p className="mk-claim">
            Each figure on a Passport is labelled <em>declared</em>,{' '}
            <em>modeled</em>, or <em>tested</em> — an operator&rsquo;s assertion, a
            value derived from telemetry, or a number proven by a completed drill.
            The three are never summed into one flattering total.
          </p>

          <ol className="mk-chain">
            <li>
              <span className="mk-stage">1</span>
              <div>
                <h3>Telemetry, append-only</h3>
                <p>
                  Readings are stored where the database itself rejects updates
                  and deletes. Corrections are new rows, never edits.
                </p>
              </div>
            </li>
            <li>
              <span className="mk-stage">2</span>
              <div>
                <h3>Envelope, with reasons</h3>
                <p>
                  A deterministic engine computes reducible capacity and records
                  every cap that bound the result. Confidence starts from the
                  weakest mechanism, not the average.
                </p>
              </div>
            </li>
            <li>
              <span className="mk-stage">3</span>
              <div>
                <h3>Drill, operator-armed</h3>
                <p>
                  A real reduction, held for a real duration, inside limits the
                  operator confirmed by typing them back. Emergency stop preempts
                  everything.
                </p>
              </div>
            </li>
            <li>
              <span className="mk-stage">4</span>
              <div>
                <h3>MRV, exact arithmetic</h3>
                <p>
                  Delivered energy is summed in integer watt-hours. Missing
                  intervals contribute zero and are reported. Rebound is shown
                  separately, never netted off.
                </p>
              </div>
            </li>
            <li>
              <span className="mk-stage">5</span>
              <div>
                <h3>Passport, immutable</h3>
                <p>
                  Issued once and never edited. A later version supersedes it;
                  revocation preserves the original and adds a reason.
                </p>
              </div>
            </li>
          </ol>
        </section>

        {/* ---- Honest status ---- */}
        <section className="mk-band">
          <h2 className="mk-h2">What ships, and what does not.</h2>
          <p className="mk-claim">
            Capability is staged deliberately. We ship the first three rungs and
            refuse the last two until there is a written safety record to justify
            them.
          </p>

          <div className="mk-ladder-wrap">
            <table className="mk-ladder">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Capability</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mk-num">1</td>
                  <td>Read-only telemetry and modeling</td>
                  <td>
                    <span className="mk-ship">Ships</span>
                  </td>
                </tr>
                <tr>
                  <td className="mk-num">2</td>
                  <td>Shadow recommendations</td>
                  <td>
                    <span className="mk-ship">Ships</span>
                  </td>
                </tr>
                <tr>
                  <td className="mk-num">3</td>
                  <td>Operator-approved drills</td>
                  <td>
                    <span className="mk-ship">Ships</span>
                  </td>
                </tr>
                <tr>
                  <td className="mk-num">4</td>
                  <td>Supervised dispatch</td>
                  <td>
                    <span className="mk-hold">Does not ship</span>
                  </td>
                </tr>
                <tr>
                  <td className="mk-num">5</td>
                  <td>Bounded automation</td>
                  <td>
                    <span className="mk-hold">Does not ship</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* ---- CTA ---- */}
        <section className="mk-band mk-cta-band">
          <p className="mk-claim mk-claim--lead">
            The demo facility runs a deterministic simulator. Every value in it is
            labelled simulated, because a number you cannot trace is worth nothing
            to the person you are trying to convince.
          </p>
          <Link className="mk-cta-solid" href="/console">
            Open the console →
          </Link>
        </section>
      </main>

      {/* Ft5 · Statement */}
      <footer className="mk-foot">
        <p className="mk-foot-line">Claims should survive a hostile reviewer.</p>
        <div className="mk-foot-meta">
          <span className="mk-wordmark">GridFlex</span>
          <span className="mk-muted">
            Flexibility assurance · stages 1–3 · no regulatory certification implied
          </span>
        </div>
      </footer>
    </div>
  );
}
