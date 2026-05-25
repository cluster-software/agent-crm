import { describe, expect, it } from "vitest";
import { __test as linkedinCommandTest } from "./import-linkedin.js";

describe("import linkedin command", () => {
  it("builds a hosted sync-engine LinkedIn connect URL", () => {
    const url = linkedinCommandTest.linkedinConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      clusterOrgId: "org-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/linkedin/connect?workspace_id=workspace-1&cluster_org_id=org-1&workspace_name=pipeline",
    );
  });
});
