import { redirect } from "next/navigation";
import { searchArchiveCards } from "../../archive-view/archive-view.ts";
import { FOCUS_PARAM } from "../../library/focus-param.ts";
import { libraryItemOf } from "../../library/library-item.ts";
import { QUERY_PARAM, searchHref } from "../../library/search-url.ts";
import { archiveRepository, OWNER_ID } from "../archive-server.ts";
import { SearchResults } from "./search-results.tsx";

/** Every match is sent at once (the grid draws them in batches). A safety cap, far above today's broadest query. */
const SEARCH_RESULT_LIMIT = 2_000;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Search (docs/design-direction.md §5): find something specific. The query
 * stays in the top nav, editable; below it, every match in ranked order as a
 * dense grid. A result opens its Details directly (no Focus here).
 */
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const params = await searchParams;
  const query = (first(params[QUERY_PARAM]) ?? "").trim();
  // Search has no Focus state; older links that carried one land on the results.
  if (first(params[FOCUS_PARAM]) !== undefined) redirect(query ? searchHref(query) : "/search");
  const search = query ? await searchArchiveCards(archiveRepository(), OWNER_ID, query, { pageSize: SEARCH_RESULT_LIMIT }) : undefined;
  const cards = search?.cards ?? [];

  return (
    <main className="search">
      {/* The query itself is in the top nav's search field (site-nav.tsx), which stays in place. */}
      <p className="search-count" aria-live="polite">
        {search && search.total > 0
          ? search.total > cards.length
            ? `First ${cards.length} of ${search.total} matches`
            : `${search.total} ${search.total === 1 ? "match" : "matches"}`
          : ""}
      </p>

      {!query ? (
        <p className="search-empty">What are you looking for? A creator, a word from a caption, or what you remember about it.</p>
      ) : cards.length === 0 ? (
        <div className="search-empty" aria-live="polite">
          <p>Nothing matches “{query}” yet.</p>
          <p className="search-empty-hint">Try fewer words, a creator’s @name, or a word you remember from the caption.</p>
        </div>
      ) : (
        // A new query starts a new grid: fresh batches, no carried-over state.
        <SearchResults key={query} items={cards.map(libraryItemOf)} />
      )}
    </main>
  );
}
