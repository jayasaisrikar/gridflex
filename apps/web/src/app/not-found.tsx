import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="standalone-state">
      <section className="panel empty-state">
        <span className="empty-state__mark" aria-hidden="true">404</span>
        <h1>That GridFlex page is not here</h1>
        <p>Check the address, or return to a known starting point.</p>
        <div className="button-row">
          <Link className="btn btn--primary" href="/" prefetch={false}>Public site</Link>
          <Link className="btn" href="/login" prefetch={false}>Operator sign in</Link>
        </div>
      </section>
    </main>
  );
}
