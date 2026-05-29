import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled skills", () => {
  it("does not ask bundled skills to run version preflight checks", () => {
    const skillsDir = new URL("../skills/", import.meta.url);
    for (const filename of readdirSync(skillsDir)) {
      if (!filename.endsWith(".md")) continue;
      const skill = readFileSync(new URL(filename, skillsDir), "utf8");
      expect(skill, filename).not.toContain("acrm --version");
    }
  });

  it("does not ask acrm-onboarding to run preflight checks", () => {
    const skill = readFileSync(
      new URL("../skills/acrm-onboarding.md", import.meta.url),
      "utf8",
    );

    expect(skill).not.toContain('acrm execute "SELECT 1" --json');
    expect(skill).not.toContain("ACRM_ERROR_NO_WORKSPACE");
    expect(skill).not.toContain("acrm init");
    expect(skill).not.toContain("acrm --version");
    expect(skill).not.toContain("npm view @agent-crm/cli version");
    expect(skill).not.toContain("npm install -g @agent-crm/cli@latest");
    expect(skill).not.toContain("latest-version detection");
    expect(skill).not.toContain("Compare normal semver versions numerically");
  });
});
