/**
 * SPIKE (Step 08B.3): retrieves the video of a public Instagram Reel. Not
 * production code: no frames, thumbnails, login or rate limiting.
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
import type { MediaSourceAdapter, RetrievalContext, RetrievalOutcome } from "../media-source-adapter.ts";
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
    if (!video) return temporary("Embed page has no video URL");

    const download = await fetchOrFailure(this.fetch, video.url);
    if (!download.ok) return temporary(`Video download failed: ${download.failure.message}`);
    const mimeType = (download.response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("video/")) return temporary(`Expected a video, got "${mimeType}"`);

    return {
      ok: true,
      ...(video.isReel && { kind: "reel" as const }),
      assets: [{
        position: 0,
        mediaType: "video",
        result: {
          ok: true,
          bytes: new Uint8Array(await download.response.arrayBuffer()),
          mimeType,
          ...(video.width !== undefined && { width: video.width }),
          ...(video.height !== undefined && { height: video.height }),
          ...(video.durationMs !== undefined && { durationMs: video.durationMs }),
        },
      }],
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

function temporary(message: string): RetrievalOutcome {
  return fail({ kind: "temporary", code: "unknown", message });
}

function fail(failure: RetrievalFailure): RetrievalOutcome {
  return { ok: false, failure };
}
