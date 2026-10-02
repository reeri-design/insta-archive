import { isDeepStrictEqual } from "node:util";
import type { ArchiveItem, OriginalMetadata } from "../../domain/archive-item.ts";
import {
  importInstagramExport,
  resolveItemDetails,
} from "../../importers/instagram/import-export.ts";
import type {
  ExportFile,
  FileReport,
  ImportOptions,
  ImportWarning,
  SkippedEntry,
} from "../../importers/instagram/types.ts";
import {
  ArchiveIdentityConflictError,
  PersistenceIntegrityError,
  type ArchiveRepository,
} from "../../persistence/archive-repository.ts";

export type IngestionSummary = {
  files: FileReport[];
  /** Files that could not be read or parsed as JSON; nothing from them was imported. */
  unreadableFiles: { path: string; reason: string }[];
  sourceRecordsSeen: number;
  newSourceRecords: number;
  existingSourceRecords: number;
  uniqueItems: number;
  /** Items with more than one source record (including repeat DM shares). */
  multiSourceItems: number;
  /** Items found in more than one of Messages, Saved and Liked. */
  crossSourceItems: number;
  newItems: number;
  /** Already stored, and changed because this export added information. */
  updatedItems: number;
  unchangedItems: number;
  skipped: SkippedEntry[];
  warnings: ImportWarning[];
};

/**
 * Parses export files with the Instagram importer and stores the result in
 * one transaction: either the whole export is persisted or nothing is.
 *
 * Idempotent: items and source records are keyed by the importer's
 * deterministic ids, existing source records are never rewritten, and an
 * existing item's kind/original metadata are re-resolved from *all* of its
 * stored sources, so a later or partial export can add information but never
 * remove it. No media is fetched and no AI is called.
 */
export async function ingestInstagramExport(
  repository: ArchiveRepository,
  files: ExportFile[],
  options: ImportOptions,
  unreadableFiles: IngestionSummary["unreadableFiles"] = [],
): Promise<IngestionSummary> {
  const result = importInstagramExport(files, options);
  const warnings = [...result.warnings];
  const summary: IngestionSummary = {
    files: result.files,
    unreadableFiles,
    sourceRecordsSeen: result.items.reduce((n, i) => n + i.sources.length, 0),
    newSourceRecords: 0,
    existingSourceRecords: 0,
    uniqueItems: result.items.length,
    multiSourceItems: result.items.filter((i) => i.sources.length > 1).length,
    crossSourceItems: result.items.filter((i) => new Set(i.sources.map((s) => s.source)).size > 1)
      .length,
    newItems: 0,
    updatedItems: 0,
    unchangedItems: 0,
    skipped: result.skipped,
    warnings,
  };

  await repository.withTransaction(async (repo) => {
    for (const { item, sources } of result.items) {
      const stored = await repo.findArchiveItemByIdentity(item.ownerId, item.identity);
      if (stored && stored.id !== item.id) {
        throw new ArchiveIdentityConflictError(
          `Item ${stored.id} already holds the identity of ${item.id}`,
        );
      }
      if (!stored) await repo.saveArchiveItem(item);

      const added = await repo.addSourceRecords(sources);
      summary.newSourceRecords += added.inserted;
      summary.existingSourceRecords += added.existing;

      const aggregate = await repo.getArchiveItemAggregate(item.id);
      if (!aggregate) throw new PersistenceIntegrityError(`Item ${item.id} vanished mid-import`);
      const mergeWarnings: ImportWarning[] = [];
      const fromExport = resolveItemDetails(item.identity, aggregate.sources, item.id, mergeWarnings);
      if (stored) warnings.push(...newWarnings(mergeWarnings, warnings));

      const current: ArchiveItem = stored ?? { ...item, original: {} };
      const details = keepRetrievedDetails(current, fromExport);
      const itemChanged =
        current.kind !== details.kind || current.canonicalUrl !== details.canonicalUrl;
      const originalChanged = !isDeepStrictEqual(current.original, details.original);

      if (itemChanged) {
        await repo.saveArchiveItem({
          ...current,
          kind: details.kind,
          canonicalUrl: details.canonicalUrl,
          updatedAt: options.importedAt,
        });
      }
      if (originalChanged) await repo.saveOriginalMetadata(item.id, details.original);

      if (!stored) summary.newItems++;
      else if (itemChanged || originalChanged) summary.updatedItems++;
      else summary.unchangedItems++;
    }
  });

  return summary;
}

/**
 * Export-derived details win, but what only media retrieval supplied survives
 * a re-import: a kind the export cannot tell (with its canonical URL), and
 * original-metadata fields the export leaves empty.
 */
function keepRetrievedDetails(
  current: ArchiveItem,
  fromExport: Pick<ArchiveItem, "kind" | "canonicalUrl" | "original">,
): Pick<ArchiveItem, "kind" | "canonicalUrl" | "original"> {
  const keepKind = fromExport.kind === "unknown" && current.kind !== "unknown";
  const original: OriginalMetadata = { ...fromExport.original };
  for (const field of ["creator", "caption", "postedAt"] as const) {
    const existing = current.original[field];
    if (!original[field] && existing?.provenance.from === "retrieval") {
      (original as Record<string, unknown>)[field] = existing;
    }
  }
  return {
    kind: keepKind ? current.kind : fromExport.kind,
    canonicalUrl: keepKind ? current.canonicalUrl : fromExport.canonicalUrl,
    original,
  };
}

function newWarnings(candidates: ImportWarning[], existing: ImportWarning[]): ImportWarning[] {
  return candidates.filter(
    (c) => !existing.some((e) => e.message === c.message && e.archiveItemId === c.archiveItemId),
  );
}

/** Human-readable summary for the CLI. */
export function formatIngestionSummary(summary: IngestionSummary): string {
  const count = (kind: FileReport["kind"]) => summary.files.filter((f) => f.kind === kind).length;
  const lines = [
    `Files:               ${count("liked")} liked, ${count("saved")} saved, ` +
      `${count("messages")} message thread files` +
      (summary.unreadableFiles.length ? `, ${summary.unreadableFiles.length} unreadable` : ""),
    `Source records seen: ${summary.sourceRecordsSeen} ` +
      `(new ${summary.newSourceRecords}, already stored ${summary.existingSourceRecords})`,
    `Unique items:        ${summary.uniqueItems} (multi-source ${summary.multiSourceItems}, ` +
      `in more than one of Messages/Saved/Liked ${summary.crossSourceItems})`,
    `Persisted items:     new ${summary.newItems}, updated ${summary.updatedItems}, ` +
      `unchanged ${summary.unchangedItems}`,
    `Skipped entries:     ${summary.skipped.length}`,
    ...grouped(summary.skipped.map((s) => s.reason)),
    `Warnings:            ${summary.warnings.length}`,
    ...grouped(summary.warnings.map((w) => w.message)),
  ];
  for (const file of summary.unreadableFiles) lines.push(`  unreadable: ${file.path} (${file.reason})`);
  return lines.join("\n");
}

function grouped(messages: string[]): string[] {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts].map(([m, n]) => `  ${n} × ${m}`);
}
