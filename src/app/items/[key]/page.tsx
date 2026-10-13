import { notFound } from "next/navigation";
import { getArchiveCard, getItemDetail, type ItemDetail } from "../../../archive-view/archive-view.ts";
import { reviewInputFrom } from "../../../archive-view/review.ts";
import { ORGANIZATION_CATEGORIES, ORGANIZATION_TYPES } from "../../../ai/organization-schema.ts";
import type { FieldOrigin, OrganizationFields, SourceRecord } from "../../../domain/archive-item.ts";
import { KIND_LABELS, libraryItemOf, titleOf } from "../../../library/library-item.ts";
import { archiveRepository, OWNER_ID } from "../../archive-server.ts";
import { formatDate } from "../../format.ts";
import { saveReview } from "./actions.ts";
import { BackLink } from "./back-link.tsx";
import { DetailMedia } from "./detail-media.tsx";
import { EditOrganization } from "./edit-organization.tsx";

/**
 * Details (docs/design-direction.md §3, level 3; §7): understand one item.
 * Media first, then where it came from, what it is, your own context, what AI
 * makes of it (labelled as such), and the rest of the original record — with
 * editing tucked behind a quiet Edit.
 */
export default async function ItemPage({ params, searchParams }: PageProps<"/items/[key]">) {
  const { key } = await params;
  const { saved, error } = await searchParams;
  const [detail, card] = await Promise.all([
    getItemDetail(archiveRepository(), OWNER_ID, key),
    getArchiveCard(archiveRepository(), OWNER_ID, key),
  ]);
  if (!detail || !card) notFound();
  const item = libraryItemOf(card);
  const { item: archiveItem, sources } = detail.aggregate;
  const caption = archiveItem.original.caption?.value;
  const creator = item.creator;
  const title = caption ? titleOf(caption) : undefined;
  const postedAt = archiveItem.original.postedAt?.value;
  const hasMedia = item.media.length > 0;

  return (
    <main className="detail">
      <div className="detail-layout">
        {/* Inline with the composition: its own narrow column, level with the top of the media. */}
        <nav className="detail-nav">
          <BackLink />
        </nav>

        <section className="detail-content" aria-label="Media">
          {hasMedia ? (
            <DetailMedia media={item.media} />
          ) : (
            <figure className="detail-fragment">
              {caption && <span className="detail-fragment-label">{creator ? `Caption by ${creator}` : "Caption"}</span>}
              {caption ? <blockquote>{caption}</blockquote> : <p>{`A saved ${item.kindLabel.toLowerCase()}`}</p>}
              <figcaption>
                <span className="tile-state" data-state={item.mediaState}>
                  {item.mediaState === "unavailable" ? "Media unavailable" : "Media not saved yet"}
                </span>
              </figcaption>
            </figure>
          )}
        </section>

        <article className="detail-info">
          <header className="detail-heading">
            {hasMedia && title ? (
              <h1 className="detail-title">{title}</h1>
            ) : (
              <h1 className="detail-title detail-title-quiet">{[KIND_LABELS[archiveItem.kind], creator && `by ${creator}`].filter(Boolean).join(" ")}</h1>
            )}
            <p className="detail-source">
              <a href={archiveItem.canonicalUrl} target="_blank" rel="noreferrer">
                {[item.source.name, item.source.handle].filter(Boolean).join(" · ")} <span aria-hidden="true">↗</span>
              </a>
            </p>
          </header>

          {hasMedia && caption && caption.trim() !== title && (
            <Caption text={caption} by={creator} />
          )}

          <YourContext sources={sources} />

          <Organization detail={detail} />

          <details className="detail-original">
            <summary>About the original</summary>
            <dl>
              {postedAt && (
                <>
                  <dt>Posted</dt>
                  <dd>{formatDate(postedAt)}</dd>
                </>
              )}
              {creator && (
                <>
                  <dt>Creator</dt>
                  <dd>
                    {archiveItem.original.creator?.value.displayName && `${archiveItem.original.creator.value.displayName} · `}
                    {creator}
                  </dd>
                </>
              )}
              <dt>Kind</dt>
              <dd>{KIND_LABELS[archiveItem.kind]}</dd>
              <dt>Original</dt>
              <dd>
                <a href={archiveItem.canonicalUrl} target="_blank" rel="noreferrer">
                  {archiveItem.canonicalUrl}
                </a>
              </dd>
              {mediaNotes(detail).length > 0 && (
                <>
                  <dt>Media</dt>
                  <dd>{mediaNotes(detail).join(" · ")}</dd>
                </>
              )}
            </dl>
          </details>

          <div className="detail-edit-area">
            {saved && <p className="detail-notice">Saved.</p>}
            {typeof error === "string" && <p className="detail-notice detail-notice-error">Not saved: {error}</p>}
            <EditOrganization
              // Remount after each save so the form shows the saved values.
              key={detail.aggregate.curated?.reviewedAt ?? "unreviewed"}
              action={saveReview.bind(null, key)}
              values={reviewInputFrom(detail.aggregate.curated?.fields ?? detail.suggestion?.fields)}
              startsFrom={detail.aggregate.curated ? "yours" : detail.suggestion ? "ai" : "nothing"}
              types={ORGANIZATION_TYPES}
              categories={ORGANIZATION_CATEGORIES}
            />
          </div>
        </article>
      </div>
    </main>
  );
}

