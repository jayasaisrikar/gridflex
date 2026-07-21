import Link from 'next/link';
import { Chip } from '@/components/chip';
import { api } from '@/lib/api';
import { formatKw, requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';

export default async function DrillsPage() {
  const facility = await requireFacility();
  const { drills } = await api.drills(facility.id);

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Drills</h1>
            <p className="pagehead__sub">
              Operator-approved capability tests. V1 runs simulated drills only —
              no unsupervised production control.
            </p>
          </div>
        </div>
      </header>

      {drills.length === 0 ? (
        <section className="panel">
          <p>No drills have been run for this facility.</p>
        </section>
      ) : (
        <section className="panel">
          <div className="sheet-wrap">
            <table className="sheet">
              <thead>
                <tr>
                  <th>Drill</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th className="num">Requested</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {drills.map((drill) => (
                  <tr key={drill.id}>
                    <td>{drill.name}</td>
                    <td>
                      <Chip kind={drill.status === 'COMPLETED' ? 'tested' : 'declared'}>
                        {drill.status}
                      </Chip>
                    </td>
                    <td>
                      {drill.simulation_mode ? (
                        <Chip kind="simulated">Simulated</Chip>
                      ) : (
                        <Chip kind="neutral">Live</Chip>
                      )}
                    </td>
                    <td className="num tnum">
                      {formatKw(drill.requested_reduction_kw)} kW
                    </td>
                    <td className="sheet__note tnum">
                      {drill.started_at ? drill.started_at.replace('T', ' ').replace('Z', '') : '—'}
                    </td>
                    <td>
                      <Link href={`/drills/${drill.id}`}>Proof chain →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
