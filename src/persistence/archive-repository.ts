import type { SearchField } from "../search/search-query.ts";
import type {
  AiOrganization,
  ArchiveItem,
  ArchiveItemAggregate,
  ArchiveItemId,
  CuratedOrganization,
  InstagramIdentity,
  IsoDateTime,
  MediaAsset,
  OriginalMetadata,
  SourceKind,
  SourceRecord,
  UserId,
} from "../domain/archive-item.ts";
import type { MediaRetrievalRequest } from "../domain/media-retrieval.ts";
import type { EnrichmentFailure } from "../ai/enrichment-failure.ts";

/**
 * Storage-agnostic access to the archive. Speaks only domain types; the
 * SQLite implementation lives in ./sqlite. Async so a networked database
 * can replace SQLite without changing callers.
 *
 * Each method is atomic on its own; use withTransaction to make several
 * calls one unit. Writes must respect references: an item before its
 * sources, sources before OriginalMetadata that cites them.
 */
export interface ArchiveRepository {
  /**
   * Runs `work` as one transaction: everything it writes through `repo` is
   * committed together, or rolled back together if it throws. Do not use
   * the outer repository, or start another transaction, inside `work`.
   */
  withTransaction<T>(work: (repo: ArchiveRepository) => Promise<T>): Promise<T>;

  /**
   * Insert, or update `kind`, `canonicalUrl` and `updatedAt` of an existing
   * item. `ownerId` and `identity` never change once stored.
   *
   * `original` is saved separately (saveOriginalMetadata) because it cites
   * source records, which in turn need the item to exist first.
   * @throws ArchiveIdentityConflictError when another item already has this
   *   (ownerId, identity), or when an existing id is given a different one.
   */
  saveArchiveItem(item: Omit<ArchiveItem, "original">): Promise<void>;

  /**
   * Insert source records as-is. Records whose id already exists are left
   * untouched (source data is never rewritten), making re-imports idempotent.
   * @throws PersistenceIntegrityError if an existing id belongs to another item.
   */
  addSourceRecords(records: SourceRecord[]): Promise<{ inserted: number; existing: number }>;

  /** Replace the item's original metadata; absent fields are cleared. */
  saveOriginalMetadata(itemId: ArchiveItemId, metadata: OriginalMetadata): Promise<void>;

  /** Insert or update assets by id (e.g. a new retrieval state). */
  saveMediaAssets(assets: MediaAsset[]): Promise<void>;

  /**
   * Replace a Reel's stored frames — its `derived_frame` assets that stand in
   * for a video that was not kept (no derivedFromAssetId) — with `frames`, in
   * one transaction. Other assets are untouched, and so are files in media
   * storage (the old frames' files stay until removed deliberately).
   */
  replaceReelFrames(itemId: ArchiveItemId, frames: MediaAsset[]): Promise<void>;

  /** Ids of the owner's items that have Reel frames standing in for a video (see replaceReelFrames). */
  listItemIdsWithReelFrames(ownerId: UserId): Promise<ArchiveItemId[]>;

  /** Add a new AI suggestion. Existing suggestions can never be modified. */
  appendAiOrganization(suggestion: AiOrganization): Promise<void>;

  /**
   * appendAiOrganization, only while `workerId` still holds the item's
   * enrichment claim (checked in the same transaction). Returns false, writing
   * nothing, when the claim is gone or belongs to another worker: a worker
   * whose lease expired and was taken over cannot add a duplicate.
   */
  appendAiOrganizationIfClaimed(suggestion: AiOrganization, workerId: string): Promise<boolean>;

  /**
   * Atomically claim an item for AI enrichment until `expiresAt`. Succeeds
   * when the item has no claim, its claim has expired (at `now`), or
   * `workerId` already holds it (a renewal). Never takes over another
   * worker's active claim: of two workers claiming the same item, only one
   * gets it. A claim says nothing about eligibility; it only prevents two
   * workers processing the same item at once.
   */
  claimAiEnrichment(itemId: ArchiveItemId, claim: { workerId: string; now: IsoDateTime; expiresAt: IsoDateTime }): Promise<boolean>;

