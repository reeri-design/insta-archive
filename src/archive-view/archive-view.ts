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
import type { MediaStorage } from "../media/media-storage.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import type { SearchField } from "../search/search-query.ts";
import { buildCuratedOrganization, parseReviewInput, type ReviewInput } from "./review.ts";

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

export type MediaPreview = { mediaType: "image" | "video"; url: string };

export type ArchiveCard = {
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
    if (aggregate) cards.push(toCard(aggregate));
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
    if (aggregate) cards.push({ ...toCard(aggregate), matchedFields: hit.matchedFields });
  }
  return { cards, page, hasNext: page * pageSize < total, total };
}

function toCard(aggregate: ArchiveItemAggregate): ArchiveCard {
  const { item } = aggregate;
  const latestAt = aggregate.sources
    .map((s) => s.occurredAt)
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1);
  const preview = previewOf(aggregate);
  const fields = aggregate.curated?.fields ?? latestSuggestion(aggregate)?.fields;
  return {
    href: itemHref(item),
    kind: item.kind,
    ...(item.original.creator && { creator: item.original.creator.value }),
    ...(item.original.caption && { caption: item.original.caption.value }),
    ...(latestAt && { latestAt }),
    sources: [...new Set(aggregate.sources.map((s) => s.source))].sort(),
    ...(preview && { preview }),
    storedMediaCount: storedContent(aggregate).length,
    reviewStatus: reviewStatusOf(aggregate),
    ...(fields && {
      organization: { ...(fields.type && { type: fields.type }), ...(fields.category && { category: fields.category }) },
    }),
  };
}

/** The first stored image (slide or post), else the first stored frame, else a stored video. */
function previewOf(aggregate: ArchiveItemAggregate): MediaPreview | undefined {
  const content = storedContent(aggregate);
  const image = content.find((m) => m.mediaType === "image") ?? storedFrames(aggregate)[0];
  if (image) return { mediaType: "image", url: mediaHref(aggregate.item, image) };
  const video = content.find((m) => m.mediaType === "video");
  return video && { mediaType: "video", url: mediaHref(aggregate.item, video) };
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
  return {
    aggregate,
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
