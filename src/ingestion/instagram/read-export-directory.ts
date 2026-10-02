import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { classifyExportFile } from "../../importers/instagram/import-export.ts";
import type { ExportFile } from "../../importers/instagram/types.ts";

export type ExportDirectory = {
  /** Supported files, JSON-parsed, with paths relative to the directory. */
  files: ExportFile[];
  unreadableFiles: { path: string; reason: string }[];
};

/**
 * Finds the export files the importer supports (Liked, Saved, Messages)
 * anywhere under `root`, which may be the unpacked export or its
 * `your_instagram_activity` folder. Other files are not read.
 */
export function readExportDirectory(root: string): ExportDirectory {
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);

  const paths = readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".json") && classifyExportFile(path) !== "unsupported")
    .sort();

  const result: ExportDirectory = { files: [], unreadableFiles: [] };
  for (const path of paths) {
    try {
      result.files.push({ path, data: JSON.parse(readFileSync(join(root, path), "utf8")) });
    } catch (error) {
      result.unreadableFiles.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
