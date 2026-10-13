"use client";

import { useState } from "react";
import type { ViewableMedia } from "../../../archive-view/archive-view.ts";
import { MediaViewer } from "../../media-viewer.tsx";

const NOTES: Partial<Record<ViewableMedia["role"], string>> = {
  cover: "Cover image chosen by the creator · video unavailable",
  frame: "Frames kept from the video · the video itself wasn't kept",
};

/** The item's media, large: slides, video, frames or cover, browsable in place (arrow keys too). */
export function DetailMedia({ media }: { media: ViewableMedia[] }) {
  const [index, setIndex] = useState(0);
  const count = media.length;
  const step = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const note = NOTES[media[0]!.role];
  return (
    <figure
      className="detail-media"
      aria-label={count > 1 ? `Media, ${count} ${media[0]!.role === "frame" ? "frames" : "slides"}` : "Media"}
      onKeyDown={(event) => {
        if (count < 2 || (event.target as HTMLElement).tagName === "VIDEO") return;
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
        else return;
        event.preventDefault();
      }}
    >
      <MediaViewer media={media} index={index} onStep={step} sizes="(max-width: 860px) 100vw, 60vw" />
      {note && <figcaption>{note}</figcaption>}
    </figure>
  );
}
