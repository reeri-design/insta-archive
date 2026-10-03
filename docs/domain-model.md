# Domain Model

Types: [`src/domain/archive-item.ts`](../src/domain/archive-item.ts). This is a model, not a schema. Tables come later.

```
ArchiveItem (1 per unique Instagram post, per owner)
 ├── SourceRecord   1..n  verbatim export facts (messages / saved / liked)
 ├── OriginalMetadata     resolved creator, caption, postedAt (each with provenance)
 ├── MediaAsset     0..n  ordered content + derived frames, each with retrieval state
 ├── AiOrganization 0..n  immutable AI suggestions
 └── CuratedOrganization 0..1  human-reviewed organization
```

## Entities

**ArchiveItem**: the canonical record for one piece of Instagram content. It carries `ownerId`, an `identity` (the dedup key), a `kind` (`post | reel | carousel | unknown`) and a `canonicalUrl`.

**SourceRecord**: one place the item appears in the export. It keeps:
- the exact `originalUrl`
- the timestamp from the export (`occurredAt`)
- the creator and caption or share text as the export gives them
- the export file location and the untouched `raw` JSON

Message sources also carry `MessageContext`. It includes `userNote`, which holds what the user wrote alongside the share. Nothing writes to a SourceRecord except the importer.

**OriginalMetadata**: the best-known original facts about the post. Each field is `Attributed<T>`, which records whether the value came from the export or from retrieval. The export takes priority, and retrieval only fills in gaps. AI never writes here.

**MediaAsset**: one of two roles:
- `content`: the single image, a carousel slide or a reel's video, ordered by `position`.
- `derived_frame`: a frame extracted from the item's video, ordered by `frameTimeMs`. `derivedFromAssetId` names the stored `content` video; it is absent when the video was intentionally not retained because it exceeded the configured size threshold (see `docs/media-retrieval.md`).

**AiOrganization**: one AI suggestion, never edited after it is written. Re-running AI adds a new one. Each suggestion records provider, model, prompt version and taxonomy version.

**CuratedOrganization**: what the user reviewed. For each field, `fieldOrigins` records whether the value was `ai_accepted`, `human_edited` or `human_added`.

## Key decisions

- **Main archive scope: Saved + Messages. Likes are preserved as imported source data but are not included in the main archive.**
  - An item is in the main archive when at least one of its SourceRecords is `saved` or `messages`. An item that was liked *and* saved or shared stays in, and its liked record stays attached and visible.
  - Liked-only items are imported and stored like any other item. Their records are never deleted, so Likes can become an optional source later. They are simply left out of the product: the archive UI, AI enrichment selection and, later, search.
  - Defined once in `src/domain/archive-scope.ts` (`MAIN_ARCHIVE_SOURCES`, `isInMainArchive`). Repository list queries take a `sources` option, so the filtering happens in SQL rather than in the UI.

- **Deduplication:** items are keyed by `(ownerId, identity)`. `identity` is the Instagram shortcode, which is shared across `/p/`, `/reel/` and `/tv/` URLs. If no shortcode can be extracted, a normalized URL is used instead. A post that was saved, liked and sent in DMs becomes one item with three SourceRecords, and each record keeps its own URL and timestamp.
- **Carousel and reel are one item each.** A carousel is one item with ordered `content` assets. A reel is one item with one `content` video plus any number of `derived_frame` assets.
- **`kind: "unknown"` is valid.** The export often gives only a URL. The kind can be refined later, for example once retrieval shows a post is a carousel.
- **Media failure never invalidates an item.** Retrieval is `pending | stored | failed | unavailable`, and `media` may be empty. `failed` means retryable; `unavailable` means the media is known to be gone (deleted, private and so on).
- **Layers never mix.** Four layers stay separate:
  - export facts (SourceRecord)
  - resolved originals (OriginalMetadata)
  - AI suggestions (AiOrganization)
  - human decisions (CuratedOrganization)

  AI output lives only in its own layer.
- **The user's reason for saving is never inferred.** `userNote` comes only from the export. `usefulFor` describes what the content could be useful for, not why the user saved it.
- **Optional means "Instagram didn't say."** Fields are optional wherever the export doesn't reliably provide them.
- **The taxonomy is provisional.**
  - The fields are `type`, `category`, `tags`, `summary`, `usefulFor` and `confidence`.
  - `type` and `category` are free-form strings for now.
  - Every organization records a `taxonomyVersion`, so labels can change without losing track of older data.
  - `confidence` exists only on AI output.
- **Review status is derived, not stored:** `reviewed` if curated, else `ai_suggested` if any suggestion exists, else `unorganized`.
- **Ready for more than one user:** `ownerId` on items and `reviewedBy` on curation. Branded ID types stop one kind of ID being passed where another is expected.
