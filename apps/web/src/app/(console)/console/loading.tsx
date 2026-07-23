export default function ConsoleLoading() {
  return (
    <main className="content stack" aria-busy="true" aria-label="Loading workbench view">
      <section className="loading-panel panel" role="status">
        <span className="sr-only">Loading workbench view…</span>
        <span className="loading-line loading-line--eyebrow" aria-hidden="true" />
        <span className="loading-line loading-line--title" aria-hidden="true" />
        <span className="loading-line loading-line--copy" aria-hidden="true" />
      </section>
      <section className="grid-metrics" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <div className="loading-panel panel" key={item}>
            <span className="loading-line loading-line--eyebrow" />
            <span className="loading-line loading-line--metric" />
            <span className="loading-line loading-line--copy" />
          </div>
        ))}
      </section>
    </main>
  );
}
