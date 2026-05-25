import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCloudWorkspaceMetadata } from "./cloud-workspace.js";

describe("cloud workspace metadata", () => {
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
});
