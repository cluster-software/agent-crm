import { afterEach, describe, expect, it, vi } from "vitest";
import { ERR, type AcrmError } from "@agent-crm/sdk";
import { __test as linkedinCommandTest } from "./import-linkedin.js";
import {
  LINKEDIN_NOT_CONNECTED_HINT,
  LINKEDIN_NOT_CONNECTED_MESSAGE,
} from "../lib/cloud-workspace.js";
import { openTestWorkspace } from "../test/open-test-db.js";

const TEST_DATABASE_URL = "postgres://user:pass@localhost/acrm_test";

describe("import linkedin command", () => {
  const oldSyncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL;
  const oldCloudWorkspaceId = process.env.ACRM_CLOUD_WORKSPACE_ID;
  const oldCloudOrgId = process.env.ACRM_CLOUD_ORG_ID;
  const oldDesktopSessionToken = process.env.ACRM_DESKTOP_SESSION_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldSyncEngineUrl === undefined) delete process.env.ACRM_SYNC_ENGINE_URL;
    else process.env.ACRM_SYNC_ENGINE_URL = oldSyncEngineUrl;
    if (oldCloudWorkspaceId === undefined) delete process.env.ACRM_CLOUD_WORKSPACE_ID;
    else process.env.ACRM_CLOUD_WORKSPACE_ID = oldCloudWorkspaceId;
    if (oldCloudOrgId === undefined) delete process.env.ACRM_CLOUD_ORG_ID;
    else process.env.ACRM_CLOUD_ORG_ID = oldCloudOrgId;
    if (oldDesktopSessionToken === undefined) delete process.env.ACRM_DESKTOP_SESSION_TOKEN;
    else process.env.ACRM_DESKTOP_SESSION_TOKEN = oldDesktopSessionToken;
  });

  it("imports relations through the hosted sync-engine import endpoint", async () => {
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    process.env.ACRM_CLOUD_WORKSPACE_ID = "workspace-1";
    process.env.ACRM_CLOUD_ORG_ID = "org-1";
    process.env.ACRM_DESKTOP_SESSION_TOKEN = "desktop-token";
    const baseRelation = {
      object: "UserRelation",
      member_id: "member-1",
      created_at: 1742051769000,
      first_name: "Ada",
      last_name: "Lovelace",
      headline: "Founder at Analytical Engines",
      public_identifier: "ada-lovelace",
      public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
      profile_picture_url: "https://media.example.com/ada.jpg",
      company_name: "Analytical Engines",
      company_linkedin_url: "https://www.linkedin.com/company/analytical-engines/",
    };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/integrations/linkedin/messages/backfill")) {
        return Response.json({
          ok: true,
          started: 1,
          integration_account_ids: ["acct-1"],
          scoped: true,
        });
      }
      return Response.json({
        ok: true,
        data: {
          relations: [baseRelation],
          stats: {
            relations_seen: 1,
            people_created: 1,
            people_updated: 0,
            companies_created: 1,
            companies_updated: 0,
            relations_skipped_no_key: 0,
          },
          company_enrichment: { requested: true, provider: "fiber" },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await linkedinCommandTest.runImportLinkedinNetwork({});

    expect(result.stats.people_created).toBe(1);
    expect(result.stats.companies_created).toBe(1);
    expect(result.message_backfill).toEqual({
      started: 1,
      integration_account_ids: ["acct-1"],
      scoped: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [backfillUrl, backfillInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://sync.example.com/workspaces/workspace-1/integrations/linkedin/relations/import");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer desktop-token" });
    expect(JSON.parse(String(init.body))).toEqual({ enrich_companies: true });
    expect(backfillUrl).toContain("/integrations/linkedin/messages/backfill");
    expect(JSON.parse(String(backfillInit.body))).toEqual({
      scope: {
        providerPersonIds: ["member-1"],
        linkedinUrls: ["linkedin.com/in/ada-lovelace"],
        publicIdentifiers: ["ada-lovelace"],
      },
    });
  });

  it("passes cutoff-date to the relations import endpoint", async () => {
    const db = await openTestWorkspace();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: {
        relations: [],
        stats: {
          relations_seen: 0,
          people_created: 0,
          people_updated: 0,
          companies_created: 0,
          companies_updated: 0,
          relations_skipped_no_key: 0,
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await linkedinCommandTest.runImportLinkedinNetwork({
        workspace: TEST_DATABASE_URL,
        db,
        cutoffDate: "2026-04-25",
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `https://sync.example.com/workspaces/${encodeURIComponent(result.workspace_id)}/integrations/linkedin/relations/import`,
      );
      expect(JSON.parse(String(init.body))).toEqual({
        cutoff_date: "2026-04-25",
        enrich_companies: true,
      });
    } finally {
      await db.close();
    }
  });

  it("returns the helpful connect error when LinkedIn is not connected", async () => {
    const db = await openTestWorkspace();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: { code: "linkedin_not_connected" },
    }, { status: 409 })));

    try {
      await expect(
        linkedinCommandTest.runImportLinkedinNetwork({ workspace: TEST_DATABASE_URL, db }),
      ).rejects.toMatchObject({
        message: LINKEDIN_NOT_CONNECTED_MESSAGE,
        code: ERR.INVALID_INPUT,
        hint: LINKEDIN_NOT_CONNECTED_HINT,
      } satisfies Partial<AcrmError>);
    } finally {
      await db.close();
    }
  });
});
