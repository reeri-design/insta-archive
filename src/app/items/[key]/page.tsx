import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getItemDetail, type ItemDetail } from "../../../archive-view/archive-view.ts";
import { reviewInputFrom } from "../../../archive-view/review.ts";
import { ORGANIZATION_CATEGORIES, ORGANIZATION_TYPES } from "../../../ai/organization-schema.ts";
import type { CuratedOrganization, OrganizationFields, Provenance, SourceRecord } from "../../../domain/archive-item.ts";
import { archiveRepository, OWNER_ID } from "../../archive-server.ts";
import { formatDate } from "../../format.ts";
import { saveReview } from "./actions.ts";

export default async function ItemPage({ params, searchParams }: PageProps<"/items/[key]">) {
  const { key } = await params;
  const { saved, error } = await searchParams;
  const detail = await getItemDetail(archiveRepository(), OWNER_ID, key);
  if (!detail) notFound();
  const { item, sources } = detail.aggregate;

  return (
    <main className="item">
      <p>
        <Link href="/">← Archive</Link>
      </p>
      <div className="item-layout">
        <MediaSection detail={detail} />
        <div className="panels">
          <section className="panel original">
            <h2>Original · Instagram</h2>
            <Original detail={detail} />
            <p>
              <a href={item.canonicalUrl} target="_blank" rel="noreferrer">
                Open on Instagram ↗
              </a>
            </p>
          </section>

          <section className="panel">
            <h2>Sources · your export</h2>
            <ul className="sources">
              {sources.map((source) => (
                <Source key={source.id} source={source} />
              ))}
            </ul>
          </section>

          <section className="panel ai">
            <h2>AI suggestion</h2>
            <Suggestion detail={detail} />
          </section>

          <section className="panel review">
            <h2>Your review</h2>
            {saved && <p className="notice">Review saved.</p>}
            {typeof error === "string" && <p className="notice error">Not saved: {error}</p>}
            <ReviewForm detail={detail} itemKey={key} />
          </section>
        </div>
      </div>
    </main>
  );
}

