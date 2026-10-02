import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { UserId } from "../../domain/archive-item.ts";
import { classifyExportFile, importInstagramExport } from "./import-export.ts";
import type { ExportFile, ImportOptions, ImportResult } from "./types.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const LIKED = "your_instagram_activity/likes/liked_posts.json";
const SAVED = "your_instagram_activity/saved/saved_posts.json";
const THREAD = "your_instagram_activity/messages/inbox/friend_1234567890/message_1.json";

function load(path: string): ExportFile {
  return { path, data: JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) };
}

const OPTIONS: ImportOptions = {
  ownerId: "owner-1" as UserId,
  importedAt: "2026-09-30T12:00:00.000Z",
  exportId: "export-2026-09",
};

function importAll(options: ImportOptions = OPTIONS): ImportResult {
  return importInstagramExport([load(LIKED), load(SAVED), load(THREAD)], options);
}

function itemFor(result: ImportResult, shortcode: string) {
  const found = result.items.find(
    (i) => i.item.identity.kind === "shortcode" && i.item.identity.shortcode === shortcode,
  );
  assert.ok(found, `no item for ${shortcode}`);
  return found;
}

describe("Messages share", () => {
  test("becomes a messages SourceRecord with verbatim URL, time, creator and share text", () => {
    const result = importInstagramExport([load(THREAD)], OPTIONS);
    const { item, sources } = itemFor(result, "ReelAAA111");
    assert.equal(sources.length, 1);
    const [record] = sources;

    assert.equal(record.source, "messages");
    assert.equal(
      record.originalUrl,
      "https://www.instagram.com/reel/ReelAAA111/?id=3995492971799002740_69479576036",
    );
    assert.equal(record.occurredAt, "2026-09-28T14:39:57.945Z");
    assert.deepEqual(record.creator, { username: "example_artist" });
    assert.equal(record.sharedText, "it’s a sketchbook tour 🎨\n\n#sketchbook");
    assert.deepEqual(record.message, {
      threadId: "inbox/friend_1234567890",
      threadTitle: "Friend",
      senderName: "Owner’s Studio",
      sentByOwner: true,
    });
    assert.deepEqual(record.exportLocation, {
      file: THREAD,
      pointer: "/messages/0",
      exportId: "export-2026-09",
    });
    const thread = load(THREAD).data as { messages: unknown[] };
    assert.deepEqual(record.raw, thread.messages[0]);
    assert.equal(item.kind, "reel");
    assert.equal(item.canonicalUrl, "https://www.instagram.com/reel/ReelAAA111/");
  });

  test('a normal share with "You sent an attachment." has no userNote', () => {
    const [record] = itemFor(importInstagramExport([load(THREAD)], OPTIONS), "ReelAAA111").sources;
    const raw = record.raw as { content: string };
    assert.equal(raw.content, "You sent an attachment.");
    assert.equal(record.message?.sentByOwner, true);
    assert.equal(record.message?.userNote, undefined);
    assert.equal("userNote" in (record.message ?? {}), false);
  });

  test("no Messages record ever gets a userNote", () => {
    for (const { sources } of importAll().items) {
      for (const s of sources) assert.equal(s.message?.userNote, undefined);
    }
  });

  test("owner text on a link-only share (a reply) stays in raw only, not userNote", () => {
    const [record] = itemFor(importInstagramExport([load(THREAD)], OPTIONS), "ReplyEEE555").sources;
    assert.equal(record.message?.userNote, undefined);
    assert.equal(record.sharedText, undefined);
    assert.equal((record.raw as { content: string }).content, "keeping this for the logo project");
    // No placeholder here; the name is tied to the owner by "You sent an
    // attachment." elsewhere in the export.
    assert.equal(record.message?.sentByOwner, true);
  });

  test('"<sender_name> sent an attachment." marks the sender as not the owner', () => {
    const { sources } = itemFor(importInstagramExport([load(THREAD)], OPTIONS), "CarouBBB222");
    for (const s of sources) {
      assert.equal(s.message?.senderName, "Friend");
      assert.equal(s.message?.sentByOwner, false);
    }
  });
});

