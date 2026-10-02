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

An Instagram export can be imported into the SQLite archive. The media-retrieval infrastructure exists (queue, storage, adapter contract) but no source adapter yet, so no media is downloaded. There is no AI, search or archive UI yet.

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

## Importing an Instagram export

Request a JSON-format "Download your information" export from Instagram and unzip it somewhere **outside this project**. Then run:

```bash
npm run import:instagram -- /path/to/instagram-export
npm run import:instagram -- /path/to/instagram-export --owner-sender-name "Your Other Account"
```

- **What it reads:** Liked, Saved and every Messages thread. Other files are ignored. No media is downloaded and no AI is called.
- **Where it writes:** the database at `DATABASE_PATH` (from `.env.local`); `--database <path>` overrides it.
- **All or nothing:** the whole export is written in one transaction, so a failed import writes nothing.
- **Safe to re-run:** posts and source records are never duplicated. A later export only adds information.
- **Options:**
  - `--owner-sender-name`: marks DMs from your other accounts as sent by you.
  - `--owner-id`: defaults to `local`. Keep it the same across imports.
  - `--help` lists every option.

Requires Node.js 22.13 or later (built-in `node:sqlite`); `npm test` needs 22.18 or later (native TypeScript).