  /** Release `workerId`'s claim on the item, if it still holds it (another worker's claim is left alone). */
  releaseAiEnrichmentClaim(itemId: ArchiveItemId, workerId: string): Promise<void>;

  /**
   * Record the item's latest enrichment failure (see src/ai/enrichment-failure.ts),
   * replacing an earlier one; `attempts` counts failures since the last success.
   * A temporary failure also gets its retry time, failedAt + retryDelayMs(attempts),
   * computed in the same transaction as the new count. Returns the stored record.
   */
  recordAiEnrichmentFailure(
    failure: Omit<EnrichmentFailure, "attempts" | "nextRetryAt">,
    options: { retryDelayMs: (attempts: number) => number },
  ): Promise<EnrichmentFailure>;

  /** The item's latest enrichment failure, if it has one. */
  getAiEnrichmentFailure(itemId: ArchiveItemId): Promise<EnrichmentFailure | undefined>;

  /** Forget the item's enrichment failure (after a success). */
  clearAiEnrichmentFailure(itemId: ArchiveItemId): Promise<void>;

  /** Insert or replace the item's single curated organization. */
  saveCuratedOrganization(curated: CuratedOrganization): Promise<void>;

  getArchiveItem(id: ArchiveItemId): Promise<ArchiveItem | undefined>;

  /**
   * The item with its sources, media, AI suggestions and curation.
   * @throws PersistenceIntegrityError if the item has no source records.
   */
  getArchiveItemAggregate(id: ArchiveItemId): Promise<ArchiveItemAggregate | undefined>;

  findArchiveItemByIdentity(
    ownerId: UserId,
    identity: InstagramIdentity,
  ): Promise<ArchiveItem | undefined>;

  /**
   * Create a retrieval request unless the item already has one (whatever its
   * status). Returns whether it was created.
   */
  enqueueMediaRetrieval(request: MediaRetrievalRequest): Promise<boolean>;

  /** Insert or replace the item's request (a state transition). */
  saveMediaRetrievalRequest(request: MediaRetrievalRequest): Promise<void>;

  getMediaRetrievalRequest(itemId: ArchiveItemId): Promise<MediaRetrievalRequest | undefined>;

  /**
   * Requests due at `now` (see isDue): highest priority first, then by
   * `order`: the longest-waiting (default), or the newest item (latest
   * save/like/DM date). Optionally only one owner's items, only priorities
   * up to `maxPriority`, and only items with a source record of one of
   * `sources` (e.g. MAIN_ARCHIVE_SOURCES).
   */
  listDueMediaRetrievals(
    now: string,
    limit?: number,
    options?: { ownerId?: UserId; maxPriority?: number; order?: "waiting" | "newest"; sources?: readonly SourceKind[] },
  ): Promise<MediaRetrievalRequest[]>;

  /**
   * Items of an owner that may need AI enrichment, newest first (latest
   * save/like/DM date), with what enrichment needs to choose among them:
   * items with no AI organization yet, and items with media stored after
   * their newest AI organization was created (see latestOrganization).
   * With `sources`, only items with at least one source record of those kinds.
   * Each carries its enrichment priority (see AiEnrichmentCandidate.priority).
   */
  listAiEnrichmentCandidates(
    ownerId: UserId,
    /**
     * `unclaimedAt`: leave out items another worker holds an active enrichment claim on at that time.
     * `excludeProviderRejected`: leave out items whose latest failure is provider_rejected.
     * `retryableAt`: leave out items whose temporary failure may not be retried yet at that time.
     */
    options?: { sources?: readonly SourceKind[]; unclaimedAt?: IsoDateTime; excludeProviderRejected?: boolean; retryableAt?: IsoDateTime },
  ): Promise<AiEnrichmentCandidate[]>;

