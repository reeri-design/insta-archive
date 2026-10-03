/**
 * Enriches a small, explicit batch of ArchiveItems with an AI organization.
 * Uses only media already stored; never downloads anything.
 *
 *   npm run enrich:ai -- --limit 10 [--item <shortcode> ...] [options]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UserId } from "../domain/archive-item.ts";
import { runEnrichmentBatch, selectItemsForEnrichment, MAX_ENRICHMENT_LIMIT } from "../ai/enrichment-batch.ts";
import { AiEnrichmentService, type EnrichmentResult } from "../ai/enrichment-service.ts";
import { createOrganizationProvider } from "../ai/providers/index.ts";
import { FfmpegFrameExtractor } from "../media/instagram/ffmpeg-frame-extractor.ts";
import { LocalMediaStorage, mediaStorageDirFromEnv } from "../media/local-media-storage.ts";
import { databasePathFromEnv, openDatabase } from "../persistence/sqlite/database.ts";
import { SqliteArchiveRepository } from "../persistence/sqlite/sqlite-archive-repository.ts";

const USAGE = `Usage: npm run enrich:ai -- --limit <n> [options]

  --limit <n>          Required, 1–${MAX_ENRICHMENT_LIMIT}. Items to enrich in this run.
  --item <shortcode>   Enrich these items (repeatable); otherwise a deterministic,
                       varied sample of items without an AI organization.
  --dry-run            Show which items would be enriched; no AI calls.
  --delay-ms <ms>      Pause between items (default 1000).
  --owner-id <id>      Archive owner (default "local").
  --database <path>    SQLite file (default: DATABASE_PATH).
  -h, --help

The AI provider and model come from AI_PROVIDER / AI_MODEL (see docs/ai-enrichment.md).
Stops early on a rate limit or missing/invalid credentials.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string" },
      item: { type: "string", multiple: true },
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
      const ids = await selectItemsForEnrichment({ repository, ownerId, limit, ...(values.item && { shortcodes: values.item }) });
      console.log(`Would enrich ${ids.length} item(s) (no AI calls made):\n`);
      for (const [n, itemId] of ids.entries()) {
        const aggregate = await repository.getArchiveItemAggregate(itemId);
        if (!aggregate) continue;
        const sources = [...new Set(aggregate.sources.map((s) => s.source))].sort().join("+");
        const creator = aggregate.item.original.creator?.value.username;
        const caption = aggregate.item.original.caption?.value.replace(/\s+/g, " ").slice(0, 60);
        const media = aggregate.media.some((m) => m.retrieval.status === "stored") ? "media" : "metadata-only";
        console.log(`${String(n + 1).padStart(2)}. ${itemId.split(":").pop()?.padEnd(12)} ${aggregate.item.kind.padEnd(8)} ${sources.padEnd(15)} ${media.padEnd(13)} ${creator ? `@${creator}` : "-"}  ${caption ? JSON.stringify(caption) : "(no caption)"}`);
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
    const started = Date.now();
    const summary = await runEnrichmentBatch({
      service,
      repository,
      ownerId,
      limit,
      ...(values.item && { shortcodes: values.item }),
      delayMs,
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
    return `enriched  ${id}  [${result.mediaUsed ? `media ×${result.imageCount}` : "metadata-only"}]  ${o.fields.type}/${o.fields.category}  conf ${o.confidence}  (${o.model}, ${o.promptVersion})`;
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
