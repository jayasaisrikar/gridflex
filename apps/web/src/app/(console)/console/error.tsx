'use client';

import Link from 'next/link';

export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="content stack">
      <section className="panel empty-state" role="alert">
        <span className="empty-state__mark" aria-hidden="true">ERR</span>
        <h1>The workbench could not load this view</h1>
        <p>
          No operational action was taken. Retry the read, or return to the
          overview to confirm system health before continuing.
        </p>
        <div className="button-row">
          <button className="btn btn--primary" type="button" onClick={reset}>
            Retry this view
          </button>
          <Link className="btn" href="/console" prefetch={false}>
            Return to overview
          </Link>
        </div>
        {error.digest ? <code className="state-reference">Reference {error.digest}</code> : null}
      </section>
    </main>
  );
}