describe("Sender ownership", () => {
  const linkOnlyShare = (sender_name: string, shortcode: string) => ({
    sender_name,
    timestamp_ms: 1790500000000,
    share: { link: `https://www.instagram.com/p/${shortcode}/` },
    is_geoblocked_for_viewer: false,
    is_unsent_image_by_messenger_kid_parent: false,
  });
  const attachment = (sender_name: string, content: string, shortcode: string) => ({
    sender_name,
    timestamp_ms: 1790400000000,
    content,
    share: {
      link: `https://www.instagram.com/reel/${shortcode}/`,
      share_text: "",
      original_content_owner: "someone",
    },
  });
  const thread = (messages: unknown[]): ExportFile => ({
    path: "your_instagram_activity/messages/inbox/t_1/message_1.json",
    data: { participants: [], messages, title: "T", thread_path: "inbox/t_1" },
  });
  const sentByOwnerOf = (result: ImportResult, shortcode: string) =>
    itemFor(result, shortcode).sources[0].message?.sentByOwner;

  test("is unknown when the sender cannot be matched to the owner or anyone else", () => {
    const result = importInstagramExport([thread([linkOnlyShare("Stranger", "Unknown1")])], OPTIONS);
    const [record] = itemFor(result, "Unknown1").sources;
    assert.equal(record.message?.senderName, "Stranger");
    assert.equal(record.message?.sentByOwner, undefined);
    assert.equal("sentByOwner" in (record.message ?? {}), false);
  });

  test("is unknown when a known owner exists but the sender is not otherwise identified", () => {
    const result = importInstagramExport(
      [thread([attachment("Me", "You sent an attachment.", "Mine1"), linkOnlyShare("Stranger", "Unknown1")])],
      OPTIONS,
    );
    assert.equal(sentByOwnerOf(result, "Mine1"), true);
    assert.equal(sentByOwnerOf(result, "Unknown1"), undefined);
  });

  test("is unknown when the export ties the same name to both the owner and someone else", () => {
    const result = importInstagramExport(
      [
        thread([
          attachment("Sam", "You sent an attachment.", "Mine1"),
          attachment("Sam", "Sam sent an attachment.", "Theirs1"),
          linkOnlyShare("Sam", "Ambiguous1"),
        ]),
      ],
      OPTIONS,
    );
    assert.equal(sentByOwnerOf(result, "Mine1"), true);
    assert.equal(sentByOwnerOf(result, "Theirs1"), false);
    assert.equal(sentByOwnerOf(result, "Ambiguous1"), undefined);
  });

  test("a placeholder with only the first word of a multi-word sender_name is false", () => {
    const result = importInstagramExport(
      [
        thread([
          attachment("Aanchal Example", "Aanchal sent an attachment.", "Theirs1"),
          linkOnlyShare("Aanchal Example", "Reply1"),
        ]),
      ],
      OPTIONS,
    );
    assert.equal(sentByOwnerOf(result, "Theirs1"), false);
    // The name is now known as someone else's, so the link-only share is too.
    assert.equal(sentByOwnerOf(result, "Reply1"), false);
  });

  test("a link-only share from a name only ever seen as someone else is false", () => {
    const result = importInstagramExport(
      [thread([attachment("Friend", "Friend sent an attachment.", "Theirs1"), linkOnlyShare("Friend", "Reply1")])],
      OPTIONS,
    );
    assert.equal(sentByOwnerOf(result, "Reply1"), false);
  });

  test("ownerSenderNames marks the owner's other accounts as the owner, without disabling detection", () => {
    const result = importInstagramExport([load(THREAD)], {
      ...OPTIONS,
      ownerSenderNames: ["Friend"],
    });
    for (const s of itemFor(result, "CarouBBB222").sources) {
      assert.equal(s.message?.sentByOwner, true);
    }
    assert.equal(itemFor(result, "ReelAAA111").sources[0].message?.sentByOwner, true);
  });
});

