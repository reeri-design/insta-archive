"use client";

import Link from "next/link";

/** A search that failed: say so plainly, offer to try again, and keep the way back to the library. */
export default function SearchError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="search">
      <div className="search-empty" role="alert">
        <p>Search didn’t work just now.</p>
        <p className="search-empty-hint">
          <button type="button" className="search-retry" onClick={() => retry()}>
            Try again
          </button>{" "}
          or go back to the <Link href="/">library</Link>.
        </p>
      </div>
    </main>
  );
}
