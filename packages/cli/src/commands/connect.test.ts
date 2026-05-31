import { afterEach, describe, expect, it, vi } from "vitest";
import { __test as connectCommandTest } from "./connect.js";
import { openTestWorkspace } from "../test/open-test-db.js";

const TEST_DATABASE_URL = "postgres://user:pass@localhost/acrm_test";

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
    const db = await openTestWorkspace();
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
        workspace: TEST_DATABASE_URL,
        db,
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
      await db.close();
    }
  });

  it("reports an already connected workspace instead of returning a connect URL", async () => {
    const db = await openTestWorkspace();
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
        workspace: TEST_DATABASE_URL,
        db,
      });

      expect(result.connected).toBe(true);
      expect("auth_url" in result).toBe(false);
      expect(result.message).toBe("This workspace is already connected with LinkedIn: Luis on LinkedIn");
      expect(result.linkedin.connected).toBe(true);
      expect(result.linkedin.display_name).toBe("Luis on LinkedIn");
    } finally {
      await db.close();
    }
  });

  it("uses LinkedIn provider health when sync status is stale or errored", async () => {
    const db = await openTestWorkspace();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      integrations: {
        gmail: { connected: false },
        linkedin: {
          connected: true,
          displayName: "Luis on LinkedIn",
          providerAccountId: "unipile-account-1",
          sync: {
            state: "failed",
            errorMessage: "bad historical message payload",
          },
          accounts: [
            {
              id: "acct-1",
              providerAccountId: "unipile-account-1",
              displayName: "Luis on LinkedIn",
              status: "error",
              providerStatus: "ok",
            },
          ],
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await connectCommandTest.runConnectLinkedinStatus({
        workspace: TEST_DATABASE_URL,
        db,
      });

      expect(result.linkedin.connected).toBe(true);
      expect(result.linkedin.sync).toEqual({
        state: "failed",
        errorMessage: "bad historical message payload",
      });
      expect(result.linkedin.accounts?.[0]?.status).toBe("error");
      expect(result.linkedin.accounts?.[0]?.provider_status).toBe("ok");
    } finally {
      await db.close();
    }
  });

  it("lets provider health override active sync status", () => {
    const result = connectCommandTest.toCliProviderStatus({
      connected: true,
      accounts: [
        {
          id: "acct-1",
          providerAccountId: "unipile-account-1",
          status: "active",
          providerStatus: "credentials",
        },
      ],
    }, { requireActiveAccount: true });

    expect(result.connected).toBe(false);
    expect(result.accounts?.[0]?.status).toBe("active");
    expect(result.accounts?.[0]?.provider_status).toBe("credentials");
  });

  it("builds a Granola connect URL with the workspace token", () => {
    const url = connectCommandTest.granolaConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clientToken: "client-token-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/granola/connect?workspace_id=workspace-1&client_token=client-token-1&workspace_name=pipeline",
    );
  });

  it("connects Granola by posting the API key to the hosted sync engine", async () => {
    const db = await openTestWorkspace();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/register")) return Response.json({ ok: true });
      expect(url).toBe("https://sync.example.com/integrations/granola/connect");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        api_key: "grn_test",
        workspace_id: expect.any(String),
      });
      return Response.json({
        ok: true,
        account: { id: "acct-1", provider: "granola" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await connectCommandTest.runConnectGranola({
        workspace: TEST_DATABASE_URL,
        db,
        apiKey: "grn_test",
      });

      expect(result.connected).toBe(true);
      expect(result.account).toEqual({ id: "acct-1", provider: "granola" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });

  it("requires an active LinkedIn account before reporting connected status", async () => {
    const db = await openTestWorkspace();
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
        workspace: TEST_DATABASE_URL,
        db,
      });

      expect(result.linkedin.connected).toBe(false);
      expect(result.linkedin.accounts?.[0]?.status).toBe("paused");
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/integrations/status");
    } finally {
      await db.close();
    }
  });
});
