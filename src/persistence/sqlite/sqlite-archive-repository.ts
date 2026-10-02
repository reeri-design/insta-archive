import type { DatabaseSync } from "node:sqlite";
import type {
  AiOrganization,
  AiOrganizationId,
  ArchiveItem,
  ArchiveItemAggregate,
  ArchiveItemId,
  ArchiveItemKind,
  Attributed,
  CuratedOrganization,
  InstagramIdentity,
  MediaAsset,
  MediaAssetId,
  MediaRetrieval,
  NonEmptyArray,
  OriginalMetadata,
  Provenance,
  SourceKind,
  SourceRecord,
  SourceRecordId,
  UserId,
} from "../../domain/archive-item.ts";
import type { MediaRetrievalRequest } from "../../domain/media-retrieval.ts";
import {
  ArchiveIdentityConflictError,
  PersistenceIntegrityError,
  type ArchiveRepository,
} from "../archive-repository.ts";

/**
 * ArchiveRepository on node:sqlite. The driver is synchronous, so every
 * method runs to completion (inside one transaction when it writes several
 * rows) before its promise resolves.
 *
 * One connection, one transaction at a time: while withTransaction is
 * running, other callers must not use the same repository.
 */
export class SqliteArchiveRepository implements ArchiveRepository {
  private readonly db: DatabaseSync;
  private savepoints = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async withTransaction<T>(work: (repo: ArchiveRepository) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) {
      throw new PersistenceIntegrityError("withTransaction cannot be nested");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** `item.original` is not written here; use saveOriginalMetadata. */
  async saveArchiveItem(item: Omit<ArchiveItem, "original">): Promise<void> {
    const identity = identityColumns(item.identity);
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT owner_id, identity_kind, identity_value FROM archive_items WHERE id = ?")
        .get(item.id) as ItemIdentityRow | undefined;

      if (existing) {
        if (
          existing.owner_id !== item.ownerId ||
          existing.identity_kind !== identity.identity_kind ||
          existing.identity_value !== identity.identity_value
        ) {
          throw new ArchiveIdentityConflictError(
            `Archive item ${item.id} already exists with a different owner or identity`,
          );
        }
        this.db
          .prepare(
            `UPDATE archive_items SET kind = :kind, canonical_url = :canonical_url,
               updated_at = :updated_at WHERE id = :id`,
          )
          .run({ id: item.id, kind: item.kind, canonical_url: item.canonicalUrl, updated_at: item.updatedAt });
        return;
      }

      try {
        this.db
          .prepare(
            `INSERT INTO archive_items
               (id, owner_id, identity_kind, identity_value, kind, canonical_url, created_at, updated_at)
             VALUES (:id, :owner_id, :identity_kind, :identity_value, :kind, :canonical_url,
               :created_at, :updated_at)`,
          )
          .run({
            id: item.id,
            owner_id: item.ownerId,
            ...identity,
            kind: item.kind,
            canonical_url: item.canonicalUrl,
            created_at: item.createdAt,
            updated_at: item.updatedAt,
          });
      } catch (error) {
        if (isConstraint(error, "UNIQUE constraint failed: archive_items.owner_id")) {
          throw new ArchiveIdentityConflictError(
            `Owner ${item.ownerId} already has an archive item for ${identity.identity_kind} ` +
              `"${identity.identity_value}"`,
          );
        }
        throw error;
      }
    });
  }

  async addSourceRecords(records: SourceRecord[]): Promise<{ inserted: number; existing: number }> {
    const insert = this.db.prepare(
      `INSERT INTO source_records
         (id, archive_item_id, source, original_url, occurred_at, creator_json, shared_text,
          message_json, export_file, export_pointer, export_id, raw_json, imported_at)
       VALUES (:id, :archive_item_id, :source, :original_url, :occurred_at, :creator_json,
         :shared_text, :message_json, :export_file, :export_pointer, :export_id, :raw_json,
         :imported_at)
       ON CONFLICT (id) DO NOTHING`,
    );
    const ownerOf = this.db.prepare("SELECT archive_item_id FROM source_records WHERE id = ?");

    return this.transaction(() => {
      let inserted = 0;
      let existing = 0;
      for (const r of records) {
        const { changes } = insert.run({
          id: r.id,
          archive_item_id: r.archiveItemId,
          source: r.source,
          original_url: r.originalUrl,
          occurred_at: r.occurredAt ?? null,
          creator_json: jsonOrNull(r.creator),
          shared_text: r.sharedText ?? null,
          message_json: jsonOrNull(r.message),
          export_file: r.exportLocation.file,
          export_pointer: r.exportLocation.pointer ?? null,
          export_id: r.exportLocation.exportId ?? null,
          raw_json: JSON.stringify(r.raw ?? null),
          imported_at: r.importedAt,
        });
        if (changes > 0) {
          inserted++;
          continue;
        }
        const row = ownerOf.get(r.id) as { archive_item_id: string } | undefined;
        if (row?.archive_item_id !== r.archiveItemId) {
          throw new PersistenceIntegrityError(
            `Source record ${r.id} already belongs to ${row?.archive_item_id}, not ${r.archiveItemId}`,
          );
        }
        existing++;
      }
      return { inserted, existing };
    });
  }

  async saveOriginalMetadata(itemId: ArchiveItemId, metadata: OriginalMetadata): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO original_metadata
         (archive_item_id, field, value_json, provenance_from, provenance_source_record_id,
          provenance_retrieved_at)
       VALUES (:archive_item_id, :field, :value_json, :provenance_from,
         :provenance_source_record_id, :provenance_retrieved_at)`,
    );
    const fields: [keyof OriginalMetadata, Attributed<unknown> | undefined][] = [
      ["creator", metadata.creator],
      ["caption", metadata.caption],
      ["postedAt", metadata.postedAt],
    ];

    this.transaction(() => {
      this.db.prepare("DELETE FROM original_metadata WHERE archive_item_id = ?").run(itemId);
      for (const [field, attributed] of fields) {
        if (!attributed) continue;
        const p = attributed.provenance;
        insert.run({
          archive_item_id: itemId,
          field,
          value_json: JSON.stringify(attributed.value),
          provenance_from: p.from,
          provenance_source_record_id: p.from === "export" ? p.sourceRecordId : null,
          provenance_retrieved_at: p.from === "retrieval" ? p.retrievedAt : null,
        });
      }
    });
  }

  async saveMediaAssets(assets: MediaAsset[]): Promise<void> {
    const upsert = this.db.prepare(
      `INSERT INTO media_assets
         (id, archive_item_id, role, media_type, position, derived_from_asset_id, frame_time_ms,
          retrieval_status, retrieval_json)
       VALUES (:id, :archive_item_id, :role, :media_type, :position, :derived_from_asset_id,
         :frame_time_ms, :retrieval_status, :retrieval_json)
       ON CONFLICT (id) DO UPDATE SET
         role = excluded.role,
         media_type = excluded.media_type,
         position = excluded.position,
         derived_from_asset_id = excluded.derived_from_asset_id,
         frame_time_ms = excluded.frame_time_ms,
         retrieval_status = excluded.retrieval_status,
         retrieval_json = excluded.retrieval_json
       WHERE media_assets.archive_item_id = excluded.archive_item_id`,
    );
    // Content first, so frames in the same batch can reference their video.
    const ordered = [...assets].sort(
      (a, b) => Number(a.role === "derived_frame") - Number(b.role === "derived_frame"),
    );

    this.transaction(() => {
      for (const asset of ordered) {
        const { changes } = upsert.run({
          id: asset.id,
          archive_item_id: asset.archiveItemId,
          role: asset.role,
          media_type: asset.mediaType,
          position: asset.role === "content" ? asset.position : null,
          derived_from_asset_id: asset.role === "derived_frame" ? (asset.derivedFromAssetId ?? null) : null,
          frame_time_ms: asset.role === "derived_frame" ? asset.frameTimeMs : null,
          retrieval_status: asset.retrieval.status,
          retrieval_json: JSON.stringify(asset.retrieval),
        });
        if (changes === 0) {
          throw new PersistenceIntegrityError(
            `Media asset ${asset.id} already belongs to another archive item`,
          );
        }
      }
    });
  }

  async appendAiOrganization(s: AiOrganization): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO ai_organizations
             (id, archive_item_id, fields_json, confidence, taxonomy_version, provider, model,
              prompt_version, created_at)
           VALUES (:id, :archive_item_id, :fields_json, :confidence, :taxonomy_version,
             :provider, :model, :prompt_version, :created_at)`,
        )
        .run({
          id: s.id,
          archive_item_id: s.archiveItemId,
          fields_json: JSON.stringify(s.fields),
          confidence: s.confidence,
          taxonomy_version: s.taxonomyVersion,
          provider: s.provider,
          model: s.model,
          prompt_version: s.promptVersion,
          created_at: s.createdAt,
        });
    } catch (error) {
      if (isConstraint(error, "UNIQUE constraint failed: ai_organizations.id")) {
        throw new PersistenceIntegrityError(
          `AI organization ${s.id} already exists; suggestions are append-only`,
        );
      }
      throw error;
    }
  }

  async saveCuratedOrganization(c: CuratedOrganization): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO curated_organizations
           (archive_item_id, fields_json, field_origins_json, based_on_suggestion_id,
            taxonomy_version, reviewed_by, reviewed_at)
         VALUES (:archive_item_id, :fields_json, :field_origins_json, :based_on_suggestion_id,
           :taxonomy_version, :reviewed_by, :reviewed_at)
         ON CONFLICT (archive_item_id) DO UPDATE SET
           fields_json = excluded.fields_json,
           field_origins_json = excluded.field_origins_json,
           based_on_suggestion_id = excluded.based_on_suggestion_id,
           taxonomy_version = excluded.taxonomy_version,
           reviewed_by = excluded.reviewed_by,
           reviewed_at = excluded.reviewed_at`,
      )
      .run({
        archive_item_id: c.archiveItemId,
        fields_json: JSON.stringify(c.fields),
        field_origins_json: JSON.stringify(c.fieldOrigins),
        based_on_suggestion_id: c.basedOnSuggestionId ?? null,
        taxonomy_version: c.taxonomyVersion,
        reviewed_by: c.reviewedBy,
        reviewed_at: c.reviewedAt,
      });
  }

  async enqueueMediaRetrieval(request: MediaRetrievalRequest): Promise<boolean> {
    const { changes } = this.db
      .prepare(
        `INSERT INTO media_retrieval_requests (${REQUEST_COLUMNS.join(", ")})
         VALUES (${REQUEST_COLUMNS.map((c) => `:${c}`).join(", ")})
         ON CONFLICT (archive_item_id) DO NOTHING`,
      )
      .run(requestParams(request));
    return changes > 0;
  }

  async saveMediaRetrievalRequest(request: MediaRetrievalRequest): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO media_retrieval_requests (${REQUEST_COLUMNS.join(", ")})
         VALUES (${REQUEST_COLUMNS.map((c) => `:${c}`).join(", ")})
         ON CONFLICT (archive_item_id) DO UPDATE SET
           ${REQUEST_COLUMNS.filter((c) => c !== "archive_item_id" && c !== "created_at")
             .map((c) => `${c} = excluded.${c}`)
             .join(", ")}`,
      )
      .run(requestParams(request));
  }

  async getMediaRetrievalRequest(itemId: ArchiveItemId): Promise<MediaRetrievalRequest | undefined> {
    const row = this.db
      .prepare("SELECT * FROM media_retrieval_requests WHERE archive_item_id = ?")
      .get(itemId) as RequestRow | undefined;
    return row && toRequest(row);
  }

  async listDueMediaRetrievals(
    now: string,
    limit = 100,
    options: { ownerId?: UserId; maxPriority?: number; order?: "waiting" | "newest" } = {},
  ): Promise<MediaRetrievalRequest[]> {
    const order =
      options.order === "newest"
        ? `(SELECT MAX(s.occurred_at) FROM source_records s WHERE s.archive_item_id = r.archive_item_id) DESC NULLS LAST`
        : "COALESCE(r.next_attempt_at, r.created_at)";
    const rows = this.db
      .prepare(
        `SELECT r.* FROM media_retrieval_requests r
         JOIN archive_items i ON i.id = r.archive_item_id
         WHERE ((r.status = 'pending' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= :now))
             OR (r.status = 'failed' AND r.next_attempt_at IS NOT NULL AND r.next_attempt_at <= :now))
           AND (:owner_id IS NULL OR i.owner_id = :owner_id)
           AND (:max_priority IS NULL OR r.priority <= :max_priority)
         ORDER BY r.priority DESC, ${order}, r.archive_item_id
         LIMIT :limit`,
      )
      .all({ now, limit, owner_id: options.ownerId ?? null, max_priority: options.maxPriority ?? null }) as RequestRow[];
    return rows.map(toRequest);
  }

  async countMediaRetrievalsByStatus(): Promise<Record<MediaRetrievalRequest["status"], number>> {
    const counts = { pending: 0, stored: 0, failed: 0, unavailable: 0 };
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM media_retrieval_requests GROUP BY status")
      .all() as { status: keyof typeof counts; n: number }[];
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getArchiveItem(id: ArchiveItemId): Promise<ArchiveItem | undefined> {
    const row = this.db.prepare("SELECT * FROM archive_items WHERE id = ?").get(id) as
      | ItemRow
      | undefined;
    return row && this.toItem(row);
  }

  async getArchiveItemAggregate(id: ArchiveItemId): Promise<ArchiveItemAggregate | undefined> {
    const item = await this.getArchiveItem(id);
    if (!item) return undefined;

    const sources = (
      this.db
        .prepare(
          `SELECT * FROM source_records WHERE archive_item_id = ?
           ORDER BY occurred_at IS NULL, occurred_at, id`,
        )
        .all(id) as SourceRow[]
    ).map(toSource);
    if (sources.length === 0) {
      throw new PersistenceIntegrityError(`Archive item ${id} has no source records`);
    }

    const media = (
      this.db
        .prepare(
          `SELECT * FROM media_assets WHERE archive_item_id = ?
           ORDER BY role = 'derived_frame', position, derived_from_asset_id, frame_time_ms, id`,
        )
        .all(id) as MediaRow[]
    ).map(toMedia);

    const aiSuggestions = (
      this.db
        .prepare(
          "SELECT * FROM ai_organizations WHERE archive_item_id = ? ORDER BY created_at, rowid",
        )
        .all(id) as AiRow[]
    ).map(toAi);

    const curatedRow = this.db
      .prepare("SELECT * FROM curated_organizations WHERE archive_item_id = ?")
      .get(id) as CuratedRow | undefined;

    return {
      item,
      sources: sources as NonEmptyArray<SourceRecord>,
      media,
      aiSuggestions,
      ...(curatedRow && { curated: toCurated(curatedRow) }),
    };
  }

  async findArchiveItemByIdentity(
    ownerId: UserId,
    identity: InstagramIdentity,
  ): Promise<ArchiveItem | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM archive_items
         WHERE owner_id = :owner_id AND identity_kind = :identity_kind
           AND identity_value = :identity_value`,
      )
      .get({ owner_id: ownerId, ...identityColumns(identity) }) as ItemRow | undefined;
    return row && this.toItem(row);
  }

  async listArchiveItems(
    ownerId: UserId,
    page: { limit?: number; offset?: number } = {},
  ): Promise<ArchiveItem[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM archive_items WHERE owner_id = :owner_id
         ORDER BY created_at DESC, id LIMIT :limit OFFSET :offset`,
      )
      .all({ owner_id: ownerId, limit: page.limit ?? 100, offset: page.offset ?? 0 }) as ItemRow[];
    return rows.map((row) => this.toItem(row));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toItem(row: ItemRow): ArchiveItem {
    const metadataRows = this.db
      .prepare("SELECT * FROM original_metadata WHERE archive_item_id = ?")
      .all(row.id) as MetadataRow[];
    const original: OriginalMetadata = {};
    for (const m of metadataRows) {
      const provenance: Provenance =
        m.provenance_from === "export"
          ? { from: "export", sourceRecordId: m.provenance_source_record_id as SourceRecordId }
          : { from: "retrieval", retrievedAt: m.provenance_retrieved_at as string };
      const value: unknown = JSON.parse(m.value_json);
      (original as Record<string, Attributed<unknown>>)[m.field] = { value, provenance };
    }

    return {
      id: row.id as ArchiveItemId,
      ownerId: row.owner_id as UserId,
      identity:
        row.identity_kind === "shortcode"
          ? { kind: "shortcode", shortcode: row.identity_value }
          : { kind: "url", normalizedUrl: row.identity_value },
      kind: row.kind,
      canonicalUrl: row.canonical_url,
      original,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Atomic unit for one method; a savepoint inside withTransaction. */
  private transaction<T>(fn: () => T): T {
    if (!this.db.isTransaction) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const name = `sp_${++this.savepoints}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

type ItemIdentityRow = { owner_id: string; identity_kind: string; identity_value: string };

type ItemRow = ItemIdentityRow & {
  id: string;
  kind: ArchiveItemKind;
  canonical_url: string;
  created_at: string;
  updated_at: string;
};

type MetadataRow = {
  field: keyof OriginalMetadata;
  value_json: string;
  provenance_from: "export" | "retrieval";
  provenance_source_record_id: string | null;
  provenance_retrieved_at: string | null;
};

type SourceRow = {
  id: string;
  archive_item_id: string;
  source: SourceKind;
  original_url: string;
  occurred_at: string | null;
  creator_json: string | null;
  shared_text: string | null;
  message_json: string | null;
  export_file: string;
  export_pointer: string | null;
  export_id: string | null;
  raw_json: string;
  imported_at: string;
};

type MediaRow = {
  id: string;
  archive_item_id: string;
  role: MediaAsset["role"];
  media_type: MediaAsset["mediaType"];
  position: number | null;
  derived_from_asset_id: string | null;
  frame_time_ms: number | null;
  retrieval_json: string;
};

type AiRow = {
  id: string;
  archive_item_id: string;
  fields_json: string;
  confidence: number;
  taxonomy_version: string;
  provider: string;
  model: string;
  prompt_version: string;
  created_at: string;
};

type CuratedRow = {
  archive_item_id: string;
  fields_json: string;
  field_origins_json: string;
  based_on_suggestion_id: string | null;
  taxonomy_version: string;
  reviewed_by: string;
  reviewed_at: string;
};

function toSource(row: SourceRow): SourceRecord {
  return {
    id: row.id as SourceRecordId,
    archiveItemId: row.archive_item_id as ArchiveItemId,
    source: row.source,
    originalUrl: row.original_url,
    ...(row.occurred_at !== null && { occurredAt: row.occurred_at }),
    ...(row.creator_json !== null && { creator: JSON.parse(row.creator_json) }),
    ...(row.shared_text !== null && { sharedText: row.shared_text }),
    ...(row.message_json !== null && { message: JSON.parse(row.message_json) }),
    exportLocation: {
      file: row.export_file,
      ...(row.export_pointer !== null && { pointer: row.export_pointer }),
      ...(row.export_id !== null && { exportId: row.export_id }),
    },
    raw: JSON.parse(row.raw_json),
    importedAt: row.imported_at,
  };
}

function toMedia(row: MediaRow): MediaAsset {
  const base = {
    id: row.id as MediaAssetId,
    archiveItemId: row.archive_item_id as ArchiveItemId,
    mediaType: row.media_type,
    retrieval: JSON.parse(row.retrieval_json) as MediaRetrieval,
  };
  return row.role === "content"
    ? { ...base, role: "content", position: row.position as number }
    : {
        ...base,
        role: "derived_frame",
        ...(row.derived_from_asset_id !== null && {
          derivedFromAssetId: row.derived_from_asset_id as MediaAssetId,
        }),
        frameTimeMs: row.frame_time_ms as number,
      };
}

function toAi(row: AiRow): AiOrganization {
  return {
    id: row.id as AiOrganizationId,
    archiveItemId: row.archive_item_id as ArchiveItemId,
    fields: JSON.parse(row.fields_json),
    confidence: row.confidence,
    taxonomyVersion: row.taxonomy_version,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

function toCurated(row: CuratedRow): CuratedOrganization {
  return {
    archiveItemId: row.archive_item_id as ArchiveItemId,
    fields: JSON.parse(row.fields_json),
    fieldOrigins: JSON.parse(row.field_origins_json),
    ...(row.based_on_suggestion_id !== null && {
      basedOnSuggestionId: row.based_on_suggestion_id as AiOrganizationId,
    }),
    taxonomyVersion: row.taxonomy_version,
    reviewedBy: row.reviewed_by as UserId,
    reviewedAt: row.reviewed_at,
  };
}

const REQUEST_COLUMNS = [
  "archive_item_id",
  "priority",
  "status",
  "attempts",
  "last_attempt_at",
  "next_attempt_at",
  "failure_code",
  "failure_json",
  "created_at",
  "updated_at",
] as const;

type RequestRow = {
  archive_item_id: string;
  priority: number;
  status: MediaRetrievalRequest["status"];
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
};

function requestParams(r: MediaRetrievalRequest) {
  return {
    archive_item_id: r.archiveItemId,
    priority: r.priority,
    status: r.status,
    attempts: r.attempts,
    last_attempt_at: r.lastAttemptAt ?? null,
    next_attempt_at: r.nextAttemptAt ?? null,
    failure_code: r.lastFailure?.code ?? null,
    failure_json: jsonOrNull(r.lastFailure),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function toRequest(row: RequestRow): MediaRetrievalRequest {
  return {
    archiveItemId: row.archive_item_id as ArchiveItemId,
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    ...(row.last_attempt_at !== null && { lastAttemptAt: row.last_attempt_at }),
    ...(row.next_attempt_at !== null && { nextAttemptAt: row.next_attempt_at }),
    ...(row.failure_json !== null && { lastFailure: JSON.parse(row.failure_json) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identityColumns(identity: InstagramIdentity) {
  return identity.kind === "shortcode"
    ? { identity_kind: "shortcode", identity_value: identity.shortcode }
    : { identity_kind: "url", identity_value: identity.normalizedUrl };
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function isConstraint(error: unknown, messagePrefix: string): boolean {
  return error instanceof Error && error.message.startsWith(messagePrefix);
}
