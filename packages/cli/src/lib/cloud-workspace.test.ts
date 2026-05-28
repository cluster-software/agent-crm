import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCloudWorkspaceMetadata,
  connectCloudGranola,
  fetchCloudCommunicationExport,
  fetchCloudGranolaTranscriptsExport,
  fetchCloudIntegrationStatus,
  fetchCloudLinkedinRelationsExport,
  GRANOLA_NOT_CONNECTED_HINT,
  GRANOLA_NOT_CONNECTED_MESSAGE,
  LINKEDIN_NOT_CONNECTED_HINT,
  LINKEDIN_NOT_CONNECTED_MESSAGE,
  registerCloudWorkspace,
  startCloudGranolaBackfill,
  startCloudLinkedinMessageBackfill
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

  it("reuses a sidecar with a matching local workspace id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      const first = ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        localWorkspaceId: "local-1",
      });
      const second = ensureCloudWorkspaceMetadata(dir, {
        localWorkspaceId: "local-1",
      });

      expect(first.workspaceId).toBe("workspace-1");
      expect(second.workspaceId).toBe("workspace-1");
      expect(second.clientToken).toBe("client-token-1");
      expect(second.localWorkspaceId).toBe("local-1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backfills a non-stale legacy sidecar with the local workspace id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      const workspacePath = join(dir, "test.acrm");
      await writeFile(workspacePath, "", "utf8");
      await writeFile(join(dir, ".agent-crm-cloud.json"), `${JSON.stringify({
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      })}\n`, "utf8");

      const metadata = ensureCloudWorkspaceMetadata(dir, {
        localWorkspaceId: "local-1",
        workspacePath,
      });
      const raw = JSON.parse(await readFile(join(dir, ".agent-crm-cloud.json"), "utf8")) as {
        workspaceId?: string;
        localWorkspaceId?: string;
      };

      expect(metadata.workspaceId).toBe("workspace-1");
      expect(raw.localWorkspaceId).toBe("local-1");
      expect((await readdir(dir)).filter((name) => name.includes(".stale-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("archives a stale legacy sidecar when the .acrm file is newer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      const workspacePath = join(dir, "test.acrm");
      await writeFile(workspacePath, "", "utf8");
      await writeFile(join(dir, ".agent-crm-cloud.json"), `${JSON.stringify({
        workspaceId: "old-workspace",
        clientToken: "old-token",
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`, "utf8");

      const metadata = ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "new-workspace",
        clientToken: "new-token",
        localWorkspaceId: "local-1",
        workspacePath,
      });
      const entries = await readdir(dir);

      expect(metadata.workspaceId).toBe("new-workspace");
      expect(metadata.clientToken).toBe("new-token");
      expect(entries.some((name) => name.startsWith(".agent-crm-cloud.json.stale-"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("archives a stale legacy sidecar without createdAt using file timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      const workspacePath = join(dir, "test.acrm");
      await writeFile(workspacePath, "", "utf8");
      await writeFile(join(dir, ".agent-crm-cloud.json"), `${JSON.stringify({
        workspaceId: "old-workspace",
        clientToken: "old-token",
      })}\n`, "utf8");
      const future = new Date(Date.now() + 60_000);
      await utimes(workspacePath, future, future);

      const metadata = ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "new-workspace",
        clientToken: "new-token",
        localWorkspaceId: "local-1",
        workspacePath,
      });
      const entries = await readdir(dir);

      expect(metadata.workspaceId).toBe("new-workspace");
      expect(metadata.clientToken).toBe("new-token");
      expect(entries.some((name) => name.startsWith(".agent-crm-cloud.json.stale-"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("archives a sidecar with a mismatched local workspace id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-cloud-workspace-"));
    try {
      ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "old-workspace",
        clientToken: "old-token",
        localWorkspaceId: "local-1",
      });

      const metadata = ensureCloudWorkspaceMetadata(dir, {
        workspaceId: "new-workspace",
        clientToken: "new-token",
        localWorkspaceId: "local-2",
      });
      const entries = await readdir(dir);

      expect(metadata.workspaceId).toBe("new-workspace");
      expect(metadata.clientToken).toBe("new-token");
      expect(metadata.localWorkspaceId).toBe("local-2");
      expect(entries.some((name) => name.startsWith(".agent-crm-cloud.json.stale-"))).toBe(true);
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
    })).resolves.toEqual({
      ...integrations,
      granola: { connected: false },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/status",
      {
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("connects Granola with an API key and default hosted scopes", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      account: { id: "acct-1", provider: "granola" },
      cutoff_date: "2026-05-01",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(connectCloudGranola({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      apiKey: "grn_test",
      cutoffDate: "2026-05-01",
    })).resolves.toEqual({
      account: { id: "acct-1", provider: "granola" },
      cutoff_date: "2026-05-01",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/integrations/granola/connect",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-token-1",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          workspace_id: "workspace-1",
          api_key: "grn_test",
          cutoff_date: "2026-05-01",
        }),
      },
    );
  });

  it("fetches Granola transcript exports with cutoff date", async () => {
    const data = {
      transcripts: [{
        source: "granola",
        source_id: "note-1",
        participants: [{ email: "alice@example.com" }],
      }],
    };
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudGranolaTranscriptsExport({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      cutoffDate: "2026-05-01",
    })).resolves.toEqual(data);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/granola/export?cutoff_date=2026-05-01",
      {
        headers: {
          authorization: "Bearer client-token-1",
        },
      },
    );
  });

  it("starts Granola backfill with cutoff date", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      started: 1,
      integration_account_ids: ["acct-1"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCloudGranolaBackfill({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      cutoffDate: "2026-05-01",
    })).resolves.toEqual({
      started: 1,
      integration_account_ids: ["acct-1"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/granola/backfill",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-token-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cutoff_date: "2026-05-01",
        }),
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

  it("starts LinkedIn message backfill", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      started: 1,
      integration_account_ids: ["acct-1"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startCloudLinkedinMessageBackfill({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
    })).resolves.toEqual({
      started: 1,
      integration_account_ids: ["acct-1"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sync.example.com/workspaces/workspace-1/integrations/linkedin/messages/backfill",
      {
        method: "POST",
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

  it("turns Granola not-connected export responses into an actionable error", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ok: false,
      error: { code: "granola_not_connected" },
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCloudGranolaTranscriptsExport({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
    })).rejects.toMatchObject({
      message: GRANOLA_NOT_CONNECTED_MESSAGE,
      code: ERR.INVALID_INPUT,
      hint: GRANOLA_NOT_CONNECTED_HINT,
    });
  });
});
