# Persistence

The domain model (`src/domain/archive-item.ts`) is stored in SQLite through a storage-agnostic repository:

```
src/persistence/
  archive-repository.ts                  ArchiveRepository interface + errors (domain types only)
  sqlite/database.ts                     openDatabase(), migrate(), databasePathFromEnv()
  sqlite/migrations.ts                   schema, versioned by PRAGMA user_version
  sqlite/sqlite-archive-repository.ts    SqliteArchiveRepository (node:sqlite)
```

- **Driver:** Node's built-in `node:sqlite`, with no npm dependency and no ORM. It still prints an "experimental" warning on Node 24. Only `sqlite/` knows about it, so swapping in `better-sqlite3` or another database touches nothing else.
- **Location:** `DATABASE_PATH` (default `./data/insta-archive.sqlite`, which is git-ignored) for the personal archive; `DEMO_DATABASE_PATH` (default `./demo-data/archive.sqlite`) for the demo archive. Which one is used is decided in `src/config/data-source.ts` (`ARCHIVE_DATA_SOURCE`, personal by default; see the README). Tests use `:memory:` or a temp directory and never read `DATABASE_PATH`.
- **Connection settings:** `foreign_keys = ON`, WAL journal and `busy_timeout = 5000`, set on every connection.

## Tables

```
archive_items 1 ─┬─ n source_records
                 ├─ n original_metadata   (one row per field; provenance → a source_record of the same item)
                 ├─ n media_assets        (derived frame → a content asset of the same item, if the video is kept)
                 ├─ n ai_organizations
                 ├─ 0..1 curated_organizations (basedOnSuggestionId → an ai_organization of the same item)
                 └─ 0..1 media_retrieval_requests   (retrieval queue; see docs/media-retrieval.md)
```

| Table | Key | Notable constraints |
|---|---|---|
| `archive_items` | `id` (importer id) | **`UNIQUE(owner_id, identity_kind, identity_value)`**: the dedup identity |
| `source_records` | `id` (importer id, stored as-is) | `raw_json NOT NULL`; `message_json` only allowed when `source = 'messages'` |
| `original_metadata` | `(archive_item_id, field)` | `field` ∈ creator, caption, postedAt; provenance must be *either* export + source record *or* retrieval + timestamp |
| `media_assets` | `id` | content needs `position`; frames need `frame_time_ms` and no `position`, and `derived_from_asset_id` is optional (migration 3) but, when set, must be a video of the same item; a `cover` (migration 4) is an image with no position, source or frame time, at most one per item; unique `(item, position)` for content; `retrieval_status` must match `retrieval_json.status` |
| `ai_organizations` | `id` | `confidence` between 0 and 1; a trigger rejects every `UPDATE` (immutable) |
| `curated_organizations` | `archive_item_id` | the primary key *is* the item, so there is at most one per item |
| `media_retrieval_requests` | `archive_item_id` | one per item; `failed` requires a temporary failure and `unavailable` an unavailable one; only `pending` / `failed` may have a `next_attempt_at`; indexed for the queue (status, priority, next attempt) |

**Other conventions:**
- **Same-item references:** where a row points at another child row, a composite foreign key such as `(provenance_source_record_id, archive_item_id)` guarantees the target belongs to the **same item**.
- **No cascades:** foreign keys never delete by cascade, so raw export data cannot disappear by accident.
- **Strict typing:** every table is `STRICT`.
- **Timestamps:** stored as ISO-8601 UTC text, which sorts correctly as text.
- **Owners:** `owner_id` is a plain column. There is no users table until authentication exists.

## What is JSON, and why

| Column | Why JSON |
|---|---|
| `source_records.raw_json` | Untouched export fragment; its shape belongs to Instagram |
| `source_records.creator_json`, `message_json` | Small value objects, always read with their record, never joined on |
| `original_metadata.value_json` | Value type differs by field (a Creator object or a string) |
| `media_assets.retrieval_json` | Each retrieval status has different fields; `retrieval_status` is also a real, indexed column so retry queues can query it |
| `media_retrieval_requests.failure_json` | The last failure (kind, code, message, retry-after); `failure_code` is also a real column for queries |
| `ai_organizations.fields_json`, `curated_organizations.fields_json` / `field_origins_json` | The taxonomy is provisional; JSON lets it change without migrations or taxonomy tables |

Relational instead: anything with its own identity, relationships or constraints. That covers items, sources, media assets, AI suggestions and curation, plus the identity, source kind, export location and timestamps.

## Repository API → domain

| Method | Domain effect |
|---|---|
| `withTransaction(work)` | Runs several calls as one unit: all are committed or none. |
| `saveArchiveItem(item)` | Insert, or update `kind` / `canonicalUrl` / `updatedAt`. Owner and identity never change. A duplicate identity throws `ArchiveIdentityConflictError`. |
| `addSourceRecords(records)` | Insert as-is. Existing ids are left untouched, which makes re-imports idempotent. An id that belongs to another item throws. |
| `saveOriginalMetadata(itemId, metadata)` | Replaces the item's `original`. |
| `saveMediaAssets(assets)` | Upsert by id, for example when retrieval state changes. |
| `appendAiOrganization(s)` | Insert only; re-running AI means appending a new suggestion. |
| `saveCuratedOrganization(c)` | Insert or replace the one curation. |
| `enqueueMediaRetrieval(request)` | Creates the item's retrieval request unless one exists (whatever its status). |
| `saveMediaRetrievalRequest(request)` / `getMediaRetrievalRequest(id)` | Saves or reads a request state transition. |
| `listDueMediaRetrievals(now, limit)` | Due requests, highest priority first, then longest-waiting. |
| `getArchiveItem`, `findArchiveItemByIdentity`, `listArchiveItems` | `ArchiveItem`, with `original` assembled from `original_metadata`. |
| `getArchiveItemAggregate(id)` | `ArchiveItemAggregate`: sources ordered by `occurredAt` (unknown last), content media by position with frames after, AI suggestions oldest first. |

**Write order:** item → sources → original metadata. `ArchiveItem.original` cites source records, which in turn reference the item, so `saveArchiveItem` takes the item *without* `original`, and the metadata is saved afterwards.

**Transactions:** each method is atomic on its own. `withTransaction(work)` makes several calls one unit; inside it, each method's own atomic step becomes a savepoint. There is one connection and one transaction at a time, so do not nest transactions or use the outer repository inside `work`. The Instagram ingestion writes a whole export inside one transaction (see `src/ingestion/instagram/`). If an item without sources ever exists, `getArchiveItemAggregate` reports it as a `PersistenceIntegrityError` instead of returning an invalid aggregate.

## Schema changes

Append a new migration to `MIGRATIONS`, and never edit a released one. `openDatabase` applies the pending migrations in order, each in its own transaction, and records the version in `PRAGMA user_version`.
