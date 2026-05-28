import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "@agent-crm/sdk";
import { attachGranolaSubcommand } from "./import-granola.js";

describe("import granola command", () => {
  const oldSyncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldSyncEngineUrl === undefined) delete process.env.ACRM_SYNC_ENGINE_URL;
    else process.env.ACRM_SYNC_ENGINE_URL = oldSyncEngineUrl;
  });

  it("does not start backfill when --no-backfill is passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-granola-import-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
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
      const root = new Command();
      root.exitOverride();
      root.option("--workspace <path>");
      root.option("--json");
      attachGranolaSubcommand(root.command("import"));

      await root.parseAsync([
        "node",
        "acrm",
        "--workspace",
        workspacePath,
        "--json",
        "import",
        "granola",
        "--no-backfill"
      ]);

      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/integrations/granola/backfill")
      )).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
