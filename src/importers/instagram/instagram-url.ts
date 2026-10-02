import type {
  ArchiveItemKind,
  InstagramIdentity,
} from "../../domain/archive-item.ts";

/** A URL that points at an Instagram post or reel. */
export type InstagramContentUrl = {
  identity: InstagramIdentity;
  /** What the URL alone tells us about the kind of content. */
  kindHint?: Extract<ArchiveItemKind, "reel" | "carousel">;
  /**
   * Set when a single carousel slide was shared from Messages. It names the
   * slide, not the post: the post is still identified by the shortcode.
   */
  carouselChildMediaId?: string;
};

export type ParsedInstagramUrl =
  | { ok: true; content: InstagramContentUrl }
  | { ok: false; reason: string };

const INSTAGRAM_HOST = /^(www\.|m\.)?instagram\.com$/i;
const SHORTCODE = /^[A-Za-z0-9_-]+$/;
const CONTENT_SEGMENTS = new Set(["p", "reel", "reels", "tv"]);

/**
 * Extract the content identity from an Instagram URL. The shortcode after
 * /p/, /reel/, /reels/ or /tv/ is the identity; query parameters such as `id`
 * and `carousel_share_child_media_id` never change it.
 */
export function parseInstagramUrl(raw: string): ParsedInstagramUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (!INSTAGRAM_HOST.test(url.hostname)) {
    return { ok: false, reason: "not an Instagram URL" };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "stories") {
    return { ok: false, reason: "story link (not a post or reel)" };
  }

  // Usually /p/X/, but /<username>/p/X/ also occurs.
  const at = segments.findIndex((s) => CONTENT_SEGMENTS.has(s));
  const shortcode = at === -1 ? undefined : segments[at + 1];
  if (!shortcode || !SHORTCODE.test(shortcode)) {
    return { ok: false, reason: "Instagram URL without a post/reel shortcode" };
  }

  const segment = segments[at];
  const carouselChildMediaId =
    url.searchParams.get("carousel_share_child_media_id") ?? undefined;
  const kindHint = carouselChildMediaId
    ? "carousel"
    : segment === "reel" || segment === "reels"
      ? "reel"
      : undefined;

  return {
    ok: true,
    content: {
      identity: { kind: "shortcode", shortcode },
      ...(kindHint && { kindHint }),
      ...(carouselChildMediaId && { carouselChildMediaId }),
    },
  };
}

/** String form of an identity, unique per identity. */
export function identityKey(identity: InstagramIdentity): string {
  return identity.kind === "shortcode"
    ? `shortcode:${identity.shortcode}`
    : `url:${identity.normalizedUrl}`;
}

export function canonicalUrlFor(
  identity: InstagramIdentity,
  kind: ArchiveItemKind,
): string {
  if (identity.kind === "url") return identity.normalizedUrl;
  const segment = kind === "reel" ? "reel" : "p";
  return `https://www.instagram.com/${segment}/${identity.shortcode}/`;
}
