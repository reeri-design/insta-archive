/**
 * SPIKE (Step 08B.3): retrieves the video of a public Instagram Reel (and its
 * cover image, when the video is withheld or too large to keep). No frames,
 * login or rate limiting here.
 *
 * How it works (as observed 2026-10):
 *  1. GET https://www.instagram.com/p/<shortcode>/embed/captioned/ (no login).
 *  2. The embed root must have data-media-type="GraphVideo".
 *  3. The page's contextJSON blob (gql_data.shortcode_media) has is_video,
 *     product_type ("clips" for Reels), video_url (a signed .mp4 CDN URL),
 *     video_duration (seconds) and dimensions. The page has no <video> tag.
 *  4. GET video_url and return the bytes untouched.
 *
 * A failed video download is a temporary failure: the CDN URL is signed and
 * expires, so it says nothing about whether the Reel still exists.
 */
import type { ArchiveItem } from "../../domain/archive-item.ts";
import type { RetrievalFailure } from "../../domain/media-retrieval.ts";
import type { MediaSourceAdapter, RetrievalContext, RetrievalOutcome, RetrievedAsset } from "../media-source-adapter.ts";
import {
  embedShortcodeMedia,
  embedUrlFor,
  fetchOrFailure,
  parseMediaType,
  type Fetch,
} from "./instagram-image-spike-adapter.ts";

export type ReelVideo = {
  url: string;
  isReel: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
};

export class InstagramReelSpikeAdapter implements MediaSourceAdapter {
  readonly name = "instagram-reel-spike";
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
    if (context.storedPositions.has(0)) {
      return { ok: true, assets: [{ position: 0, mediaType: "video", result: { ok: "already_stored" } }] };
    }

    const page = await fetchOrFailure(this.fetch, embedUrlFor(item.identity.shortcode));
    if (!page.ok) return fail(page.failure);
    const html = await page.response.text();

    const mediaType = parseMediaType(html);
    if (mediaType !== "GraphVideo") {
      return temporary(
        mediaType
          ? `Reel spike only supports videos; post is ${mediaType}`
          : "Embed page has no media type (layout changed or post unavailable)",
      );
    }
    const video = parseReelVideo(html);
    if (!video) {
      // Instagram's embed states the post is a video but withholds its URL
      // (seen with Reels using licensed music). Re-fetching returns the same
      // page, so this is not retried; a manual retry can still re-run it.
      const withheld: RetrievalFailure = { kind: "unavailable", code: "restricted", message: "Embed page has no video URL" };
      const cover = parseReelCover(html);
      if (!cover) return fail(withheld);
      // The page still publishes the Reel's cover image: retrieve that instead,
      // as a cover (never as the video), and record the video as unavailable.
      return {
        ok: true,
        assets: [{ position: 0, mediaType: "video", result: { ok: false, failure: withheld } }],
        cover: context.coverStored ? { ok: "already_stored" } : await this.downloadCover(cover),
      };
    }

    const download = await fetchOrFailure(this.fetch, video.url);
    if (!download.ok) {
      // A rate limit keeps its code so callers can stop; anything else stays retryable.
      if (download.failure.code === "rate_limited") return fail(download.failure);
      return temporary(`Video download failed: ${download.failure.message}`);
    }
    const mimeType = (download.response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("video/")) return temporary(`Expected a video, got "${mimeType}"`);

    const bytes = new Uint8Array(await download.response.arrayBuffer());
    // A video that will not be kept is replaced by frames plus the creator's cover, when the page publishes one.
    const over = context.coverIfVideoOverBytes;
    const coverInfo = over !== undefined && bytes.byteLength > over ? parseReelCover(html) : undefined;
    const cover = coverInfo && (context.coverStored ? ({ ok: "already_stored" } as const) : await this.downloadCover(coverInfo));
    return {
      ok: true,
      ...(video.isReel && { kind: "reel" as const }),
      ...(cover && { cover }),
      assets: [{
        position: 0,
        mediaType: "video",
        result: {
          ok: true,
          bytes,
          mimeType,
          ...(video.width !== undefined && { width: video.width }),
          ...(video.height !== undefined && { height: video.height }),
          ...(video.durationMs !== undefined && { durationMs: video.durationMs }),
        },
      }],
    };
  }

  /** Downloads the cover image; a failure is temporary (signed URLs expire, pages change). */
  private async downloadCover(cover: { url: string; width?: number; height?: number }): Promise<RetrievedAsset["result"]> {
    const download = await fetchOrFailure(this.fetch, cover.url);
    if (!download.ok) {
      if (download.failure.code === "rate_limited") return { ok: false, failure: download.failure };
      return { ok: false, failure: { kind: "temporary", code: "unknown", message: `Cover download failed: ${download.failure.message}` } };
    }
    const mimeType = (download.response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("image/")) {
      return { ok: false, failure: { kind: "temporary", code: "unknown", message: `Expected a cover image, got "${mimeType}"` } };
    }
    return {
      ok: true,
      bytes: new Uint8Array(await download.response.arrayBuffer()),
      mimeType,
      ...(cover.width !== undefined && { width: cover.width }),
      ...(cover.height !== undefined && { height: cover.height }),
    };
  }
}

/** The video URL and the metadata the embed states about it. */
export function parseReelVideo(html: string): ReelVideo | undefined {
  const media = embedShortcodeMedia(html);
  if (!media || media.is_video !== true || typeof media.video_url !== "string") return undefined;
  const dimensions = media.dimensions as { width?: unknown; height?: unknown } | undefined;
  const duration = media.video_duration;
  return {
    url: media.video_url,
    isReel: media.product_type === "clips",
    ...(typeof duration === "number" && { durationMs: Math.round(duration * 1000) }),
    ...(typeof dimensions?.width === "number" && { width: dimensions.width }),
    ...(typeof dimensions?.height === "number" && { height: dimensions.height }),
  };
}

/** The Reel's published cover image: its widest rendition, else display_url. */
export function parseReelCover(html: string): { url: string; width?: number; height?: number } | undefined {
  const media = embedShortcodeMedia(html);
  if (!media) return undefined;
  const resources = Array.isArray(media.display_resources)
    ? (media.display_resources as { src?: unknown; config_width?: unknown; config_height?: unknown }[])
        .filter((r): r is { src: string; config_width: number; config_height: number } =>
          typeof r.src === "string" && typeof r.config_width === "number" && typeof r.config_height === "number")
    : [];
  const widest = [...resources].sort((a, b) => b.config_width - a.config_width)[0];
  if (widest) return { url: widest.src, width: widest.config_width, height: widest.config_height };
  return typeof media.display_url === "string" ? { url: media.display_url } : undefined;
}

function temporary(message: string): RetrievalOutcome {
  return fail({ kind: "temporary", code: "unknown", message });
}

function fail(failure: RetrievalFailure): RetrievalOutcome {
  return { ok: false, failure };
}
