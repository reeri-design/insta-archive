import { redirect } from "next/navigation";
import { getArchiveCard, listArchiveCards } from "../archive-view/archive-view.ts";
import { FOCUS_PARAM } from "../library/focus-param.ts";
import { libraryItemOf } from "../library/library-item.ts";
import { QUERY_PARAM, searchHref } from "../library/search-url.ts";
import { archiveRepository, OWNER_ID } from "./archive-server.ts";
import { LibraryBrowse } from "./library-browse.tsx";

/**
 * The whole main archive goes onto the canvas at once; the canvas repeats it
 * to fill an unbounded field and only puts what is near the view in the DOM.
 * A safety cap, far above today's archive.
 */
const CANVAS_ITEM_LIMIT = 20_000;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Browse (docs/design-direction.md §3, level 1): the canvas, to wander. Search (in the top nav, site-nav.tsx) is its own page. */
export default async function LibraryPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  // Searching used to happen on the canvas; old links go to the Search page.
  const query = (first(params[QUERY_PARAM]) ?? "").trim();
  if (query) redirect(searchHref(query));

  // Shuffle (from the nav) swaps in its own selection on the client, in place (library-browse.tsx).
  const { cards } = await listArchiveCards(archiveRepository(), OWNER_ID, { pageSize: CANVAS_ITEM_LIMIT });
  // A deep link may focus an item that is not among these.
  const focusKey = first(params[FOCUS_PARAM]);
  const extra =
    focusKey && !cards.some((c) => c.key === focusKey) ? await getArchiveCard(archiveRepository(), OWNER_ID, focusKey) : undefined;
  const items = [...cards, ...(extra ? [extra] : [])].map(libraryItemOf);

  return (
    <main className="library">
      {items.length === 0 ? <p className="library-empty">Nothing in your archive yet.</p> : <LibraryBrowse items={items} />}
    </main>
  );
}
