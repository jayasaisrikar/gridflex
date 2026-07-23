import Link from 'next/link';

export default function ConsoleNotFound() {
  return (
    <main className="content stack">
      <section className="panel empty-state">
        <span className="empty-state__mark" aria-hidden="true">404</span>
        <h1>This workbench record does not exist</h1>
        <p>
          The identifier may be invalid, expired, or outside this facility. No
          operational state was changed.
        </p>
        <Link className="btn btn--primary" href="/console" prefetch={false}>
          Return to overview
        </Link>
      </section>
    </main>
  );
}
