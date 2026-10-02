/**
 * Retrieves one ArchiveItem's media from Instagram by routing to the existing
 * adapters: single images and carousels go through MediaRetrievalService
 * (so carousel retries fetch only missing slides), videos through the Reel
 * media strategy (video kept up to the size threshold, otherwise frames).
 *
 * The embed page is fetched once per item and reused by whichever adapter
 * handles it, so routing costs no extra request.
 */
import type { ArchiveItem, ArchiveItemId, IsoDateTime } from "../../domain/archive-item.ts";
import type { MediaRetrievalRequest } from "../../domain/media-retrieval.ts";
import type { ArchiveRepository } from "../../persistence/archive-repository.ts";
import type { MediaRetrievalJobItemRetriever } from "../media-retrieval-job.ts";
import { MediaRetrievalService } from "../media-retrieval-service.ts";
import type { MediaSourceAdapter, RetrievalContext, RetrievalOutcome } from "../media-source-adapter.ts";
import type { MediaStorage } from "../media-storage.ts";
import { InstagramCarouselSpikeAdapter } from "./instagram-carousel-spike-adapter.ts";
import {
  embedUrlFor,
  fetchOrFailure,
  InstagramImageSpikeAdapter,
  isRemovedPostPage,
  parseMediaType,
  type Fetch,
} from "./instagram-image-spike-adapter.ts";
import { InstagramReelSpikeAdapter } from "./instagram-reel-spike-adapter.ts";
import { ReelMediaRetrieval, type FrameExtractor } from "./reel-media.ts";

export type InstagramItemRetrieverOptions = {
  repository: ArchiveRepository;
  storage: MediaStorage;
  extractor: FrameExtractor;
  maxRetainedVideoBytes: number;
  fetch?: Fetch;
  tempRoot?: string;
  now?: () => IsoDateTime;
};

export class InstagramItemRetriever implements MediaRetrievalJobItemRetriever {
  private readonly options: InstagramItemRetrieverOptions;

  constructor(options: InstagramItemRetrieverOptions) {
    this.options = options;
  }

  async retrieve(itemId: ArchiveItemId): Promise<{ request: MediaRetrievalRequest; mediaType?: string }> {
    const { repository, storage, extractor, maxRetainedVideoBytes, tempRoot, now } = this.options;
    const item = await repository.getArchiveItem(itemId);
    if (!item) throw new Error(`Unknown archive item ${itemId}`);
    const fetch = cacheEmbedPages(this.options.fetch ?? globalThis.fetch);

    let mediaType: string | undefined;
    if (item.identity.kind === "shortcode") {
      const page = await fetchOrFailure(fetch, embedUrlFor(item.identity.shortcode));
      if (page.ok) mediaType = parseMediaType(await page.response.text());
    }

    if (mediaType === "GraphVideo") {
      const reels = new ReelMediaRetrieval({
        repository, storage, extractor, maxRetainedVideoBytes,
        adapter: new InstagramReelSpikeAdapter(fetch),
        ...(tempRoot !== undefined && { tempRoot }),
        ...(now !== undefined && { now }),
      });
      return { request: (await reels.run(itemId)).request, mediaType };
    }

    // Images, carousels, and anything that failed or is not recognised: the
    // service records the outcome (including the page's failure, if any).
    const service = new MediaRetrievalService({
      repository, storage,
      adapters: [new InstagramPostAdapter(fetch)],
      ...(now !== undefined && { now }),
    });
    await service.enqueue(itemId);
    return { request: (await service.process(itemId)).request, ...(mediaType && { mediaType }) };
  }
}

/** Routes a single-image or carousel post to its adapter; refuses anything else. */
class InstagramPostAdapter implements MediaSourceAdapter {
  readonly name = "instagram-post";
  private readonly fetch: Fetch;

  constructor(fetchImpl: Fetch) {
    this.fetch = fetchImpl;
  }

  canRetrieve(): boolean {
    return true;
  }

  async retrieve(item: ArchiveItem, context: RetrievalContext): Promise<RetrievalOutcome> {
    if (item.identity.kind !== "shortcode") {
      return { ok: false, failure: { kind: "unavailable", code: "unknown", message: "No Instagram shortcode" } };
    }
    const page = await fetchOrFailure(this.fetch, embedUrlFor(item.identity.shortcode));
    if (!page.ok) return { ok: false, failure: page.failure };
    const html = await page.response.text();
    if (isRemovedPostPage(html)) {
      return {
        ok: false,
        failure: { kind: "unavailable", code: "not_found", message: "Instagram says the post may have been removed or the link is broken" },
      };
    }
    const mediaType = parseMediaType(html);
    if (mediaType === "GraphImage") return new InstagramImageSpikeAdapter(this.fetch).retrieve(item, context);
    if (mediaType === "GraphSidecar") return new InstagramCarouselSpikeAdapter(this.fetch).retrieve(item, context);
    return {
      ok: false,
      failure: {
        kind: "temporary",
        code: "unknown",
        message: mediaType ? `Unsupported post type ${mediaType}` : "Embed page has no media type (layout changed or post unavailable)",
      },
    };
  }
}

/**
 * Wraps fetch so each embed page is requested once; later requests for the
 * same page (from the router and then the adapter) get a copy. Media
 * downloads are never cached.
 */
export function cacheEmbedPages(fetchImpl: Fetch): Fetch {
  const pages = new Map<string, Promise<{ body: string; status: number; headers: [string, string][] }>>();
  return async (url, init) => {
    if (!url.includes("/embed/captioned/")) return fetchImpl(url, init);
    let page = pages.get(url);
    if (!page) {
      page = fetchImpl(url, init).then(async (response) => ({
        body: await response.text(),
        status: response.status,
        headers: [...response.headers.entries()],
      }));
      pages.set(url, page);
    }
    const { body, status, headers } = await page;
    return new Response(status === 204 || status === 304 ? null : body, { status, headers });
  };
}
