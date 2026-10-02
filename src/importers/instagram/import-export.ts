import type {
  ArchiveItem,
  ArchiveItemId,
  ArchiveItemKind,
  InstagramIdentity,
  NonEmptyArray,
  OriginalMetadata,
  SourceKind,
  SourceRecord,
  SourceRecordId,
} from "../../domain/archive-item.ts";
import { canonicalUrlFor, identityKey, parseInstagramUrl } from "./instagram-url.ts";
import { parseActivityFile } from "./parse-activity.ts";
import { collectSenderEvidence, parseMessagesFile } from "./parse-messages.ts";
import type {
  ExportFile,
  ExportFileKind,
  FileReport,
  ImportOptions,
  ImportResult,
  ImportWarning,
  ImportedArchiveItem,
  ParseOutcome,
  ParsedExportRecord,
  SkippedEntry,
} from "./types.ts";

export function classifyExportFile(path: string): ExportFileKind {
  if (/(^|\/)likes\/liked_posts\.json$/.test(path)) return "liked";
  if (/(^|\/)saved\/saved_posts\.json$/.test(path)) return "saved";
  if (/(^|\/)messages\/[^/]+\/[^/]+\/message_\d+\.json$/.test(path)) return "messages";
  return "unsupported";
}

/**
 * Converts Instagram export files into ArchiveItems + SourceRecords.
 *
 * Pure and deterministic: no I/O, no clock; ids derive from export content, so
 * importing the same files twice yields the same items and records. Media and
 * AI are untouched.
 */
