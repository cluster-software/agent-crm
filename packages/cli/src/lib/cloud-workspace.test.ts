import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCloudWorkspaceMetadata,
  fetchCloudCommunicationExport,
  fetchCloudIntegrationStatus,
  fetchCloudLinkedinRelationsExport,
  LINKEDIN_NOT_CONNECTED_HINT,
  LINKEDIN_NOT_CONNECTED_MESSAGE,
  registerCloudWorkspace
} from "./cloud-workspace.js";
import { ERR } from "@agent-crm/sdk";

describe("cloud workspace metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists a preferred Cluster org id for future hosted connects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      const first = ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        clusterOrgId: "org-1",
      });
      const second = ensureCloudWorkspaceMetadata(dir);
      const raw = JSON.parse(await readFile(join(dir, ".agent-crm-cloud.json"), "utf8")) as {
        clusterOrgId?: string;
      };

      expect(first.clusterOrgId).toBe("org-1");
      expect(second.clusterOrgId).toBe("org-1");
      expect(raw.clusterOrgId).toBe("org-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers a cloud workspace with the sync engine", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await registerCloudWorkspace({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      workspaceName: "pipeline",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/register?workspace_name=pipeline",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("fetches integration status", async () => {
    const integrations = {
      gmail: { connected: false },
      linkedin: {
        connected: true,
        displayName: "Luis on LinkedIn",
        providerAccountId: "unipile-account-1",
        accounts: [
          {
            id: "acct-1",
            providerAccountId: "unipile-account-1",
            displayName: "Luis on LinkedIn",
            status: "active",
          },
        ],
      },
    };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, integrations }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudIntegrationStatus({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
    })).resolves.toEqual(integrations);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/status",
      {
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("fetches linkedIn communication export data", async () => {
    const data = {
      people: [],
      communicationThreads: [],
      communicationMessages: [],
    };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudCommunicationExport({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      provider: "linkedin",
    })).resolves.toEqual(data);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/linkedin/export",
      {
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("fetches LinkedIn relations export data with a cutoff date and company enrichment", async () => {
    const relations = [
      {
        object: "UserRelation",
        member_id: "member-1",
        public_profile_url: "https://www.linkedin.com/in/member-1/",
      },
    ];
    const company_enrichment = { requested: true, provider: "fiber" };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { relations, company_enrichment } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudLinkedinRelationsExport({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      cutoffDate: "2026-04-25",
      enrichCompanies: true,
    })).resolves.toEqual({ relations, company_enrichment });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/linkedin/relations/export?cutoff_date=2026-04-25&enrich_companies=1",
      {
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("turns LinkedIn not-connected export responses into an actionable error", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: false,
      error: { code: "linkedin_not_connected" },
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudLinkedinRelationsExport({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
    })).rejects.toMatchObject({
      message: LINKEDIN_NOT_CONNECTED_MESSAGE,
      code: ERR.INVALID_INPUT,
      hint: LINKEDIN_NOT_CONNECTED_HINT,
    });
  });
});