function MediaSection({ detail }: { detail: ItemDetail }) {
  const { media, frames, missingMedia } = detail;
  return (
    <section className="media">
      {media.length > 0 && (
        <div className={media.length > 1 ? "slides" : undefined}>
          {media.map((m) => (
            <figure key={m.url} className="slide">
              {m.mediaType === "video" ? (
                <video src={m.url} controls playsInline preload="metadata" />
              ) : (
                <Image src={m.url} alt="" width={1080} height={1350} unoptimized />
              )}
              {media.length > 1 && <figcaption className="muted">{(m.position ?? 0) + 1}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {frames.length > 0 && (
        <>
          <p className="muted">Frames kept from the video{media.length === 0 && " (the video itself was not stored)"}:</p>
          <div className="frames">
            {frames.map((f) => (
              <figure key={f.url}>
                <Image src={f.url} alt="" width={540} height={960} unoptimized />
                <figcaption className="muted">{((f.frameTimeMs ?? 0) / 1000).toFixed(1)}s</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
      {media.length === 0 && frames.length === 0 && <div className="no-media">No stored media</div>}
      {missingMedia.length > 0 && (
        <p className="muted">
          Not stored:{" "}
          {missingMedia
            .map((m) => `${m.mediaType}${m.position !== undefined ? ` ${m.position + 1}` : ""} (${m.status})`)
            .join(", ")}
        </p>
      )}
    </section>
  );
}

function Original({ detail }: { detail: ItemDetail }) {
  const { item } = detail.aggregate;
  const { creator, caption, postedAt } = item.original;
  return (
    <dl>
      <dt>Kind</dt>
      <dd>{item.kind}</dd>
      <dt>Creator</dt>
      <dd>
        {creator ? (
          <>
            {creator.value.displayName && `${creator.value.displayName} `}
            {creator.value.username && <span className="muted">@{creator.value.username}</span>}
            <From provenance={creator.provenance} />
          </>
        ) : (
          <span className="muted">Unknown</span>
        )}
      </dd>
      {postedAt && (
        <>
          <dt>Posted</dt>
          <dd>
            {formatDate(postedAt.value)} <From provenance={postedAt.provenance} />
          </dd>
        </>
      )}
      <dt>Caption</dt>
      <dd className="caption">
        {caption ? (
          <>
            {caption.value} <From provenance={caption.provenance} />
          </>
        ) : (
          <span className="muted">No caption</span>
        )}
      </dd>
    </dl>
  );
}

/** Where an original value came from. */
function From({ provenance }: { provenance: Provenance }) {
  return <span className="provenance">{provenance.from === "export" ? "export" : "retrieved"}</span>;
}

function Source({ source }: { source: SourceRecord }) {
  const message = source.message;
  return (
    <li>
      <strong>{source.source}</strong>
      {source.occurredAt && <span className="muted"> · {formatDate(source.occurredAt)}</span>}
      {message && (
        <div className="muted">
          {message.threadTitle && <>In “{message.threadTitle}”</>}
          {message.sentByOwner === true && " · sent by you"}
          {message.sentByOwner === false && message.senderName && ` · from ${message.senderName}`}
        </div>
      )}
      {message?.userNote && <blockquote className="user-note">Your note: {message.userNote}</blockquote>}
    </li>
  );
}

function Suggestion({ detail }: { detail: ItemDetail }) {
  const { suggestion } = detail;
  if (!suggestion) return <p className="muted">No AI suggestion yet.</p>;
  const usedMedia = suggestion.promptVersion.endsWith("/media");
  return (
    <>
      <p className="muted">
        Generated by {suggestion.provider} · {suggestion.model} · {formatDate(suggestion.createdAt)} ·{" "}
        {usedMedia ? "saw the media" : "metadata only"} · confidence {Math.round(suggestion.confidence * 100)}%
        {detail.aggregate.aiSuggestions.length > 1 && ` · newest of ${detail.aggregate.aiSuggestions.length}`}
      </p>
      <Fields fields={suggestion.fields} />
    </>
  );
}

function Fields({ fields }: { fields: OrganizationFields }) {
  return (
    <dl>
      <dt>Type</dt>
      <dd>{fields.type ?? "—"}</dd>
      <dt>Category</dt>
      <dd>{fields.category ?? "—"}</dd>
      <dt>Tags</dt>
      <dd>
        {fields.tags.length ? fields.tags.map((tag) => <span key={tag} className="tag">{tag}</span>) : "—"}
      </dd>
      <dt>Summary</dt>
      <dd>{fields.summary ?? "—"}</dd>
      <dt>Useful for</dt>
      <dd>
        {fields.usefulFor.length ? (
          <ul className="plain">
            {fields.usefulFor.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        ) : (
          "—"
        )}
      </dd>
    </dl>
  );
}

const ORIGIN_LABELS = { ai_accepted: "accepted", human_edited: "edited", human_added: "added" } as const;

function ReviewForm({ detail, itemKey }: { detail: ItemDetail; itemKey: string }) {
  const curated = detail.aggregate.curated;
  const values = reviewInputFrom(curated?.fields ?? detail.suggestion?.fields);
  const origin = (field: keyof OrganizationFields) => <Origin curated={curated} field={field} />;
  return (
    // Remount after each save so the fields show the saved values.
    <form key={curated?.reviewedAt ?? "unreviewed"} action={saveReview.bind(null, itemKey)} className="review-form">
      <p className="muted">
        {curated
          ? `Reviewed ${formatDate(curated.reviewedAt)}. Saving replaces your review; the AI suggestion is kept as it is.`
          : detail.suggestion
            ? "Starts from the AI suggestion. Saving stores your review; the AI suggestion is kept as it is."
            : "No AI suggestion: fill in what you like."}
      </p>
      <label>
        <span>Type {origin("type")}</span>
        <input name="type" list="types" defaultValue={values.type} />
      </label>
      <label>
        <span>Category {origin("category")}</span>
        <input name="category" list="categories" defaultValue={values.category} />
      </label>
      <label>
        <span>Tags {origin("tags")} <span className="muted">one per line</span></span>
        <textarea name="tags" rows={5} defaultValue={values.tags} />
      </label>
      <label>
        <span>Summary {origin("summary")}</span>
        <textarea name="summary" rows={3} defaultValue={values.summary} />
      </label>
      <label>
        <span>Useful for {origin("usefulFor")} <span className="muted">one per line</span></span>
        <textarea name="usefulFor" rows={4} defaultValue={values.usefulFor} />
      </label>
      <datalist id="types">
        {ORGANIZATION_TYPES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="categories">
        {ORGANIZATION_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div className="actions">
        <button type="submit">Save review</button>
        <button type="reset" className="secondary">Reset edits</button>
      </div>
    </form>
  );
}

function Origin({ curated, field }: { curated: CuratedOrganization | undefined; field: keyof OrganizationFields }) {
  const origin = curated?.fieldOrigins[field];
  return origin ? <span className={`origin ${origin}`}>{ORIGIN_LABELS[origin]}</span> : null;
}
