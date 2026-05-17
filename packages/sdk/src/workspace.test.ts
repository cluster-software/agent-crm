import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AcrmError, ERR } from "./lib/errors.js";
import { Workspace } from "./workspace.js";

describe("Workspace", () => {
  it("rejects relative paths before opening a workspace", async () => {
    await expect(Workspace.open("relative.acrm")).rejects.toMatchObject({
      code: ERR.INVALID_INPUT,
      message: "workspace path must be absolute: relative.acrm",
    });
  });

  it("rejects relative paths before creating a workspace", async () => {
    await expect(Workspace.create("relative.acrm")).rejects.toBeInstanceOf(
      AcrmError,
    );
  });

  it("creates a workspace at an absolute path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acrm-sdk-workspace-"));
    try {
      const workspacePath = path.join(dir, "test.acrm");
      const workspace = await Workspace.create(workspacePath);
      await workspace.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
