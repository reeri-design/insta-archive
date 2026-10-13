/**
 * Parses a single HTTP Range header ("bytes=start-end", "bytes=start-" or
 * "bytes=-suffix") against a body of `size` bytes. Browsers need this to
 * play and seek video. Multiple ranges are not supported (the whole body is
 * sent instead, which HTTP allows).
 *
 * Returns the inclusive byte range to send, "unsatisfiable" for a range
 * outside the body, or undefined to send the whole body.
 *
 * With `maxOpenEndedBytes`, an open-ended range ("bytes=start-") is answered
 * with at most that many bytes, as video servers commonly do: the browser asks
 * for the next part when playback needs it. Without it, a page of video
 * previews that only want a first frame would each pull the whole file.
 */
export function parseByteRange(
  header: string | null,
  size: number,
  options: { maxOpenEndedBytes?: number } = {},
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
  const cap = options.maxOpenEndedBytes;
  const end =
    to === "" ? (cap && cap > 0 ? Math.min(size - 1, start + cap - 1) : size - 1) : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}
