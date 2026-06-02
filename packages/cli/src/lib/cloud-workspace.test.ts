import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCloudWorkspaceMetadata,
  ensureCloudWorkspaceMetadataForWorkspace,
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
  startCloudLinkedinMessageBackfill,
} from "./cloud-workspace.js";
import { ERR } from "@agent-crm/sdk";
import { exec } from "../../../sdk/src/db/execute.js";
import { openTestWorkspace } from "../test/open-test-db.js";

const TEST_DATABASE_URL = "postgres://user:pass@localhost/acrm_test";

describe("cloud workspace metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists a preferred Cluster org id for future hosted connects", async () => {
    const db = await openTestWorkspace();
    try {
      const first = await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        orgId: "org-1",
      });
      const second = await ensureCloudWorkspaceMetadata(db);
      const raw = await exec(db, "SELECT value FROM acrm_metadata WHERE key = $1", ["cloud.org_id"]);

      expect(first.orgId).toBe("org-1");
      expect(second.orgId).toBe("org-1");
      expect(raw.rows[0]?.value).toBe("org-1");
    } finally {
      await db.close();
    }
  });

  it("reuses metadata stored in the Postgres workspace", async () => {
    const db = await openTestWorkspace();
    try {
      const first = await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        localWorkspaceId: "local-1",
      });
      const second = await ensureCloudWorkspaceMetadata(db, {
        localWorkspaceId: "local-1",
      });

      expect(first.workspaceId).toBe("workspace-1");
      expect(second.workspaceId).toBe("workspace-1");
      expect(second.clientToken).toBe("client-token-1");
      expect(second.localWorkspaceId).toBe("local-1");
    } finally {
      await db.close();
    }
  });

  it("stores workspace credentials in a canonical metadata row", async () => {
    const db = await openTestWorkspace();
    try {
      await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        orgId: "org-1",
        localWorkspaceId: "local-1",
      });
      const raw = await exec(db, "SELECT value FROM acrm_metadata WHERE key = $1", ["cloud.workspace"]);

      expect(JSON.parse(String(raw.rows[0]?.value))).toMatchObject({
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        orgId: "org-1",
        localWorkspaceId: "local-1",
      });
    } finally {
      await db.close();
    }
  });

  it("prefers canonical cloud credentials over stale split metadata rows", async () => {
    const db = await openTestWorkspace();
    try {
      await exec(db, "INSERT INTO acrm_metadata (key, value) VALUES ($1, $2)", [
        "cloud.workspace",
        JSON.stringify({
          workspaceId: "workspace-canonical",
          clientToken: "client-token-canonical",
          createdAt: "2026-05-31T00:00:00.000Z",
        }),
      ]);
      await exec(db, "INSERT INTO acrm_metadata (key, value) VALUES ($1, $2)", [
        "cloud.workspace_id",
        "workspace-stale",
      ]);
      await exec(db, "INSERT INTO acrm_metadata (key, value) VALUES ($1, $2)", [
        "cloud.client_token",
        "client-token-stale",
      ]);

      const metadata = await ensureCloudWorkspaceMetadata(db);
      const split = await exec(
        db,
        "SELECT key, value FROM acrm_metadata WHERE key IN ($1, $2) ORDER BY key",
        ["cloud.client_token", "cloud.workspace_id"],
      );

      expect(metadata.workspaceId).toBe("workspace-canonical");
      expect(metadata.clientToken).toBe("client-token-canonical");
      expect(split.rows).toEqual([
        { key: "cloud.client_token", value: "client-token-canonical" },
        { key: "cloud.workspace_id", value: "workspace-canonical" },
      ]);
    } finally {
      await db.close();
    }
  });

  it("migrates legacy sidecar credentials into the Postgres workspace", async () => {
    const db = await openTestWorkspace();
    const legacyDir = mkdtempSync(join(tmpdir(), "acrm-cloud-"));
    try {
      writeFileSync(
        join(legacyDir, ".agent-crm-cloud.json"),
        `${JSON.stringify({
          workspaceId: "workspace-legacy",
          clientToken: "client-token-legacy",
          orgId: "org-legacy",
        })}\n`,
        "utf8",
      );

      const metadata = await ensureCloudWorkspaceMetadataForWorkspace(
        TEST_DATABASE_URL,
        {},
        { db, legacyMetadataDir: legacyDir },
      );
      const raw = await exec(db, "SELECT value FROM acrm_metadata WHERE key = $1", ["cloud.workspace"]);

      expect(metadata.workspaceId).toBe("workspace-legacy");
      expect(metadata.clientToken).toBe("client-token-legacy");
      expect(metadata.orgId).toBe("org-legacy");
      expect(JSON.parse(String(raw.rows[0]?.value))).toMatchObject({
        workspaceId: "workspace-legacy",
        clientToken: "client-token-legacy",
        orgId: "org-legacy",
      });
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      await db.close();
    }
  });

  it("does not implicitly migrate a sidecar from the current working directory", async () => {
    const db = await openTestWorkspace();
    const oldCwd = process.cwd();
    const legacyDir = mkdtempSync(join(tmpdir(), "acrm-cloud-"));
    try {
      writeFileSync(
        join(legacyDir, ".agent-crm-cloud.json"),
        `${JSON.stringify({
          workspaceId: "workspace-legacy",
          clientToken: "client-token-legacy",
        })}\n`,
        "utf8",
      );
      process.chdir(legacyDir);

      const metadata = await ensureCloudWorkspaceMetadataForWorkspace(
        TEST_DATABASE_URL,
        { workspaceId: "workspace-new", clientToken: "client-token-new" },
        { db },
      );

      expect(metadata.workspaceId).toBe("workspace-new");
      expect(metadata.clientToken).toBe("client-token-new");
    } finally {
      process.chdir(oldCwd);
      rmSync(legacyDir, { recursive: true, force: true });
      await db.close();
    }
  });

  it("does not let a legacy sidecar overwrite existing Postgres metadata", async () => {
    const db = await openTestWorkspace();
    const legacyDir = mkdtempSync(join(tmpdir(), "acrm-cloud-"));
    try {
      await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "workspace-db",
        clientToken: "client-token-db",
        orgId: "org-db",
      });
      writeFileSync(
        join(legacyDir, ".agent-crm-cloud.json"),
        `${JSON.stringify({
          workspaceId: "workspace-legacy",
          clientToken: "client-token-legacy",
          orgId: "org-legacy",
        })}\n`,
        "utf8",
      );

      const metadata = await ensureCloudWorkspaceMetadataForWorkspace(
        TEST_DATABASE_URL,
        {},
        { db, legacyMetadataDir: legacyDir },
      );

      expect(metadata.workspaceId).toBe("workspace-db");
      expect(metadata.clientToken).toBe("client-token-db");
      expect(metadata.orgId).toBe("org-db");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      await db.close();
    }
  });

  it("keeps existing workspace credentials but lets preferred Cluster org id change", async () => {
    const db = await openTestWorkspace();
    try {
      await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "workspace-1",
        clientToken: "client-token-1",
        localWorkspaceId: "local-1",
      });
      const metadata = await ensureCloudWorkspaceMetadata(db, {
        workspaceId: "new-workspace",
        clientToken: "new-token",
        orgId: "org-2",
      });

      expect(metadata.workspaceId).toBe("workspace-1");
      expect(metadata.clientToken).toBe("client-token-1");
      expect(metadata.orgId).toBe("org-2");
      expect(metadata.localWorkspaceId).toBe("local-1");
    } finally {
      await db.close();
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
