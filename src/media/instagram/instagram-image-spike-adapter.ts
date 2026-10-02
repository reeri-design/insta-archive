/**
 * SPIKE (Step 08B.1): retrieves the image of a public, single-image
 * Instagram post. Not the production adapter: no carousels, reels, videos,
 * login or rate-limit handling. Kept isolated so it can be replaced.
 *
 * How it works (as observed 2026-10):
 *  1. GET https://www.instagram.com/p/<shortcode>/embed/captioned/ (no login).
 *  2. The embed root has data-media-type="GraphImage" | "GraphSidecar" | ...;
 *     only GraphImage is accepted.
 *  3. <img class="EmbeddedMediaImage" srcset="..."> lists CDN renditions;
 *     the widest one is the full-size image.
 *  4. GET that URL and return the bytes untouched.
 * The post page's og:image is not used: it is a square crop.
 */
import type { ArchiveItem } from "../../domain/archive-item.ts";
import type { RetrievalFailure } from "../../domain/media-retrieval.ts";
import type {
  MediaSourceAdapter,
  RetrievalContext,
  RetrievalOutcome,
} from "../media-source-adapter.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class InstagramImageSpikeAdapter implements MediaSourceAdapter {
  readonly name = "instagram-image-spike";
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
      return { ok: true, kind: "post", assets: [{ position: 0, mediaType: "image", result: { ok: "already_stored" } }] };
    }
    const embedUrl = embedUrlFor(item.identity.shortcode);

    const page = await fetchOrFailure(this.fetch, embedUrl);
    if (!page.ok) return fail(page.failure);
    const html = await page.response.text();

    const mediaType = parseMediaType(html);
    if (mediaType !== "GraphImage") {
      return fail({
        kind: "temporary",
        code: "unknown",
        message: mediaType
          ? `Spike only supports single images; post is ${mediaType}`
          : "Embed page has no media type (layout changed or post unavailable)",
      });
    }

    const image = largestRendition(html);
    if (!image) {
      return fail({ kind: "temporary", code: "unknown", message: "Embed page has no image renditions" });
    }

    const download = await fetchOrFailure(this.fetch, image.url);
    if (!download.ok) return fail(download.failure);
    const mimeType = (download.response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!mimeType.startsWith("image/")) {
      return fail({ kind: "temporary", code: "unknown", message: `Expected an image, got "${mimeType}"` });
    }
    const bytes = new Uint8Array(await download.response.arrayBuffer());

    return {
      ok: true,
      kind: "post",
      assets: [{ position: 0, mediaType: "image", result: { ok: true, bytes, mimeType, width: image.width } }],
    };
  }
}

/** GET a URL; non-2xx responses and network errors become a RetrievalFailure. */
export async function fetchOrFailure(
  fetchImpl: Fetch,
  url: string,
): Promise<{ ok: true; response: Response } | { ok: false; failure: RetrievalFailure }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    return { ok: false, failure: { kind: "temporary", code: "network_error", message: messageOf(error) } };
  }
  if (response.ok) return { ok: true, response };
  return { ok: false, failure: failureForStatus(response) };
}

export function embedUrlFor(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
}

/** The embed root's data-media-type, e.g. "GraphImage" or "GraphSidecar". */
export function parseMediaType(html: string): string | undefined {
  return /data-media-type="([A-Za-z]+)"/.exec(html)?.[1];
}

/** Widest entry of the EmbeddedMediaImage srcset. */
export function largestRendition(html: string): { url: string; width: number } | undefined {
  const img = /<img[^>]*class="EmbeddedMediaImage"[^>]*>/.exec(html)?.[0];
  const srcset = img && /srcset="([^"]*)"/.exec(img)?.[1];
  if (!srcset) return undefined;
  let best: { url: string; width: number } | undefined;
  for (const candidate of decodeEntities(srcset).split(",")) {
    const match = /^\s*(\S+)\s+(\d+)w\s*$/.exec(candidate);
    if (!match?.[1] || !match[2]) continue;
    const width = Number(match[2]);
    if (!best || width > best.width) best = { url: match[1], width };
  }
  return best;
}

function failureForStatus(response: Response): RetrievalFailure {
  const message = `HTTP ${response.status}`;
  if (response.status === 404 || response.status === 410) {
    return { kind: "unavailable", code: "not_found", message };
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    return {
      kind: "temporary",
      code: "rate_limited",
      message,
      ...(Number.isFinite(seconds) && seconds > 0 && { retryAfterMs: seconds * 1000 }),
    };
  }
  if (response.status >= 500) return { kind: "temporary", code: "server_error", message };
  return { kind: "temporary", code: "unknown", message };
}

function fail(failure: RetrievalFailure): RetrievalOutcome {
  return { ok: false, failure };
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&quot;/g, '"');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * gql_data.shortcode_media from the embed's `"contextJSON":"<JSON string>"`,
 * or undefined when the blob is null/absent (as seen for single images).
 */
export function embedShortcodeMedia(html: string): Record<string, unknown> | undefined {
  const raw = /"contextJSON":("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
  if (!raw) return undefined;
  try {
    const context = JSON.parse(JSON.parse(raw) as string) as {
      gql_data?: { shortcode_media?: Record<string, unknown> | null };
    };
    return context.gql_data?.shortcode_media ?? undefined;
  } catch {
    return undefined;
  }
}
