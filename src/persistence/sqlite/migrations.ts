/**
 * Ordered schema migrations. Migration N brings the database to
 * `PRAGMA user_version = N`. Never edit a released migration; append one.
 *
 * Conventions:
 * - ids are TEXT and come from the domain (deterministic importer ids).
 * - timestamps are ISO-8601 TEXT (UTC, fixed width, so they sort as text).
 * - JSON columns hold small nested value objects and are CHECKed json_valid.
 * - Children reference their item with NO ACTION foreign keys: nothing is
 *   deleted by cascade, so raw export data cannot disappear by accident.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: initial schema */ `
  CREATE TABLE archive_items (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    identity_kind   TEXT NOT NULL CHECK (identity_kind IN ('shortcode', 'url')),
    -- shortcode, or normalized URL for identity_kind = 'url'
    identity_value  TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('post', 'reel', 'carousel', 'unknown')),
    canonical_url   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    -- the deduplication identity
    UNIQUE (owner_id, identity_kind, identity_value)
  ) STRICT;

  CREATE INDEX archive_items_owner_created ON archive_items (owner_id, created_at DESC, id);

  CREATE TABLE source_records (
    id               TEXT PRIMARY KEY,
    archive_item_id  TEXT NOT NULL REFERENCES archive_items (id),
    source           TEXT NOT NULL CHECK (source IN ('messages', 'saved', 'liked')),
    original_url     TEXT NOT NULL,
    occurred_at      TEXT,
    creator_json     TEXT CHECK (creator_json IS NULL OR json_valid(creator_json)),
    shared_text      TEXT,
    message_json     TEXT CHECK (message_json IS NULL OR json_valid(message_json)),
    export_file      TEXT NOT NULL,
    export_pointer   TEXT,
    export_id        TEXT,
    raw_json         TEXT NOT NULL CHECK (json_valid(raw_json)),
    imported_at      TEXT NOT NULL,
    CHECK (message_json IS NULL OR source = 'messages'),
    -- lets original_metadata require its provenance source to be of the same item
    UNIQUE (id, archive_item_id)
  ) STRICT;

  CREATE INDEX source_records_item ON source_records (archive_item_id, occurred_at);
  CREATE INDEX source_records_export ON source_records (export_id, export_file);

  -- One row per resolved field (creator, caption, postedAt), each with its
  -- provenance. Separate from AI and curation tables by design.
  CREATE TABLE original_metadata (
    archive_item_id              TEXT NOT NULL REFERENCES archive_items (id),
    field                        TEXT NOT NULL CHECK (field IN ('creator', 'caption', 'postedAt')),
    value_json                   TEXT NOT NULL CHECK (json_valid(value_json)),
    provenance_from              TEXT NOT NULL CHECK (provenance_from IN ('export', 'retrieval')),
    provenance_source_record_id  TEXT,
    provenance_retrieved_at      TEXT,
    PRIMARY KEY (archive_item_id, field),
    FOREIGN KEY (provenance_source_record_id, archive_item_id)
      REFERENCES source_records (id, archive_item_id),
    CHECK (
      (provenance_from = 'export'
        AND provenance_source_record_id IS NOT NULL AND provenance_retrieved_at IS NULL)
      OR (provenance_from = 'retrieval'
        AND provenance_retrieved_at IS NOT NULL AND provenance_source_record_id IS NULL)
    )
  ) STRICT, WITHOUT ROWID;

  -- Metadata and retrieval state only; binaries live in media storage.
  CREATE TABLE media_assets (
    id                     TEXT PRIMARY KEY,
    archive_item_id        TEXT NOT NULL REFERENCES archive_items (id),
    role                   TEXT NOT NULL CHECK (role IN ('content', 'derived_frame')),
    media_type             TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    position               INTEGER,
    derived_from_asset_id  TEXT,
    frame_time_ms          INTEGER,
    retrieval_status       TEXT NOT NULL
      CHECK (retrieval_status IN ('pending', 'stored', 'failed', 'unavailable')),
    retrieval_json         TEXT NOT NULL CHECK (json_valid(retrieval_json)),
    UNIQUE (id, archive_item_id),
    FOREIGN KEY (derived_from_asset_id, archive_item_id)
      REFERENCES media_assets (id, archive_item_id),
    CHECK (
      (role = 'content'
        AND position IS NOT NULL AND position >= 0
        AND derived_from_asset_id IS NULL AND frame_time_ms IS NULL)
      OR (role = 'derived_frame'
        AND position IS NULL
        AND derived_from_asset_id IS NOT NULL AND frame_time_ms IS NOT NULL AND frame_time_ms >= 0)
    ),
    CHECK (json_extract(retrieval_json, '$.status') = retrieval_status)
  ) STRICT;

  CREATE UNIQUE INDEX media_assets_content_position
    ON media_assets (archive_item_id, position) WHERE role = 'content';
  CREATE INDEX media_assets_retrieval_status ON media_assets (retrieval_status);

  -- Immutable: see the trigger below.
  CREATE TABLE ai_organizations (
    id                TEXT PRIMARY KEY,
    archive_item_id   TEXT NOT NULL REFERENCES archive_items (id),
    fields_json       TEXT NOT NULL CHECK (json_valid(fields_json)),
    confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    taxonomy_version  TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_version    TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (id, archive_item_id)
  ) STRICT;

  CREATE INDEX ai_organizations_item ON ai_organizations (archive_item_id, created_at);

  CREATE TRIGGER ai_organizations_immutable
    BEFORE UPDATE ON ai_organizations
    BEGIN
      SELECT RAISE(ABORT, 'ai_organizations rows are immutable');
    END;

  -- At most one per item: the item id is the primary key.
  CREATE TABLE curated_organizations (
    archive_item_id         TEXT PRIMARY KEY REFERENCES archive_items (id),
    fields_json             TEXT NOT NULL CHECK (json_valid(fields_json)),
    field_origins_json      TEXT NOT NULL CHECK (json_valid(field_origins_json)),
    based_on_suggestion_id  TEXT,
    taxonomy_version        TEXT NOT NULL,
    reviewed_by             TEXT NOT NULL,
    reviewed_at             TEXT NOT NULL,
    FOREIGN KEY (based_on_suggestion_id, archive_item_id)
      REFERENCES ai_organizations (id, archive_item_id)
  ) STRICT;
  `,

  /* 2: media retrieval queue */ `
  -- One request per item. Per-asset results stay on media_assets.
  CREATE TABLE media_retrieval_requests (
    archive_item_id  TEXT PRIMARY KEY REFERENCES archive_items (id),
    priority         INTEGER NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'failed', 'unavailable')),
    attempts         INTEGER NOT NULL CHECK (attempts >= 0),
    last_attempt_at  TEXT,
    next_attempt_at  TEXT,
    failure_code     TEXT,
    failure_json     TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK ((failure_code IS NULL) = (failure_json IS NULL)),
    CHECK (failure_json IS NULL OR json_extract(failure_json, '$.code') = failure_code),
    -- failed = temporary failure; unavailable = content unobtainable
    CHECK (status <> 'failed' OR json_extract(failure_json, '$.kind') = 'temporary'),
    CHECK (status <> 'unavailable' OR json_extract(failure_json, '$.kind') = 'unavailable'),
    CHECK (status IN ('pending', 'failed') OR next_attempt_at IS NULL)
  ) STRICT;

  CREATE INDEX media_retrieval_requests_queue
    ON media_retrieval_requests (status, priority DESC, next_attempt_at, created_at);
  `,

  /* 3: derived frames may exist without a retained source video */ `
  -- SQLite cannot alter a CHECK, so media_assets is rebuilt with the same
  -- definition except that derived_from_asset_id is optional for frames.
  -- The composite foreign key is unchanged: SQLite skips it when the column
  -- is NULL and still enforces it when it is set. Renaming first keeps
  -- foreign keys enforced throughout.
  DROP INDEX media_assets_content_position;
  DROP INDEX media_assets_retrieval_status;
  ALTER TABLE media_assets RENAME TO media_assets_v2;

  CREATE TABLE media_assets (
    id                     TEXT PRIMARY KEY,
    archive_item_id        TEXT NOT NULL REFERENCES archive_items (id),
    role                   TEXT NOT NULL CHECK (role IN ('content', 'derived_frame')),
    media_type             TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    position               INTEGER,
    derived_from_asset_id  TEXT,
    frame_time_ms          INTEGER,
    retrieval_status       TEXT NOT NULL
      CHECK (retrieval_status IN ('pending', 'stored', 'failed', 'unavailable')),
    retrieval_json         TEXT NOT NULL CHECK (json_valid(retrieval_json)),
    UNIQUE (id, archive_item_id),
    FOREIGN KEY (derived_from_asset_id, archive_item_id)
      REFERENCES media_assets (id, archive_item_id),
    CHECK (
      (role = 'content'
        AND position IS NOT NULL AND position >= 0
        AND derived_from_asset_id IS NULL AND frame_time_ms IS NULL)
      OR (role = 'derived_frame'
        AND position IS NULL
        AND frame_time_ms IS NOT NULL AND frame_time_ms >= 0)
    ),
    CHECK (json_extract(retrieval_json, '$.status') = retrieval_status)
  ) STRICT;

  -- Content first, so every frame's source video already exists.
  INSERT INTO media_assets
    SELECT * FROM media_assets_v2 ORDER BY role = 'derived_frame', id;
  DROP TABLE media_assets_v2;

  CREATE UNIQUE INDEX media_assets_content_position
    ON media_assets (archive_item_id, position) WHERE role = 'content';
  CREATE INDEX media_assets_retrieval_status ON media_assets (retrieval_status);
  `,

  /* 4: a post's cover image as its own role (Reels whose video is withheld) */ `
  -- Rebuilt as in migration 3, adding role 'cover': an image with no
  -- position, source asset or frame time, and at most one per item.
  DROP INDEX media_assets_content_position;
  DROP INDEX media_assets_retrieval_status;
  ALTER TABLE media_assets RENAME TO media_assets_v3;

  CREATE TABLE media_assets (
    id                     TEXT PRIMARY KEY,
    archive_item_id        TEXT NOT NULL REFERENCES archive_items (id),
    role                   TEXT NOT NULL CHECK (role IN ('content', 'derived_frame', 'cover')),
    media_type             TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
    position               INTEGER,
    derived_from_asset_id  TEXT,
    frame_time_ms          INTEGER,
    retrieval_status       TEXT NOT NULL
      CHECK (retrieval_status IN ('pending', 'stored', 'failed', 'unavailable')),
    retrieval_json         TEXT NOT NULL CHECK (json_valid(retrieval_json)),
    UNIQUE (id, archive_item_id),
    FOREIGN KEY (derived_from_asset_id, archive_item_id)
      REFERENCES media_assets (id, archive_item_id),
    CHECK (
      (role = 'content'
        AND position IS NOT NULL AND position >= 0
        AND derived_from_asset_id IS NULL AND frame_time_ms IS NULL)
      OR (role = 'derived_frame'
        AND position IS NULL
        AND frame_time_ms IS NOT NULL AND frame_time_ms >= 0)
      OR (role = 'cover'
        AND media_type = 'image'
        AND position IS NULL AND derived_from_asset_id IS NULL AND frame_time_ms IS NULL)
    ),
    CHECK (json_extract(retrieval_json, '$.status') = retrieval_status)
  ) STRICT;

  -- Content first, so every frame's source video already exists.
  INSERT INTO media_assets
    SELECT * FROM media_assets_v3 ORDER BY role = 'derived_frame', id;
  DROP TABLE media_assets_v3;

  CREATE UNIQUE INDEX media_assets_content_position
    ON media_assets (archive_item_id, position) WHERE role = 'content';
  CREATE UNIQUE INDEX media_assets_cover ON media_assets (archive_item_id) WHERE role = 'cover';
  CREATE INDEX media_assets_retrieval_status ON media_assets (retrieval_status);
  `,
  /* 5: AI enrichment claims (leases), so concurrent workers never process the same item */ `
  -- At most one active claim per item. A claim is a lease: it expires, so a worker that crashes
  -- or exits never excludes an item for good; an expired claim can be taken over. Rows are
  -- removed when a worker finishes with the item, whatever the outcome.
  CREATE TABLE ai_enrichment_claims (
    archive_item_id  TEXT PRIMARY KEY REFERENCES archive_items (id),
    worker_id        TEXT NOT NULL,
    claimed_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    CHECK (expires_at > claimed_at)
  ) STRICT;
  CREATE INDEX ai_enrichment_claims_expiry ON ai_enrichment_claims (expires_at);
  `,
  /* 6: persistent AI enrichment failures, so every run and worker knows an item failed */ `
  -- One row per item: its most recent enrichment failure (see src/ai/enrichment-failure.ts).
  -- provider_rejected rows keep the item out of normal enrichment runs; temporary and unknown
  -- ones are informational. A later success removes the row; nothing else is deleted.
  CREATE TABLE ai_enrichment_failures (
    archive_item_id  TEXT PRIMARY KEY REFERENCES archive_items (id),
    category         TEXT NOT NULL CHECK (category IN ('provider_rejected', 'temporary', 'unknown')),
    status_code      INTEGER,
    provider         TEXT,
    error_code       TEXT NOT NULL,
    message          TEXT NOT NULL,
    failed_at        TEXT NOT NULL,
    attempts         INTEGER NOT NULL CHECK (attempts >= 1)
  ) STRICT;
  CREATE INDEX ai_enrichment_failures_category ON ai_enrichment_failures (category);
  `,
  /* 7: backoff for temporary enrichment failures */ `
  -- When a temporary failure may be retried (see temporaryRetryDelayMs in src/ai/enrichment-failure.ts).
  -- NULL for other categories. Normal runs leave a temporary failure alone until this time.
  ALTER TABLE ai_enrichment_failures ADD COLUMN next_retry_at TEXT;

  -- Temporary failures recorded before this migration: the same schedule, from their failure time
  -- and count (1 → 1 min, 2 → 5 min, 3 → 15 min, more → 30 min).
  UPDATE ai_enrichment_failures
    SET next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', failed_at,
      CASE WHEN attempts = 1 THEN '+1 minutes' WHEN attempts = 2 THEN '+5 minutes'
           WHEN attempts = 3 THEN '+15 minutes' ELSE '+30 minutes' END)
    WHERE category = 'temporary';
  `,
];
