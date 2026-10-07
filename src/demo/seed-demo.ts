/**
 * A tiny seeded demo archive (placeholder content, not the final curated
 * demo set). Built through the same paths as a real archive — the Instagram
 * importer and the repository — from the repository's own synthetic test
 * export, plus a few generated placeholder images. Nothing here comes from a
 * personal archive.
 *
 * Writes only to the repository and media storage it is given; the CLI
 * (src/cli/seed-demo.ts) gives it the demo archive's.
 */
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import type { ArchiveItemId, IsoDateTime, MediaAsset, MediaAssetId, UserId } from "../domain/archive-item.ts";
import { contentAssetId, newRetrievalRequest, recordRetrievalSuccess, RETRIEVAL_PRIORITY } from "../domain/media-retrieval.ts";
import { ingestInstagramExport, type IngestionSummary } from "../ingestion/instagram/ingest-export.ts";
import { readExportDirectory } from "../ingestion/instagram/read-export-directory.ts";
import type { ArchiveRepository } from "../persistence/archive-repository.ts";
import { storageKeyFor, type MediaStorage } from "../media/media-storage.ts";

/** The synthetic export the importer's tests use: a handful of made-up posts, reels and DMs. */
export const DEMO_EXPORT_DIR = join(import.meta.dirname, "../importers/instagram/__fixtures__");

/** Placeholder images per demo item (shortcode → slide colours), so the demo has media and media-less tiles. */
const DEMO_IMAGES: Record<string, [number, number, number][]> = {
  CarouBBB222: [[214, 196, 172], [168, 182, 160]],
  BareDDD444: [[196, 176, 204]],
};

export type DemoSeedSummary = { ingestion: IngestionSummary; images: number };

export async function seedDemoArchive(options: {
  repository: ArchiveRepository;
  storage: MediaStorage;
  ownerId: UserId;
  now?: () => IsoDateTime;
}): Promise<DemoSeedSummary> {
  const { repository, storage, ownerId } = options;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const ingestion = await ingestInstagramExport(repository, readExportDirectory(DEMO_EXPORT_DIR).files, { ownerId, importedAt: now });

  let images = 0;
  for (const [shortcode, colours] of Object.entries(DEMO_IMAGES)) {
    const item = await repository.findArchiveItemByIdentity(ownerId, { kind: "shortcode", shortcode });
    if (!item) continue;
    const assets: MediaAsset[] = [];
    for (const [position, colour] of colours.entries()) {
      const id = contentAssetId(item.id, position);
      const bytes = placeholderPng(480, 600, colour);
      const { storageKey } = await storage.put(storageKeyFor(item.id, id, "image/png"), bytes);
      assets.push({
        id: id as MediaAssetId,
        archiveItemId: item.id as ArchiveItemId,
        mediaType: "image",
        role: "content",
        position,
        retrieval: { status: "stored", storageKey, mimeType: "image/png", retrievedAt: now, byteLength: bytes.byteLength, width: 480, height: 600 },
      });
      images++;
    }
    await repository.saveMediaAssets(assets);
    // Marked as retrieved, so nothing would ever try to fetch these made-up posts.
    await repository.saveMediaRetrievalRequest(recordRetrievalSuccess(newRetrievalRequest(item.id, RETRIEVAL_PRIORITY.normal, now), now));
  }
  return { ingestion, images };
}

/** A soft vertical gradient in one colour, as a PNG (no dependencies: zlib + CRC). */
export function placeholderPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const shade = 1 - (y / height) * 0.18;
    const offset = y * (width * 3 + 1); // first byte of each row: filter type 0
    for (let x = 0; x < width; x++) {
      const i = offset + 1 + x * 3;
      rows[i] = Math.round(r * shade);
      rows[i + 1] = Math.round(g * shade);
      rows[i + 2] = Math.round(b * shade);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
