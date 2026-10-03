/**
 * Parses a single HTTP Range header ("bytes=start-end", "bytes=start-" or
 * "bytes=-suffix") against a body of `size` bytes. Browsers need this to
 * play and seek video. Multiple ranges are not supported (the whole body is
 * sent instead, which HTTP allows).
 *
 * Returns the inclusive byte range to send, "unsatisfiable" for a range
 * outside the body, or undefined to send the whole body.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return undefined;
  if (from === "") {
    // Suffix range: the last N bytes.
    const length = Number(to);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}
