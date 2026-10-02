import type { IsoDateTime } from "../../domain/archive-item.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Instagram exports write UTF-8 text byte-by-byte as \u00XX code points
 * ("’" arrives as "â\u0080\u0099"). Reverse that. Strings that are not
 * such mojibake are returned unchanged.
 */
export function decodeExportText(value: string): string {
  if (!/[\u0080-ÿ]/.test(value)) return value;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0xff) return value;
    bytes[i] = code;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return value;
  }
}

/** Decoded, non-blank text, or undefined. Instagram uses "" for "none". */
export function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return decodeExportText(value);
}

/** Unix seconds (Likes, Saved) → ISO. */
export function secondsToIso(value: unknown): IsoDateTime | undefined {
  return isValidEpoch(value) ? new Date(value * 1000).toISOString() : undefined;
}

/** Unix milliseconds (Messages) → ISO. */
export function millisToIso(value: unknown): IsoDateTime | undefined {
  return isValidEpoch(value) ? new Date(value).toISOString() : undefined;
}

function isValidEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
