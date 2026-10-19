/**
 * Persistent enrichment failure state: what went wrong the last time an item
 * was sent to the AI provider, so every run and every worker sees it.
 *
 *   provider_rejected  The provider refused the input (HTTP 400 from the
 *                      OpenRouter path, e.g. AtlasCloud's "bad request").
 *                      Retrying the same input gets the same answer, so normal
 *                      runs no longer select the item; naming it explicitly
 *                      (enrich:ai --item) retries it.
 *   temporary          The provider or the network failed (HTTP 502/503/504,
 *                      no HTTP answer at all). Stays eligible, after a
 *                      backoff: normal runs leave it alone until its
 *                      `nextRetryAt` (see temporaryRetryDelayMs), which is
 *                      stored, so every worker respects it.
 *   unknown            Anything else (other HTTP errors, refusals, unreadable
 *                      output). Stays eligible.
 *
 * Not recorded: a rate limit (the run stops, as before; the item is not at
 * fault) and missing or rejected credentials (likewise). A later success
 * clears the item's failure. Nothing here changes eligibility for items that
 * never failed, and nothing is ever marked unavailable or deleted.
 */
import type { ArchiveItemId, IsoDateTime } from "../domain/archive-item.ts";
import type { EnrichmentResult } from "./enrichment-service.ts";

export type EnrichmentFailureCategory = "provider_rejected" | "temporary" | "unknown";

/** The item's most recent enrichment failure (one per item; `attempts` counts failures in a row). */
export type EnrichmentFailure = {
  itemId: ArchiveItemId;
  category: EnrichmentFailureCategory;
  /** HTTP status, when the provider gave one. */
  statusCode?: number;
  /** The provider that failed: the upstream one a gateway named (e.g. "AtlasCloud"), else the one called. */
  provider?: string;
  /** The failure kind as the enrichment service reported it (e.g. "provider_error"). */
  errorCode: string;
  message: string;
  failedAt: IsoDateTime;
  attempts: number;
  /** Temporary failures only: when the item may be tried again (failedAt + temporaryRetryDelayMs(attempts)). */
  nextRetryAt?: IsoDateTime;
};

/** Backoff after the n-th failure in a row (n ≥ 1): 1 min, 5 min, 15 min, then 30 min. */
export const TEMPORARY_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000, 1_800_000];

export function temporaryRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(1, Math.floor(attempts)), TEMPORARY_RETRY_DELAYS_MS.length) - 1;
  return TEMPORARY_RETRY_DELAYS_MS[index]!;
}

/** Whether a failure keeps the item out of normal runs at `now`: rejected for good, or temporary and still backing off. */
export function holdsBackItem(failure: EnrichmentFailure | undefined, now: IsoDateTime): "provider_rejected" | "backing_off" | undefined {
  if (failure?.category === "provider_rejected") return "provider_rejected";
  if (failure?.category === "temporary" && failure.nextRetryAt !== undefined && failure.nextRetryAt > now) return "backing_off";
  return undefined;
}

const TEMPORARY_STATUSES = new Set([502, 503, 504]);

/** How a failed result is recorded, or undefined when it is not recorded at all (rate limit, credentials). */
export function classifyEnrichmentFailure(
  result: Extract<EnrichmentResult, { status: "failed" }>,
): EnrichmentFailureCategory | undefined {
  if (result.kind === "rate_limited" || result.kind === "authentication") return undefined;
  const { status, network } = result.details ?? {};
  if (network) return "temporary";
  if (status !== undefined && TEMPORARY_STATUSES.has(status)) return "temporary";
  if (status === 400 && result.provider === "openrouter") return "provider_rejected";
  return "unknown";
}

/** The record to store for a failed result, or undefined when it is not recorded. */
export function failureRecordFor(
  result: Extract<EnrichmentResult, { status: "failed" }>,
  failedAt: IsoDateTime,
): Omit<EnrichmentFailure, "attempts" | "nextRetryAt"> | undefined {
  const category = classifyEnrichmentFailure(result);
  if (!category) return undefined;
  const provider = result.details?.upstreamProvider ?? result.provider;
  return {
    itemId: result.itemId,
    category,
    ...(result.details?.status !== undefined && { statusCode: result.details.status }),
    ...(provider && { provider }),
    errorCode: result.kind,
    message: result.reason.length > 1000 ? `${result.reason.slice(0, 1000)}…` : result.reason,
    failedAt,
  };
}
