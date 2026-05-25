import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCloudWorkspaceMetadata,
  fetchCloudCommunicationExport,
  registerCloudWorkspace
} from "./cloud-workspace.js";

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
});
