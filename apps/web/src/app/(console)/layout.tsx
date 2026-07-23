import type { ReactNode } from 'react';
import { Rail } from '@/components/rail';
import { api } from '@/lib/api';
import { requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  // Resolving the facility in the shared layout protects every console route,
  // including setup pages that otherwise have no data fetch of their own.
  const facility = await requireFacility();
  const [drillsResult, connectorsResult, qualityResult] = await Promise.allSettled([
    api.drills(facility.id),
    api.connectors(facility.id),
    api.telemetryQuality(facility.id),
  ]);

  // These calls only enrich the rail's source label. A partial API outage must
  // not take down the workspace or hide safety controls such as emergency stop.
  const drills = drillsResult.status === 'fulfilled' ? drillsResult.value.drills : [];
  const connectors =
    connectorsResult.status === 'fulfilled' ? connectorsResult.value.connectors : [];
  const quality = qualityResult.status === 'fulfilled' ? qualityResult.value : null;
  const sourceStatusUnavailable =
    drillsResult.status === 'rejected' ||
    connectorsResult.status === 'rejected' ||
    qualityResult.status === 'rejected';
  const simulated =
    (quality?.contains_simulated_data ?? false) ||
    connectors.some(
      (connector) =>
        connector.connector_type === 'SIMULATOR' && connector.status !== 'DISABLED',
    ) ||
    drills.some((drill) => drill.simulation_mode);
  // Unknown provenance is treated conservatively in the compact rail. The
  // adjacent banner explains the uncertainty instead of claiming physical data.
  const showSimulationCaution = simulated || sourceStatusUnavailable;
  const facilityMeta = [facility.market, facility.region, facility.timezone]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="shell">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <Rail
        facilityName={facility.name}
        facilityMeta={facilityMeta}
        simulated={showSimulationCaution}
      />
      <div className="main">
        <span className="sr-only" id="workspace" tabIndex={-1}>Operator workspace</span>
        {showSimulationCaution ? (
          <div className="simbar" role="status">
            <span className="simbar__glyph" aria-hidden="true">
              {sourceStatusUnavailable && !simulated ? 'CHK' : 'SIM'}
            </span>
            {sourceStatusUnavailable && !simulated ? (
              <span>
                Evidence-source status is temporarily unavailable. Treat results as
                potentially simulated until source provenance can be verified.
              </span>
            ) : (
              <span>
                Simulated evidence is present for this facility. Simulation results are
                labelled throughout and do not prove physical delivery.
              </span>
            )}
          </div>
        ) : null}
        {children}
        <footer className="build-ledger">
          <p>
            GridFlex pilot console · envelope gridflex-envelope-1.0.0 · MRV
            gridflex-mrv-1.0.0 · canonical evidence gridflex-canonical-1 · all
            operational claims remain separated as declared, modeled, tested, or
            simulated.
          </p>
        </footer>
      </div>
    </div>
  );
}
