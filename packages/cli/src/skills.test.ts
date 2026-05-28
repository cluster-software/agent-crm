import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled skills", () => {
  it("does not ask acrm-onboarding to manually preflight CLI versions", () => {
    const skill = readFileSync(
      new URL("../skills/acrm-onboarding.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain('acrm execute "SELECT 1" --json');
    expect(skill).not.toContain("acrm --version");
    expect(skill).not.toContain("npm view @agent-crm/cli version");
    expect(skill).not.toContain("npm install -g @agent-crm/cli@latest");
    expect(skill).not.toContain("latest-version detection");
    expect(skill).not.toContain("Compare normal semver versions numerically");
  });
});
