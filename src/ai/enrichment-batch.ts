/**
 * A small, explicit enrichment batch: a fixed limit, a deterministic choice of
 * items (or the ones named), one call at a time, stopping on a rate limit.
 */
import type { ArchiveItemId, UserId } from "../domain/archive-item.ts";
import { isInMainArchive, MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import type { AiEnrichmentCandidate, ArchiveRepository } from "../persistence/archive-repository.ts";
import { isEnrichmentCandidate } from "./enrichment-eligibility.ts";
import type { AiEnrichmentService, EnrichmentResult } from "./enrichment-service.ts";

/** Hard ceiling per run, so a batch can never cover the whole archive by accident. */
export const MAX_ENRICHMENT_LIMIT = 100;

export type EnrichmentBatchSummary = {
  attempted: number;
  enriched: number;
  skipped: number;
  failed: number;
  rateLimited: boolean;
  /** Stopped because the provider rejected or lacked credentials. */
  stoppedForAuthentication: boolean;
  inputTokens: number;
  outputTokens: number;
  results: EnrichmentResult[];
};

export type EnrichmentBatchOptions = {
  service: Pick<AiEnrichmentService, "enrich">;
  repository: ArchiveRepository;
  ownerId: UserId;
  limit: number;
  /** Specific items to enrich (by Instagram shortcode); otherwise a representative sample. */
  shortcodes?: string[];
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: EnrichmentResult) => void;
};

export async function runEnrichmentBatch(options: EnrichmentBatchOptions): Promise<EnrichmentBatchSummary> {
  const { limit } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENRICHMENT_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_ENRICHMENT_LIMIT}`);
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const itemIds = await selectItemsForEnrichment(options);

  const summary: EnrichmentBatchSummary = {
    attempted: 0, enriched: 0, skipped: 0, failed: 0, rateLimited: false, stoppedForAuthentication: false, inputTokens: 0, outputTokens: 0, results: [],
  };
  for (const [index, itemId] of itemIds.entries()) {
    if (index > 0 && options.delayMs) await sleep(options.delayMs);
    let result: EnrichmentResult;
    try {
      result = await options.service.enrich(itemId);
    } catch (error) {
      result = { status: "failed", itemId, kind: "provider_error", reason: error instanceof Error ? error.message : String(error) };
    }
    summary.attempted++;
    summary.results.push(result);
    options.onResult?.(result);
    if (result.status === "enriched") {
      summary.enriched++;
      summary.inputTokens += result.usage?.inputTokens ?? 0;
      summary.outputTokens += result.usage?.outputTokens ?? 0;
    } else if (result.status === "skipped") {
      summary.skipped++;
    } else {
      summary.failed++;
      if (result.kind === "rate_limited") {
        summary.rateLimited = true;
        break;
      }
      // Every further call would fail the same way.
      if (result.kind === "authentication") {
        summary.stoppedForAuthentication = true;
        break;
      }
    }
  }
  return summary;
}

/**
 * The items a batch will process: the named ones (first `limit`), or
 * prioritizedSample of the items needing enrichment: those without an AI
 * organization, and those organized without media that have media now. Both are
 * limited to the main archive (Saved + Messages): liked-only items are
 * never enriched.
 */
export async function selectItemsForEnrichment(
  options: Pick<EnrichmentBatchOptions, "repository" | "ownerId" | "limit" | "shortcodes">,
): Promise<ArchiveItemId[]> {
  const { repository, ownerId, limit } = options;
  if (options.shortcodes && options.shortcodes.length > 0) {
    const ids: ArchiveItemId[] = [];
    for (const shortcode of options.shortcodes.slice(0, limit)) {
      const item = await repository.findArchiveItemByIdentity(ownerId, { kind: "shortcode", shortcode });
      if (!item) throw new Error(`No archive item for shortcode ${shortcode}`);
      const aggregate = await repository.getArchiveItemAggregate(item.id);
      if (!aggregate || !isInMainArchive(aggregate.sources)) {
        throw new Error(`${shortcode} is not in the main archive (Saved + Messages); liked-only items are not enriched`);
      }
      ids.push(item.id);
    }
    return ids;
  }
  const candidates = await repository.listAiEnrichmentCandidates(ownerId, { sources: MAIN_ARCHIVE_SOURCES });
  return prioritizedSample(candidates.filter(isEnrichmentCandidate), limit);
}

/**
 * New captures first, then backfill. New items (imported after the initial
 * import) are all taken, up to the limit: those with stored media first, then
 * the most recent. Backfill fills the rest with representativeSample (media
 * first, varied by kind, source and creator), so the historical archive is
 * enriched opportunistically by whatever capacity is left. Items with neither
 * a caption nor stored media are never chosen. Candidates are expected newest
 * first.
 */
export function prioritizedSample(candidates: AiEnrichmentCandidate[], limit: number): ArchiveItemId[] {
  const usable = (c: AiEnrichmentCandidate) => c.hasCaption || c.hasStoredMedia;
  const fresh = candidates
    .filter((c) => c.priority === "new" && usable(c))
    // Stable sort: media first, otherwise keeping the newest-first order.
    .sort((a, b) => Number(b.hasStoredMedia) - Number(a.hasStoredMedia))
    .slice(0, limit)
    .map((c) => c.itemId);
  const backfill = candidates.filter((c) => c.priority === "backfill");
  return [...fresh, ...representativeSample(backfill, limit - fresh.length)];
}

/**
 * Deterministic, varied sample. Items with stored media come first, so the
 * media-aware path is exercised; metadata-only items fill the rest of the
 * limit. Within each tier, items are grouped by content kind and source
 * context (e.g. "reel | liked", "carousel | messages+saved"), groups are
 * visited round-robin (largest first), and within a group the newest item by
 * a creator not yet picked (in either tier) comes first. Items with neither a
 * caption nor stored media are left out: there is nothing to classify without
 * guessing. Candidates are expected newest first.
 */
export function representativeSample(candidates: AiEnrichmentCandidate[], limit: number): ArchiveItemId[] {
  const picked: ArchiveItemId[] = [];
  const creators = new Set<string>();
  pickRoundRobin(candidates.filter((c) => c.hasStoredMedia), limit, picked, creators);
  pickRoundRobin(candidates.filter((c) => !c.hasStoredMedia && c.hasCaption), limit, picked, creators);
  return picked;
}

/** Adds candidates to `picked` round-robin over kind/source groups, up to `limit` in total. */
function pickRoundRobin(candidates: AiEnrichmentCandidate[], limit: number, picked: ArchiveItemId[], creators: Set<string>): void {
  const groups = new Map<string, AiEnrichmentCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.kind} | ${candidate.sources.join("+")}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const ordered = [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.length - a.length || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, group]) => group);

  while (picked.length < limit && ordered.some((g) => g.length > 0)) {
    for (const group of ordered) {
      if (picked.length >= limit || group.length === 0) continue;
      const fresh = group.findIndex((c) => !c.creatorUsername || !creators.has(c.creatorUsername));
      const [choice] = group.splice(fresh === -1 ? 0 : fresh, 1);
      if (!choice) continue;
      picked.push(choice.itemId);
      if (choice.creatorUsername) creators.add(choice.creatorUsername);
    }
  }
}