describe("Saved post", () => {
  test("becomes a saved SourceRecord with seconds timestamp, owner and caption", () => {
    const result = importInstagramExport([load(SAVED)], OPTIONS);
    const [record] = itemFor(result, "ReelAAA111").sources;
    assert.equal(record.source, "saved");
    assert.equal(record.id, "owner-1:saved:fbid:18000000000000011");
    assert.equal(record.originalUrl, "https://www.instagram.com/reel/ReelAAA111/");
    assert.equal(record.occurredAt, "2026-09-17T05:07:40.000Z");
    assert.deepEqual(record.creator, { username: "example_artist", displayName: "Zoë Example" });
    assert.equal(record.sharedText, "it’s a sketchbook tour 🎨\n\n#sketchbook");
    assert.equal(record.message, undefined);
    assert.deepEqual(record.exportLocation, { file: SAVED, pointer: "/0", exportId: "export-2026-09" });
  });
});

describe("Liked post", () => {
  test("becomes a liked SourceRecord; owner website is not mistaken for a profile URL", () => {
    const result = importInstagramExport([load(LIKED)], OPTIONS);
    const [record] = itemFor(result, "ReelAAA111").sources;
    assert.equal(record.source, "liked");
    assert.equal(record.occurredAt, "2026-09-29T12:27:39.000Z");
    assert.deepEqual(record.creator, { username: "example_artist", displayName: "Zoë Example" });
    assert.equal("profileUrl" in (record.creator ?? {}), false);
  });

  test("a Caption row repeated with the same text yields one caption and no warning", () => {
    const result = importInstagramExport([load(LIKED)], OPTIONS);
    assert.equal(itemFor(result, "PostCCC333").sources[0].sharedText, "type specimen, first draft");
    assert.equal(result.warnings.length, 0);
  });
});

describe("Same post in several sources", () => {
  test("is one ArchiveItem with one SourceRecord per occurrence", () => {
    const { item, sources } = itemFor(importAll(), "ReelAAA111");
    assert.deepEqual(
      sources.map((s) => s.source),
      ["saved", "messages", "liked"], // ordered by occurredAt
    );
    assert.equal(new Set(sources.map((s) => s.archiveItemId)).size, 1);
    assert.equal(sources[0].archiveItemId, item.id);
    assert.equal(item.id, "owner-1:shortcode:ReelAAA111");
    // Each source keeps its own URL form and timestamp.
    assert.equal(new Set(sources.map((s) => s.originalUrl)).size, 2);
    assert.equal(new Set(sources.map((s) => s.occurredAt)).size, 3);
    // Original metadata comes from the richest source (saved), with provenance.
    assert.deepEqual(item.original.creator, {
      value: { username: "example_artist", displayName: "Zoë Example" },
      provenance: { from: "export", sourceRecordId: "owner-1:saved:fbid:18000000000000011" },
    });
    assert.equal(item.original.caption?.value, "it’s a sketchbook tour 🎨\n\n#sketchbook");
    assert.equal(item.original.postedAt, undefined);
  });
});

describe("Carousel shared in Messages", () => {
  test("slides share the post's shortcode and stay one carousel item", () => {
    const result = importAll();
    const { item, sources } = itemFor(result, "CarouBBB222");
    assert.equal(item.kind, "carousel");
    assert.equal(item.canonicalUrl, "https://www.instagram.com/p/CarouBBB222/");
    assert.deepEqual(sources.map((s) => s.source), ["liked", "messages", "messages"]);

    // Child media ids are preserved in the verbatim URLs, not turned into items.
    const childUrls = sources.filter((s) => s.source === "messages").map((s) => s.originalUrl);
    assert.deepEqual(childUrls, [
      "https://www.instagram.com/p/CarouBBB222/?carousel_share_child_media_id=3978319684826841251_38343213362",
      "https://www.instagram.com/p/CarouBBB222/?carousel_share_child_media_id=3978319684633888767_38343213362",
    ]);
    const idsMentioningChild = result.items.filter((i) => i.item.id.includes("3978319684"));
    assert.equal(idsMentioningChild.length, 0);

    // Slide shares carry an empty share_text: no caption is invented; the
    // item caption comes from the Liked entry.
    for (const s of sources.filter((s) => s.source === "messages")) {
      assert.equal(s.sharedText, undefined);
    }
    assert.equal(item.original.caption?.value, "five poster studies, swipe for process");
  });
});

