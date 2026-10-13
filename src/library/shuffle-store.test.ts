import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createShuffleStore, type ShuffleRequest } from "./shuffle-store.ts";

/** A stand-in for the server: answers each request when told to, with the items given. */
function fakeServer() {
  const calls: { request: ShuffleRequest; resolve: (items: string[]) => void; reject: (e: Error) => void }[] = [];
  const fetchSelection = (request: ShuffleRequest) =>
    new Promise<string[]>((resolve, reject) => calls.push({ request, resolve, reject }));
  return { calls, fetchSelection };
}

/** Records any attempt to navigate: history entries, URL changes, reloads. */
function watchNavigation() {
  const attempts: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { history: g.history, location: g.location };
  g.history = {
    pushState: () => attempts.push("pushState"),
    replaceState: () => attempts.push("replaceState"),
    back: () => attempts.push("back"),
    go: () => attempts.push("go"),
  };
  g.location = {
    href: "http://localhost/",
    assign: () => attempts.push("assign"),
    replace: () => attempts.push("replace"),
    reload: () => attempts.push("reload"),
  };
  return { attempts, restore: () => Object.assign(g, saved) };
}

describe("shuffle store", () => {
  let navigation: ReturnType<typeof watchNavigation>;
  beforeEach(() => (navigation = watchNavigation()));
  afterEach(() => navigation.restore());

  test("starts on the whole archive", () => {
    const store = createShuffleStore(fakeServer().fetchSelection);
    assert.deepEqual(store.getSnapshot(), { version: 0, pending: false });
  });

  test("a Shuffle replaces the selection in place, without touching the URL or history", async () => {
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const seen: boolean[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().pending));

    const done = store.shuffle();
    assert.equal(store.getSnapshot().pending, true);
    server.calls[0]!.resolve(["a", "b", "c"]);
    await done;

    assert.deepEqual(store.getSnapshot(), { items: ["a", "b", "c"], version: 1, pending: false });
    assert.deepEqual(seen, [true, false]);
    assert.deepEqual(navigation.attempts, [], "no navigation");
    assert.equal((globalThis as { location?: { href: string } }).location?.href, "http://localhost/", "URL unchanged");
  });

  test("successive Shuffles each show their own selection; items may repeat across them", async () => {
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const first = store.shuffle();
    server.calls[0]!.resolve(["a", "b"]);
    await first;
    const second = store.shuffle();
    server.calls[1]!.resolve(["b", "c"]);
    await second;
    assert.deepEqual(store.getSnapshot(), { items: ["b", "c"], version: 2, pending: false });
    assert.equal(server.calls.length, 2, "each press asks the server afresh");
    assert.deepEqual(navigation.attempts, []);
  });

  test("passes the focused item along, to keep it in the new selection", async () => {
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const done = store.shuffle({ keep: "PostABC" });
    assert.deepEqual(server.calls[0]!.request, { keep: "PostABC" });
    server.calls[0]!.resolve(["PostABC"]);
    await done;
  });

  test("only the latest Shuffle lands", async () => {
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const slow = store.shuffle();
    const fast = store.shuffle();
    server.calls[1]!.resolve(["new"]);
    await fast;
    server.calls[0]!.resolve(["old"]);
    await slow;
    assert.deepEqual(store.getSnapshot().items, ["new"]);
  });

  test("the selection outlives the library page: leaving and coming back by top-bar links keeps it", async () => {
    // Regression: the archive's name in the top bar used to reset the store to the whole archive.
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const done = store.shuffle();
    server.calls[0]!.resolve(["b", "a", "c"]);
    await done;
    const shuffled = store.getSnapshot();

    // The library's canvas unmounts (Search, Details, or the brand link's own navigation)…
    const unsubscribe = store.subscribe(() => assert.fail("nothing changes the selection while away"));
    unsubscribe();
    // …and mounts again: it reads the same selection, same version (so Back may restore its saved view).
    assert.equal(store.getSnapshot(), shuffled);
    assert.deepEqual(Object.keys(store).sort(), ["getSnapshot", "shuffle", "subscribe"], "no way to discard a Shuffle but another Shuffle");
    assert.equal(server.calls.length, 1, "coming back asks the server for nothing");
    assert.deepEqual(navigation.attempts, []);
  });

  test("a failed or empty Shuffle keeps what is shown", async (t) => {
    t.mock.method(console, "error", () => {});
    const server = fakeServer();
    const store = createShuffleStore(server.fetchSelection);
    const ok = store.shuffle();
    server.calls[0]!.resolve(["a"]);
    await ok;
    const failing = store.shuffle();
    server.calls[1]!.reject(new Error("offline"));
    await failing;
    assert.deepEqual(store.getSnapshot(), { items: ["a"], version: 1, pending: false });
    const empty = store.shuffle();
    server.calls[2]!.resolve([]);
    await empty;
    assert.deepEqual(store.getSnapshot(), { items: ["a"], version: 1, pending: false });
  });
});
