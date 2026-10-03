/**
 * The structured AI organization output for the first enrichment experiment,
 * and its validation. Provider-agnostic.
 *
 * The allowed values are deliberately few and provisional; they are enforced
 * here (not in the domain model, which keeps free-form strings) so the
 * taxonomy can change by bumping TAXONOMY_VERSION.
 */
import type { OrganizationFields } from "../domain/archive-item.ts";

export const TAXONOMY_VERSION = "v1";

export const ORGANIZATION_TYPES = ["inspiration", "idea", "insight", "content_idea", "reference"] as const;
export const ORGANIZATION_CATEGORIES = ["art", "design", "craft", "fashion", "photography", "content", "other"] as const;

export const TAGS_MIN = 3;
export const TAGS_MAX = 7;
export const USEFUL_FOR_MIN = 1;
export const USEFUL_FOR_MAX = 5;
const SUMMARY_MAX_CHARS = 600;
const ENTRY_MAX_CHARS = 120;

/**
 * JSON schema sent to the provider as the required output shape. Count and
 * range limits are not expressible for every provider, so they are stated in
 * the prompt and enforced by validateOrganizationOutput.
 */
export const ORGANIZATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...ORGANIZATION_TYPES] },
    category: { type: "string", enum: [...ORGANIZATION_CATEGORIES] },
    tags: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    usefulFor: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["type", "category", "tags", "summary", "usefulFor", "confidence"],
  additionalProperties: false,
} as const;

export type ValidatedOrganization = {
  fields: Required<Pick<OrganizationFields, "type" | "category" | "summary">> & OrganizationFields;
  confidence: number;
};

/** Accepts only a complete, well-formed organization; never repairs guesses. */
export function validateOrganizationOutput(
  raw: unknown,
): { ok: true; value: ValidatedOrganization } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["output is not a JSON object"] };
  }
  const o = raw as Record<string, unknown>;
  const allowed = new Set(Object.keys(ORGANIZATION_OUTPUT_SCHEMA.properties));
  for (const key of Object.keys(o)) if (!allowed.has(key)) errors.push(`unexpected field "${key}"`);

  const type = o.type;
  if (typeof type !== "string" || !(ORGANIZATION_TYPES as readonly string[]).includes(type)) {
    errors.push(`type must be one of ${ORGANIZATION_TYPES.join(", ")}`);
  }
  const category = o.category;
  if (typeof category !== "string" || !(ORGANIZATION_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`category must be one of ${ORGANIZATION_CATEGORIES.join(", ")}`);
  }

  const tags = stringList(o.tags, "tags", errors);
  if (tags && (tags.length < TAGS_MIN || tags.length > TAGS_MAX)) {
    errors.push(`tags must have ${TAGS_MIN}–${TAGS_MAX} distinct entries, got ${tags.length}`);
  }
  const usefulFor = stringList(o.usefulFor, "usefulFor", errors);
  if (usefulFor && (usefulFor.length < USEFUL_FOR_MIN || usefulFor.length > USEFUL_FOR_MAX)) {
    errors.push(`usefulFor must have ${USEFUL_FOR_MIN}–${USEFUL_FOR_MAX} entries, got ${usefulFor.length}`);
  }

  const summary = typeof o.summary === "string" ? o.summary.trim() : undefined;
  if (!summary) errors.push("summary must be a non-empty string");
  else if (summary.length > SUMMARY_MAX_CHARS) errors.push(`summary longer than ${SUMMARY_MAX_CHARS} characters`);

  const confidence = o.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  if (errors.length > 0 || !tags || !usefulFor || !summary) return { ok: false, errors };
  return {
    ok: true,
    value: {
      fields: { type: type as string, category: category as string, tags, summary, usefulFor },
      confidence: confidence as number,
    },
  };
}

/** Trimmed, non-empty, case-insensitively distinct strings; undefined if not a string array. */
function stringList(value: unknown, name: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    errors.push(`${name} must be an array of strings`);
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value as string[]) {
    const text = entry.trim();
    if (!text) {
      errors.push(`${name} contains an empty entry`);
      continue;
    }
    if (text.length > ENTRY_MAX_CHARS) errors.push(`${name} entry longer than ${ENTRY_MAX_CHARS} characters`);
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
  }
  return result;
}
