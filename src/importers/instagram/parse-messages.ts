import type {
  ExportLocation,
  MessageContext,
} from "../../domain/archive-item.ts";
import { parseInstagramUrl } from "./instagram-url.ts";
import { decodeExportText, isRecord, millisToIso, nonEmptyText } from "./text.ts";
import type { ParseOutcome, ParsedExportRecord } from "./types.ts";

/**
 * Instagram puts a system placeholder in `content` on shares:
 * "You sent an attachment." when the exporting account sent it, and
 * "<name> sent an attachment." when anyone else did. <name> is not always the
 * full sender_name: for multi-word display names Instagram uses only the first
 * word ("Aanchal" for "Aanchal Chaurasia"). It is never text
 * the user wrote.
 */
const OWNER_PLACEHOLDER = "You sent an attachment.";
const ATTACHMENT_PLACEHOLDER = /^.+ sent an attachment\.$/;
/** Any placeholder other than "You …": the sender is not the exporting account. */
const isOtherPlaceholder = (content: string) =>
  content !== OWNER_PLACEHOLDER && ATTACHMENT_PLACEHOLDER.test(content);

/**
 * Which sender names the export's own placeholders tie to the exporting
 * account (`owner`) or to someone else (`others`). Decoded names.
 */
export type SenderEvidence = {
  owner: ReadonlySet<string>;
  others: ReadonlySet<string>;
};

export function collectSenderEvidence(threads: unknown[]): SenderEvidence {
  const owner = new Set<string>();
  const others = new Set<string>();
  for (const thread of threads) {
    if (!isRecord(thread) || !Array.isArray(thread.messages)) continue;
    for (const message of thread.messages) {
      if (!isRecord(message) || typeof message.sender_name !== "string") continue;
      if (typeof message.content !== "string") continue;
      const name = decodeExportText(message.sender_name);
      const content = decodeExportText(message.content);
      if (content === OWNER_PLACEHOLDER) owner.add(name);
      else if (isOtherPlaceholder(content)) others.add(name);
    }
  }
  return { owner, others };
}

/**
 * Whether the archive owner sent a message; undefined when it cannot be told
 * reliably. In order:
 *   1. sender is in `configuredOwnerNames` (the owner's own accounts)  → true
 *   2. content is "You sent an attachment."                            → true
 *   3. content is any other "<name> sent an attachment."               → false
 *   4. no placeholder: the sender name is tied only to the owner, or only
 *      to others, by placeholders elsewhere in the export               → true / false
 *   5. anything else (unseen or ambiguous name, missing sender)         → undefined
 */
export function resolveSentByOwner(
  senderName: string | undefined,
  content: string | undefined,
  evidence: SenderEvidence,
  configuredOwnerNames: ReadonlySet<string>,
): boolean | undefined {
  if (senderName !== undefined && configuredOwnerNames.has(senderName)) return true;
  if (content === OWNER_PLACEHOLDER) return true;
  if (content !== undefined && isOtherPlaceholder(content)) return false;
  if (senderName === undefined) return undefined;

  const isOwnerName = evidence.owner.has(senderName);
  const isOtherName = evidence.others.has(senderName);
  if (isOwnerName && !isOtherName) return true;
  if (isOtherName && !isOwnerName) return false;
  return undefined;
}

/**
 * Parses messages/<inbox|message_requests>/<thread>/message_N.json:
 * `{ participants, messages: [...], title, thread_path, ... }`. Only messages
 * with a `share` pointing at an Instagram post/reel become records; plain chat
 * messages are ignored.
 */
export function parseMessagesFile(
  path: string,
  data: unknown,
  exportId: string | undefined,
  senderEvidence: SenderEvidence,
  configuredOwnerNames: ReadonlySet<string>,
): ParseOutcome {
  const outcome: ParseOutcome = { records: [], skipped: [], warnings: [], ignored: 0 };
  const location = (pointer?: string): ExportLocation => ({
    file: path,
    ...(pointer !== undefined && { pointer }),
    ...(exportId !== undefined && { exportId }),
  });

  if (!isRecord(data) || !Array.isArray(data.messages)) {
    outcome.skipped.push({ exportLocation: location(), reason: "expected a thread with a messages array" });
    return outcome;
  }

  const threadId = typeof data.thread_path === "string" ? data.thread_path : undefined;
  const threadTitle = nonEmptyText(data.title);

  data.messages.forEach((message, index) => {
    const exportLocation = location(`/messages/${index}`);
    if (!isRecord(message)) {
      outcome.skipped.push({ exportLocation, reason: "message is not an object" });
      return;
    }
    if (message.share === undefined) {
      outcome.ignored++;
      return;
    }
    const share = message.share;
    const originalUrl = isRecord(share) && typeof share.link === "string" ? share.link : "";
    if (originalUrl === "") {
      outcome.skipped.push({ exportLocation, reason: "share has no link" });
      return;
    }
    const parsed = parseInstagramUrl(originalUrl);
    if (!parsed.ok) {
      outcome.skipped.push({ exportLocation, reason: parsed.reason });
      return;
    }

    const senderName = nonEmptyText(message.sender_name);
    const content =
      typeof message.content === "string" ? decodeExportText(message.content) : undefined;
    const sentByOwner = resolveSentByOwner(
      senderName,
      content,
      senderEvidence,
      configuredOwnerNames,
    );

    // userNote is never set here. Share messages carry only the attachment
    // placeholder; the only other text seen on a share is on link-only
    // shares (replies to stories/posts), which is conversation, not the
    // owner's context for a shared post. Such text stays in `raw` only.
    const messageContext: MessageContext = {
      ...(threadId && { threadId }),
      ...(threadTitle && { threadTitle }),
      ...(senderName && { senderName }),
      ...(sentByOwner !== undefined && { sentByOwner }),
    };

    const username = isRecord(share) ? nonEmptyText(share.original_content_owner) : undefined;
    const shareText = isRecord(share) ? nonEmptyText(share.share_text) : undefined;
    const occurredAt = millisToIso(message.timestamp_ms);

    const record: ParsedExportRecord = {
      source: "messages",
      naturalKey: `messages:${threadId ?? path}:${String(message.timestamp_ms)}:${originalUrl}`,
      originalUrl,
      url: parsed.content,
      ...(occurredAt && { occurredAt }),
      ...(username && { creator: { username } }),
      captions: shareText ? [shareText] : [],
      message: messageContext,
      exportLocation,
      raw: structuredClone(message),
    };
    outcome.records.push(record);
  });

  return outcome;
}
