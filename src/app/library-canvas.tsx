"use client";

import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ArchiveCanvas,
  focusCamera,
  packAroundFocus,
  type Camera,
  type Occurrence,
  type Rect,
} from "../library/canvas-layout.ts";
import { FOCUS_PARAM } from "../library/focus-param.ts";
import type { LibraryItem } from "../library/library-item.ts";
import { focusWidth } from "../library/library-layout.ts";
import { FocusPiece, focusRatioOf } from "./library-focus.tsx";
import { Tile } from "./library-tile.tsx";

/** Marks history entries pushed by opening Focus, so closing can step back instead of adding an entry. */
const HISTORY_KEY = "libraryFocus";
/** The view (camera, focused occurrence) kept in this history entry when Details opens, for Back. */
const VIEW_KEY = "libraryView";
/** Tells Details it was opened from here, so its Back returns to this exact view (see back-link.tsx). */
const RETURN_KEY = "library:return-to";

type SavedView = { camera: Camera; clicked?: { key: string; column: number; row: number }; beforeFocus?: Camera };

function savedView(): SavedView | undefined {
  if (typeof window === "undefined") return undefined;
  const view = window.history.state?.[VIEW_KEY] as SavedView | undefined;
  return view && typeof view.camera?.x === "number" ? view : undefined;
}
/** One duration for every part of a move (camera, cells). */
const MOVE_MS = 460;
/** Room the focused item's information layer takes below its media, until measured. */
const INFO_ESTIMATE = 104;
/** Canvas pixels rendered beyond each edge of the viewport; the rest is not in the DOM. */
const RENDER_MARGIN = 700;
/** A press that moves less than this is a click, not a pan. */
const DRAG_THRESHOLD = 6;

type Metrics = {
  columnWidth: number;
  gap: number;
  /** Page margin: where the canvas origin sits horizontally at rest. */
  margin: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Bottom of the top chrome (header, search): focus settles below it. */
  top: number;
};

/**
 * The library as an infinite canvas seen through a camera.
 *
 *   archive items → canvas coordinates (ArchiveCanvas) → camera → viewport
 *
 * The camera is the canvas point at the viewport's top-left. It is the one
 * thing that moves when you look around: dragging, touch, trackpad/wheel and
 * arrow keys move it directly (no React render per frame), and Focus moves the
 * same camera to the focused item. Only occurrences near the viewport are in
 * the DOM; React re-renders when the camera leaves that window.
 *
 * Focus (?focus=<key>) is a state of the canvas: the focused occurrence grows
 * about 1.5× where it is, its neighbours slide aside, and the camera glides to
 * bring it into a comfortable spot. Everything else stays visible and
 * clickable; manual panning never touches history.
 */
