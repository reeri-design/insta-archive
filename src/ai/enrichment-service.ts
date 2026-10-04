/**
 * AI enrichment: ArchiveItem + already-stored media → provider → validated
 * AiOrganization (appended, immutable). Never downloads media, and never
 * writes original metadata, curation or anything else about the item.
 * Which items need it, including media-aware re-enrichment of items first
 * organized without media, is decided by enrichmentNeed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AiOrganization,
  AiOrganizationId,
  ArchiveItemAggregate,
  ArchiveItemId,
  IsoDateTime,
  MediaAsset,
} from "../domain/archive-item.ts";
import type { FrameExtractor } from "../media/instagram/reel-media.ts";
import type { MediaStorage } from "../media/media-storage.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import {
  AiProviderError,
  type AiImageInput,
  type AiProviderErrorKind,
  type OrganizationProvider,
} from "./organization-provider.ts";
import {
  buildOrganizationContent,
  ORGANIZATION_INSTRUCTIONS,
  promptVersionFor,
  type MediaSummary,
} from "./organization-prompt.ts";
import { ORGANIZATION_OUTPUT_SCHEMA, TAXONOMY_VERSION, validateOrganizationOutput } from "./organization-schema.ts";
import { enrichmentNeed } from "./enrichment-eligibility.ts";

/**
 * Images per request, and size limits that stay well inside provider limits.
 * The total is raw bytes: base64 adds a third, so 12 MB stays under request
 * limits as low as 20 MB (Gemini) with room for the text.
 */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_TOTAL_IMAGE_BYTES = 12_000_000;
