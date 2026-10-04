# AI Enrichment

First AI organization pipeline (experimental). AI **suggests**; the user remains the authority.

```
ArchiveItem + already-stored media
  → prompt (organize-v1)
  → OrganizationProvider        provider-agnostic (src/ai/organization-provider.ts)
  → validated output            src/ai/organization-schema.ts
  → AiOrganization (appended, immutable) in SQLite
```

## Output (taxonomy v1, provisional)

| Field | Allowed |
|---|---|
| `type` | `inspiration` · `idea` · `insight` · `content_idea` · `reference` |
| `category` | `art` · `design` · `craft` · `fashion` · `photography` · `content` · `other` (used when nothing clearly fits) |
| `tags` | 3–7 specific, distinct tags |
| `summary` | 1–2 sentences describing the content |
| `usefulFor` | 1–5 possible uses as creative reference (not the owner's reasons) |
| `confidence` | 0–1 |

- **Validation:** output that fails validation (wrong values, wrong counts, missing or extra fields, non-JSON) is **not saved**.
- **Enum enforcement:** the allowed values are enforced in validation, not in the domain model. The model keeps free-form strings, so the taxonomy can change by bumping `TAXONOMY_VERSION`.

## What the model sees

- **Text:** only the post's own context: kind, creator, caption and posting date.
- **Never sent:** whether the owner saved, liked or DMed the post, who sent it, or when.
- **Instructions:** describe the content, never guess why it was saved, and use `other` when unsure.
- **Images:** only media that is already stored. Nothing is downloaded. Up to 8 images, 12 MB raw in total (about 16 MB once base64-encoded, under Gemini's 20 MB request limit), in this order of preference:
  - carousel or post images, by position
  - a frames-only Reel's stored frames, in time order
  - for a stored Reel video, a few frames sampled into a temp folder (deleted afterwards, never stored); no video is ever sent
  - last resort: the post's `cover` image (a Reel whose video was withheld). The media line tells the model it is the published cover image, a single still chosen by the creator and not a frame of the video. A cover stored after a metadata-only organization makes the item eligible for media-aware re-enrichment like any other newly stored media.
- **Unusable images are left out:** a failed or unavailable asset, a missing file, a too-large image, or a type the provider can't accept (`supportedImageTypes`; Gemini takes JPEG, PNG and WEBP, not GIF). The prompt's media line names exactly which slides were sent. If nothing usable remains, the request is the unchanged metadata-only one.
- **Provider-specific placement** happens in the adapter: Gemini gets the text first, then the images (Google's guidance).
- **No stored media:** the item is enriched from metadata only. The prompt version records which variant ran (`organize-v1/media` or `organize-v1/metadata`), and metadata-only answers are asked to keep confidence ≤ 0.6.
- **Nothing to classify:** items with no caption and no stored media are skipped without an API call.

## Storage rules

- **Append-only:** each result is a new `AiOrganization`, recording `provider`, `model` (the one that actually answered), `promptVersion`, `taxonomyVersion` and `confidence`.
- **Re-enrichment only when media arrives:** an item is enriched when it has no AI organization yet. It is enriched *again* only when its newest organization was made without media (`organize-v1/metadata`) **and** media has been stored since that organization was created. The new, media-aware organization is appended; the old one is kept unchanged, and the newest is the effective AI organization (the one search uses unless a curated review exists).
- **No repeats:** a media-aware organization is never redone. A metadata-only one is not redone while no new media has arrived. Failed or unavailable media never makes an item eligible. If the new media cannot be used by the AI (for example, an unsupported image type), the item is skipped without an AI call rather than organized from metadata again. The rule lives in `src/ai/enrichment-eligibility.ts`.
- **Nothing else is written:** original metadata, sources, media and curated organization are never modified.

## Providers

- **Configuration:** `AI_PROVIDER` selects the implementation (default `gemini`). `AI_MODEL` optionally overrides that provider's default model.
- **Gemini** (`src/ai/providers/gemini-organization-provider.ts`):
  - Uses Google's official `@google/genai` SDK, with structured JSON output via `responseJsonSchema`.
  - Default model `gemini-3.8-flash`, the newest stable Flash model, which has a free tier.
  - Key: `GEMINI_API_KEY` in `.env.local`.
- **OpenRouter** (`src/ai/providers/openrouter-organization-provider.ts`): selected with `AI_PROVIDER=openrouter`.
  - Calls OpenRouter's chat completions API over plain HTTP (no SDK), with structured JSON output via `response_format: json_schema` (strict). `provider.require_parameters` makes OpenRouter use only upstream providers that support it.
  - Default model `dots-studio/dots-3-note-preview:free`, a free model. No fallback models or automatic routing (`openrouter/free`) are used.
  - Images go after the text, as base64 data URLs; JPEG, PNG and WEBP, the same types as Gemini.
  - Key: `OPENROUTER_API_KEY` in `.env.local`. It is sent only in the `Authorization` header and kept in a private field, so it never appears in errors or logs.
- **Anthropic** (`src/ai/providers/anthropic-organization-provider.ts`): selected only with `AI_PROVIDER=anthropic`.
- **Isolation:** the provider files are the only code that uses a vendor SDK or knows vendor model names.
- **Adding a provider:** implement `OrganizationProvider` and add a case in `src/ai/providers/index.ts`.

## Running a batch

```bash
npm run enrich:ai -- --limit 10                      # a varied sample of 10 items without an AI organization
npm run enrich:ai -- --limit 3 --item <shortcode> …  # specific items
```

- **Limits:** `--limit` is required (1–100), so a run can never cover the whole archive.
- **Scope:** only items in the main archive (Saved + Messages) are enriched. Liked-only items are never selected, and naming one with `--item` is refused.
- **Priority:** two workloads share one queue, without any stored flag.
  - **New captures:** items with a Saved or Messages source record imported *after the owner's first import*. Every import run stamps the records it adds with its own `importedAt`, and existing records are never rewritten, so only genuinely new saves and DMs carry a later time. They are taken first, all of them up to the limit: stored media first, then the most recent.
  - **Backfill:** everything from the first (historical) import. It fills whatever room a batch has left, so it is enriched opportunistically. An old item that later gets only a new *like* stays backfill.
  - Priority disappears on its own once an item is enriched. If the initial historical import was split over several runs, the later runs count as new captures.
- **Selection:** without `--item`, backfill items are chosen deterministically for variety. Items with stored media are chosen first, so the media-aware path gets exercised; metadata-only items fill the rest of the limit. Within each of these two tiers, groups are built from content kind × source context (e.g. "reel | liked") and visited in turn, newest item first, preferring creators not yet picked. Items with neither a caption nor stored media are never chosen.
- **Preview:** `--dry-run` lists the items a run would enrich, without any AI calls.
- **Pacing:** items are processed one at a time with a pause between them (`--delay-ms`, default 1000).
- **Stopping:** the batch stops early on a rate limit or on missing/invalid credentials. Other failures (refusals, invalid output, provider errors) are reported and save nothing.
- **Output:** one line per item (media used or metadata-only, type, category, confidence), then totals including token usage.