describe("Missing optional metadata", () => {
  test("an entry with empty caption and no owner still imports, with nothing invented", () => {
    const { item, sources } = itemFor(importAll(), "BareDDD444");
    const [record] = sources;
    assert.equal(record.sharedText, undefined);
    assert.equal(record.creator, undefined);
    assert.deepEqual(item.original, {});
    assert.equal(item.kind, "unknown");
  });

  test("a missing timestamp leaves occurredAt unset", () => {
    const result = importInstagramExport(
      [{ path: SAVED, data: [{ label_values: [{ label: "URL", href: "https://www.instagram.com/p/NoTime1/" }] }] }],
      OPTIONS,
    );
    const [record] = itemFor(result, "NoTime1").sources;
    assert.equal(record.occurredAt, undefined);
    assert.equal(record.id, "owner-1:saved:undefined:shortcode:NoTime1");
  });
});

describe("Malformed and irrelevant entries", () => {
  test("story links, non-Instagram links and plain messages are skipped or ignored", () => {
    const result = importAll();
    const thread = result.files.find((f) => f.path === THREAD);
    assert.deepEqual(thread, { path: THREAD, kind: "messages", imported: 4, ignored: 2, skipped: 2 });
    assert.deepEqual(
      result.skipped.map((s) => [s.exportLocation.pointer, s.reason]),
      [
        ["/messages/1", "story link (not a post or reel)"],
        ["/messages/6", "not an Instagram URL"],
      ],
    );
  });

  test("malformed entries are skipped without aborting the import", () => {
    const result = importInstagramExport(
      [
        { path: LIKED, data: [42, { label_values: [] }, { label_values: [{ label: "URL", href: "not a url" }] }, ...(load(LIKED).data as unknown[])] },
        { path: SAVED, data: { not: "an array" } },
        { path: THREAD, data: { messages: [null, { sender_name: "X", share: {} }, { share: { link: 7 } }] } },
        { path: "your_instagram_activity/saved/saved_collections.json", data: {} },
      ],
      OPTIONS,
    );
    assert.equal(result.items.length, 3); // the three valid liked entries
    assert.deepEqual(
      result.skipped.map((s) => `${s.exportLocation.file}#${s.exportLocation.pointer ?? ""}: ${s.reason}`),
      [
        `${LIKED}#/0: entry has no label_values`,
        `${LIKED}#/1: entry has no URL`,
        `${LIKED}#/2: not a valid URL`,
        `${THREAD}#/messages/0: message is not an object`,
        `${THREAD}#/messages/1: share has no link`,
        `${THREAD}#/messages/2: share has no link`,
        `${SAVED}#: expected a JSON array`,
      ],
    );
    assert.equal(
      result.files.find((f) => f.path.endsWith("saved_collections.json"))?.kind,
      "unsupported",
    );
  });
});

describe("Idempotence", () => {
  test("importing the same input twice gives identical results", () => {
    assert.deepEqual(importAll(), importAll());
  });

  test("file order and import time do not change logical ids", () => {
    const a = importAll();
    const b = importInstagramExport([load(THREAD), load(SAVED), load(LIKED)], {
      ...OPTIONS,
      importedAt: "2027-01-01T00:00:00.000Z",
    });
    const ids = (r: ImportResult) =>
      r.items.map((i) => [i.item.id, i.sources.map((s) => s.id)]);
    assert.deepEqual(ids(a), ids(b));
  });

  test("the same file supplied twice does not duplicate SourceRecords", () => {
    const once = importAll();
    const twice = importInstagramExport(
      [load(LIKED), load(SAVED), load(THREAD), load(LIKED)],
      OPTIONS,
    );
    assert.deepEqual(twice.items, once.items);
  });
});

describe("classifyExportFile", () => {
  test("recognises the supported export paths", () => {
    assert.equal(classifyExportFile(LIKED), "liked");
    assert.equal(classifyExportFile(SAVED), "saved");
    assert.equal(classifyExportFile(THREAD), "messages");
    assert.equal(
      classifyExportFile("your_instagram_activity/messages/message_requests/x_1/message_2.json"),
      "messages",
    );
    assert.equal(classifyExportFile("your_instagram_activity/saved/saved_collections.json"), "unsupported");
  });
});