export function importInstagramExport(
  files: ExportFile[],
  options: ImportOptions,
): ImportResult {
  const sortedFiles = [...files].sort((a, b) => compare(a.path, b.path));
  const kinds = sortedFiles.map((file) => classifyExportFile(file.path));

  const senderEvidence = collectSenderEvidence(
    sortedFiles.filter((_, i) => kinds[i] === "messages").map((f) => f.data),
  );
  const configuredOwnerNames = new Set(options.ownerSenderNames ?? []);

  const skipped: SkippedEntry[] = [];
  const warnings: ImportWarning[] = [];
  const reports: FileReport[] = [];
  const recordsByKey = new Map<string, ParsedExportRecord>();

  sortedFiles.forEach((file, i) => {
    const kind = kinds[i] ?? "unsupported";
    let outcome: ParseOutcome;
    if (kind === "liked" || kind === "saved") {
      outcome = parseActivityFile(kind, file.path, file.data, options.exportId);
    } else if (kind === "messages") {
      outcome = parseMessagesFile(
        file.path,
        file.data,
        options.exportId,
        senderEvidence,
        configuredOwnerNames,
      );
    } else {
      reports.push({ path: file.path, kind, imported: 0, ignored: 0, skipped: 0 });
      warnings.push({ message: `Unsupported export file ignored: ${file.path}` });
      return;
    }

    let imported = 0;
    for (const record of outcome.records) {
      if (recordsByKey.has(record.naturalKey)) {
        warnings.push({
          message: "Duplicate export entry ignored (already imported)",
          exportLocation: record.exportLocation,
        });
        continue;
      }
      recordsByKey.set(record.naturalKey, record);
      imported++;
    }
    skipped.push(...outcome.skipped);
    warnings.push(...outcome.warnings);
    reports.push({
      path: file.path,
      kind,
      imported,
      ignored: outcome.ignored,
      skipped: outcome.skipped.length,
    });
  });

  // Deduplicate: one ArchiveItem per (owner, identity).
  const groups = new Map<string, ParsedExportRecord[]>();
  for (const record of recordsByKey.values()) {
    const key = identityKey(record.url.identity);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const items: ImportedArchiveItem[] = [];
  for (const [key, group] of groups) {
    items.push(buildItem(key, group, options, warnings));
  }
  items.sort((a, b) => compare(a.item.id, b.item.id));

  return { items, skipped, warnings, files: reports };
}

function buildItem(
  key: string,
  group: ParsedExportRecord[],
  options: ImportOptions,
  warnings: ImportWarning[],
): ImportedArchiveItem {
  const first = group[0];
  if (!first) throw new Error("buildItem called with an empty group");
  const identity = first.url.identity;
  const archiveItemId = `${options.ownerId}:${key}` as ArchiveItemId;

  const pairs = group.map((parsed) => ({
    parsed,
    record: toSourceRecord(parsed, archiveItemId, options),
  }));
  for (const { parsed } of pairs) {
    if (parsed.captions.length > 1) {
      warnings.push({
        message: `Entry has ${parsed.captions.length} different captions; using the first`,
        exportLocation: parsed.exportLocation,
        archiveItemId,
      });
    }
  }

  const records = pairs.map((p) => p.record);
  const item: ArchiveItem = {
    id: archiveItemId,
    ownerId: options.ownerId,
    identity,
    ...resolveItemDetails(identity, records, archiveItemId, warnings),
    createdAt: options.importedAt,
    updatedAt: options.importedAt,
  };

  const sources = records.sort(byOccurrence);
  return { item, sources: sources as NonEmptyArray<SourceRecord> };
}

/**
 * Kind, canonical URL and original metadata of an item, derived from all of
 * its source records. Used at import time and again when an item gains
 * sources from a later import, so both follow the same rules.
 */
export function resolveItemDetails(
  identity: InstagramIdentity,
  sources: SourceRecord[],
  archiveItemId: ArchiveItemId,
  warnings: ImportWarning[],
): Pick<ArchiveItem, "kind" | "canonicalUrl" | "original"> {
  const hints = new Set<ArchiveItemKind>();
  for (const source of sources) {
    const parsed = parseInstagramUrl(source.originalUrl);
    if (parsed.ok && parsed.content.kindHint) hints.add(parsed.content.kindHint);
  }
  let kind: ArchiveItemKind = "unknown";
  const [onlyHint] = hints;
  if (hints.size === 1 && onlyHint) kind = onlyHint;
  if (hints.size > 1) {
    warnings.push({
      message: `Conflicting kinds from URLs (${[...hints].sort().join(", ")}); kind left unknown`,
      archiveItemId,
    });
  }
  return {
    kind,
    canonicalUrl: canonicalUrlFor(identity, kind),
    original: resolveOriginal(sources, archiveItemId, warnings),
  };
}

function toSourceRecord(
  parsed: ParsedExportRecord,
  archiveItemId: ArchiveItemId,
  options: ImportOptions,
): SourceRecord {
  const sharedText = parsed.captions[0];
  return {
    id: `${options.ownerId}:${parsed.naturalKey}` as SourceRecordId,
    archiveItemId,
    source: parsed.source,
    originalUrl: parsed.originalUrl,
    ...(parsed.occurredAt && { occurredAt: parsed.occurredAt }),
    ...(parsed.creator && { creator: parsed.creator }),
    ...(sharedText && { sharedText }),
    ...(parsed.message && { message: parsed.message }),
    exportLocation: parsed.exportLocation,
    raw: parsed.raw,
    importedAt: options.importedAt,
  };
}

/**
 * Saved and Liked entries carry the full caption and owner name; message
 * shares only the username and (for carousel slides) often an empty caption.
 */
const SOURCE_PRIORITY: Record<SourceKind, number> = { saved: 0, liked: 1, messages: 2 };

function resolveOriginal(
  sources: SourceRecord[],
  archiveItemId: ArchiveItemId,
  warnings: ImportWarning[],
): OriginalMetadata {
  const ordered = [...sources].sort(
    (a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || byOccurrence(a, b),
  );
  const fromExport = (r: SourceRecord) => ({ from: "export" as const, sourceRecordId: r.id });

  const usernames = new Set(ordered.map((r) => r.creator?.username).filter((u) => u !== undefined));
  if (usernames.size > 1) {
    warnings.push({
      message: `Sources disagree on creator username (${[...usernames].sort().join(", ")})`,
      archiveItemId,
    });
  }

  const creatorSource =
    ordered.find((r) => r.creator?.username && r.creator.displayName) ??
    ordered.find((r) => r.creator);
  const captionSource = ordered.find((r) => r.sharedText);

  return {
    ...(creatorSource?.creator && {
      creator: { value: creatorSource.creator, provenance: fromExport(creatorSource) },
    }),
    ...(captionSource?.sharedText && {
      caption: { value: captionSource.sharedText, provenance: fromExport(captionSource) },
    }),
  };
}

function byOccurrence(a: SourceRecord, b: SourceRecord): number {
  if (a.occurredAt !== b.occurredAt) {
    if (a.occurredAt === undefined) return 1;
    if (b.occurredAt === undefined) return -1;
    return compare(a.occurredAt, b.occurredAt);
  }
  return compare(a.id, b.id);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
