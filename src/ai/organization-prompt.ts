/**
 * The prompt for the first organization experiment. One version, two
 * variants: with media and metadata-only (recorded in promptVersion).
 *
 * Only the post's own original context goes in (kind, creator, caption,
 * posting date, media). How the user came across it (saved, liked, DMs),
 * who sent it and when are deliberately left out, so the model describes the
 * content and cannot speculate about why the user kept it.
 */
import type { ArchiveItemAggregate } from "../domain/archive-item.ts";
import {
  ORGANIZATION_CATEGORIES,
  ORGANIZATION_TYPES,
  TAGS_MAX,
  TAGS_MIN,
  USEFUL_FOR_MAX,
  USEFUL_FOR_MIN,
} from "./organization-schema.ts";

export const PROMPT_VERSION = "organize-v1";

export type MediaSummary =
  | { kind: "none" }
  | { kind: "images"; count: number; description: string };

export function promptVersionFor(media: MediaSummary): string {
  return `${PROMPT_VERSION}/${media.kind === "none" ? "metadata" : "media"}`;
}

export const ORGANIZATION_INSTRUCTIONS = `You organize items in a personal creative reference archive. Each item is a public Instagram post that the archive owner kept. You see the post's own information (its kind, creator, caption, posting date) and, when available, its images.

Your job:
1. Classify what the content is.
2. Describe what is visibly and semantically useful about it.
3. Suggest how it could be useful as creative reference.

Rules:
- Describe the content itself. Never guess, state or imply why the owner saved, liked or shared it, and never describe the owner.
- Base everything on what is actually shown or written. Do not invent details that are not in the images or text.
- "type" is one of: ${ORGANIZATION_TYPES.join(", ")}.
  inspiration = visual or creative work to draw inspiration from; idea = a concrete project or thing one could make or do; insight = knowledge, advice, a lesson or an explanation; content_idea = a format or idea for making social or online content; reference = factual or technical material to look things up in (tutorials, patterns, how-tos, resources).
- "category" is one of: ${ORGANIZATION_CATEGORIES.join(", ")}. Use "other" whenever none clearly fits, rather than forcing a category.
- "tags": ${TAGS_MIN}–${TAGS_MAX} specific, lowercase tags about subject, technique, medium, style or format (e.g. "embroidery", "risograph", "color palette"). Avoid vague tags like "art", "cool", "instagram" or "inspiration".
- "summary": one or two plain sentences describing the content.
- "usefulFor": ${USEFUL_FOR_MIN}–${USEFUL_FOR_MAX} short phrases naming concrete uses as creative reference (e.g. "palette reference for illustrations"). These are possible uses, not the owner's reasons.
- "confidence": a number from 0 to 1 for how sure you are of type and category. When there are no images and only little text, keep it at 0.6 or below.

Return only the JSON object with exactly these fields: type, category, tags, summary, usefulFor, confidence.`;

/** The item-specific part of the prompt, from original metadata and media. */
export function buildOrganizationContent(aggregate: ArchiveItemAggregate, media: MediaSummary): string {
  const { item } = aggregate;
  const lines: string[] = [];
  lines.push(`Instagram content kind: ${item.kind === "unknown" ? "post (single image, video or carousel; not known)" : item.kind}`);

  const creator = item.original.creator?.value;
  if (creator?.username || creator?.displayName) {
    const name = [creator.displayName, creator.username && `@${creator.username}`].filter(Boolean).join(" ");
    lines.push(`Creator: ${name}`);
  }
  if (item.original.postedAt) lines.push(`Posted: ${item.original.postedAt.value.slice(0, 10)}`);

  const caption = item.original.caption?.value?.trim();
  lines.push(caption ? `Caption:\n"""\n${caption}\n"""` : "Caption: (none)");

  lines.push(
    media.kind === "none"
      ? "Media: not available. Classify from the text above only."
      : `Media: ${media.description}`,
  );
  return lines.join("\n");
}
