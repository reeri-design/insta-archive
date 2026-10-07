# Insta Archive

A personal web app that turns your saved Instagram posts, carousels and reels into an organized, searchable archive, and keeps your own reason for saving each one.

## MVP direction

1. **Import/capture:** load your Instagram "Download your information" JSON export (the source of truth). Fetching public media is a separate step that may fail without breaking the import.
2. **AI first pass:** suggest organization that adds to your original context. The AI never guesses why you saved something.
3. **Human review:** you check and edit what the AI suggested.
4. **Archive/search:** browse and find what you saved.

A carousel is one item with ordered media. A reel is one item, possibly with extracted frames.

## Stack

Next.js (App Router) and strict TypeScript. SQLite for metadata and the local filesystem for media. AI runs behind a provider abstraction; Claude is the first provider.

## Status

An Instagram export can be imported into the SQLite archive. Media can be retrieved in controlled, resumable batches (single images, carousels, and Reels as video or sampled frames). AI enrichment exists as a small-batch experiment. There is no search or archive UI yet.

## Development

```bash
npm install
cp .env.example .env.local   # fill in values when features need them
npm run dev                  # http://localhost:3000
npm run lint
npm run typecheck
npm test
npm run build
```

## Personal and demo archives

The app works on one of two archives, chosen by `ARCHIVE_DATA_SOURCE` (`src/config/data-source.ts`):

| | Personal (default) | Demo |
|---|---|---|
| Select | nothing to set | `ARCHIVE_DATA_SOURCE=demo` (the `*:demo` scripts set it) |
| Database | `DATABASE_PATH` (`./data/insta-archive.sqlite`) | `DEMO_DATABASE_PATH` (default `./demo-data/archive.sqlite`) |
| Media | `MEDIA_STORAGE_DIR` (`./data/media`) | `DEMO_MEDIA_STORAGE_DIR` (default `./demo-data/media`) |

```bash
npm run dev                    # personal archive, http://localhost:3000 (unchanged)

npm run demo:seed              # create/refresh the demo archive (tiny placeholder data); --reset to start over
npm run dev:demo               # demo archive, http://localhost:3001
npm run build && npm run start:demo   # or a production server on the demo archive
```

- The two never share a location: every database and media path is resolved in one place, and a configuration where the demo archive's database, its folder, or its media would equal, contain or sit inside the personal archive's (or the other way round) is refused in either mode.
- `demo:seed` refuses to run unless the demo archive is selected; it imports the repository's own synthetic test export and a few generated placeholder images — nothing from a personal archive. `/demo-data/` is git-ignored.
- The CLIs (`import:instagram`, `retrieve:media`, `enrich:ai`, …) follow the same selection; personal is the default. An explicit `--database <path>` still overrides it.
- Run one `next dev` per checkout at a time (they share `.next/`); to have both archives open, use `npm run build && npm run start:demo` beside `npm run dev`.

## Importing an Instagram export

Request a JSON-format "Download your information" export from Instagram and unzip it somewhere **outside this project**. Then run:

```bash
npm run import:instagram -- /path/to/instagram-export
npm run import:instagram -- /path/to/instagram-export --owner-sender-name "Your Other Account"
```

- **What it reads:** Liked, Saved and every Messages thread. Other files are ignored. No media is downloaded and no AI is called.
- **Scope:** Main archive scope: Saved + Messages. Likes are preserved as imported source data but are not included in the main archive. Liked-only items are imported and kept, but the archive UI and AI enrichment leave them out.
- **Where it writes:** the database at `DATABASE_PATH` (from `.env.local`); `--database <path>` overrides it.
- **All or nothing:** the whole export is written in one transaction, so a failed import writes nothing.
- **Safe to re-run:** posts and source records are never duplicated. A later export only adds information.
- **Options:**
  - `--owner-sender-name`: marks DMs from your other accounts as sent by you.
  - `--owner-id`: defaults to `local`. Keep it the same across imports.
  - `--help` lists every option.

## Retrieving media

After importing, fetch media in small batches (start with about 20):

```bash
npm run retrieve:media -- --limit 20
```

It is resumable and stops on a rate limit. See `docs/media-retrieval.md` ("Running a retrieval batch").

## AI enrichment (experimental)

```bash
npm run enrich:ai -- --limit 10
```

This suggests a type, category, tags, summary and uses for each item. It runs only on small, explicit batches and needs `GEMINI_API_KEY` in `.env.local` (or `AI_PROVIDER=openrouter` with `OPENROUTER_API_KEY`). See `docs/ai-enrichment.md`.

Requires Node.js 22.13 or later (built-in `node:sqlite`); `npm test` needs 22.18 or later (native TypeScript).
