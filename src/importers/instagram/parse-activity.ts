import type { Creator, ExportLocation } from "../../domain/archive-item.ts";
import { identityKey, parseInstagramUrl } from "./instagram-url.ts";
import { isRecord, nonEmptyText, secondsToIso } from "./text.ts";
import type { ParseOutcome, ParsedExportRecord } from "./types.ts";

/**
 * Parses likes/liked_posts.json and saved/saved_posts.json. Both are an array
 * of `{ timestamp, media, label_values, fbid }` where `label_values` mixes
 * `{ label, value, href? }` rows (URL, Caption, Title) with titled `dict`
 * groups (Hashtags, Owner, Brand partner).
 */
export function parseActivityFile(
  source: "liked" | "saved",
  path: string,
  data: unknown,
  exportId: string | undefined,
): ParseOutcome {
  const outcome: ParseOutcome = { records: [], skipped: [], warnings: [], ignored: 0 };
  const location = (pointer?: string): ExportLocation => ({
    file: path,
    ...(pointer !== undefined && { pointer }),
    ...(exportId !== undefined && { exportId }),
  });

  if (!Array.isArray(data)) {
    outcome.skipped.push({ exportLocation: location(), reason: "expected a JSON array" });
    return outcome;
  }

  data.forEach((entry, index) => {
    const exportLocation = location(`/${index}`);
    if (!isRecord(entry) || !Array.isArray(entry.label_values)) {
      outcome.skipped.push({ exportLocation, reason: "entry has no label_values" });
      return;
    }
    const rows = entry.label_values.filter(isRecord);

    const urlRow = rows.find((row) => row.label === "URL");
    const originalUrl =
      typeof urlRow?.href === "string" && urlRow.href !== ""
        ? urlRow.href
        : typeof urlRow?.value === "string" && urlRow.value !== ""
          ? urlRow.value
          : undefined;
    if (!originalUrl) {
      outcome.skipped.push({ exportLocation, reason: "entry has no URL" });
      return;
    }
    const parsed = parseInstagramUrl(originalUrl);
    if (!parsed.ok) {
      outcome.skipped.push({ exportLocation, reason: parsed.reason });
      return;
    }

    // An entry can repeat the Caption row; keep each distinct text once.
    const captions = [
      ...new Set(
        rows
          .filter((row) => row.label === "Caption")
          .map((row) => nonEmptyText(row.value))
          .filter((text) => text !== undefined),
      ),
    ];

    const occurredAt = secondsToIso(entry.timestamp);
    const creator = parseOwner(rows);
    const fbid = typeof entry.fbid === "string" && entry.fbid !== "" ? entry.fbid : undefined;
    const record: ParsedExportRecord = {
      source,
      naturalKey: fbid
        ? `${source}:fbid:${fbid}`
        : `${source}:${String(entry.timestamp)}:${identityKey(parsed.content.identity)}`,
      originalUrl,
      url: parsed.content,
      ...(occurredAt && { occurredAt }),
      ...(creator && { creator }),
      captions,
      exportLocation,
      raw: structuredClone(entry),
    };
    outcome.records.push(record);
  });

  return outcome;
}

/**
 * The "Owner" group: `{ title: "Owner", dict: [{ dict: [URL, Name, Username] }] }`.
 * Owner "URL" is the creator's external website (linktr.ee, portfolio, ...),
 * not their Instagram profile, so it is not mapped to Creator.profileUrl.
 */
function parseOwner(rows: Record<string, unknown>[]): Creator | undefined {
  const group = rows.find((row) => row.title === "Owner" && Array.isArray(row.dict));
  const first = (group?.dict as unknown[] | undefined)?.find(isRecord);
  const fields = Array.isArray(first?.dict) ? first.dict.filter(isRecord) : [];
  const field = (label: string) =>
    nonEmptyText(fields.find((f) => f.label === label)?.value);

  const username = field("Username");
  const displayName = field("Name");
  if (!username && !displayName) return undefined;
  return {
    ...(username && { username }),
    ...(displayName && { displayName }),
  };
}
