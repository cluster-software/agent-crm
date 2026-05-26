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

  it("returns a hosted sync-engine LinkedIn connect URL when the workspace is not connected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-connect-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/register")) return Response.json({ ok: true });
      return Response.json({
        ok: true,
        integrations: {
          gmail: { connected: false },
          linkedin: { connected: false },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await connectCommandTest.runConnectLinkedin({
        workspace: workspacePath,
        orgId: "org-1",
      });

      expect(result.connected).toBe(false);
      if (!result.connected) {
        expect(result.auth_url).toContain("/integrations/linkedin/connect");
        expect(result.auth_url).toContain("cluster_org_id=org-1");
      }
      expect(result.linkedin.connected).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toContain("/register");
      expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toContain("/integrations/status");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an already connected workspace instead of returning a connect URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-connected-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/register")) return Response.json({ ok: true });
      return Response.json({
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
                status: "active",
              },
            ],
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await connectCommandTest.runConnectLinkedin({
        workspace: workspacePath,
      });

      expect(result.connected).toBe(true);
      expect("auth_url" in result).toBe(false);
      expect(result.message).toBe("This workspace is already connected with LinkedIn: Luis on LinkedIn");
      expect(result.linkedin.connected).toBe(true);
      expect(result.linkedin.display_name).toBe("Luis on LinkedIn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
