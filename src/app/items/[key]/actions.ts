"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { saveItemReview } from "../../../archive-view/archive-view.ts";
import { ReviewInputError, type ReviewInput } from "../../../archive-view/review.ts";
import { archiveRepository, OWNER_ID } from "../../archive-server.ts";

/** Saves the review form as the item's CuratedOrganization. AI suggestions are not changed. */
export async function saveReview(key: string, formData: FormData): Promise<void> {
  const field = (name: keyof ReviewInput) => String(formData.get(name) ?? "");
  const input: ReviewInput = {
    type: field("type"),
    category: field("category"),
    tags: field("tags"),
    summary: field("summary"),
    usefulFor: field("usefulFor"),
  };
  let error: string | undefined;
  try {
    await saveItemReview(archiveRepository(), OWNER_ID, key, input, new Date().toISOString());
  } catch (e) {
    if (!(e instanceof ReviewInputError)) throw e;
    error = e.message;
  }
  revalidatePath("/");
  revalidatePath(`/items/${key}`);
  redirect(error ? `/items/${key}?error=${encodeURIComponent(error)}` : `/items/${key}?saved=1`);
}
