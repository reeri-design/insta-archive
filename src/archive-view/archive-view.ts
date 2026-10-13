/**
 * Read models and actions for the archive UI, on top of ArchiveRepository and
 * MediaStorage. Framework-free: the Next.js app calls these from the server;
 * React components never touch the database or storage.
 */
import type {
  AiOrganization,
  ArchiveItem,
  ArchiveItemAggregate,
  Creator,
  CuratedOrganization,
  InstagramIdentity,
  IsoDateTime,
  MediaAsset,
  ReviewStatus,
  SourceKind,
  UserId,
} from "../domain/archive-item.ts";
import { reviewStatusOf } from "../domain/archive-item.ts";
import { isInMainArchive, MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import type { MediaRetrievalRequest } from "../domain/media-retrieval.ts";
import type { MediaStorage } from "../media/media-storage.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import type { SearchField } from "../search/search-query.ts";
import { buildCuratedOrganization, parseReviewInput, type ReviewInput } from "./review.ts";
import { randomSeed, shuffleSelection } from "./shuffle.ts";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** The URL key for an item: its shortcode, or "u~" + the base64url-encoded URL. */
export function itemKey(identity: InstagramIdentity): string {
  return identity.kind === "shortcode"
    ? identity.shortcode
    : `u~${Buffer.from(identity.normalizedUrl).toString("base64url")}`;
}

export function identityFromKey(key: string): InstagramIdentity | undefined {
  if (key.startsWith("u~")) {
    const normalizedUrl = Buffer.from(key.slice(2), "base64url").toString();
    return normalizedUrl ? { kind: "url", normalizedUrl } : undefined;
  }
  return /^[A-Za-z0-9_-]+$/.test(key) ? { kind: "shortcode", shortcode: key } : undefined;
}

export function itemHref(item: ArchiveItem): string {
  return `/items/${itemKey(item.identity)}`;
}

/** The media route for one of the item's assets (keyed by the id's suffix after the item id). */
export function mediaHref(item: ArchiveItem, asset: MediaAsset): string {
  const suffix = asset.id.startsWith(`${item.id}:`) ? asset.id.slice(item.id.length + 1) : asset.id;
  return `${itemHref(item)}/media/${encodeURIComponent(suffix)}`;
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

export type MediaPreview = {
  mediaType: "image" | "video";
  url: string;
  /** Stored pixel size, when recorded; lets the library keep the natural aspect ratio. */
  width?: number;
  height?: number;
  /** The post's cover image (a Reel whose video could not be retrieved). */
  cover?: boolean;
};

/**
 * What the library can say about an item's media: shown, not retrieved yet,
 * retrieval failed (will be retried), or not obtainable. Derived from the
 * item's assets and retrieval request; nothing new is stored.
 */
export type MediaState = "available" | "pending" | "failed" | "unavailable";

/**
 * Media Focus can show, in order: the stored post media (slides, image or
 * video); else frames kept from a Reel's video; else the post's cover image.
 */
export type ViewableMedia = {
  mediaType: "image" | "video";
  url: string;
  width?: number;
  height?: number;
  role: "content" | "frame" | "cover";
};

export type ArchiveCard = {
  /** The item's URL key (see itemKey). */
  key: string;
  href: string;
  kind: ArchiveItem["kind"];
  creator?: Creator;
  caption?: string;
  /** Latest save/like/DM date. */
  latestAt?: IsoDateTime;
  sources: SourceKind[];
  preview?: MediaPreview;
  /** Stored content assets (e.g. carousel slides). */
  storedMediaCount: number;
  reviewStatus: ReviewStatus;
  /** Type and category from the curated organization, else the latest AI suggestion. */
  organization?: { type?: string; category?: string };
  /** For search results: the fields the query matched. */
  matchedFields?: SearchField[];
  mediaState: MediaState;
  viewable: ViewableMedia[];
  /** The original post on its source (e.g. its Instagram URL). */
  sourceUrl: string;
};

export const DEFAULT_PAGE_SIZE = 60;

/** One page of the main archive (Saved + Messages), most recently saved/liked/sent first. */
export async function listArchiveCards(
  repository: ArchiveRepository,
  ownerId: UserId,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ cards: ArchiveCard[]; page: number; hasNext: boolean }> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const items = await repository.listArchiveItems(ownerId, {
    order: "recent",
    sources: MAIN_ARCHIVE_SOURCES,
    limit: pageSize + 1,
    offset: (page - 1) * pageSize,
  });
  const cards: ArchiveCard[] = [];
  for (const item of items.slice(0, pageSize)) {
    const aggregate = await repository.getArchiveItemAggregate(item.id);
    if (aggregate) cards.push(toCard(aggregate, await repository.getMediaRetrievalRequest(item.id)));
  }
  return { cards, page, hasNext: items.length > pageSize };
}

/**
 * One page of main-archive items matching a keyword query, best matches
 * first (see ArchiveRepository.searchArchiveItems). No AI is called.
 */
export async function searchArchiveCards(
  repository: ArchiveRepository,
  ownerId: UserId,
  query: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ cards: ArchiveCard[]; page: number; hasNext: boolean; total: number }> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const { total, hits } = await repository.searchArchiveItems(ownerId, query, {
    sources: MAIN_ARCHIVE_SOURCES,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const cards: ArchiveCard[] = [];
  for (const hit of hits) {
    const aggregate = await repository.getArchiveItemAggregate(hit.item.id);
    if (aggregate) {
      const request = await repository.getMediaRetrievalRequest(hit.item.id);
      cards.push({ ...toCard(aggregate, request), matchedFields: hit.matchedFields });
    }
  }
  return { cards, page, hasNext: page * pageSize < total, total };
}

/**
 * A Shuffle selection of the main archive (see shuffle.ts), in its shuffled
 * order: a fresh one per call unless `seed` is given. Only the ids of the
 * whole archive are read; cards are built for the chosen items alone.
 */
export async function listShuffledArchiveCards(
  repository: ArchiveRepository,
  ownerId: UserId,
  options: { seed?: string; size?: number } = {},
): Promise<ArchiveCard[]> {
  const ids = await repository.listArchiveItemIds(ownerId, { sources: MAIN_ARCHIVE_SOURCES });
  const cards: ArchiveCard[] = [];
  for (const id of shuffleSelection(ids, options.seed ?? randomSeed(), options.size)) {
    const aggregate = await repository.getArchiveItemAggregate(id);
    if (aggregate) cards.push(toCard(aggregate, await repository.getMediaRetrievalRequest(id)));
  }
  return cards;
}

/** One main-archive item as a card, by its URL key (e.g. to focus an item that is not on the current page). */
export async function getArchiveCard(
  repository: ArchiveRepository,
  ownerId: UserId,
  key: string,
): Promise<ArchiveCard | undefined> {
  const aggregate = await findAggregate(repository, ownerId, key);
  return aggregate && toCard(aggregate, await repository.getMediaRetrievalRequest(aggregate.item.id));
}

function toCard(aggregate: ArchiveItemAggregate, request: MediaRetrievalRequest | undefined): ArchiveCard {
  const { item } = aggregate;
  const latestAt = aggregate.sources
    .map((s) => s.occurredAt)
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1);
  const preview = previewOf(aggregate);
  const fields = aggregate.curated?.fields ?? latestSuggestion(aggregate)?.fields;
  return {
    key: itemKey(item.identity),
    href: itemHref(item),
    kind: item.kind,
    ...(item.original.creator && { creator: item.original.creator.value }),
    ...(item.original.caption && { caption: item.original.caption.value }),
    ...(latestAt && { latestAt }),
    sources: [...new Set(aggregate.sources.map((s) => s.source))].sort(),
    ...(preview && { preview }),
    storedMediaCount: storedContent(aggregate).length,
    reviewStatus: reviewStatusOf(aggregate),
    mediaState: mediaStateOf(preview, request),
    viewable: viewableOf(aggregate),
    sourceUrl: item.canonicalUrl,
    ...(fields && {
      organization: { ...(fields.type && { type: fields.type }), ...(fields.category && { category: fields.category }) },
    }),
  };
}

/** The first stored image (slide or post), else the first stored frame, else the cover image, else a stored video. */
function previewOf(aggregate: ArchiveItemAggregate): MediaPreview | undefined {
  const content = storedContent(aggregate);
  const image = content.find((m) => m.mediaType === "image") ?? storedFrames(aggregate)[0] ?? storedCover(aggregate);
  const asset = image ?? content.find((m) => m.mediaType === "video");
  if (!asset || asset.retrieval.status !== "stored") return undefined;
  const { width, height } = asset.retrieval;
  return {
    mediaType: image ? "image" : "video",
    url: mediaHref(aggregate.item, asset),
    ...(width !== undefined && height !== undefined && { width, height }),
    ...(asset.role === "cover" && { cover: true }),
  };
}

function viewableOf(aggregate: ArchiveItemAggregate): ViewableMedia[] {
  const content = storedContent(aggregate);
  const frames = storedFrames(aggregate);
  const cover = storedCover(aggregate);
  const chosen: { asset: MediaAsset; role: ViewableMedia["role"] }[] =
    content.length > 0
      ? content.map((asset) => ({ asset, role: "content" }))
      : frames.length > 0
        ? frames.map((asset) => ({ asset, role: "frame" }))
        : cover
          ? [{ asset: cover, role: "cover" }]
          : [];
  return chosen.flatMap(({ asset, role }) => {
    if (asset.retrieval.status !== "stored") return [];
    const { width, height } = asset.retrieval;
    return [
      {
        mediaType: asset.mediaType,
        url: mediaHref(aggregate.item, asset),
        ...(width !== undefined && height !== undefined && { width, height }),
        role,
      },
    ];
  });
}

/** Shown if there is a preview; otherwise what the retrieval request says (no request yet counts as pending). */
function mediaStateOf(preview: MediaPreview | undefined, request: MediaRetrievalRequest | undefined): MediaState {
  if (preview) return "available";
  if (!request || request.status === "pending") return "pending";
  if (request.status === "failed") return "failed";
  // "unavailable", or "stored" with nothing previewable (e.g. only unsupported video slides).
  return "unavailable";
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type DisplayMedia = {
  mediaType: "image" | "video";
  url: string;
  /** Slide position, or frame time in ms for derived frames. */
  position?: number;
  frameTimeMs?: number;
};

export type ItemDetail = {
  aggregate: ArchiveItemAggregate;
  /** Stored post media in order (images and videos). */
  media: DisplayMedia[];
  /** Stored frames derived from a Reel's video, in time order. */
  frames: DisplayMedia[];
  /** The post's published cover image, when stored (e.g. a Reel whose video was withheld). */
  cover?: DisplayMedia;
  /** Assets that are not stored, with their status, e.g. "failed". */
  missingMedia: { position?: number; mediaType: "image" | "video"; status: string }[];
  /** The newest AI suggestion (suggestions are never edited). */
  suggestion?: AiOrganization;
  reviewStatus: ReviewStatus;
};

export async function getItemDetail(
  repository: ArchiveRepository,
  ownerId: UserId,
  key: string,
): Promise<ItemDetail | undefined> {
  const aggregate = await findAggregate(repository, ownerId, key);
  if (!aggregate) return undefined;
  const { item } = aggregate;
  const suggestion = latestSuggestion(aggregate);
  const cover = storedCover(aggregate);
  return {
    aggregate,
    ...(cover && { cover: { mediaType: "image" as const, url: mediaHref(item, cover) } }),
    media: storedContent(aggregate).map((m) => ({ mediaType: m.mediaType, url: mediaHref(item, m), position: m.position })),
    frames: storedFrames(aggregate).map((m) => ({ mediaType: m.mediaType, url: mediaHref(item, m), frameTimeMs: m.frameTimeMs })),
    missingMedia: aggregate.media
      .filter((m) => m.retrieval.status !== "stored")
      .map((m) => ({ ...(m.role === "content" && { position: m.position }), mediaType: m.mediaType, status: m.retrieval.status })),
    ...(suggestion && { suggestion }),
    reviewStatus: reviewStatusOf(aggregate),
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Saves reviewed fields as the item's CuratedOrganization (replacing an
 * earlier review). AI suggestions are left exactly as they are.
 * @throws ReviewInputError for unusable input; Error if the item is not found.
 */
export async function saveItemReview(
  repository: ArchiveRepository,
  ownerId: UserId,
  key: string,
  input: ReviewInput,
  now: IsoDateTime,
): Promise<CuratedOrganization> {
  const aggregate = await findAggregate(repository, ownerId, key);
  if (!aggregate) throw new Error(`No archive item ${key}`);
  const suggestion = latestSuggestion(aggregate);
  const curated = buildCuratedOrganization({
    archiveItemId: aggregate.item.id,
    fields: parseReviewInput(input),
    ...(suggestion && { suggestion }),
    reviewedBy: ownerId,
    reviewedAt: now,
  });
  await repository.saveCuratedOrganization(curated);
  return curated;
}

// ---------------------------------------------------------------------------
// Media bytes
// ---------------------------------------------------------------------------

/** The stored bytes of one of the owner's item assets, if stored. */
export async function readItemMedia(
  repository: ArchiveRepository,
  storage: MediaStorage,
  ownerId: UserId,
  key: string,
  assetKey: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  const aggregate = await findAggregate(repository, ownerId, key);
  if (!aggregate) return undefined;
  // Accept the suffix raw or still percent-encoded; the id must match exactly.
  const candidates = new Set([assetKey, safeDecode(assetKey)].map((suffix) => `${aggregate.item.id}:${suffix}`));
  const asset = aggregate.media.find((m) => candidates.has(m.id));
  if (asset?.retrieval.status !== "stored") return undefined;
  return { bytes: await storage.read(asset.retrieval.storageKey), mimeType: asset.retrieval.mimeType };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The owner's item for a route key, if it is in the main archive. */
async function findAggregate(repository: ArchiveRepository, ownerId: UserId, key: string) {
  const identity = identityFromKey(key);
  const item = identity && (await repository.findArchiveItemByIdentity(ownerId, identity));
  const aggregate = item && (await repository.getArchiveItemAggregate(item.id));
  return aggregate && isInMainArchive(aggregate.sources) ? aggregate : undefined;
}

function latestSuggestion(aggregate: ArchiveItemAggregate): AiOrganization | undefined {
  return aggregate.aiSuggestions.at(-1);
}

function storedContent(aggregate: ArchiveItemAggregate) {
  return aggregate.media
    .filter((m): m is Extract<MediaAsset, { role: "content" }> => m.role === "content" && m.retrieval.status === "stored")
    .sort((a, b) => a.position - b.position);
}

function storedCover(aggregate: ArchiveItemAggregate) {
  return aggregate.media.find((m) => m.role === "cover" && m.retrieval.status === "stored");
}

function storedFrames(aggregate: ArchiveItemAggregate) {
  return aggregate.media
    .filter((m): m is Extract<MediaAsset, { role: "derived_frame" }> => m.role === "derived_frame" && m.retrieval.status === "stored")
    .sort((a, b) => a.frameTimeMs - b.frameTimeMs);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
