/**
 * SPIKE (Step 08B.2): retrieves every image slide of a public Instagram
 * carousel. Not production code: no videos/reels, login or rate limiting.
 *
 * How it works (as observed 2026-10):
 *  1. GET https://www.instagram.com/p/<shortcode>/embed/captioned/ (no login).
 *  2. The embed root must have data-media-type="GraphSidecar".
 *  3. The page embeds `"contextJSON":"<JSON string>"`; its
 *     gql_data.shortcode_media.edge_sidecar_to_children.edges lists the
 *     slides in post order, each with display_resources (renditions).
 *     (For single images this blob was null, which is why 08B.1 reads the
 *     <img srcset> instead.)
 *  4. For each slide, GET the widest rendition and return the bytes untouched,
 *     at position = slide index.
 *
 * Any slide that cannot be downloaded is reported as a temporary failure, so
 * the carousel is never recorded as completely stored with slides missing.
 */
import type { ArchiveItem } from "../../domain/archive-item.ts";
import type { RetrievalFailure } from "../../domain/media-retrieval.ts";
import type {
  MediaSourceAdapter,
  RetrievalContext,
  RetrievalOutcome,
  RetrievedAsset,
} from "../media-source-adapter.ts";
import { embedUrlFor, fetchOrFailure, parseMediaType, type Fetch } from "./instagram-image-spike-adapter.ts";

export type CarouselSlide = {
  id: string;
  isVideo: boolean;
  /** Widest rendition, if any. */
  image?: { url: string; width: number; height: number };
};

export class InstagramCarouselSpikeAdapter implements MediaSourceAdapter {
  readonly name = "instagram-carousel-spike";
  private readonly fetch: Fetch;

  constructor(fetchImpl: Fetch = globalThis.fetch) {
    this.fetch = fetchImpl;
  }

  canRetrieve(item: ArchiveItem): boolean {
    return item.identity.kind === "shortcode";
  }

  async retrieve(item: ArchiveItem, context: RetrievalContext): Promise<RetrievalOutcome> {
    if (item.identity.kind !== "shortcode") {
      return fail({ kind: "unavailable", code: "unknown", message: "No Instagram shortcode" });
    }

    const page = await fetchOrFailure(this.fetch, embedUrlFor(item.identity.shortcode));
    if (!page.ok) return fail(page.failure);
    const html = await page.response.text();

    const mediaType = parseMediaType(html);
    if (mediaType !== "GraphSidecar") {
      return fail({
        kind: "temporary",
        code: "unknown",
        message: mediaType
          ? `Carousel spike only supports carousels; post is ${mediaType}`
          : "Embed page has no media type (layout changed or post unavailable)",
      });
    }

    const slides = parseCarouselSlides(html);
    if (!slides || slides.length === 0) {
      return fail({ kind: "temporary", code: "unknown", message: "Embed page has no carousel slide data" });
    }

    const assets: RetrievedAsset[] = [];
    for (const [position, slide] of slides.entries()) {
      if (context.storedPositions.has(position)) {
        assets.push({ position, mediaType: slide.isVideo ? "video" : "image", result: { ok: "already_stored" } });
        continue;
      }
      assets.push({ position, ...(await this.downloadSlide(slide)) });
    }
    return { ok: true, kind: "carousel", assets };
  }

  private async downloadSlide(slide: CarouselSlide): Promise<Omit<RetrievedAsset, "position">> {
    if (slide.isVideo) {
      return slideFailure("video", "Video slides are not supported by the spike");
    }
    if (!slide.image) return slideFailure("image", `Slide ${slide.id} has no renditions`);

    const download = await fetchOrFailure(this.fetch, slide.image.url);
    if (!download.ok) {
      // CDN URLs are signed and expire; a failed slide download says nothing
      // about whether the post still exists, so it stays retryable.
      return slideFailure("image", `Slide download failed: ${download.failure.message}`);
    }
    const mimeType = (download.response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("image/")) {
      return slideFailure("image", `Expected an image, got "${mimeType}"`);
    }
    return {
      mediaType: "image",
      result: {
        ok: true,
        bytes: new Uint8Array(await download.response.arrayBuffer()),
        mimeType,
        width: slide.image.width,
        height: slide.image.height,
      },
    };
  }
}

/** Slides in post order from the embed's contextJSON, or undefined if absent. */
export function parseCarouselSlides(html: string): CarouselSlide[] | undefined {
  const raw = /"contextJSON":("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
  if (!raw) return undefined;
  let edges: unknown;
  try {
    const context = JSON.parse(JSON.parse(raw) as string) as {
      gql_data?: { shortcode_media?: { edge_sidecar_to_children?: { edges?: unknown } } };
    };
    edges = context.gql_data?.shortcode_media?.edge_sidecar_to_children?.edges;
  } catch {
    return undefined;
  }
  if (!Array.isArray(edges)) return undefined;

  return edges.map((edge: { node?: SlideNode }) => {
    const node = edge.node ?? {};
    let image: CarouselSlide["image"];
    for (const r of node.display_resources ?? []) {
      if (typeof r.src === "string" && (!image || r.config_width > image.width)) {
        image = { url: r.src, width: r.config_width, height: r.config_height };
      }
    }
    return { id: String(node.id ?? ""), isVideo: node.is_video === true, ...(image && { image }) };
  });
}

type SlideNode = {
  id?: string;
  is_video?: boolean;
  display_resources?: { src?: string; config_width: number; config_height: number }[];
};

function slideFailure(mediaType: "image" | "video", message: string): Omit<RetrievedAsset, "position"> {
  const failure: RetrievalFailure = { kind: "temporary", code: "unknown", message };
  return { mediaType, result: { ok: false, failure } };
}

function fail(failure: RetrievalFailure): RetrievalOutcome {
  return { ok: false, failure };
}