/** Interval for sampling a stored Reel video for the model (not stored). */
const VIDEO_SAMPLE_INTERVAL_MS = 4_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type EnrichmentResult =
  | {
      status: "enriched";
      itemId: ArchiveItemId;
      /** A media-aware organization added because media arrived after a metadata-only one. */
      reenriched: boolean;
      organization: AiOrganization;
      mediaUsed: boolean;
      imageCount: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { status: "skipped"; itemId: ArchiveItemId; reason: string }
  | { status: "failed"; itemId: ArchiveItemId; kind: AiProviderErrorKind | "invalid_output"; reason: string };

export type AiEnrichmentServiceOptions = {
  repository: ArchiveRepository;
  storage: MediaStorage;
  provider: OrganizationProvider;
  /** Samples frames from a stored Reel video so the model can see it. */
  frameExtractor?: FrameExtractor;
  tempRoot?: string;
  now?: () => IsoDateTime;
};

export class AiEnrichmentService {
  private readonly options: AiEnrichmentServiceOptions;

  constructor(options: AiEnrichmentServiceOptions) {
    this.options = options;
  }

  /** Whether the provider can take an image of this type. */
  private accepts(mimeType: string): mimeType is AiImageInput["mimeType"] {
    const supported = this.options.provider.supportedImageTypes;
    return IMAGE_TYPES.has(mimeType) && (!supported || (supported as readonly string[]).includes(mimeType));
  }

  async enrich(itemId: ArchiveItemId): Promise<EnrichmentResult> {
    const { repository, provider } = this.options;
    const aggregate = await repository.getArchiveItemAggregate(itemId);
    if (!aggregate) throw new Error(`Unknown archive item ${itemId}`);
    const need = enrichmentNeed(aggregate);
    if (!need.eligible) return { status: "skipped", itemId, reason: need.reason };

    const { images, summary } = await this.collectImages(aggregate);
    if (need.reason === "media_added" && images.length === 0) {
      // Redoing it from metadata alone would only repeat the existing organization.
      return { status: "skipped", itemId, reason: "media stored since the last organization is not usable by the AI" };
    }
    if (images.length === 0 && !aggregate.item.original.caption?.value.trim()) {
      return { status: "skipped", itemId, reason: "no caption or stored media to classify" };
    }

    let response;
    try {
      response = await provider.organize({
        instructions: ORGANIZATION_INSTRUCTIONS,
        content: buildOrganizationContent(aggregate, summary),
        images,
        outputSchema: ORGANIZATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      });
    } catch (error) {
      const kind = error instanceof AiProviderError ? error.kind : "provider_error";
      return { status: "failed", itemId, kind, reason: error instanceof Error ? error.message : String(error) };
    }

    const validated = validateOrganizationOutput(response.output);
    if (!validated.ok) {
      return { status: "failed", itemId, kind: "invalid_output", reason: validated.errors.join("; ") };
    }

    const createdAt = (this.options.now ?? (() => new Date().toISOString()))();
    const organization: AiOrganization = {
      id: `${itemId}:ai:${createdAt}` as AiOrganizationId,
      archiveItemId: itemId,
      fields: validated.value.fields,
      confidence: validated.value.confidence,
      taxonomyVersion: TAXONOMY_VERSION,
      provider: provider.provider,
      model: response.model,
      promptVersion: promptVersionFor(summary),
      createdAt,
    };
    // Appended, never replacing the earlier one; the newest is the effective AI organization.
    await repository.appendAiOrganization(organization);
    return {
      status: "enriched",
      itemId,
      reenriched: need.reason === "media_added",
      organization,
      mediaUsed: images.length > 0,
      imageCount: images.length,
      ...(response.usage && { usage: response.usage }),
    };
  }

  /**
   * Stored media as images, in viewing order: content images (carousel slides
   * by position), else frames already stored for a frames-only Reel, else a
   * few frames sampled from a stored Reel video into a temp dir (not kept).
   */
  private async collectImages(aggregate: ArchiveItemAggregate): Promise<{ images: AiImageInput[]; summary: MediaSummary }> {
    const stored = (m: MediaAsset) => m.retrieval.status === "stored";
    const contentImages = aggregate.media
      .filter((m): m is Extract<MediaAsset, { role: "content" }> => m.role === "content" && m.mediaType === "image" && stored(m))
      .sort((a, b) => a.position - b.position);
    if (contentImages.length > 0) {
      const { images, included } = await this.loadImages(contentImages);
      const total = contentImages.length;
      const firstN = included.every((index, i) => index === i);
      const description = total === 1
        ? "1 image attached (the post's image)."
        : firstN
          ? `${images.length} images attached: carousel slides 1–${images.length} of ${total}, in order.`
          : `${images.length} of the ${total} carousel slides attached (slides ${included.map((i) => i + 1).join(", ")}), in order.`;
      return images.length ? { images, summary: { kind: "images", count: images.length, description } } : none();
    }

    const frames = aggregate.media
      .filter((m): m is Extract<MediaAsset, { role: "derived_frame" }> => m.role === "derived_frame" && stored(m))
      .sort((a, b) => a.frameTimeMs - b.frameTimeMs);
    if (frames.length > 0) {
      const picked = evenly(frames, MAX_IMAGES);
      const { images } = await this.loadImages(picked);
      const times = picked.map((f) => `${(f.frameTimeMs / 1000).toFixed(1)}s`).join(", ");
      return images.length
        ? { images, summary: { kind: "images", count: images.length, description: `${images.length} frames from the video, in time order (at ${times}).` } }
        : none();
    }

    const video = aggregate.media.find((m) => m.role === "content" && m.mediaType === "video" && stored(m));
    if (video && video.retrieval.status === "stored" && this.options.frameExtractor) {
      return this.sampleVideo(video.retrieval.storageKey);
    }
    return none();
  }

  private async sampleVideo(storageKey: string): Promise<{ images: AiImageInput[]; summary: MediaSummary }> {
    const extractor = this.options.frameExtractor;
    if (!extractor) return none();
    const dir = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "insta-archive-ai-"));
    try {
      const videoPath = join(dir, "video.mp4");
      await writeFile(videoPath, await this.options.storage.read(storageKey));
      const extracted = evenly(await extractor.extract(videoPath, join(dir, "frames"), VIDEO_SAMPLE_INTERVAL_MS), MAX_IMAGES);
      const images: AiImageInput[] = [];
      for (const frame of extracted) {
        if (!this.accepts(frame.mimeType)) continue;
        images.push({ mimeType: frame.mimeType, bytes: new Uint8Array(await readFile(frame.path)) });
      }
      const times = extracted.map((f) => `${(f.frameTimeMs / 1000).toFixed(1)}s`).join(", ");
      return images.length
        ? { images, summary: { kind: "images", count: images.length, description: `${images.length} frames sampled from the video, in time order (at ${times}).` } }
        : none();
    } catch {
      // Media is optional for enrichment: fall back to metadata only.
      return none();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Reads stored images up to the count and size limits, skipping unusable
   * ones (unsupported type, missing file, too large). `included` holds the
   * indexes of the assets that made it in.
   */
  private async loadImages(assets: MediaAsset[]): Promise<{ images: AiImageInput[]; included: number[] }> {
    const images: AiImageInput[] = [];
    const included: number[] = [];
    let total = 0;
    for (const [index, asset] of assets.entries()) {
      if (images.length >= MAX_IMAGES) break;
      if (asset.retrieval.status !== "stored" || !this.accepts(asset.retrieval.mimeType)) continue;
      let bytes: Uint8Array;
      try {
        bytes = await this.options.storage.read(asset.retrieval.storageKey);
      } catch {
        continue;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES || total + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) continue;
      total += bytes.byteLength;
      images.push({ mimeType: asset.retrieval.mimeType, bytes });
      included.push(index);
    }
    return { images, included };
  }
}

function none(): { images: AiImageInput[]; summary: MediaSummary } {
  return { images: [], summary: { kind: "none" } };
}

/** Up to `max` items spread evenly, keeping the first and last. */
function evenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))] as T);
}
