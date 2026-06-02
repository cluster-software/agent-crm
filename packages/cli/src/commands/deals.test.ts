import { afterEach, describe, expect, it, vi } from "vitest";
import { __test as dealsCommandTest } from "./deals.js";

describe("deals command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("requires a desktop cloud session", () => {
    expect(() => dealsCommandTest.requireCloudSession()).toThrow(/cloud desktop session/);
  });

  it("normalizes human-readable pipeline stage input", () => {
    expect(dealsCommandTest.parseStage("Close Won")).toEqual({
      id: "close_won",
      title: "Close Won"
    });
    expect(dealsCommandTest.parseMigrations(["In Progress:Close Won"])).toEqual({
      in_progress: "close_won"
    });
  });

  it("sends pipeline stages and migrations to the sync engine", async () => {
    vi.stubEnv("ACRM_SYNC_ENGINE_URL", "https://sync.example.com");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("ACRM_CLOUD_ORG_ID", "org-1");
    vi.stubEnv("ACRM_DESKTOP_SESSION_TOKEN", "desktop-token");
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      pipeline: {
        stages: [
          { id: "qualified", title: "Qualified" },
          { id: "closed_won", title: "Closed Won" },
          { id: "closed_lost", title: "Closed Lost" }
        ],
        stage_counts: {}
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dealsCommandTest.runDealsPipelineSet({
      stage: ["qualified:Qualified", "closed_won:Closed Won", "closed_lost:Closed Lost"],
      map: ["lead:qualified"]
    });

    expect(result).toEqual({
      pipeline: {
        stages: [
          { id: "qualified", title: "Qualified" },
          { id: "closed_won", title: "Closed Won" },
          { id: "closed_lost", title: "Closed Lost" }
        ],
        stage_counts: {}
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sync.example.com/app/workspace/deals/pipeline");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer desktop-token");
    expect(JSON.parse(String(init.body))).toEqual({
      stages: [
        { id: "qualified", title: "Qualified" },
        { id: "closed_won", title: "Closed Won" },
        { id: "closed_lost", title: "Closed Lost" }
      ],
      migrations: { lead: "qualified" },
      source: "cli:deals-pipeline-set"
    });
  });
});
