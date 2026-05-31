import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  ensureWorkspaceIdentity: vi.fn(),
}));

vi.mock("@agent-crm/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent-crm/sdk")>();
  return {
    ...actual,
    Workspace: {
      create: sdkMocks.createWorkspace,
    },
    ensureWorkspaceIdentity: sdkMocks.ensureWorkspaceIdentity,
  };
});

import { registerInit } from "./init.js";

describe("init command", () => {
  const originalCwd = process.cwd();
  const originalAcrmDatabaseUrl = process.env.ACRM_DATABASE_URL;
  const originalNeonDatabaseUrl = process.env.NEON_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.chdir(originalCwd);
    restoreEnv("ACRM_DATABASE_URL", originalAcrmDatabaseUrl);
    restoreEnv("NEON_DATABASE_URL", originalNeonDatabaseUrl);
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
    sdkMocks.createWorkspace.mockReset();
    sdkMocks.ensureWorkspaceIdentity.mockReset();
    vi.restoreAllMocks();
  });

  it("loads ACRM_DATABASE_URL from the current project .env", async () => {
    const databaseUrl = "postgres://user:pass@localhost/acrm_test";
    const tmp = mkdtempSync(join(tmpdir(), "acrm-init-"));
    const close = vi.fn(async () => undefined);
    delete process.env.ACRM_DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;
    delete process.env.DATABASE_URL;
    writeFileSync(join(tmp, ".env"), `ACRM_DATABASE_URL=${databaseUrl}\n`, "utf8");
    process.chdir(tmp);
    sdkMocks.createWorkspace.mockResolvedValue({ close });
    sdkMocks.ensureWorkspaceIdentity.mockResolvedValue("workspace-1");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const program = new Command();
      program.exitOverride();
      program.option("-w, --workspace <url>");
      program.option("--json");
      registerInit(program);

      await program.parseAsync(["node", "acrm", "--json", "init"]);

      expect(sdkMocks.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        databaseUrl,
        provider: "postgres",
        source: "ACRM_DATABASE_URL",
      }));
      expect(sdkMocks.ensureWorkspaceIdentity).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
