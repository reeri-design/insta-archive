# Media Retrieval

Source-agnostic infrastructure for fetching an ArchiveItem's media. No source adapter exists yet; the Instagram adapter comes in a later step. Nothing here makes network requests, extracts frames or runs in the background.

```
ArchiveItem ──enqueue──▶ MediaRetrievalRequest (pending)
                              │ process()
                              ▼
                     MediaSourceAdapter.retrieve()      no DB transaction held
                              │ original bytes, per position
                              ▼
                     MediaStorage.put(stable key)        files, never SQLite
                              │
                              ▼  one transaction
          MediaAssets + request status + missing metadata filled + kind (if unknown)
```

## The four concepts

| Concept | What it is | Where |
|---|---|---|
| **ArchiveItem** | One Instagram post. Always valid, with or without media. Retrieval never touches its identity, sources or existing metadata. | `domain/archive-item.ts` |
| **MediaAsset** | One media file of the item: a `content` asset (an image, carousel slide or reel video, ordered by `position`) or a `derived_frame` of a video. Its `retrieval` field is the per-asset outcome: `pending / stored / failed / unavailable`. It is the existing model, unchanged. | `domain/archive-item.ts` |
| **MediaRetrievalRequest** | The queue entry for an item, one per item. Assets are only known after retrieval (how many slides, whether there is a video), so scheduling lives here: priority, status, attempts, last and next attempt, last failure. | `domain/media-retrieval.ts` |
| **MediaStorage** | Where the bytes are stored. Bytes are kept exactly as received; `put` refuses to overwrite different bytes under an existing key. `LocalMediaStorage` writes under `MEDIA_STORAGE_DIR`. | `media/media-storage.ts`, `media/local-media-storage.ts` |

Two more pieces connect them:
- **`MediaSourceAdapter`** (`media/media-source-adapter.ts`) is the contract a source implements. It returns the post's own media only, one result per position, plus optional metadata and kind. Expected failures are returned, not thrown.
- **`MediaRetrievalService`** (`media/media-retrieval-service.ts`) runs the flow above. It also stores derived frames for a stored video.

## Status and retries

| Request status | Meaning | Automatic retry |
|---|---|---|
| `pending` | Waiting to run: new, a scheduled retry, or a manual retry | Runs when due |
| `stored` | All obtainable media is stored | Never |
| `failed` | A temporary problem (`network_error`, `rate_limited`, `timeout`, `server_error`, `storage_error`, `unknown`) | At `nextAttemptAt`, with exponential backoff per code; none once that code's attempt limit is reached |
| `unavailable` | The content can't be obtained (`deleted`, `private`, `restricted`, `not_found`, `unknown`) | Never |

**Retry details:**
- **Backoff** (`defaultRetryPolicy`, injectable): network errors and timeouts start at 1 min, server errors at 5 min, rate limits at 15 min; each retry waits 4× longer, up to 24 h. A source's `retryAfterMs` is honoured. Attempt limits are 5 for most codes, 8 for rate limits and 3 for `storage_error` / `unknown`.
- **Manual retry:** `retryManually` re-queues an item from any status and keeps the last failure for context.
- **Adapter crashes:** a thrown error is recorded as `temporary / unknown`, not as unavailable.

**Mixed results within one item** (for example, some carousel slides fail):
- Any temporary failure makes the request `failed`, so it is retried. Already-stored positions are passed to the adapter as `storedPositions` and are never fetched or written again.
- Otherwise, if at least one asset is stored, the request is `stored`. Slides that are permanently gone stay `unavailable` on their own asset.
- If nothing is stored at all, the request is `unavailable`.

## Priority

Priority is a number, and higher runs first. Requests with equal priority run longest-waiting first. Defaults:

- **`RETRIEVAL_PRIORITY.ownerExchange` = 100:** content exchanged directly between the owner's own accounts.
- **`RETRIEVAL_PRIORITY.normal` = 0:** everything else.

The rule is injected as a `PriorityPolicy`. `ownerExchangePriority(predicate)` takes the "is this an owner exchange?" test from the caller; no account detection is built in yet.

## Storage keys

A storage key looks like `<2 hex chars>/<sha256(itemId)>/<sha256(assetId)>.<ext>`. Asset ids are deterministic (`<itemId>:media:<position>`, `<videoId>:frame:<ms>`), so a key is known *before* downloading. That makes "already stored?" a cheap check, and a crash between writing the file and saving the database row is repaired by the next attempt. The database stores only the key.

## Reels: video or sampled frames

A Reel's video is the canonical media representation (`media/instagram/reel-media.ts`). After the video is downloaded, its **byte size** decides how it is kept:

| Downloaded video | Stored as |
|---|---|
| `≤ REEL_MAX_RETAINED_VIDEO_BYTES` | The video, unchanged: one `content` video asset (`byteLength`, `width`, `height`, `durationMs`) |
| `> REEL_MAX_RETAINED_VIDEO_BYTES` | Frames only: `derived_frame` images sampled at a size-dependent interval (below) |

**Frames-only sampling (experimental).** The frames are a visual summary, not a replacement for the video's full timeline, so larger videos are sampled more sparsely. The interval is chosen by the downloaded video's byte size (`FRAME_INTERVAL_BUCKETS` in `reel-media.ts`):

| Downloaded video | One frame every |
|---|---|
| `> 100 MB` | 12 s |
| `> 50 MB` (up to 100 MB) | 8 s |
| Anything else on the frames path (`> 20 MB` by default) | 4 s |

Sampling keeps the first frame, then the first frame at or after each interval mark, then the final frame if it was not already picked. Frames stay in chronological order and record their actual timestamps. A boundary value (exactly 50 or 100 MB) belongs to the lower bucket.

- **Frames path:**
  - The video exists only in a temporary directory, which is deleted on success and on failure.
  - Frames have no `derivedFromAssetId`, carry their actual `frameTimeMs`, and record the discarded video in `retrieval.derivedFrom` (type, size, duration, dimensions).
  - Frames are extracted with the local `ffmpeg`/`ffprobe` and saved as lossless PNG.
  - A failed extraction leaves the request `failed`, never `stored`.
- **Which path was used** can be read from the assets: a `content` video, or frames whose `retrieval.derivedFrom` shows the video's size.
- **Frames may also be used later for AI and search.**
- **The threshold is configurable and experimental.** Its default is 20 MB: the test Reel was 2.17 MB for 12.4 s, about 1.4 Mbit/s, so 20 MB is roughly 2 minutes.
- **Rerunning a completed Reel fetches nothing,** whichever way it was stored. Changing the threshold later does not convert Reels that are already stored.

## Metadata from retrieval

- Retrieved creator, caption and `postedAt` only **fill fields the export left empty**, recorded with `provenance: retrieval`.
- Export values are never replaced, so the archive keeps what existed when the item was saved.
- `kind` is set from retrieval only while it is `unknown`.
- Re-importing an export keeps these retrieval-only values (`keepRetrievedDetails` in ingestion).
