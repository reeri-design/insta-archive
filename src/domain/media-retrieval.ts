/**
 * Media retrieval requests: the queue entry that asks for an ArchiveItem's
 * media to be fetched. Source-agnostic (no Instagram concepts).
 *
 * One request per ArchiveItem, because the item's assets (how many carousel
 * slides, whether there is a video) are only known after retrieval. The
 * per-asset outcome lives on MediaAsset.retrieval; the request tracks
 * scheduling for the item as a whole and reuses the same status vocabulary.
 */
import type {
  ArchiveItemId,
  IsoDateTime,
  MediaAssetId,
  MediaRetrieval,
  UnavailableReason,
} from "./archive-item.ts";

export type RetrievalStatus = MediaRetrieval["status"];

/** Higher runs first. Numeric so new tiers can be slotted in later. */
export type RetrievalPriority = number;

export const RETRIEVAL_PRIORITY = {
  /** Content exchanged directly between the archive owner's own accounts. */
  ownerExchange: 100,
  normal: 0,
} as const satisfies Record<string, RetrievalPriority>;

/** Transient problems: worth retrying automatically. */
export type TemporaryFailureCode =
  | "network_error"
  | "rate_limited"
  | "timeout"
  | "server_error"
  | "storage_error"
  | "unknown";

export type RetrievalFailure =
  | {
      kind: "temporary";
      code: TemporaryFailureCode;
      message: string;
      /** Source-provided wait (e.g. Retry-After), if any. */
      retryAfterMs?: number;
    }
  | {
      /** The content itself cannot be obtained (deleted, private, ...). */
      kind: "unavailable";
      code: UnavailableReason;
      message: string;
    };

export type MediaRetrievalRequest = {
  archiveItemId: ArchiveItemId;
  priority: RetrievalPriority;
  /**
   * pending:     waiting to run (new, scheduled retry, or manual retry)
   * stored:      done; all obtainable media is stored
   * failed:      temporary failure; retried at nextAttemptAt, or only
   *              manually once nextAttemptAt is unset (attempts exhausted)
   * unavailable: content cannot be obtained; only a manual retry reruns it
   */
  status: RetrievalStatus;
  attempts: number;
  lastAttemptAt?: IsoDateTime;
  nextAttemptAt?: IsoDateTime;
  /** Why the most recent attempt failed. Kept after a manual retry for context. */
  lastFailure?: RetrievalFailure;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export function newRetrievalRequest(
  archiveItemId: ArchiveItemId,
  priority: RetrievalPriority,
  now: IsoDateTime,
): MediaRetrievalRequest {
  return { archiveItemId, priority, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
}

/** Whether a request should run now. */
export function isDue(request: MediaRetrievalRequest, now: IsoDateTime): boolean {
  if (request.status === "pending") return !request.nextAttemptAt || request.nextAttemptAt <= now;
  if (request.status === "failed") return !!request.nextAttemptAt && request.nextAttemptAt <= now;
  return false;
}

export function recordRetrievalSuccess(
  request: MediaRetrievalRequest,
  now: IsoDateTime,
): MediaRetrievalRequest {
  return {
    ...without(request, "nextAttemptAt", "lastFailure"),
    status: "stored",
    attempts: request.attempts + 1,
    lastAttemptAt: now,
    updatedAt: now,
  };
}

/**
 * Temporary failures become `failed` with a retry time from the policy (none
 * once it gives up); unavailable content becomes `unavailable`, never retried
 * automatically.
 */
export function recordRetrievalFailure(
  request: MediaRetrievalRequest,
  failure: RetrievalFailure,
  now: IsoDateTime,
  policy: RetryPolicy = defaultRetryPolicy,
): MediaRetrievalRequest {
  const attempts = request.attempts + 1;
  const base = {
    ...without(request, "nextAttemptAt"),
    attempts,
    lastAttemptAt: now,
    lastFailure: failure,
    updatedAt: now,
  };
  if (failure.kind === "unavailable") return { ...base, status: "unavailable" };

  const delayMs = policy(failure, attempts);
  return {
    ...base,
    status: "failed",
    ...(delayMs !== undefined && {
      nextAttemptAt: new Date(Date.parse(now) + delayMs).toISOString(),
    }),
  };
}

/** User-initiated retry, allowed from any finished or failed state. */
export function requestManualRetry(
  request: MediaRetrievalRequest,
  now: IsoDateTime,
): MediaRetrievalRequest {
  return { ...without(request, "nextAttemptAt"), status: "pending", updatedAt: now };
}

/**
 * Delay before the next automatic attempt, or undefined to stop retrying
 * (a manual retry is still possible). `attempts` includes the one that failed.
 */
export type RetryPolicy = (
  failure: Extract<RetrievalFailure, { kind: "temporary" }>,
  attempts: number,
) => number | undefined;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const BACKOFF: Record<TemporaryFailureCode, { firstDelayMs: number; maxAttempts: number }> = {
  network_error: { firstDelayMs: MINUTE, maxAttempts: 5 },
  timeout: { firstDelayMs: MINUTE, maxAttempts: 5 },
  server_error: { firstDelayMs: 5 * MINUTE, maxAttempts: 5 },
  // Being rate limited means slowing down a lot, not hammering again.
  rate_limited: { firstDelayMs: 15 * MINUTE, maxAttempts: 8 },
  storage_error: { firstDelayMs: MINUTE, maxAttempts: 3 },
  unknown: { firstDelayMs: 5 * MINUTE, maxAttempts: 3 },
};

/** Exponential backoff (×4 per attempt, capped at 24h) per failure code. */
export const defaultRetryPolicy: RetryPolicy = (failure, attempts) => {
  const { firstDelayMs, maxAttempts } = BACKOFF[failure.code];
  if (attempts >= maxAttempts) return undefined;
  const backoff = Math.min(firstDelayMs * 4 ** (attempts - 1), 24 * HOUR);
  return Math.max(backoff, failure.retryAfterMs ?? 0);
};

/** Copy of `request` without the given optional fields. */
function without<K extends "nextAttemptAt" | "lastFailure">(
  request: MediaRetrievalRequest,
  ...keys: K[]
): Omit<MediaRetrievalRequest, K> {
  const copy = { ...request };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Deterministic asset ids, so re-retrieval updates instead of duplicating. */
export function contentAssetId(itemId: ArchiveItemId, position: number): MediaAssetId {
  return `${itemId}:media:${position}` as MediaAssetId;
}

export function derivedFrameAssetId(videoId: MediaAssetId, frameTimeMs: number): MediaAssetId {
  return `${videoId}:frame:${frameTimeMs}` as MediaAssetId;
}