  /**
   * Keyword search over the creator, caption and the item's organization
   * (the curated one if reviewed, else the latest AI suggestion): type,
   * category, tags, summary and usefulFor. Case-insensitive, with American
   * spellings and light singular forms; terms match the start of words, and
   * short terms whole words only (see planSearch). Ranking, in order: how
   * many distinct query terms match (coverage; generic words like "ideas"
   * only when the query has nothing else, usefulFor never), whether
   * neighbouring terms occur together as a phrase, the score (each term's
   * best field weight, summed), how many fields matched (corroboration),
   * then most recent. AI fields assist but cannot, through generic words or
   * boilerplate, outrank a more complete or stronger literal match.
   * Only items with a source record of one of `sources` are searched.
   * An empty query, or one of only common words, matches nothing.
   */
  searchArchiveItems(
    ownerId: UserId,
    query: string,
    options: { sources: readonly SourceKind[]; limit?: number; offset?: number },
  ): Promise<{ total: number; hits: ArchiveSearchHit[] }>;

  /**
   * Number of retrieval requests per status; optionally only one owner's
   * items and only items with a source record of one of `sources`.
   */
  countMediaRetrievalsByStatus(
    options?: { ownerId?: UserId; sources?: readonly SourceKind[] },
  ): Promise<Record<MediaRetrievalRequest["status"], number>>;

  /**
   * Newest first: by `createdAt` (default), or with `order: "recent"` by the
   * latest save/like/DM date (items without one last). Ties by id.
   * With `sources`, only items with at least one source record of those
   * kinds (e.g. MAIN_ARCHIVE_SOURCES for the main archive).
   */
  listArchiveItems(
    ownerId: UserId,
    page?: { limit?: number; offset?: number; order?: "created" | "recent"; sources?: readonly SourceKind[] },
  ): Promise<ArchiveItem[]>;

  /**
   * The ids of all of an owner's items, by id: cheap enough to choose among
   * the whole archive (e.g. Shuffle) without loading the items themselves.
   * With `sources`, only items with at least one source record of those kinds.
   */
  listArchiveItemIds(ownerId: UserId, options?: { sources?: readonly SourceKind[] }): Promise<ArchiveItemId[]>;
}

export type ArchiveSearchHit = {
  item: ArchiveItem;
  /** Sum over matched terms of the weight of each term's best field (see SEARCH_FIELD_WEIGHTS). */
  score: number;
  /** Sum over neighbouring query-term pairs of the weight of the best field they occur in together (see PHRASE_FIELD_WEIGHTS). */
  phraseScore: number;
  /** How many distinct query terms matched in a field that counts toward coverage. */
  matchedTerms: number;
  /** How many distinct query terms matched the item's organization (ORGANIZATION_SEARCH_FIELDS). */
  organizationTerms: number;
  matchedFields: SearchField[];
};

export type AiEnrichmentCandidate = {
  itemId: ArchiveItemId;
  kind: ArchiveItem["kind"];
  /** Distinct source kinds, sorted (e.g. ["liked", "messages"]). */
  sources: SourceRecord["source"][];
  latestAt?: string;
  creatorUsername?: string;
  hasCaption: boolean;
  hasStoredMedia: boolean;
  /**
   * The item's newest AI organization, when it has one (then media has been
   * stored since it was created). Callers decide whether that warrants
   * re-enrichment, e.g. only when it was made without media.
   */
  latestOrganization?: { promptVersion: string; createdAt: string };
  /**
   * "new": the item has a source record (of the requested kinds) imported
   * after the owner's first import, i.e. a capture that arrived after the
   * initial historical import. "backfill": everything from that first import.
   * Derived from source records' importedAt; nothing is stored.
   */
  priority: "new" | "backfill";
};

/** Another item already holds this (ownerId, identity). */
export class ArchiveIdentityConflictError extends Error {
  override name = "ArchiveIdentityConflictError";
}

/** Stored data breaks a domain invariant, or a write would. */
export class PersistenceIntegrityError extends Error {
  override name = "PersistenceIntegrityError";
}
