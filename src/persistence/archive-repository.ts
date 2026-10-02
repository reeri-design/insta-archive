import type {
  AiOrganization,
  ArchiveItem,
  ArchiveItemAggregate,
  ArchiveItemId,
  CuratedOrganization,
  InstagramIdentity,
  MediaAsset,
  OriginalMetadata,
  SourceRecord,
  UserId,
} from "../domain/archive-item.ts";
import type { MediaRetrievalRequest } from "../domain/media-retrieval.ts";

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

  /** Add a new AI suggestion. Existing suggestions can never be modified. */
  appendAiOrganization(suggestion: AiOrganization): Promise<void>;

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
   * Requests due at `now` (see isDue): highest priority first, then the
   * longest-waiting.
   */
  listDueMediaRetrievals(now: string, limit?: number): Promise<MediaRetrievalRequest[]>;

  /** Newest first (createdAt, then id). */
  listArchiveItems(
    ownerId: UserId,
    page?: { limit?: number; offset?: number },
  ): Promise<ArchiveItem[]>;
}

/** Another item already holds this (ownerId, identity). */
export class ArchiveIdentityConflictError extends Error {
  override name = "ArchiveIdentityConflictError";
}

/** Stored data breaks a domain invariant, or a write would. */
export class PersistenceIntegrityError extends Error {
  override name = "PersistenceIntegrityError";
}
