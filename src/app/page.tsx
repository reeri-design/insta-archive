import Image from "next/image";
import Link from "next/link";
import { listArchiveCards, searchArchiveCards, type ArchiveCard } from "../archive-view/archive-view.ts";
import { archiveRepository, OWNER_ID } from "./archive-server.ts";
import { formatDate } from "./format.ts";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function ArchivePage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const query = (first(params.q) ?? "").trim();
  const requested = Number(first(params.page));
  const pageNumber = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
  const search = query ? await searchArchiveCards(archiveRepository(), OWNER_ID, query, { page: pageNumber }) : undefined;
  const { cards, page, hasNext } = search ?? (await listArchiveCards(archiveRepository(), OWNER_ID, { page: pageNumber }));
  const pageHref = (n: number) => `/?${new URLSearchParams({ ...(query && { q: query }), page: String(n) })}`;

  return (
    <main className="archive">
      <form action="/" className="search">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search your archive: creators, captions, tags, ideas…"
          aria-label="Search the archive"
          autoFocus={!query}
        />
        <button type="submit">Search</button>
      </form>
      <p className="muted">
        {search ? (
          <>
            {search.total} {search.total === 1 ? "result" : "results"} for “{query}” · best matches first
            {search.total > 0 && ` · page ${page}`} · <Link href="/">Clear</Link>
          </>
        ) : (
          <>Most recently saved or shared first · page {page}</>
        )}
      </p>
      {cards.length === 0 ? (
        <p className="empty">{query ? "Nothing in your archive matches that." : "No items on this page."}</p>
      ) : (
        <ul className="grid">
          {cards.map((card) => (
            <li key={card.href}>
              <Card card={card} />
            </li>
          ))}
        </ul>
      )}
      <nav className="pager">
        {page > 1 ? <Link href={pageHref(page - 1)}>{query ? "← Previous" : "← Newer"}</Link> : <span />}
        {hasNext && <Link href={pageHref(page + 1)}>{query ? "Next →" : "Older →"}</Link>}
      </nav>
    </main>
  );
}

function Card({ card }: { card: ArchiveCard }) {
  const creator = card.creator?.username ? `@${card.creator.username}` : card.creator?.displayName;
  return (
    <Link href={card.href} className="card">
      <div className="thumb">
        {card.preview?.mediaType === "image" && (
          <Image src={card.preview.url} alt="" fill sizes="220px" unoptimized />
        )}
        {card.preview?.mediaType === "video" && (
          // A muted, unplayed video shows its first frame as a thumbnail.
          <video src={`${card.preview.url}#t=0.1`} muted playsInline preload="metadata" />
        )}
        {!card.preview && <p className="thumb-text">{card.caption ?? "No caption"}</p>}
        <span className="badge kind">
          {card.kind}
          {card.storedMediaCount > 1 && ` · ${card.storedMediaCount}`}
        </span>
        {card.reviewStatus !== "unorganized" && (
          <span className={`badge status ${card.reviewStatus}`}>{card.reviewStatus === "reviewed" ? "Reviewed" : "AI"}</span>
        )}
      </div>
      <div className="card-meta">
        <span className="creator">{creator ?? "Unknown creator"}</span>
        <span className="muted">
          {card.sources.join(" · ")}
          {card.latestAt && ` · ${formatDate(card.latestAt)}`}
        </span>
        {card.organization && (
          <span className="muted">{[card.organization.type, card.organization.category].filter(Boolean).join(" / ")}</span>
        )}
        {card.matchedFields && card.matchedFields.length > 0 && (
          <span className="matched">matched: {card.matchedFields.map((f) => FIELD_LABELS[f]).join(", ")}</span>
        )}
      </div>
    </Link>
  );
}

const FIELD_LABELS: Record<NonNullable<ArchiveCard["matchedFields"]>[number], string> = {
  tags: "tags",
  creator: "creator",
  type: "type",
  category: "category",
  summary: "summary",
  usefulFor: "useful for",
  caption: "caption",
};
