/**
 * When an item needs (re-)enrichment. Derived from existing data; nothing is
 * stored. AiOrganizations stay immutable: re-enrichment appends a newer one,
 * which then becomes the item's effective AI organization.
 *
 * - No AI organization yet: eligible.
 * - Newest organization made without media, and media has been stored since
 *   it was created: eligible for media-aware re-enrichment.
 * - Otherwise not: a media-aware organization is kept, and a metadata-only one
 *   is not redone while nothing new has arrived. Only stored media counts;
 *   failed or unavailable assets never make an item eligible.
 */
import type { AiOrganization, ArchiveItemAggregate } from "../domain/archive-item.ts";
import type { AiEnrichmentCandidate } from "../persistence/archive-repository.ts";
import { promptVersionUsedMedia } from "./organization-prompt.ts";

export type EnrichmentNeed =
  | { eligible: true; reason: "unorganized" | "media_added" }
  | { eligible: false; reason: string };

export function enrichmentNeed(aggregate: ArchiveItemAggregate): EnrichmentNeed {
  const latest = aggregate.aiSuggestions.at(-1);
  if (!latest) return { eligible: true, reason: "unorganized" };
  if (promptVersionUsedMedia(latest.promptVersion)) {
    return { eligible: false, reason: "already has a media-aware AI organization" };
  }
  return hasMediaStoredSince(aggregate, latest)
    ? { eligible: true, reason: "media_added" }
    : { eligible: false, reason: "already has an AI organization; no media stored since" };
}

/**
 * The same rule for a repository candidate. Candidates are items without an
 * organization or with media stored after their newest one; this keeps those
 * whose newest organization was made without media.
 */
export function isEnrichmentCandidate(candidate: AiEnrichmentCandidate): boolean {
  return !candidate.latestOrganization || !promptVersionUsedMedia(candidate.latestOrganization.promptVersion);
}

function hasMediaStoredSince(aggregate: ArchiveItemAggregate, organization: AiOrganization): boolean {
  return aggregate.media.some(
    (m) => m.retrieval.status === "stored" && m.retrieval.retrievedAt > organization.createdAt,
  );
}
