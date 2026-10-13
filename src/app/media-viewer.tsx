"use client";

import Image from "next/image";
import { useRef, type CSSProperties, type PointerEvent } from "react";
import type { ViewableMedia } from "../archive-view/archive-view.ts";

/**
 * An item's media, usable in place: an image, a playable video (never
 * autoplayed; the browser's own controls), or a sequence — carousel slides or
 * frames kept from a Reel — with previous/next, swipe, and a quiet position
 * marker. A cover is labelled as the cover, never presented as the video.
 *
 * Controlled: the parent owns `index` (so it can also step with the keyboard).
 * The box keeps the first media's proportions; other slides fit inside it.
 */
export function MediaViewer({
  media,
  index,
  onStep,
  sizes,
}: {
  media: readonly ViewableMedia[];
  index: number;
  onStep: (delta: number) => void;
  sizes: string;
}) {
  const swipeStart = useRef<number | undefined>(undefined);
  const count = media.length;
  const current = media[index];
  if (!current) return null;
  const first = media[0]!;
  const ratio = first.width && first.height ? first.height / first.width : 1.25;

  const onPointerDown = (event: PointerEvent) => {
    if (count > 1 && current.mediaType !== "video") swipeStart.current = event.clientX;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (swipeStart.current === undefined) return;
    const dx = event.clientX - swipeStart.current;
    swipeStart.current = undefined;
    if (Math.abs(dx) > 40) onStep(dx < 0 ? 1 : -1);
  };

  const position = count > 1 ? `${current.role === "frame" ? "Frame " : ""}${index + 1} / ${count}` : current.role === "cover" ? "Cover" : undefined;

  return (
    <div
      className="media-viewer"
      style={{ aspectRatio: `1 / ${ratio}`, "--media-ratio": ratio } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipeStart.current = undefined)}
    >
      {current.mediaType === "video" ? (
        <video key={current.url} src={`${current.url}#t=0.1`} controls playsInline preload="metadata" />
      ) : (
        <Image key={current.url} src={current.url} alt="" fill sizes={sizes} unoptimized draggable={false} />
      )}
      {position && (
        <span className="media-position" aria-live="polite">
          {position}
        </span>
      )}
      {count > 1 && (
        <>
          <button type="button" className="media-step media-step-prev" onClick={() => onStep(-1)} aria-label="Previous">
            ‹
          </button>
          <button type="button" className="media-step media-step-next" onClick={() => onStep(1)} aria-label="Next">
            ›
          </button>
        </>
      )}
    </div>
  );
}
