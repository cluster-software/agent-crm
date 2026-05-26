import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled skills", () => {
  it("keeps acrm-onboarding aligned with the workspace version preflight", () => {
    const skill = readFileSync(
      new URL("../skills/acrm-onboarding.md", import.meta.url),
      "utf8",
    );
    const versionCheck = skill.indexOf("acrm --version");
    const workspaceCheck = skill.indexOf('acrm execute "SELECT 1" --json');

    expect(versionCheck).toBeGreaterThanOrEqual(0);
    expect(workspaceCheck).toBeGreaterThanOrEqual(0);
    expect(versionCheck).toBeLessThan(workspaceCheck);
    expect(skill).toContain("Always** run `acrm --version` before any other `acrm` command");
  });
});