export function LibraryCanvas({ items, restoreView = true }: { items: LibraryItem[]; /** False for a canvas that replaces another in place (Shuffle). */ restoreView?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [metrics, setMetrics] = useState<Metrics>();
  const [renderWindow, setRenderWindow] = useState<Rect>();
  // Returning (Back from Details): start from the view this history entry remembers.
  const [restored] = useState(() => (restoreView ? savedView() : undefined));
  const [clicked, setClicked] = useState<{ key: string; column: number; row: number } | undefined>(restored?.clicked);
  const [pieceHeight, setPieceHeight] = useState<{ key: string; height: number }>();
  const searchParams = useSearchParams();
  const focusKey = searchParams.get(FOCUS_PARAM);
  /** The running glide or momentum, if any; `to` is where a glide is heading. */
  const motion = useRef<{ stop: () => void; to?: Camera } | undefined>(undefined);
  /** Mirrors renderWindow, so camera moves can tell whether React needs to render at all. */
  const renderedWindow = useRef<Rect | undefined>(undefined);
  const drag = useRef<{ id: number; x: number; y: number; cx: number; cy: number; moved: boolean; vx: number; vy: number; t: number }>(undefined);
  const suppressClick = useRef(false);
  const beforeFocus = useRef<{ camera: Camera; panned: boolean } | undefined>(undefined);

  const indexByKey = useMemo(() => new Map(items.map((item, i) => [item.key, i])), [items]);
  const canvas = useMemo(
    () => metrics && new ArchiveCanvas({ ratios: items.map((i) => i.ratio), columnWidth: metrics.columnWidth, gap: metrics.gap }),
    [items, metrics],
  );

  // ---- camera ------------------------------------------------------------------------------

  const applyCamera = useCallback(() => {
    const { x, y, zoom } = camera.current;
    if (world.current) world.current.style.transform = `translate3d(${-x}px, ${-y}px, 0) scale(${zoom})`;
    // Re-render only when the view nears the edge of what is in the DOM. Camera moves happen
    // every frame; touching React state on each one (even with an unchanged value) schedules
    // urgent renders that keep interrupting other work, such as a pending navigation.
    if (!metrics) return;
    const current = renderedWindow.current;
    const view = { x, y, width: metrics.viewportWidth, height: metrics.viewportHeight };
    const slack = RENDER_MARGIN / 2; // re-window once the view comes within half the margin of the edge
    if (
      current &&
      view.x - slack >= current.x &&
      view.y - slack >= current.y &&
      view.x + view.width + slack <= current.x + current.width &&
      view.y + view.height + slack <= current.y + current.height
    ) {
      return;
    }
    const next = { x: x - RENDER_MARGIN, y: y - RENDER_MARGIN, width: view.width + 2 * RENDER_MARGIN, height: view.height + 2 * RENDER_MARGIN };
    renderedWindow.current = next;
    setRenderWindow(next);
  }, [metrics]);

  const stopMotion = () => {
    motion.current?.stop();
    motion.current = undefined;
  };

  /** Glides the camera to `to` (instantly with reduced motion). */
  const moveCamera = useCallback(
    (to: Camera) => {
      motion.current?.stop();
      const from = { ...camera.current };
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        camera.current = to;
        applyCamera();
        return;
      }
      let frame = 0;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / MOVE_MS);
        const e = 1 - (1 - t) ** 4; // close to the cells' ease-out curve
        camera.current = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, zoom: to.zoom };
        applyCamera();
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      motion.current = { stop: () => cancelAnimationFrame(frame), to };
    },
    [applyCamera],
  );

  /** A manual move: stops any glide, and means "don't return me to where I was" on close. */
  const panBy = useCallback(
    (dx: number, dy: number) => {
      stopMotion();
      if (beforeFocus.current) beforeFocus.current.panned = true;
      camera.current = { ...camera.current, x: camera.current.x + dx, y: camera.current.y + dy };
      applyCamera();
    },
    [applyCamera],
  );

  // ---- measuring ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const columns = Number.parseInt(style.getPropertyValue("--grid-columns"), 10) || 4;
      const gap = Number.parseFloat(style.getPropertyValue("--canvas-gap")) || 16;
      const margin = Number.parseFloat(style.getPropertyValue("--page-margin")) || 24;
      const width = element.clientWidth;
      const chrome = document.querySelector(".site-nav")?.getBoundingClientRect().bottom ?? 120;
      const next: Metrics = {
        columnWidth: Math.floor((width - 2 * margin - gap * (columns - 1)) / columns),
        gap,
        margin,
        viewportWidth: width,
        viewportHeight: element.clientHeight,
        top: Math.round(chrome),
      };
      setMetrics((prev) => (prev && (Object.keys(next) as (keyof Metrics)[]).every((k) => prev[k] === next[k]) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // At rest the canvas origin sits at the page margin, just below the chrome.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!metrics || placed.current) return;
    placed.current = true;
    camera.current = restored?.camera ?? { x: -metrics.margin, y: -(metrics.top + 8), zoom: 1 };
    if (restored?.beforeFocus) beforeFocus.current = { camera: restored.beforeFocus, panned: false };
    applyCamera();
  }, [metrics, applyCamera, restored]);
  useLayoutEffect(() => {
    renderedWindow.current = undefined; // new metrics: re-window around the camera
    applyCamera();
  }, [applyCamera]);

  // Leaving the library (e.g. to Details) stops any glide or momentum: nothing keeps
  // running, or touching state, once the canvas is gone.
  useEffect(() => () => motion.current?.stop(), []);

  // ---- focus -------------------------------------------------------------------------------

  // Which occurrence is focused: the one clicked, else (deep link, Back) the item's occurrence
  // nearest the resting view, so arriving at a focused item lands somewhere predictable.
  const focusIndex = focusKey ? indexByKey.get(focusKey) : undefined;
  const focusAt = useMemo(() => {
    if (!focusKey || focusIndex === undefined || !canvas || !metrics) return undefined;
    if (clicked?.key === focusKey) return clicked;
    const rest = { x: metrics.viewportWidth / 2 - metrics.margin, y: metrics.viewportHeight / 2 - metrics.top };
    const o = canvas.findOccurrence(focusIndex, rest);
    return o && { key: focusKey, column: o.column, row: o.row };
  }, [focusKey, focusIndex, canvas, metrics, clicked]);

  const focused = focusAt && canvas && focusIndex !== undefined ? canvas.occurrence(focusAt.column, focusAt.row) : undefined;
  const focusedItem = focused ? items[focused.index] : undefined;
  const focusRatio = focusedItem && focusRatioOf(focusedItem);
  const pieceWidth =
    metrics && focused
      ? focusWidth(metrics.columnWidth, {
          viewportWidth: metrics.viewportWidth,
          ...(focusRatio && { ratio: focusRatio }),
          maxMediaHeight: Math.max(180, Math.min(metrics.viewportHeight * 0.62, metrics.viewportHeight - metrics.top - INFO_ESTIMATE - 48)),
        })
      : 0;
  const measured = pieceHeight && pieceHeight.key === focusKey ? pieceHeight.height : undefined;
  const pieceHeightNow = measured ?? Math.round(focusRatio ? pieceWidth * focusRatio + INFO_ESTIMATE : 280);
  // How the field flows around the focus (nothing hides, nothing overlaps), and where the camera settles on it.
  const packing = useMemo(
    () => (canvas && focused ? packAroundFocus(canvas, focused, { width: pieceWidth, height: pieceHeightNow }) : undefined),
    // Recompute only when what it depends on changes (focus, its size, the canvas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvas, focused?.id, pieceWidth, pieceHeightNow],
  );
  const focusRect = packing?.focus;
  const settledCamera =
    focusRect && metrics ? focusCamera(focusRect, { width: metrics.viewportWidth, height: metrics.viewportHeight, top: metrics.top }) : undefined;

  const onPieceHeight = useCallback(
    (h: number) => focusKey && setPieceHeight((prev) => (prev?.key === focusKey && prev.height === h ? prev : { key: focusKey, height: h })),
    [focusKey],
  );

  // When the focus moves, the camera follows; when it closes, return to where you were (unless you moved).
  const focusId = focused?.id;
  // A restored view already has the camera where it was; don't glide it to the focus again.
  const lastFocusId = useRef<string | undefined>(restored?.clicked && `${restored.clicked.column}:${restored.clicked.row}`);
  useEffect(() => {
    const previous = lastFocusId.current;
    if (previous === focusId || !metrics) return;
    lastFocusId.current = focusId;
    if (focusId && focusRect) {
      if (!previous && !beforeFocus.current) beforeFocus.current = { camera: { ...camera.current }, panned: false };
      if (settledCamera) moveCamera(settledCamera);
      viewport.current?.querySelector<HTMLElement>(".focus-piece")?.focus({ preventScroll: true });
    } else if (!focusId && previous) {
      const back = beforeFocus.current;
      beforeFocus.current = undefined;
      if (back && !back.panned) moveCamera(back.camera);
      viewport.current?.querySelector<HTMLElement>(`[data-occurrence="${CSS.escape(previous)}"]`)?.focus({ preventScroll: true });
    }
  }, [focusId, focusRect, settledCamera, metrics, moveCamera]);

  /** Keeps the current view in this history entry (no new entry), and marks the way back for Details. */
  const rememberView = () => {
    // Settle first: finish a glide at its destination and stop any momentum, so the view
    // remembered is where the camera was going, and nothing moves while Details loads.
    const target = motion.current?.to;
    stopMotion();
    if (target) {
      camera.current = target;
      applyCamera();
    }
    const view: SavedView = {
      camera: { ...camera.current },
      ...(focusAt && { clicked: focusAt }),
      ...(beforeFocus.current && { beforeFocus: beforeFocus.current.camera }),
    };
    window.history.replaceState({ ...window.history.state, [VIEW_KEY]: view }, "", window.location.href);
    try {
      sessionStorage.setItem(RETURN_KEY, window.location.href);
    } catch {
      // Storage unavailable: Details' Back falls back to the library.
    }
  };

  const hrefFor = (key: string) => `/?${new URLSearchParams({ [FOCUS_PARAM]: key })}`;

  const openFocus = (key: string, occurrence: string) => {
    const [column, row] = occurrence.split(":").map(Number) as [number, number];
    setClicked({ key, column, row });
    const url = new URL(window.location.href);
    url.searchParams.set(FOCUS_PARAM, key);
    if (focusKey) {
      // Moving focus within the canvas: one history entry for the whole visit, so Back leaves Focus.
      const pushed = window.history.state?.[HISTORY_KEY] !== undefined;
      window.history.replaceState(pushed ? { [HISTORY_KEY]: key } : null, "", url);
    } else {
      window.history.pushState({ [HISTORY_KEY]: key }, "", url);
    }
  };

  const close = useCallback(() => {
    if (window.history.state?.[HISTORY_KEY] === focusKey) {
      window.history.back(); // back to the library entry we came from
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete(FOCUS_PARAM);
      window.history.replaceState(null, "", url);
    }
  }, [focusKey]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focused, close]);

  // ---- input: click, drag, touch, wheel, keys ---------------------------------------------

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      // The press was a pan, not a click.
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element;
    // A tile's Details link goes straight to Details (no Focus); remember this view so Back returns to it.
    if (target.closest("[data-details-link]")) {
      rememberView();
      return;
    }
    const tile = target.closest<HTMLElement>("[data-focus-key]");
    if (tile?.dataset.focusKey && tile.dataset.occurrence) {
      event.preventDefault(); // also stops next/link's own navigation
      if (tile.dataset.occurrence !== focused?.id) openFocus(tile.dataset.focusKey, tile.dataset.occurrence);
    } else if (focused && (target === viewport.current || target === world.current)) {
      close(); // a click on empty canvas
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest(".media-viewer, button, input, textarea")) return;
    stopMotion();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, cx: camera.current.x, cy: camera.current.y, moved: false, vx: 0, vy: 0, t: event.timeStamp };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      viewport.current?.setPointerCapture(event.pointerId);
      viewport.current?.classList.add("is-panning");
    }
    const previous = camera.current;
    const dt = Math.max(1, event.timeStamp - d.t);
    panBy(d.cx - dx - previous.x, d.cy - dy - previous.y);
    d.vx = (camera.current.x - previous.x) / dt;
    d.vy = (camera.current.y - previous.y) / dt;
    d.t = event.timeStamp;
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = undefined;
    viewport.current?.classList.remove("is-panning");
    if (!d.moved) return;
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 0);
    // A little momentum, decaying.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let vx = d.vx * 16;
    let vy = d.vy * 16;
    let frame = 0;
    const glide = () => {
      vx *= 0.92;
      vy *= 0.92;
      if (Math.hypot(vx, vy) < 0.5) return;
      camera.current = { ...camera.current, x: camera.current.x + vx, y: camera.current.y + vy };
      applyCamera();
      frame = requestAnimationFrame(glide);
    };
    frame = requestAnimationFrame(glide);
    motion.current = { stop: () => cancelAnimationFrame(frame) };
  };

  // Trackpad / wheel pans the canvas (pinch-zoom is reserved for later and ignored).
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const horizontal = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
      panBy(horizontal * unit, (event.shiftKey ? 0 : event.deltaY) * unit);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [panBy]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".focus-piece, input, textarea, video")) return;
    const step = { ArrowLeft: [-160, 0], ArrowRight: [160, 0], ArrowUp: [0, -160], ArrowDown: [0, 160] }[event.key];
    if (!step) return;
    event.preventDefault();
    moveCamera({ ...camera.current, x: camera.current.x + step[0]!, y: camera.current.y + step[1]! });
  };

  // Keyboard focus on a tile outside the view brings the view to it. The viewport never scrolls
  // natively (it would desynchronize the camera); any scroll the browser makes becomes a pan.
  const onFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest(".focus-piece")) return; // the focus brings itself into view
    const tile = target.closest<HTMLElement>(".library-cell"); // a tile or its Details link
    if (!tile || !metrics) return;
    const r = tile.getBoundingClientRect();
    const dx = r.left < 0 ? r.left - metrics.margin : r.right > metrics.viewportWidth ? r.right - metrics.viewportWidth + metrics.margin : 0;
    const dy = r.top < metrics.top ? r.top - metrics.top - 8 : r.bottom > metrics.viewportHeight ? r.bottom - metrics.viewportHeight + 16 : 0;
    if (dx || dy) moveCamera({ ...camera.current, x: camera.current.x + dx, y: camera.current.y + dy });
  };
  const onScroll = () => {
    const element = viewport.current;
    if (!element || (!element.scrollLeft && !element.scrollTop)) return;
    const { scrollLeft, scrollTop } = element;
    element.scrollLeft = 0;
    element.scrollTop = 0;
    panBy(scrollLeft, scrollTop);
  };

  // ---- render ------------------------------------------------------------------------------

  // While focused, things move by up to `reach`: look that much further out for anything moving into the window.
  const reach = packing?.reach ?? 0;
  const occurrences: Occurrence[] =
    canvas && renderWindow
      ? canvas
          .occurrencesIn({ x: renderWindow.x - reach, y: renderWindow.y - reach, width: renderWindow.width + 2 * reach, height: renderWindow.height + 2 * reach })
          .filter((o) => !packing || overlaps(packing.place(o), renderWindow))
      : [];
  if (focused && !occurrences.some((o) => o.id === focused.id)) occurrences.push(focused);
  // Reading order (roughly left to right, top to bottom) for keyboard and screen readers.
  occurrences.sort((a, b) => Math.round(a.y / 240) - Math.round(b.y / 240) || a.x - b.x);

  return (
    <div
      ref={viewport}
      className="library-canvas"
      data-ready={metrics ? "true" : "false"}
      data-focused={focused ? "" : undefined}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
      onScroll={onScroll}
      onDragStart={(event) => event.preventDefault()}
    >
      <div ref={world} className="library-world">
        {occurrences.map((o) => {
          const item = items[o.index]!;
          const isFocus = o.id === focused?.id;
          // Focus: the focused item takes its larger rectangle; the field flows around it.
          const rect = isFocus && focusRect ? focusRect : (packing?.place(o) ?? o);
          return (
            <div
              key={o.id}
              className="library-cell"
              data-focus-cell={isFocus ? "" : undefined}
              style={{ width: rect.width, height: rect.height, transform: `translate(${rect.x}px, ${rect.y}px)` }}
            >
              {isFocus ? (
                <FocusPiece key={o.id} item={item} width={pieceWidth} onClose={close} onHeight={onPieceHeight} onDetails={rememberView} />
              ) : (
                <Tile item={item} href={hrefFor(item.key)} occurrence={o.id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
