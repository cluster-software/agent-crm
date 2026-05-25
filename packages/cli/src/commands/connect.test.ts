import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "@agent-crm/sdk";
import { __test as connectCommandTest } from "./connect.js";

describe("connect linkedin command", () => {
  const oldSyncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldSyncEngineUrl === undefined) delete process.env.ACRM_SYNC_ENGINE_URL;
    else process.env.ACRM_SYNC_ENGINE_URL = oldSyncEngineUrl;
  });

  it("builds a hosted sync-engine LinkedIn connect URL", () => {
    const url = connectCommandTest.linkedinConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clusterOrgId: "org-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/linkedin/connect?workspace_id=workspace-1&cluster_org_id=org-1&workspace_name=pipeline",
    );
  });

  it("omits Cluster org id when browser auth should infer it", () => {
    const url = connectCommandTest.linkedinConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/linkedin/connect?workspace_id=workspace-1&workspace_name=pipeline",
    );
  });

  it("requires an active LinkedIn account before reporting connected status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-status-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      integrations: {
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
              status: "paused",
            },
          ],
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await connectCommandTest.runConnectLinkedinStatus({
        workspace: workspacePath,
      });

      expect(result.linkedin.connected).toBe(false);
      expect(result.linkedin.accounts?.[0]?.status).toBe("paused");
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/integrations/status");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
