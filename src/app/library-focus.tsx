"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import type { MediaState } from "../archive-view/archive-view.ts";
import type { LibraryItem } from "../library/library-item.ts";
import { MediaViewer } from "./media-viewer.tsx";

/** Focus shows a library item: its media, identifying text, source and actions. */
export type FocusItem = LibraryItem;

/** Plain words for why there is nothing to look at (no retrieval details). */
const STATE_NOTES: Record<Exclude<MediaState, "available">, string> = {
  pending: "media not saved yet",
  failed: "media not saved yet",
  unavailable: "media unavailable",
};

/** The honest note on the source line: what the media is, when it is not simply the post. */
function mediaNote(item: FocusItem): string | undefined {
  const [first] = item.media;
  if (!first) return item.mediaState === "available" ? undefined : STATE_NOTES[item.mediaState];
  if (first.role === "cover") return "video unavailable";
  if (first.role === "frame") return `${item.media.length} ${item.media.length === 1 ? "frame" : "frames"} from the video`;
  return item.media.length > 1 ? `${item.media.length} slides` : undefined;
}

/** Height ÷ width of an item's first media from its stored size (4:5 when unknown); undefined without media. */
export function focusRatioOf(item: FocusItem): number | undefined {
  const first = item.media[0];
  if (!first) return undefined;
  return first.width && first.height ? first.height / first.width : 1.25;
}

/**
 * The focused piece, rendered inside the library cell it grew from: the
 * media (slides, video or frames usable in place), one quiet line of
 * context, and Details / Open original / ×. Reports its rendered height so
 * the field can make room for it.
 */
export function FocusPiece({
  item,
  width,
  onClose,
  onHeight,
  onDetails,
}: {
  item: FocusItem;
  /** Called just before Details opens (the canvas remembers its view for Back). */
  onDetails?: () => void;
  /** Its final width; the cell around it grows to this. */
  width: number;
  onClose: () => void;
  onHeight: (height: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const count = item.media.length;
  const current = item.media[index];
  const piece = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = piece.current;
    if (!element) return;
    const report = () => onHeight(Math.ceil(element.offsetHeight));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeight]);

  // Grow out of the tile: the cell is still at the tile's width when this mounts, and
  // transitions to `width`; scaling from that same width keeps content and cell in step.
  useLayoutEffect(() => {
    const element = piece.current;
    const cell = element?.parentElement;
    if (!element || !cell || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = cell.getBoundingClientRect().width;
    if (from > 0 && Math.abs(from - width) > 2) {
      element.animate([{ transform: `scale(${from / width})` }, { transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
    }
    // Only when the piece first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = (delta: number) => setIndex((i) => (i + delta + count) % count);

  const sourceLine = [item.source.name, item.source.handle, mediaNote(item)].filter(Boolean).join(" · ");

  return (
    <section
      ref={piece}
      className={current ? "focus-piece" : "focus-piece focus-piece-text"}
      aria-label={item.label}
      tabIndex={-1}
      style={{ width }}
      onKeyDown={(event) => {
        if (count < 2 || (event.target as HTMLElement).tagName === "VIDEO") return;
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
        else return;
        event.preventDefault();
      }}
    >
      {current ? (
        <MediaViewer media={item.media} index={index} onStep={step} sizes="(max-width: 520px) 90vw, 480px" />
      ) : (
        <div className="focus-text">
          {item.text ? <blockquote>{item.text}</blockquote> : <p>{item.kindLabel === "Saved item" ? "A saved item" : `A saved ${item.kindLabel.toLowerCase()}`}</p>}
        </div>
      )}

      <div className="focus-info">
        {current && item.title && <p className="focus-title">{item.title}</p>}
        <a className="focus-source" href={item.source.url} target="_blank" rel="noreferrer">
          {sourceLine} <span aria-hidden="true">↗</span>
        </a>
        <div className="focus-actions">
          <Link href={item.detailsHref} className="focus-action" onClick={onDetails}>
            Details
          </Link>
          <button type="button" className="focus-close" onClick={onClose} aria-label="Close focus">
            ×
          </button>
        </div>
      </div>
    </section>
  );
}
