import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  archiveDatabasePath,
  archiveMediaDir,
  assertSourcesSeparate,
  dataSourceFromEnv,
  DEFAULT_DEMO_DATABASE_PATH,
  DEFAULT_DEMO_MEDIA_STORAGE_DIR,
} from "./data-source.ts";
import { databasePathFromEnv } from "../persistence/sqlite/database.ts";
import { mediaStorageDirFromEnv } from "../media/local-media-storage.ts";

const PERSONAL = { DATABASE_PATH: "/archive/data/insta-archive.sqlite", MEDIA_STORAGE_DIR: "/archive/data/media" };

describe("selecting the data source", () => {
  test("personal is the default; demo only when asked for", () => {
    assert.equal(dataSourceFromEnv({}), "personal");
    assert.equal(dataSourceFromEnv({ ARCHIVE_DATA_SOURCE: " " }), "personal");
    assert.equal(dataSourceFromEnv({ ARCHIVE_DATA_SOURCE: "personal" }), "personal");
    assert.equal(dataSourceFromEnv({ ARCHIVE_DATA_SOURCE: "demo" }), "demo");
    assert.throws(() => dataSourceFromEnv({ ARCHIVE_DATA_SOURCE: "Demo" }), /must be "personal" or "demo"/);
  });

  test("personal mode resolves exactly as before: DATABASE_PATH and MEDIA_STORAGE_DIR", () => {
    assert.equal(databasePathFromEnv(PERSONAL), PERSONAL.DATABASE_PATH);
    assert.equal(mediaStorageDirFromEnv(PERSONAL), PERSONAL.MEDIA_STORAGE_DIR);
    assert.throws(() => databasePathFromEnv({}), /DATABASE_PATH is not set/);
    assert.throws(() => mediaStorageDirFromEnv({}), /MEDIA_STORAGE_DIR is not set/);
  });

  test("demo mode never resolves to the personal locations, even with them configured", () => {
    const env = { ...PERSONAL, ARCHIVE_DATA_SOURCE: "demo" };
    assert.equal(archiveDatabasePath(env), resolve(DEFAULT_DEMO_DATABASE_PATH));
    assert.equal(archiveMediaDir(env), resolve(DEFAULT_DEMO_MEDIA_STORAGE_DIR));
    assert.notEqual(databasePathFromEnv(env), PERSONAL.DATABASE_PATH);
    assert.notEqual(mediaStorageDirFromEnv(env), PERSONAL.MEDIA_STORAGE_DIR);
    // Overrides for the demo locations are honoured.
    const custom = { ...env, DEMO_DATABASE_PATH: "/demo/x.sqlite", DEMO_MEDIA_STORAGE_DIR: "/demo/m" };
    assert.deepEqual([archiveDatabasePath(custom), archiveMediaDir(custom)], ["/demo/x.sqlite", "/demo/m"]);
  });

  test("personal mode never reads the demo locations", () => {
    const env = { ...PERSONAL, DEMO_DATABASE_PATH: "/demo/x.sqlite", DEMO_MEDIA_STORAGE_DIR: "/demo/m" };
    assert.deepEqual([archiveDatabasePath(env), archiveMediaDir(env)], [PERSONAL.DATABASE_PATH, PERSONAL.MEDIA_STORAGE_DIR]);
  });
});

describe("keeping the two archives apart", () => {
  const overlapping: [string, Record<string, string>][] = [
    ["the same database", { DEMO_DATABASE_PATH: PERSONAL.DATABASE_PATH }],
    ["the same media directory", { DEMO_MEDIA_STORAGE_DIR: PERSONAL.MEDIA_STORAGE_DIR }],
    ["a demo database inside the personal media", { DEMO_DATABASE_PATH: "/archive/data/media/demo.sqlite" }],
    ["demo media inside the personal media", { DEMO_MEDIA_STORAGE_DIR: "/archive/data/media/demo" }],
    ["demo media containing the personal archive", { DEMO_MEDIA_STORAGE_DIR: "/archive" }],
    ["demo media containing the personal database", { DEMO_MEDIA_STORAGE_DIR: "/archive/data" }],
    ["the same path, written differently", { DEMO_DATABASE_PATH: "/archive/data/../data/insta-archive.sqlite" }],
  ];
  for (const [name, demo] of overlapping) {
    test(`refuses ${name}, in either mode`, () => {
      for (const mode of ["demo", "personal"]) {
        const env = { ...PERSONAL, DEMO_DATABASE_PATH: "/demo/x.sqlite", DEMO_MEDIA_STORAGE_DIR: "/demo/m", ...demo, ARCHIVE_DATA_SOURCE: mode };
        assert.throws(() => archiveDatabasePath(env), /overlap/, `${mode}: database`);
        assert.throws(() => archiveMediaDir(env), /overlap/, `${mode}: media`);
        assert.throws(() => databasePathFromEnv(env), /overlap/);
        assert.throws(() => mediaStorageDirFromEnv(env), /overlap/);
      }
    });
  }

  test("refuses a personal archive configured inside the demo folder", () => {
    const env = { DATABASE_PATH: "./demo-data/insta-archive.sqlite", MEDIA_STORAGE_DIR: "./data/media" };
    assert.throws(() => archiveDatabasePath(env), /overlap/);
  });

  test("allows neighbouring folders that only share a prefix", () => {
    assert.doesNotThrow(() => assertSourcesSeparate({ ...PERSONAL, DEMO_DATABASE_PATH: "/archive/data-demo/x.sqlite", DEMO_MEDIA_STORAGE_DIR: "/archive/data-demo/m" }));
  });

  const dir = mkdtempSync(join(tmpdir(), "insta-archive-sources-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("sees through symlinks: a demo folder that links to the personal media is refused", () => {
    mkdirSync(join(dir, "personal-media"));
    symlinkSync(join(dir, "personal-media"), join(dir, "demo-link"));
    const env = {
      DATABASE_PATH: join(dir, "personal.sqlite"), MEDIA_STORAGE_DIR: join(dir, "personal-media"),
      DEMO_DATABASE_PATH: join(dir, "demo.sqlite"), DEMO_MEDIA_STORAGE_DIR: join(dir, "demo-link", "media"),
      ARCHIVE_DATA_SOURCE: "demo",
    };
    assert.throws(() => archiveMediaDir(env), /overlap/);
  });
});
