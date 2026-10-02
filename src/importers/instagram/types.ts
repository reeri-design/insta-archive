import type {
  ArchiveItem,
  Creator,
  ExportLocation,
  IsoDateTime,
  MessageContext,
  NonEmptyArray,
  SourceKind,
  SourceRecord,
  UserId,
} from "../../domain/archive-item.ts";
import type { InstagramContentUrl } from "./instagram-url.ts";

/** One file from an unpacked Instagram export, already JSON-parsed. */
export type ExportFile = {
  /** Path inside the export, e.g. "your_instagram_activity/likes/liked_posts.json". */
  path: string;
  data: unknown;
};

export type ImportOptions = {
  ownerId: UserId;
  /** Timestamp stamped on everything this import creates. */
  importedAt: IsoDateTime;
  /** Identifies this export download; copied onto every ExportLocation. */
  exportId?: string;
  /**
   * `sender_name`s that also belong to the archive owner, such as the owner's
   * other Instagram accounts. Messages from them get `sentByOwner: true`,
   * even though the export itself (which only knows the exporting account)
   * labels them "<name> sent an attachment.". Adds to, never replaces, the
   * automatic detection from the export's placeholders.
   */
  ownerSenderNames?: string[];
};

/**
 * An export entry after Instagram-specific parsing, before deduplication.
 * Text fields are already decoded (see decodeExportText).
 */
export type ParsedExportRecord = {
  source: SourceKind;
  /** Stable key for this occurrence; the same entry always yields the same key. */
  naturalKey: string;
  originalUrl: string;
  url: InstagramContentUrl;
  occurredAt?: IsoDateTime;
  creator?: Creator;
  /** Distinct, non-empty captions / share texts from this entry, in export order. */
  captions: string[];
  message?: MessageContext;
  exportLocation: ExportLocation;
  raw: unknown;
};

/** An entry that looked relevant but could not be imported. */
export type SkippedEntry = {
  exportLocation: ExportLocation;
  reason: string;
};

export type ImportWarning = {
  message: string;
  exportLocation?: ExportLocation;
  archiveItemId?: ArchiveItem["id"];
};

export type ExportFileKind = "liked" | "saved" | "messages" | "unsupported";

export type FileReport = {
  path: string;
  kind: ExportFileKind;
  /** Entries turned into parsed records. */
  imported: number;
  /** Entries that are not archive material (e.g. plain chat messages). */
  ignored: number;
  skipped: number;
};

export type ImportedArchiveItem = {
  item: ArchiveItem;
  /** Ordered by occurredAt (unknown last), then id. */
  sources: NonEmptyArray<SourceRecord>;
};

/**
 * Output of a pure import. Deterministic for the same files and options, so
 * a persistence layer can upsert by id.
 */
export type ImportResult = {
  /** Ordered by item id. */
  items: ImportedArchiveItem[];
  skipped: SkippedEntry[];
  warnings: ImportWarning[];
  files: FileReport[];
};

export type ParseOutcome = {
  records: ParsedExportRecord[];
  skipped: SkippedEntry[];
  warnings: ImportWarning[];
  ignored: number;
};
