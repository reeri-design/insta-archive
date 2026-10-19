import type {
  ArchiveItem,
  ArchiveItemKind,
  Creator,
  IsoDateTime,
  MediaType,
} from "../domain/archive-item.ts";
import type { RetrievalFailure } from "../domain/media-retrieval.ts";

/**
 * Fetches the media of one ArchiveItem from some source (Instagram later).
 * Must return only the post's own media: no profile pictures, suggested or
 * related posts, comments or other page media. Never throws for expected
 * failures; it reports them as a RetrievalFailure.
 */
export interface MediaSourceAdapter {
  readonly name: string;
  canRetrieve(item: ArchiveItem): boolean;
  retrieve(item: ArchiveItem, context: RetrievalContext): Promise<RetrievalOutcome>;
}

export type RetrievalContext = {
  /** Content positions already stored; the adapter may skip downloading them. */
  storedPositions: ReadonlySet<number>;
  /** The item's cover image is already stored; the adapter may skip it. */
  coverStored?: boolean;
  /**
   * Reels: a downloaded video larger than this is not kept (it becomes frames),
   * so the adapter also retrieves the post's cover image to store beside them.
   */
  coverIfVideoOverBytes?: number;
};

export type RetrievalOutcome =
  | {
      ok: true;
      /** One entry per content asset, in post order (position 0 = first). */
      assets: RetrievedAsset[];
      /** Kind as observed at the source, if it can tell. */
      kind?: Exclude<ArchiveItemKind, "unknown">;
      metadata?: RetrievedMetadata;
      /**
       * The post's published cover image, when the adapter retrieved it (for a
       * Reel: when the video itself cannot be retrieved, or when the video is
       * larger than `coverIfVideoOverBytes`). Never a substitute content asset:
       * it is stored with the `cover` role.
       */
      cover?: RetrievedAsset["result"];
    }
  | { ok: false; failure: RetrievalFailure };

export type RetrievedAsset = {
  position: number;
  mediaType: MediaType;
  result:
    | {
        ok: true;
        /** Original bytes, untransformed. */
        bytes: Uint8Array;
        mimeType: string;
        width?: number;
        height?: number;
        durationMs?: number;
      }
    | { ok: false; failure: RetrievalFailure }
    /** Not downloaded because the position is already stored. */
    | { ok: "already_stored" };
};

/**
 * Post metadata seen during retrieval. Only fills fields the export left
 * empty; it never replaces export data (the archive keeps what existed when
 * the user saved the item).
 */
export type RetrievedMetadata = {
  creator?: Creator;
  caption?: string;
  postedAt?: IsoDateTime;
};

/** A frame derived from a stored video (extraction comes later). */
export type DerivedFrame = {
  frameTimeMs: number;
  bytes: Uint8Array;
  mimeType: string;
  width?: number;
  height?: number;
};
