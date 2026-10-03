/**
 * Human review: turns edited organization fields into the item's
 * CuratedOrganization. The AI suggestion it starts from is never modified;
 * per-field origins record what was accepted, edited or added.
 */
import type {
  AiOrganization,
  ArchiveItemId,
  CuratedOrganization,
  FieldOrigin,
  IsoDateTime,
  OrganizationFields,
  UserId,
} from "../domain/archive-item.ts";
import { TAXONOMY_VERSION } from "../ai/organization-schema.ts";

/** The review form's raw values: list fields hold one entry per line. */
export type ReviewInput = {
  type: string;
  category: string;
  tags: string;
  summary: string;
  usefulFor: string;
};

const MAX_TEXT = 2_000;
const MAX_LIST_ENTRIES = 30;

export class ReviewInputError extends Error {
  override name = "ReviewInputError";
}

/**
 * Normalizes form input: text trimmed (empty means unset), list entries
 * trimmed, blank lines dropped and duplicates removed (case-insensitive).
 * Tags may also be separated by commas.
 * @throws ReviewInputError when a value is unreasonably long or a list too large.
 */
export function parseReviewInput(input: ReviewInput): OrganizationFields {
  const text = (value: string, field: string) => {
    const trimmed = value.trim();
    if (trimmed.length > MAX_TEXT) throw new ReviewInputError(`${field} is too long`);
    return trimmed || undefined;
  };
  const list = (value: string, separator: RegExp, field: string) => {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const raw of value.split(separator)) {
      const entry = text(raw, field);
      if (!entry || seen.has(entry.toLowerCase())) continue;
      seen.add(entry.toLowerCase());
      entries.push(entry);
    }
    if (entries.length > MAX_LIST_ENTRIES) throw new ReviewInputError(`${field} has too many entries`);
    return entries;
  };

  const type = text(input.type, "type");
  const category = text(input.category, "category");
  const summary = text(input.summary, "summary");
  return {
    ...(type && { type }),
    ...(category && { category }),
    tags: list(input.tags, /[\n,]/, "tags"),
    ...(summary && { summary }),
    // Uses are phrases that may contain commas: one per line.
    usefulFor: list(input.usefulFor, /\n/, "usefulFor"),
  };
}

/** Form values for editing: the curated fields if reviewed, else the suggestion's. */
export function reviewInputFrom(fields: OrganizationFields | undefined): ReviewInput {
  return {
    type: fields?.type ?? "",
    category: fields?.category ?? "",
    tags: (fields?.tags ?? []).join("\n"),
    summary: fields?.summary ?? "",
    usefulFor: (fields?.usefulFor ?? []).join("\n"),
  };
}

/**
 * The curated organization for reviewed fields. Each field's origin compares
 * it with the suggestion it is based on: unchanged → "ai_accepted", changed
 * or cleared → "human_edited", filled where the AI had nothing →
 * "human_added". Fields empty on both sides get no origin.
 */
export function buildCuratedOrganization(options: {
  archiveItemId: ArchiveItemId;
  fields: OrganizationFields;
  /** The AI suggestion that was reviewed, if any. */
  suggestion?: AiOrganization;
  reviewedBy: UserId;
  reviewedAt: IsoDateTime;
}): CuratedOrganization {
  const { fields, suggestion } = options;
  const fieldOrigins: CuratedOrganization["fieldOrigins"] = {};
  for (const key of ["type", "category", "tags", "summary", "usefulFor"] as const) {
    const origin = originOf(fields[key], suggestion?.fields[key]);
    if (origin) fieldOrigins[key] = origin;
  }
  return {
    archiveItemId: options.archiveItemId,
    fields,
    fieldOrigins,
    ...(suggestion && { basedOnSuggestionId: suggestion.id }),
    taxonomyVersion: suggestion?.taxonomyVersion ?? TAXONOMY_VERSION,
    reviewedBy: options.reviewedBy,
    reviewedAt: options.reviewedAt,
  };
}

type FieldValue = string | string[] | undefined;

function originOf(reviewed: FieldValue, suggested: FieldValue): FieldOrigin | undefined {
  const isEmpty = (v: FieldValue) => v === undefined || v.length === 0;
  if (isEmpty(reviewed) && isEmpty(suggested)) return undefined;
  if (isEmpty(suggested)) return "human_added";
  return JSON.stringify(reviewed ?? null) === JSON.stringify(suggested) ? "ai_accepted" : "human_edited";
}
