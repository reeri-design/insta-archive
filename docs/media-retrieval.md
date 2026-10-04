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

**Failures that retrying cannot fix** are recorded as `unavailable`, so they never take future retry slots (a manual retry still re-runs them):
- **Reel with no `video_url`:** the embed describes the video but withholds its URL (seen with Reels using licensed music), and re-fetching returns the same page. The video is recorded as `unavailable / restricted`, and its published cover image is stored instead when the page offers one (see "Reels: when the video is withheld"). The item and its metadata are left untouched.
- **Carousel video slide:** video slides are not downloaded yet. The slide is recorded as `unavailable / unknown` on its own asset, the image slides stay stored, and the request is `stored` (all obtainable media). Once video slides are supported, a manual retry fetches only the missing slides.

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
- **Which path was used** can be read from the assets: a `content` video, frames whose `retrieval.derivedFrom` shows the video's size, or a `cover` with the video recorded as unavailable.
- **Frames may also be used later for AI and search.**

### Reels: when the video is withheld

Instagram's embed sometimes describes a Reel's video but gives no `video_url`. In the real archive this happened only for Reels using licensed music (not for all of them), and re-fetching returns the same page. The page still publishes the Reel's **cover image** (`display_resources` / `display_url`), so retrieval stores that instead:

- The video's `content` asset (position 0) is recorded as `unavailable`, reason `restricted`.
- The widest cover rendition is downloaded once and stored unchanged as the item's single `cover` asset (`<item>:cover`, an image with `width`/`height`). It is the still the creator chose, not a frame: it can differ from the video entirely, so it is never treated as the video or as a frame.
- The request is then `stored` (all obtainable media). A failed cover download is a temporary failure and is retried; an already stored cover is never downloaded again (adapters receive `coverStored`).
- Without a published cover, the request is `unavailable / restricted` as before, with nothing stored.
- A manual retry checks for the video again. If it has become available it is stored as usual; the cover stays as a cover.
- **The threshold is configurable and experimental.** Its default is 20 MB: the test Reel was 2.17 MB for 12.4 s, about 1.4 Mbit/s, so 20 MB is roughly 2 minutes.
- **Rerunning a completed Reel fetches nothing,** whichever way it was stored. Changing the threshold later does not convert Reels that are already stored.

## Running a retrieval batch

`npm run retrieve:media -- --limit 20` retrieves media for a small, controlled batch (`src/cli/retrieve-media.ts`, `src/media/media-retrieval-job.ts`). **Start with a small batch** (about 20–50) and check the results before going bigger. Never run the whole archive in one go.

- **Scope: main archive only (Saved + Messages).** Liked-only items get no new requests. Requests they already have stay exactly as they are: never picked, never changed, and not counted in the run summary.
- **Each run:**
  1. Creates a `pending` retrieval request for every main-archive item that has none. This makes no network requests.
  2. Picks up to `--limit` *due* requests: highest priority first, then the newest item (its latest save, like or DM date).
  3. Retrieves them one at a time, pausing between items (`--delay-ms`, default 2000).
- **Priorities:** only two tiers exist: owner exchange (100) and normal (0). Until owner-exchange detection is built, every item is normal. `--from-priority <n>` limits the run to requests with priority ≤ n.
- **Routing (Instagram):** the item's embed page is fetched once and routed by post type:
  - single image → image adapter
  - carousel → carousel adapter
  - video → Reel strategy (video kept up to the threshold, otherwise frames)
- **Outcomes per item:**
  - **Stored:** done. It is never selected or downloaded again.
  - **Unavailable** (deleted/private/not found, e.g. HTTP 404): not retried automatically.
  - **Failed** (network, server, timeout, unknown): retried at its scheduled backoff time by a later run. A carousel retry downloads only the slides it is missing.
  - **Rate limited** (HTTP 429, on the page or on a media download): **the whole batch stops**. That item is scheduled for a later retry. Everything not yet attempted stays `pending`, untouched.
  - **Unexpected error:** reported and skipped. The item stays as it was and is retried next run.
- **Resumable:** all progress lives in the retrieval requests. Running the command again continues where it stopped, and work already stored is never lost or repeated.
- **Output:** one line per item, then counts:
  - attempted, stored, unavailable, failed/retryable, errors
  - already stored (skipped), whether a rate limit stopped the run, remaining due
  - request status totals before and after, and the duration

## Metadata from retrieval

- Retrieved creator, caption and `postedAt` only **fill fields the export left empty**, recorded with `provenance: retrieval`.
- Export values are never replaced, so the archive keeps what existed when the item was saved.
- `kind` is set from retrieval only while it is `unknown`.
- Re-importing an export keeps these retrieval-only values (`keepRetrievedDetails` in ingestion).
