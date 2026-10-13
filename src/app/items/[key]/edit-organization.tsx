"use client";

import { useState } from "react";
import type { ReviewInput } from "../../../archive-view/review.ts";

/**
 * Edit is a quiet action, not the default state. Opening it shows the
 * organization fields the archive already supports, starting from your
 * earlier edits or else the AI's suggestion. Saving stores your version
 * separately; the AI suggestion itself is never changed.
 */
export function EditOrganization({
  action,
  values,
  startsFrom,
  types,
  categories,
}: {
  action: (formData: FormData) => void | Promise<void>;
  values: ReviewInput;
  /** What the form starts from, for the hint line. */
  startsFrom: "yours" | "ai" | "nothing";
  types: readonly string[];
  categories: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="detail-action" onClick={() => setOpen(true)}>
        Edit
      </button>
    );
  }
  return (
    <form action={action} className="detail-edit">
      <p className="detail-hint">
        {startsFrom === "yours"
          ? "Your version. Saving replaces it; the AI suggestion stays as it was."
          : startsFrom === "ai"
            ? "Starts from the AI suggestion. Saving keeps your version separately; the AI suggestion stays as it was."
            : "Nothing here yet. Add what helps you find it again."}
      </p>
      <label>
        <span>Tags</span>
        <textarea name="tags" rows={3} defaultValue={values.tags} placeholder="One per line, or separated by commas" />
      </label>
      <label>
        <span>What it is</span>
        <textarea name="summary" rows={3} defaultValue={values.summary} />
      </label>
      <label>
        <span>Useful for</span>
        <textarea name="usefulFor" rows={3} defaultValue={values.usefulFor} placeholder="One per line" />
      </label>
      <div className="detail-edit-pair">
        <label>
          <span>Type</span>
          <input name="type" list="detail-types" defaultValue={values.type} />
        </label>
        <label>
          <span>Category</span>
          <input name="category" list="detail-categories" defaultValue={values.category} />
        </label>
      </div>
      <datalist id="detail-types">
        {types.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="detail-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="detail-edit-actions">
        <button type="submit" className="detail-action detail-action-primary">
          Save
        </button>
        <button type="button" className="detail-action" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
