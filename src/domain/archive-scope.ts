/**
 * Product scope of the main archive: Saved + Messages. Likes are preserved as
 * imported source data but are not included in the main archive.
 *
 * An item is in the main archive when at least one of its source records is
 * one of these kinds. A liked item that was also saved or shared in messages
 * stays in, with its liked record still attached; liked-only items are kept
 * in storage but left out of browsing, enrichment and (later) search.
 */
import type { SourceKind, SourceRecord } from "./archive-item.ts";

export const MAIN_ARCHIVE_SOURCES: readonly SourceKind[] = ["saved", "messages"];

export function isInMainArchive(sources: readonly Pick<SourceRecord, "source">[]): boolean {
  return sources.some((s) => MAIN_ARCHIVE_SOURCES.includes(s.source));
}
