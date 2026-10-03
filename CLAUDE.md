# Insta Archive — Claude Guide

## Product context

Insta Archive is a personal archive for things saved on Instagram. It turns saved posts, carousels and reels into an organized, searchable archive that keeps the user's own reason for saving each item.

- It is a web application.
- It starts as a single-user, personal tool. Do not make later multi-user support needlessly hard: avoid global singletons for user-owned data, and keep ownership explicit where it costs little.
- The main bulk input is the user's Instagram **"Download your information" JSON export**.
- The export is the **source of truth** for original archive metadata.
- Fetching public Instagram URLs and media is a **separate ingestion layer**. It is best-effort and must fail gracefully. A failed fetch must never block or corrupt an import.

## MVP flow

```
import/capture → AI first-pass organization → human review/edit → archive/search
```

## Domain rules

- A **carousel** is ONE archive item that holds several media assets in order.
- A **reel** is ONE archive item. It can hold the video plus frames extracted from it.
- AI **adds to** the user's original context. It never replaces it.
- AI must **never invent why the user saved something**. Keep user-provided context apart from AI-generated content, and label AI output as AI output.
- **Media is preserved as original.** Bytes are stored exactly as retrieved and never transformed or overwritten. A Reel's video is the canonical media representation. Derived frames may be stored instead of retaining the video when the retrieved video exceeds the configured storage threshold. Frames may also be used later for AI/search. The threshold is configurable and experimental (`REEL_MAX_RETAINED_VIDEO_BYTES`). Retrieval fetches only the post's own media, is separate from ingestion, and its failure never invalidates an ArchiveItem.
- **Export metadata wins; retrieval only fills gaps.** Retrieved values fill empty fields with `retrieval` provenance and are never used to replace historical export values. They survive re-imports.
- **Main archive scope: Saved + Messages. Likes are preserved as imported source data but are not included in the main archive.** An item belongs to the main archive when it has at least one Saved or Messages source record. A liked item that was also saved or shared stays in, with its liked record attached. Liked-only items stay stored, untouched, but are left out of browsing, AI enrichment and search. The rule is `isInMainArchive` / `MAIN_ARCHIVE_SOURCES` (`src/domain/archive-scope.ts`); list queries filter with the repository's `sources` option.
- **Imports only add, never remove.** Re-importing is idempotent. An item's kind and original metadata are re-resolved from *all* of its stored source records, using the importer's rules. Source records are never rewritten, and each import is all-or-nothing.
- Keep the taxonomy light. Do not over-design categories or tags yet; they will change based on real archive and retrieval experiments.

## Architecture principles

- **Stack:** TypeScript + Node, Next.js (App Router) web app, strict TypeScript.
- **Metadata storage:** SQLite to start, through Node's built-in `node:sqlite`, behind the `ArchiveRepository` interface (`src/persistence/`). See `docs/persistence.md`. Schema changes are new migrations, never edits to old ones.
- **Media storage:** local filesystem (`MEDIA_STORAGE_DIR`) to start, behind the `MediaStorage` interface. Binaries never go in SQLite. Retrieval sources implement `MediaSourceAdapter`; see `docs/media-retrieval.md`.
- **AI providers must be replaceable.** All AI calls go through a provider abstraction. Claude is the first provider, but application code must not import a vendor SDK directly or depend on vendor-specific types outside the provider implementation.
- Keep ingestion, organization (AI), review and search as separate concerns.
- Prefer few dependencies. Do not add component libraries or other libraries without a clear need.

## Working agreements

- Build features one at a time, only when asked. Do not jump ahead to the next feature.
- Never commit real credentials. Secrets belong in `.env.local`; list only placeholder variables in `.env.example`.
- Before calling a change done, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`.
- Tests use `node:test` and run TypeScript directly on Node; relative imports need the `.ts` extension and types need `import type`.
