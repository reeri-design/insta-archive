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
- **Unusable images are left out:** a failed or unavailable asset, a missing file, a too-large image, or a type the provider can't accept (`supportedImageTypes`; Gemini takes JPEG, PNG and WEBP, not GIF). The prompt's media line names exactly which slides were sent. If nothing usable remains, the request is the unchanged metadata-only one.
- **Provider-specific placement** happens in the adapter: Gemini gets the text first, then the images (Google's guidance).
- **No stored media:** the item is enriched from metadata only. The prompt version records which variant ran (`organize-v1/media` or `organize-v1/metadata`), and metadata-only answers are asked to keep confidence ≤ 0.6.
- **Nothing to classify:** items with no caption and no stored media are skipped without an API call.

## Storage rules

- **Append-only:** each result is a new `AiOrganization`, recording `provider`, `model` (the one that actually answered), `promptVersion`, `taxonomyVersion` and `confidence`.
- **No re-enrichment:** an item that already has one is skipped.
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
- **Selection:** without `--item`, items are chosen deterministically for variety. Groups are built from content kind × source context (e.g. "reel | liked") and visited in turn, newest item first, preferring creators not yet picked. Items with neither a caption nor stored media are never chosen.
- **Preview:** `--dry-run` lists the items a run would enrich, without any AI calls.
- **Pacing:** items are processed one at a time with a pause between them (`--delay-ms`, default 1000).
- **Stopping:** the batch stops early on a rate limit or on missing/invalid credentials. Other failures (refusals, invalid output, provider errors) are reported and save nothing.
- **Output:** one line per item (media used or metadata-only, type, category, confidence), then totals including token usage.