/** The creator's words: labelled as theirs, folded when long. */
function Caption({ text, by }: { text: string; by: string | undefined }) {
  const long = text.length > 320 || text.split("\n").length > 6;
  const body = <p className="detail-caption-text">{withHashtags(text)}</p>;
  return (
    <section className="detail-caption">
      <h2>{by ? `Caption by ${by}` : "Caption"}</h2>
      {long ? (
        <details>
          <summary>
            <span className="detail-caption-preview">{withHashtags(text)}</span>
            <span className="detail-more">Show all</span>
          </summary>
          {body}
        </details>
      ) : (
        body
      )}
    </section>
  );
}

/** The caption with its hashtags set apart (quieter, in the UI face), the words themselves unchanged. */
function withHashtags(text: string) {
  return text.split(/(#[\p{L}\p{N}_]+)/u).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="detail-hashtag">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Your context: what you did with it (saved, shared, sent to you) and anything you
 * wrote alongside a share — never mixed with the creator's caption or AI.
 */
function YourContext({ sources }: { sources: readonly SourceRecord[] }) {
  const lines = [...sources]
    .sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""))
    .map((source) => ({ id: source.id, text: activityOf(source), note: source.message?.userNote }));
  if (lines.length === 0) return null;
  return (
    <section className="detail-context">
      <h2>Your context</h2>
      <ul>
        {lines.map((line) => (
          <li key={line.id}>
            {line.text}
            {line.note && (
              <blockquote className="detail-note">
                <span>Your note</span>
                {line.note}
              </blockquote>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function activityOf(source: SourceRecord): string {
  const when = source.occurredAt ? ` · ${formatDate(source.occurredAt)}` : "";
  const thread = source.message?.threadTitle ? ` in “${source.message.threadTitle}”` : "";
  switch (source.source) {
    case "saved":
      return `You saved it${when}`;
    case "liked":
      return `You liked it${when}`;
    case "messages":
      if (source.message?.sentByOwner === true) return `You shared it${thread}${when}`;
      if (source.message?.sentByOwner === false)
        return `Sent to you${source.message.senderName ? ` by ${source.message.senderName}` : ""}${thread}${when}`;
      return `Shared${thread}${when}`;
  }
}

/**
 * Organization: yours if you've edited it (the AI's original suggestion kept,
 * folded, beside it), else the AI's — labelled as AI understanding, with the
 * machinery (model, provider, confidence) left out.
 */
function Organization({ detail }: { detail: ItemDetail }) {
  const curated = detail.aggregate.curated;
  const suggestion = detail.suggestion;
  if (curated) {
    return (
      <section className="detail-organization">
        <h2>Your organization</h2>
        <Fields fields={curated.fields} origins={curated.fieldOrigins} />
        <p className="detail-hint">Edited {formatDate(curated.reviewedAt)}</p>
        {suggestion && (
          <details className="detail-ai-original">
            <summary>The AI’s original suggestion</summary>
            <Fields fields={suggestion.fields} />
          </details>
        )}
      </section>
    );
  }
  if (suggestion) {
    return (
      <section className="detail-organization detail-ai">
        <h2>AI understanding</h2>
        <Fields fields={suggestion.fields} />
        <p className="detail-hint">Suggested by AI from the post — not why you saved it. Edit to make it yours.</p>
      </section>
    );
  }
  return null;
}

const ORIGIN_LABELS: Record<FieldOrigin, string> = {
  ai_accepted: "from AI",
  human_edited: "edited",
  human_added: "added",
};

function Fields({ fields, origins }: { fields: OrganizationFields; origins?: Partial<Record<keyof OrganizationFields, FieldOrigin>> }) {
  const origin = (field: keyof OrganizationFields) =>
    origins?.[field] ? <span className="detail-origin">{ORIGIN_LABELS[origins[field]!]}</span> : null;
  const kind = [fields.type, fields.category].filter(Boolean).join(" · ");
  return (
    <div className="detail-fields">
      {fields.tags.length > 0 && (
        <p className="detail-tags">
          <span className="visually-hidden">Tags: </span>
          {fields.tags.join(" · ")} {origin("tags")}
        </p>
      )}
      {fields.usefulFor.length > 0 && (
        <div className="detail-useful">
          <h3>Useful for {origin("usefulFor")}</h3>
          <ul>
            {fields.usefulFor.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        </div>
      )}
      {(fields.summary || kind) && (
        <details className="detail-description">
          <summary>{origins ? "Description" : "AI’s description"}</summary>
          {fields.summary && (
            <p>
              {fields.summary} {origin("summary")}
            </p>
          )}
          {kind && (
            <p className="detail-kind">
              {kind} {origin("type") ?? origin("category")}
            </p>
          )}
        </details>
      )}
    </div>
  );
}

/** Plain words about media that is missing, for "About the original". */
function mediaNotes(detail: ItemDetail): string[] {
  const notes: string[] = [];
  const missingSlides = detail.missingMedia.filter((m) => m.position !== undefined && m.mediaType === "image").length;
  const missingVideo = detail.missingMedia.some((m) => m.mediaType === "video");
  if (missingVideo) notes.push(detail.frames.length > 0 ? "Video not kept; frames saved instead" : "Video unavailable");
  if (missingSlides > 0) notes.push(`${missingSlides} ${missingSlides === 1 ? "slide" : "slides"} couldn't be saved`);
  return notes;
}
