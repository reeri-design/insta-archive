/**
 * Shapes for the library: each tile's height ÷ width (decided on the server)
 * and the focused item's size. Placement on the canvas is canvas-layout.ts.
 * No React, no Node APIs.
 */
import type { ArchiveCard } from "../archive-view/archive-view.ts";

/** Height ÷ width limits: very tall or very wide media is cropped to stay browsable. */
export const MIN_TILE_RATIO = 0.55;
export const MAX_TILE_RATIO = 1.8;
/** For stored media without recorded dimensions: a neutral 4:5 portrait box (cropped to fit). */
export const UNKNOWN_MEDIA_RATIO = 1.25;

/**
 * A tile's height ÷ width. Media uses its stored pixel size (never guessed);
 * media-less tiles get a few fixed shapes by caption length, so the text
 * field has rhythm without measuring text.
 */
export function tileRatio(card: Pick<ArchiveCard, "preview" | "caption">): number {
  const { preview } = card;
  if (preview) {
    if (!preview.width || !preview.height) return UNKNOWN_MEDIA_RATIO;
    return Math.min(MAX_TILE_RATIO, Math.max(MIN_TILE_RATIO, preview.height / preview.width));
  }
  return textShape(card.caption).ratio;
}

/** Fixed shapes for media-less tiles: the ratio and how many caption lines fit. */
export function textShape(caption: string | undefined): { ratio: number; lines: number } {
  const length = caption?.trim().length ?? 0;
  if (length === 0) return { ratio: 0.45, lines: 0 };
  if (length <= 80) return { ratio: 0.7, lines: 3 };
  if (length <= 220) return { ratio: 1, lines: 6 };
  return { ratio: 1.3, lines: 9 };
}

/** Focus enlarges moderately: about this many tile widths. */
export const FOCUS_SCALE = 1.5;
/** ...but at least this wide where the viewport allows, so its information stays readable. */
export const FOCUS_MIN_WIDTH = 320;

/**
 * The focused item's width: about 1.5× a tile (at least FOCUS_MIN_WIDTH, never
 * wider than the viewport allows), narrowed so media of height ÷ width `ratio`
 * fits within `maxMediaHeight` (but not below 1.2× a tile).
 */
export function focusWidth(
  tileWidth: number,
  options: { viewportWidth: number; ratio?: number; maxMediaHeight: number },
): number {
  const room = Math.max(tileWidth, options.viewportWidth - 48);
  let width = Math.min(room, Math.max(FOCUS_SCALE * tileWidth, Math.min(FOCUS_MIN_WIDTH, room)));
  if (options.ratio && options.ratio > 0) width = Math.max(Math.min(width, 1.2 * tileWidth), Math.min(width, options.maxMediaHeight / options.ratio));
  return Math.round(width);
}
