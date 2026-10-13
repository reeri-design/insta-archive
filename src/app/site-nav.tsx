"use client";

import Form from "next/form";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { FOCUS_PARAM } from "../library/focus-param.ts";
import { QUERY_PARAM, SEARCH_PATH } from "../library/search-url.ts";
import { libraryShuffle, useLibraryShuffle } from "./library-shuffle.ts";

/**
 * The top nav, in the root layout so it stays put as you move between the
 * Library, Search and Details: only the content beneath it changes.
 *
 * On those pages it is a fixed bar with the archive's name and a wide search
 * field in the center. Clicking the field (or "/") makes it active: it
 * brightens and the page beneath steps back. Enter goes to /search?q=…;
 * Escape or a click outside closes it. On Search it shows the current query,
 * editable. On the Library, a quiet Shuffle button sits at the right; the
 * archive's name leads back to the Library as you left it (shuffled or not).
 * Any other page keeps the plain header.
 */
export function SiteNav() {
  const pathname = usePathname();
  // The full nav on the Library, Search and Details; anything else keeps the plain header.
  if (pathname !== "/" && pathname !== SEARCH_PATH && !pathname.startsWith("/items/")) {
    return (
      <header className="site-header">
        <Link href="/">Insta Archive</Link>
      </header>
    );
  }
  return (
    <header className="site-nav">
      <HomeLink />
      <NavSearch onSearchPage={pathname === SEARCH_PATH} />
      {pathname === "/" && <ShuffleButton />}
    </header>
  );
}

/**
 * The archive's name: the Library as this tab last showed it, a Shuffle
 * included (see shuffle-store.ts). On the Library it closes a Focus and keeps
 * the selection.
 */
function HomeLink() {
  return (
    <Link href="/" className="nav-pill nav-home">
      Insta Archive
    </Link>
  );
}

function NavSearch({ onSearchPage }: { onSearchPage: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const query = useSearchParams().get(QUERY_PARAM)?.trim() ?? "";
  const value = onSearchPage ? query : "";

  // "/" opens search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // An empty Search page is waiting for a query.
  useEffect(() => {
    if (onSearchPage && !query) input.current?.focus();
  }, [onSearchPage, query]);

  return (
    <>
      <Form
        action={SEARCH_PATH}
        role="search"
        className="nav-pill nav-search"
        onSubmit={(event) => {
          if (!input.current?.value.trim()) {
            event.preventDefault(); // nothing to look for
            return;
          }
          input.current.blur(); // the results take over; the page comes forward again
        }}
      >
        <SearchIcon />
        <input
          ref={input}
          // A new query (or leaving Search) resets the field to it.
          key={value}
          type="search"
          name={QUERY_PARAM}
          defaultValue={value}
          placeholder="Search your archive…"
          aria-label="Search your archive"
          autoComplete="off"
          enterKeyHint="search"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault(); // also keeps the canvas from closing a focus
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }}
        />
        <button type="submit" className="visually-hidden">
          Search
        </button>
      </Form>
      {/* While searching, the page steps back; a click on it closes search (the field loses focus). */}
      <div className="nav-scrim" aria-hidden="true" />
    </>
  );
}

/**
 * Replaces the canvas's items with a fresh random selection, in place: no
 * navigation, the URL and history stay as they are (see shuffle-store.ts). An
 * item in Focus stays in Focus.
 */
function ShuffleButton() {
  const { pending } = useLibraryShuffle();
  const focusKey = useSearchParams().get(FOCUS_PARAM) ?? undefined;
  return (
    <button
      type="button"
      className="nav-pill nav-shuffle"
      aria-label="Shuffle"
      title="Shuffle"
      aria-busy={pending || undefined}
      onClick={() => void libraryShuffle.shuffle(focusKey ? { keep: focusKey } : {})}
    >
      <ShuffleIcon />
    </button>
  );
}

function ShuffleIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5h2.2c1.2 0 2 .5 2.7 1.5l2.2 4c.7 1 1.5 1.5 2.7 1.5H14" />
      <path d="M2 11.5h2.2c1.2 0 2-.5 2.7-1.5M9.1 6c.7-1 1.5-1.5 2.7-1.5H14" />
      <path d="m12.2 2.7 1.8 1.8-1.8 1.8M12.2 9.7l1.8 1.8-1.8 1.8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="7" cy="7" r="4.75" />
      <path d="m10.5 10.5 3.25 3.25" strokeLinecap="round" />
    </svg>
  );
}
