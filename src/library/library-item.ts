/**
 * The library's per-item view model: what the canvas needs to draw a tile
 * and to focus it, kept lean because the whole archive is sent at once.
 * Built on the server from an ArchiveCard; pure, no Node or React APIs.
 */
import type { ArchiveCard, MediaPreview, MediaState, ViewableMedia } from "../archive-view/archive-view.ts";
import type { SearchField } from "../search/search-query.ts";
import { tileRatio } from "./library-layout.ts";

export type LibraryItem = {
  /** The item's URL key; every canvas occurrence of the item shares it. */
  key: string;
  /** The full item page (Details). */
  detailsHref: string;
  /** e.g. "Reel"; "Saved item" when unknown. */
  kindLabel: string;
  /** Accessible name, e.g. "Reel by @someone". */
  label: string;
  /** "@username", else the display name. */
  creator?: string;
  /** Media-less items: the caption, whitespace collapsed, up to TEXT_LENGTH. */
  text?: string;
  /** Media items: the caption's opening words, as identifying text (taken, never generated). */
  title?: string;
  preview?: MediaPreview;
  /** Tile height ÷ width on the canvas (see tileRatio). */
  ratio: number;
  storedMediaCount: number;
  mediaState: MediaState;
  /** Search results: where the query matched, e.g. "caption · tags". */
  matched?: string;
  /** What Focus can show, in order (slides, video, frames or cover). */
  media: ViewableMedia[];
  /** Where the original lives, in human terms. */
  source: { name: string; handle?: string; url: string };
};

/** How much caption a media-less item carries (its tile shows less). */
export const TEXT_LENGTH = 420;

export const KIND_LABELS: Record<ArchiveCard["kind"], string> = {
  post: "Post",
  carousel: "Carousel",
  reel: "Reel",
  unknown: "Saved item",
};

const FIELD_LABELS: Record<SearchField, string> = {
  tags: "tags",
  creator: "creator",
  type: "type",
  category: "category",
  summary: "summary",
  usefulFor: "useful for",
  caption: "caption",
};

export function libraryItemOf(card: ArchiveCard): LibraryItem {
  const creator = card.creator?.username ? `@${card.creator.username}` : card.creator?.displayName;
  const hasMedia = card.viewable.length > 0;
  const title = hasMedia && card.caption ? titleOf(card.caption) : undefined;
  return {
    key: card.key,
    detailsHref: card.href,
    kindLabel: KIND_LABELS[card.kind],
    label: [KIND_LABELS[card.kind], creator && `by ${creator}`].filter(Boolean).join(" "),
    ...(creator && { creator }),
    ...(!hasMedia && card.caption && { text: excerptOf(card.caption, TEXT_LENGTH) }),
    ...(title && { title }),
    ...(card.preview && { preview: card.preview }),
    ratio: tileRatio(card),
    storedMediaCount: card.storedMediaCount,
    mediaState: card.mediaState,
    ...(card.matchedFields?.length && { matched: card.matchedFields.map((f) => FIELD_LABELS[f]).join(" · ") }),
    media: card.viewable,
    source: {
      name: sourceNameOf(card.sourceUrl),
      ...(card.creator?.username && { handle: `@${card.creator.username}` }),
      url: card.sourceUrl,
    },
  };
}

/** Whitespace collapsed, cut at a word boundary with an ellipsis. */
export function excerptOf(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).replace(/\s+\S*$/, "")}…` : flat;
}

/**
 * Identifying text for a media item: the caption's first line or sentence,
 * without trailing hashtags, at most ~80 characters. Taken from the original
 * caption, never generated; undefined when nothing readable is left.
 */
export function titleOf(caption: string): string | undefined {
  const line = caption.split(/\n/).map((l) => l.trim()).find((l) => l.replace(/[#@]\S+/g, "").trim().length > 2) ?? "";
  const words = line.replace(/(\s*[#@]\S+)+\s*$/, "").trim();
  const sentence = words.match(/^.{12,}?[.!?](?=\s|$)/)?.[0] ?? words;
  return sentence.length > 2 ? excerptOf(sentence, 80) : undefined;
}

/** The source's human name from its URL, e.g. "Instagram". */
export function sourceNameOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "instagram.com" ? "Instagram" : host;
  } catch {
    return "Original";
  }
}
