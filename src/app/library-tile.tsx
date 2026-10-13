import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { MediaState } from "../archive-view/archive-view.ts";
import { excerptOf, type LibraryItem } from "../library/library-item.ts";
import { textShape } from "../library/library-layout.ts";

const STATE_LABELS: Record<Exclude<MediaState, "available">, string> = {
  pending: "Media not retrieved yet",
  failed: "Media retrieval failed · will retry",
  unavailable: "Media no longer available",
};

/**
 * One occurrence of an archive item, on the Canvas or in Search results: its
 * media (natural proportions), or a quiet text fragment when there is none.
 * The tile links to `href` (on the Canvas its Focus URL, which the canvas
 * handles itself; in Search its Details). Hover or keyboard focus also reveals
 * a quiet "Details" link in the bottom corner, straight to the item's Details,
 * a sibling of the tile's own link (links can't nest).
 */
export function Tile({ item, href, occurrence }: { item: LibraryItem; href: string; occurrence: string }) {
  return (
    <div className="tile-frame">
      <TileLink item={item} href={href} occurrence={occurrence} />
      <Link href={item.detailsHref} prefetch={false} className="tile-details" data-details-link="" aria-label={`Details: ${item.label}`} draggable={false}>
        Details
      </Link>
    </div>
  );
}

function TileLink({ item, href, occurrence }: { item: LibraryItem; href: string; occurrence: string }) {
  const excerpt = item.text ? excerptOf(item.text, 220) : undefined;
  const ariaLabel = [item.label, item.title ?? (excerpt && excerptOf(excerpt, 90))].filter(Boolean).join(": ");
  const { preview } = item;
  const common = {
    href,
    prefetch: false,
    "aria-label": ariaLabel,
    "data-focus-key": item.key,
    "data-occurrence": occurrence,
    draggable: false,
  };

  if (preview) {
    const isVideo = preview.mediaType === "video" || preview.cover === true || item.kindLabel === "Reel";
    return (
      <Link {...common} className="tile tile-media">
        {preview.mediaType === "image" ? (
          <Image src={preview.url} alt="" fill sizes="(max-width: 520px) 50vw, 320px" unoptimized draggable={false} />
        ) : (
          // A muted, unplayed video shows its first frame.
          <video src={`${preview.url}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />
        )}
        {(item.storedMediaCount > 1 || isVideo) && (
          <span className="tile-marker" aria-hidden="true">
            {isVideo ? <PlayIcon /> : <StackIcon />}
            {item.storedMediaCount > 1 && item.storedMediaCount}
          </span>
        )}
        <Hint matched={item.matched} />
      </Link>
    );
  }

  const { lines } = textShape(item.text);
  return (
    <Link {...common} className="tile tile-text">
      {excerpt ? (
        <blockquote style={{ "--lines": lines } as CSSProperties}>{excerpt}</blockquote>
      ) : (
        <span className="tile-byline">{item.creator ?? item.kindLabel}</span>
      )}
      <div>
        {excerpt && item.creator && <div className="tile-byline">{item.creator}</div>}
        {item.mediaState !== "available" && (
          <span className="tile-state" data-state={item.mediaState}>
            {STATE_LABELS[item.mediaState]}
          </span>
        )}
      </div>
      <Hint matched={item.matched} />
    </Link>
  );
}

/** Hover / keyboard focus, in Search: where the query matched. */
function Hint({ matched }: { matched: string | undefined }) {
  if (!matched) return null;
  return (
    <span className="tile-hint" aria-hidden="true">
      <span className="tile-matched">matched in {matched}</span>
    </span>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <path d="M2.5 1.5v7l6-3.5z" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="1" y="3" width="6" height="6" rx="1" />
      <path d="M3 1h5a1 1 0 0 1 1 1v5" />
    </svg>
  );
}
