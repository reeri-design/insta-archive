/**
 * Core domain model for Insta Archive.
 *
 * Pure types only: no persistence, parsing or I/O. See docs/domain-model.md
 * for how the entities relate.
 *
 * Layering (never mixed):
 *   SourceRecord        verbatim facts from the Instagram export (source of truth)
 *   OriginalMetadata    resolved original post facts, each with provenance
 *   MediaAsset          retrieved (or unretrievable) media, ordered
 *   AiOrganization      machine suggestions, immutable, never overwrite the above
 *   CuratedOrganization the human-approved/edited organization
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string, e.g. "2025-03-14T09:26:53.000Z". */
export type IsoDateTime = string;

type Id<Brand extends string> = string & { readonly __brand: Brand };

export type UserId = Id<"UserId">;
export type ArchiveItemId = Id<"ArchiveItemId">;
export type SourceRecordId = Id<"SourceRecordId">;
export type MediaAssetId = Id<"MediaAssetId">;
export type AiOrganizationId = Id<"AiOrganizationId">;

/** At least one element. */
export type NonEmptyArray<T> = [T, ...T[]];

// ---------------------------------------------------------------------------
// Identity & deduplication
// ---------------------------------------------------------------------------

/**
 * Stable identity of the Instagram content an item represents. This is the
 * deduplication key: sources resolving to the same identity (for the same
 * owner) attach to the same ArchiveItem.
 *
 * `/p/X`, `/reel/X` and `/tv/X` share one shortcode namespace, so the
 * shortcode alone identifies the post regardless of URL form. When no
 * shortcode can be extracted we fall back to a normalized URL.
 */
export type InstagramIdentity =
  | { kind: "shortcode"; shortcode: string }
  | { kind: "url"; normalizedUrl: string };

// ---------------------------------------------------------------------------
// Archive item (canonical aggregate root)
// ---------------------------------------------------------------------------

/**
 * What kind of Instagram content this is. "unknown" is valid: the export often
 * only gives a URL, and carousel-ness may only be learned from retrieval.
 */
export type ArchiveItemKind = "post" | "reel" | "carousel" | "unknown";

