import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled skills", () => {
  it("keeps acrm-onboarding aligned with the workspace version preflight", () => {
    const skill = readFileSync(
      new URL("../skills/acrm-onboarding.md", import.meta.url),
      "utf8",
    );
    const versionCheck = skill.indexOf("acrm --version");
    const registryCheck = skill.indexOf("npm view @agent-crm/cli version");
    const workspaceCheck = skill.indexOf('acrm execute "SELECT 1" --json');

    expect(versionCheck).toBeGreaterThanOrEqual(0);
    expect(registryCheck).toBeGreaterThanOrEqual(0);
    expect(workspaceCheck).toBeGreaterThanOrEqual(0);
    expect(versionCheck).toBeLessThan(workspaceCheck);
    expect(registryCheck).toBeLessThan(workspaceCheck);
    expect(skill).toContain(
      "Do not rely only on `acrm --version` for\nlatest-version detection; its update notifier is cached.",
    );
    expect(skill).toContain(
      "Always** run `acrm --version` and `npm view @agent-crm/cli version` before any other `acrm` command",
    );
  });
});
