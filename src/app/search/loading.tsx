/** While a search runs: a few quiet shapes where results will be (the query is already in the top nav). */
export default function SearchLoading() {
  return (
    <main className="search" aria-busy="true">
      <p className="search-count">Searching…</p>
      <div className="results-loading" aria-hidden="true">
        {[1.25, 0.8, 1.4, 1, 1.2, 0.7, 1.3, 1, 0.9, 1.25, 1.1, 0.8].map((ratio, i) => (
          <span key={i} style={{ aspectRatio: `1 / ${ratio}` }} />
        ))}
      </div>
    </main>
  );
}
