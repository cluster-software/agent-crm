import { afterEach, describe, expect, it, vi } from "vitest";
import { __test as granolaCommandTest } from "./import-granola.js";
import { openTestWorkspace } from "../test/open-test-db.js";

const TEST_DATABASE_URL = "postgres://user:pass@localhost/acrm_test";

describe("import granola command", () => {
  const oldSyncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldSyncEngineUrl === undefined) delete process.env.ACRM_SYNC_ENGINE_URL;
    else process.env.ACRM_SYNC_ENGINE_URL = oldSyncEngineUrl;
  });

  it("does not start backfill when --no-backfill is passed", async () => {
    const db = await openTestWorkspace();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/register")) return Response.json({ ok: true });
      if (url.includes("/integrations/granola/export")) {
        return Response.json({ ok: true, data: { transcripts: [] } });
      }
      return Response.json({ ok: false, error: "unexpected request" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await granolaCommandTest.runImportGranola({
        workspace: TEST_DATABASE_URL,
        db,
        startBackfill: false,
      });

      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/integrations/granola/backfill")
      )).toBe(false);
    } finally {
      await db.close();
    }
  });
});
