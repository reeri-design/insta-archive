"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/** Set by the library when it opens Details, so Back can return to exactly that view. */
export const RETURN_KEY = "library:return-to";

/**
 * A quiet way back: an arrow in a circle, nothing else visible ("Back" is only
 * its accessible name). Arriving from the library, it steps back in history (the
 * canvas restores its camera and focus from there); arriving by a direct link,
 * it goes to the library (as this tab last showed it, a Shuffle included: see
 * library/shuffle-store.ts).
 */
export function BackLink() {
  const router = useRouter();
  return (
    <Link
      href="/"
      className="detail-back"
      aria-label="Back"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        let from: string | null = null;
        try {
          from = sessionStorage.getItem(RETURN_KEY);
          sessionStorage.removeItem(RETURN_KEY);
        } catch {
          // Storage unavailable: fall back to the link.
        }
        if (from && window.history.length > 1) {
          event.preventDefault();
          router.back();
          return;
        }
        // Otherwise the link: the library as this tab last showed it (a Shuffle included).
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
      </svg>
    </Link>
  );
}
