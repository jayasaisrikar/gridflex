import type { Metadata } from 'next';
import Link from 'next/link';
import { Chip, type ChipKind } from '@/components/chip';
import { api, type ActivityEntry } from '@/lib/api';
import { requireFacility } from '@/lib/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Audit & Activity' };

export default async function AuditPage() {
  const facility = await requireFacility();
  const { entries, next_before: nextBefore } = await api.activity(facility.id);
  const auditCount = entries.filter((entry) => entry.source === 'AUDIT').length;
  const drillCount = entries.length - auditCount;

  return (
    <main className="content stack">
      <header className="pagehead">
        <div className="pagehead__row">
          <div>
            <h1>Audit & activity</h1>
            <p className="pagehead__sub">
              Configuration governance and immutable drill events, combined without
              obscuring their source.
            </p>
          </div>
          <div className="row">
            <Chip kind="neutral">{auditCount} audit</Chip>
            <Chip kind="neutral">{drillCount} drill events</Chip>
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Evidence contract</span>
          <Chip kind="tested">Append-only</Chip>
        </div>
        <p>
          Audit rows and drill events cannot be updated or deleted. Lifecycle records
          may add a later status, but they do not rewrite the event that came before.
        </p>
      </section>

      <section className="stack" aria-labelledby="timeline-title">
        <div className="section-intro">
          <div>
            <h2 id="timeline-title">Activity timeline</h2>
            <p>Newest first · up to 100 entries from this facility</p>
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="panel empty-state">
            <span className="empty-state__mark" aria-hidden="true">A0</span>
            <h2>No facility activity recorded</h2>
            <p>Configuration changes, connector actions, drills, and exports will appear here.</p>
          </div>
        ) : (
          <ol className="audit-timeline">
            {entries.map((entry) => (
              <AuditEntry key={`${entry.source}-${entry.id}`} entry={entry} />
            ))}
          </ol>
        )}
      </section>

      {nextBefore ? (
        <p className="sheet__note">
          More history exists before <span className="tnum">{nextBefore}</span>. The
          pilot API exposes cursor pagination; this console keeps the latest 100 in view.
        </p>
      ) : null}
    </main>
  );
}

function AuditEntry({ entry }: { entry: ActivityEntry }) {
  const drillHref =
    entry.object_type === 'drills' && entry.object_id
      ? `/console/drills/${entry.object_id}`
      : null;
  return (
    <li className="audit-entry">
      <div className="audit-entry__rail">
        <span className="audit-entry__dot" data-kind={entryKind(entry)} />
        <span className="audit-entry__line" aria-hidden="true" />
      </div>
      <details className="audit-entry__body">
        <summary>
          <div>
            <div className="row">
              <strong>{humanize(entry.action)}</strong>
              <Chip kind={entry.source === 'DRILL_EVENT' ? 'declared' : 'neutral'}>
                {entry.source === 'DRILL_EVENT' ? 'Drill event' : 'Audit'}
              </Chip>
            </div>
            <p>
              <span className="tnum">{entry.occurred_at}</span>
              {' · '}{entry.object_type}
              {entry.reason_code ? ` · ${entry.reason_code}` : ''}
            </p>
          </div>
          <span className="audit-entry__expand">Details</span>
        </summary>
        <div className="audit-entry__detail stack">
          <dl className="definition-list">
            <div><dt>Actor</dt><dd>{actor(entry)}</dd></div>
            <div><dt>Object ID</dt><dd className="tnum">{entry.object_id ?? '—'}</dd></div>
            <div><dt>Source row</dt><dd className="tnum">{entry.source} · {entry.id}</dd></div>
          </dl>
          {drillHref ? <Link className="btn" href={drillHref}>Open drill proof chain</Link> : null}
          <pre className="hash">{JSON.stringify(entry.detail, null, 2)}</pre>
        </div>
      </details>
    </li>
  );
}

function humanize(value: string) {
  return value.replace(/_/g, ' ').toLocaleLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function actor(entry: ActivityEntry) {
  if (entry.actor_service) return entry.actor_service;
  if (entry.actor_user_id) return `operator …${entry.actor_user_id.slice(-8)}`;
  return 'system';
}

function entryKind(entry: ActivityEntry): ChipKind {
  if (/ABORT|EMERGENCY|FAILED|ERROR/.test(entry.action)) return 'violation';
  if (/VERIFIED|COMPLETED/.test(entry.action)) return 'tested';
  return 'neutral';
}
