import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ArchiveItemId, MediaAssetId } from "./archive-item.ts";
import {
  contentAssetId,
  defaultRetryPolicy,
  derivedFrameAssetId,
  isDue,
  newRetrievalRequest,
  recordRetrievalFailure,
  recordRetrievalSuccess,
  requestManualRetry,
  RETRIEVAL_PRIORITY,
  type RetrievalFailure,
} from "./media-retrieval.ts";

const ITEM = "owner-1:shortcode:X1" as ArchiveItemId;
const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";
const network: RetrievalFailure = { kind: "temporary", code: "network_error", message: "ECONNRESET" };
const deleted: RetrievalFailure = { kind: "unavailable", code: "deleted", message: "HTTP 404" };

describe("retrieval request transitions", () => {
  test("a new request is pending, due immediately, with no attempts", () => {
    const request = newRetrievalRequest(ITEM, RETRIEVAL_PRIORITY.normal, T0);
    assert.deepEqual(request, {
      archiveItemId: ITEM, priority: 0, status: "pending", attempts: 0, createdAt: T0, updatedAt: T0,
    });
    assert.equal(isDue(request, T0), true);
  });

  test("success → stored, counts the attempt, clears retry data", () => {
    const failed = recordRetrievalFailure(newRetrievalRequest(ITEM, 0, T0), network, T0);
    const stored = recordRetrievalSuccess(requestManualRetry(failed, T1), T1);
    assert.equal(stored.status, "stored");
    assert.equal(stored.attempts, 2);
    assert.equal(stored.lastAttemptAt, T1);
    assert.equal(stored.nextAttemptAt, undefined);
    assert.equal(stored.lastFailure, undefined);
    assert.equal(isDue(stored, "2030-01-01T00:00:00.000Z"), false);
  });

  test("temporary failure → failed, retryable, scheduled by backoff", () => {
    const failed = recordRetrievalFailure(newRetrievalRequest(ITEM, 0, T0), network, T0);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastAttemptAt, T0);
    assert.deepEqual(failed.lastFailure, network);
    assert.equal(failed.nextAttemptAt, "2026-10-01T10:01:00.000Z"); // 1 min
    assert.equal(isDue(failed, T0), false);
    assert.equal(isDue(failed, "2026-10-01T10:01:00.000Z"), true);

    const again = recordRetrievalFailure(failed, network, "2026-10-01T10:01:00.000Z");
    assert.equal(again.attempts, 2);
    assert.equal(again.nextAttemptAt, "2026-10-01T10:05:00.000Z"); // 4 min
  });

  test("rate limits back off longer and honour the source's retry-after", () => {
    const limited: RetrievalFailure = { kind: "temporary", code: "rate_limited", message: "429", retryAfterMs: 2 * 3_600_000 };
    const failed = recordRetrievalFailure(newRetrievalRequest(ITEM, 0, T0), limited, T0);
    assert.equal(failed.nextAttemptAt, "2026-10-01T12:00:00.000Z");
    assert.equal(defaultRetryPolicy({ ...limited, retryAfterMs: undefined }, 1), 15 * 60_000);
  });

  test("automatic retries stop after the policy's limit; manual retry still works", () => {
    let request = newRetrievalRequest(ITEM, 0, T0);
    for (let i = 0; i < 5; i++) request = recordRetrievalFailure(request, network, T0);
    assert.equal(request.status, "failed");
    assert.equal(request.attempts, 5);
    assert.equal(request.nextAttemptAt, undefined);
    assert.equal(isDue(request, "2030-01-01T00:00:00.000Z"), false);

    const retried = requestManualRetry(request, T1);
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempts, 5);
    assert.deepEqual(retried.lastFailure, network); // kept for context
    assert.equal(isDue(retried, T1), true);
  });

  test("unavailable content → unavailable, never retried automatically", () => {
    const unavailable = recordRetrievalFailure(newRetrievalRequest(ITEM, 0, T0), deleted, T0);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.attempts, 1);
    assert.equal(unavailable.nextAttemptAt, undefined);
    assert.deepEqual(unavailable.lastFailure, deleted);
    assert.equal(isDue(unavailable, "2030-01-01T00:00:00.000Z"), false);
    assert.equal(isDue(requestManualRetry(unavailable, T1), T1), true);
  });
});

test("asset ids are deterministic", () => {
  assert.equal(contentAssetId(ITEM, 2), "owner-1:shortcode:X1:media:2");
  assert.equal(
    derivedFrameAssetId("owner-1:shortcode:X1:media:0" as MediaAssetId, 1500),
    "owner-1:shortcode:X1:media:0:frame:1500",
  );
});