export type ArchiveItem = {
  id: ArchiveItemId;
  /** Owner of this archive entry. Single user today; explicit for later. */
  ownerId: UserId;
  identity: InstagramIdentity;
  kind: ArchiveItemKind;
  /**
   * Canonical Instagram URL for this content. Each SourceRecord separately
   * keeps the exact URL string found in the export.
   */
  canonicalUrl: string;
  original: OriginalMetadata;
  /** Archive bookkeeping (not Instagram timestamps). */
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

// ---------------------------------------------------------------------------
// Sources (verbatim export facts)
// ---------------------------------------------------------------------------

/** Which part of the Instagram export an item was found in. */
export type SourceKind = "messages" | "saved" | "liked";

/**
 * One occurrence of an item in the export. An ArchiveItem has one or more of
 * these; the same post saved, liked and shared in DMs yields three records.
 * Records are written by the importer and never modified by AI or review.
 */
export type SourceRecord = {
  id: SourceRecordId;
  archiveItemId: ArchiveItemId;
  source: SourceKind;
  /** URL exactly as it appears in the export (not normalized). */
  originalUrl: string;
  /**
   * When the user saved / liked / sent it, per the export. Optional because
   * not every export entry carries a usable timestamp.
   */
  occurredAt?: IsoDateTime;
  /** Creator as named in this export entry, if present. */
  creator?: Creator;
  /** Caption / share text the export attached to the content, verbatim. */
  sharedText?: string;
  /** Present only for `source: "messages"`. */
  message?: MessageContext;
  /** Where in the export this came from, for traceability and re-import. */
  exportLocation: ExportLocation;
  /** The untouched export JSON fragment for this entry. */
  raw: unknown;
  importedAt: IsoDateTime;
};

export type MessageContext = {
  /** Export conversation folder / thread identifier. */
  threadId?: string;
  threadTitle?: string;
  /** Display name of the sender, as the export writes it. */
  senderName?: string;
  /** Whether the archive owner sent it. Unknown when it cannot be decided. */
  sentByOwner?: boolean;
  /**
   * What the user themselves wrote alongside the share. This is the user's
   * own context and is kept apart from both the post caption and any AI
   * interpretation. Only set from export data, never inferred.
   */
  userNote?: string;
};

export type ExportLocation = {
  /** Path of the JSON file inside the export, e.g. "your_instagram_activity/saved/saved_posts.json". */
  file: string;
  /** Pointer to the entry within that file (e.g. array index or JSON path). */
  pointer?: string;
  /** Identifies which export download this came from. */
  exportId?: string;
};

// ---------------------------------------------------------------------------
// Original metadata (resolved, with provenance)
// ---------------------------------------------------------------------------

export type Creator = {
  username?: string;
  displayName?: string;
  profileUrl?: string;
};

/**
 * Where a resolved original value came from. The export wins over retrieval;
 * retrieval only fills gaps the export leaves.
 */
export type Provenance =
  | { from: "export"; sourceRecordId: SourceRecordId }
  | { from: "retrieval"; retrievedAt: IsoDateTime };

export type Attributed<T> = { value: T; provenance: Provenance };

/**
 * Best-known original facts about the Instagram content, consolidated from
 * sources (and, secondarily, retrieval). Every field is optional because
 * Instagram does not always provide it. AI never writes here.
 */
export type OriginalMetadata = {
  creator?: Attributed<Creator>;
  caption?: Attributed<string>;
  /** When the creator published it, if known. */
  postedAt?: Attributed<IsoDateTime>;
};

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export type MediaType = "image" | "video";

/**
 * - `content`: an asset of the original post (the single image, a carousel
 *   slide, or a reel's video). Ordered by `position`.
 * - `derived_frame`: a frame extracted from the item's video. Frames are
 *   ordered chronologically by `frameTimeMs`.
 * - `cover`: the post's published cover image (for a Reel, the still the
 *   creator chose). At most one per item, always an image. It is neither the
 *   video nor a frame of it, and may differ from the video entirely (e.g. a
 *   designed title card). Stored when a Reel's video cannot be retrieved; the
 *   video's own `content` asset then records why it is missing.
 */
export type MediaAsset =
  | (MediaAssetBase & { role: "content"; position: number })
  | (MediaAssetBase & {
      role: "derived_frame";
      /**
       * The stored `content` video the frame came from. Absent when the frame
       * was derived from the Reel's retrieved video but that video was
       * intentionally not retained (frames-only experiment).
       */
      derivedFromAssetId?: MediaAssetId;
      /** Offset into the source video. */
      frameTimeMs: number;
    })
  | (MediaAssetBase & { role: "cover"; mediaType: "image" });

type MediaAssetBase = {
  id: MediaAssetId;
  archiveItemId: ArchiveItemId;
  mediaType: MediaType;
  retrieval: MediaRetrieval;
};

/**
 * Retrieval state. Anything but "stored" is a normal, valid state: an item
 * stays in the archive whether or not its media could be fetched.
 */
export type MediaRetrieval =
  | { status: "pending" }
  | {
      status: "stored";
      /** Key understood by the media storage boundary (not a raw path). */
      storageKey: string;
      mimeType: string;
      retrievedAt: IsoDateTime;
      width?: number;
      height?: number;
      durationMs?: number;
      /** Size of the stored bytes. */
      byteLength?: number;
      /**
       * The media this asset was derived from, when that media was not
       * retained (e.g. a Reel video replaced by frames).
       */
      derivedFrom?: {
        mimeType: string;
        byteLength: number;
        durationMs?: number;
        width?: number;
        height?: number;
      };
    }
  | {
      /** A transient failure; may be retried. */
      status: "failed";
      lastAttemptAt: IsoDateTime;
      attempts: number;
      error: string;
    }
  | {
      /** Known to be unobtainable (e.g. deleted or private). */
      status: "unavailable";
      checkedAt: IsoDateTime;
      reason: UnavailableReason;
      detail?: string;
    };

export type UnavailableReason =
  | "deleted"
  | "private"
  | "restricted"
  | "not_found"
  | "unknown";

// ---------------------------------------------------------------------------
// Organization (provisional taxonomy)
// ---------------------------------------------------------------------------

/**
 * Identifies the provisional taxonomy an organization was produced under, so
 * the taxonomy can evolve without guessing how older data was labelled.
 */
export type TaxonomyVersion = string;

/**
 * The organization fields under test. Deliberately free-form strings: no
 * fixed category/type lists until real retrieval experiments justify them.
 */
export type OrganizationFields = {
  /** Content type, e.g. "tutorial", "reference", "inspiration". */
  type?: string;
  category?: string;
  tags: string[];
  summary?: string;
  /** What the item could be useful for (not why the user saved it). */
  usefulFor: string[];
};

/**
 * One AI suggestion. Immutable once written; re-running AI adds a new
 * suggestion rather than editing an old one. Provider-neutral: `provider` is
 * a plain identifier, no vendor types.
 */
export type AiOrganization = {
  id: AiOrganizationId;
  archiveItemId: ArchiveItemId;
  fields: OrganizationFields;
  /** Model's self-reported confidence, 0..1. */
  confidence: number;
  taxonomyVersion: TaxonomyVersion;
  provider: string;
  model: string;
  /** Version of the prompt/pipeline that produced this. */
  promptVersion: string;
  createdAt: IsoDateTime;
};

/** How a curated field came to hold its value. */
export type FieldOrigin = "ai_accepted" | "human_edited" | "human_added";

/**
 * The organization a human has reviewed. Its presence means the item has
 * been reviewed; per-field origins show which values were accepted from AI
 * and which were edited by the user.
 */
export type CuratedOrganization = {
  archiveItemId: ArchiveItemId;
  fields: OrganizationFields;
  fieldOrigins: Partial<Record<keyof OrganizationFields, FieldOrigin>>;
  /** The suggestion that was reviewed, if any. */
  basedOnSuggestionId?: AiOrganizationId;
  taxonomyVersion: TaxonomyVersion;
  reviewedBy: UserId;
  reviewedAt: IsoDateTime;
};

export type ReviewStatus = "unorganized" | "ai_suggested" | "reviewed";

// ---------------------------------------------------------------------------
// Aggregate view
// ---------------------------------------------------------------------------

/** Everything known about one archive item, as loaded together. */
export type ArchiveItemAggregate = {
  item: ArchiveItem;
  /** Always at least one: every item comes from somewhere. */
  sources: NonEmptyArray<SourceRecord>;
  /** May be empty when media hasn't been (or can't be) retrieved. */
  media: MediaAsset[];
  /** Newest last. */
  aiSuggestions: AiOrganization[];
  curated?: CuratedOrganization;
};

export function reviewStatusOf(aggregate: ArchiveItemAggregate): ReviewStatus {
  if (aggregate.curated) return "reviewed";
  if (aggregate.aiSuggestions.length > 0) return "ai_suggested";
  return "unorganized";
}
