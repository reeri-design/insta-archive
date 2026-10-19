/**
 * Enriches a small, explicit batch of ArchiveItems with an AI organization.
 * Uses only media already stored; never downloads anything.
 *
 *   npm run enrich:ai -- --limit 10 [--item <shortcode> ...] [options]
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { MAIN_ARCHIVE_SOURCES } from "../domain/archive-scope.ts";
import { aiEnrichmentLeaseMsFromEnv, runEnrichmentBatch, selectItemsForEnrichment, MAX_ENRICHMENT_LIMIT } from "../ai/enrichment-batch.ts";
import { AiEnrichmentService, type EnrichmentResult } from "../ai/enrichment-service.ts";
import { createOrganizationProvider } from "../ai/providers/index.ts";
import { FfmpegFrameExtractor } from "../media/instagram/ffmpeg-frame-extractor.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run enrich:ai -- --limit <n> [options]

  --limit <n>          Required, 1–${MAX_ENRICHMENT_LIMIT}. Items to enrich in this run.
  --item <shortcode>   Enrich these items (repeatable). Otherwise items without an
                       AI organization: new captures first (imported after the
                       initial import), then a varied sample of the backfill.
  --require-media      Only items with stored media; any whose media the AI cannot
                       use are skipped, never sent metadata-only.
  --dry-run            Show which items would be enriched; no AI calls.
  --delay-ms <ms>      Pause between items (default 1000).
  --owner-id <id>      Archive owner (default "local").
  --database <path>    SQLite file (default: DATABASE_PATH).
  -h, --help

The AI provider and model come from AI_PROVIDER / AI_MODEL (see docs/ai-enrichment.md).
Stops early on a rate limit or missing/invalid credentials.

Each item is claimed before it is processed (a lease of AI_ENRICHMENT_LEASE_MS,
default 10 minutes), so several runs can work at once without processing the
same item; items another run holds are passed over.

A failure is recorded per item. Items the provider rejected (HTTP 400) are no
longer chosen by normal runs; name them with --item to retry. Temporary failures
are retried after a backoff (1, 5, 15, then 30 minutes), recorded in the
database so every run respects it. Other failures stay eligible; a success
clears the record.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      item: { type: "string", multiple: true },
      "require-media": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "delay-ms": { type: "string", default: "1000" },
      "owner-id": { type: "string", default: "local" },
      database: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const limit = Number(values.limit);
  const delayMs = Number(values["delay-ms"]);
  if (values.help || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENRICHMENT_LIMIT || !(delayMs >= 0)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const db = openDatabase(values.database ? resolve(values.database) : databasePathFromEnv());
  try {
    const repository = new SqliteArchiveRepository(db);
    const ownerId = values["owner-id"] as UserId;

    if (values["dry-run"]) {
      const ids = await selectItemsForEnrichment({ repository, ownerId, limit, ...(values.item && { shortcodes: values.item }), requireMedia: values["require-media"] });
      const priority = new Map(
        (await repository.listAiEnrichmentCandidates(ownerId, { sources: MAIN_ARCHIVE_SOURCES })).map((c) => [c.itemId, c.priority]),
      );
      const fresh = ids.filter((id) => priority.get(id) === "new").length;
      console.log(`Would enrich ${ids.length} item(s): ${fresh} new, ${ids.length - fresh} backfill (no AI calls made):\n`);
      for (const [n, itemId] of ids.entries()) {
        const aggregate = await repository.getArchiveItemAggregate(itemId);
        if (!aggregate) continue;
        const sources = [...new Set(aggregate.sources.map((s) => s.source))].sort().join("+");
        const creator = aggregate.item.original.creator?.value.username;
        const caption = aggregate.item.original.caption?.value.replace(/\s+/g, " ").slice(0, 60);
        const media = aggregate.media.some((m) => m.retrieval.status === "stored") ? "media" : "metadata-only";
        console.log(`${String(n + 1).padStart(2)}. ${itemId.split(":").pop()?.padEnd(12)} ${(priority.get(itemId) ?? "-").padEnd(8)} ${aggregate.item.kind.padEnd(8)} ${sources.padEnd(15)} ${media.padEnd(13)} ${creator ? `@${creator}` : "-"}  ${caption ? JSON.stringify(caption) : "(no caption)"}`);
      }
      return 0;
    }

    const provider = createOrganizationProvider();
    const service = new AiEnrichmentService({
      repository,
      storage: new LocalMediaStorage(mediaStorageDirFromEnv()),
      provider,
      frameExtractor: new FfmpegFrameExtractor(),
    });
    console.log(`Provider: ${provider.provider}, model ${provider.model}\n`);
    // This run's identity for its enrichment claims.
    const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    const summary = await runEnrichmentBatch({
      service,
      repository,
      ownerId,
      limit,
      ...(values.item && { shortcodes: values.item }),
      requireMedia: values["require-media"],
      delayMs,
      claims: { workerId, leaseMs: aiEnrichmentLeaseMsFromEnv() },
      onResult: (result) => console.log(formatResult(result)),
    });
    console.log(
      [
        "",
        `Attempted:     ${summary.attempted}`,
        `Enriched:      ${summary.enriched}`,
        `Skipped:       ${summary.skipped}`,
        `Failed:        ${summary.failed}`,
        `Rate limited:  ${summary.rateLimited ? "yes, stopped early" : "no"}`,
        `Held by others: ${summary.claimedElsewhere} (passed over)`,
        `Rejected before: ${summary.providerRejected} (passed over; retry with --item)`,
        `Backing off:   ${summary.backingOff} (temporary failure, retry time not reached)`,
        ...(summary.stoppedForAuthentication ? ["Stopped:       credentials missing or rejected"] : []),
        `Tokens:        ${summary.inputTokens} input, ${summary.outputTokens} output`,
        `Duration:      ${((Date.now() - started) / 1000).toFixed(1)} s`,
      ].join("\n"),
    );
    return 0;
  } finally {
    db.close();
  }
}

function formatResult(result: EnrichmentResult): string {
  const id = result.itemId.split(":").pop();
  if (result.status === "enriched") {
    const o = result.organization;
    return `${result.reenriched ? "re-enriched (media added)" : "enriched"}  ${id}  [${result.mediaUsed ? `media ×${result.imageCount}` : "metadata-only"}]  ${o.fields.type}/${o.fields.category}  conf ${o.confidence}  (${o.model}, ${o.promptVersion})`;
  }
  return `${result.status.padEnd(8)}  ${id}  ${result.status === "failed" ? `${result.kind}: ` : ""}${result.reason}`;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
