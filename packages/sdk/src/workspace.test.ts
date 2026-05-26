import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "./db/execute.js";
import { AcrmError, ERR } from "./lib/errors.js";
import { Workspace } from "./workspace.js";
import { ensureWorkspaceIdentity } from "./workspace/identity.js";

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

  it("rejects missing absolute paths when opening a workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acrm-sdk-workspace-"));
    try {
      const workspacePath = path.join(dir, "missing.acrm");
      await expect(Workspace.open(workspacePath)).rejects.toMatchObject({
        code: ERR.NO_WORKSPACE,
      });
      expect(existsSync(workspacePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates and initializes a workspace at an absolute path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acrm-sdk-workspace-"));
    try {
      const workspacePath = path.join(dir, "test.acrm");
      const workspace = await Workspace.create(workspacePath);
      try {
        const objects = await exec(
          workspace.lix,
          "SELECT object_slug FROM acrm_object ORDER BY object_slug",
        );
        expect(objects.rows.map((r) => r.object_slug)).toEqual([
          "communication_messages",
          "communication_threads",
          "companies",
          "deals",
          "people",
          "posts",
          "transcripts",
        ]);

        const emailAttr = await exec(
          workspace.lix,
          "SELECT attribute_type FROM acrm_attribute WHERE object_slug = 'people' AND attribute_slug = 'email_addresses'",
        );
        expect(emailAttr.rows[0]?.attribute_type).toBe("email-address");

        const identity = await ensureWorkspaceIdentity(workspace);
        expect(identity).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        await workspace.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not close a Lix passed through fromLix by default", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acrm-sdk-workspace-"));
    try {
      const workspacePath = path.join(dir, "test.acrm");
      const owner = await Workspace.create(workspacePath);
      const borrowed = Workspace.fromLix(owner.lix);
      await borrowed.close();
      await expect(
        exec(owner.lix, "SELECT object_slug FROM acrm_object LIMIT 1"),
      ).resolves.toMatchObject({ rowsAffected: 0 });
      await owner.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the local workspace identity when reopening", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acrm-sdk-workspace-"));
    try {
      const workspacePath = path.join(dir, "test.acrm");
      const created = await Workspace.create(workspacePath);
      const firstIdentity = await ensureWorkspaceIdentity(created);
      await created.close();

      const reopened = await Workspace.open(workspacePath);
      try {
        await expect(ensureWorkspaceIdentity(reopened)).resolves.toBe(firstIdentity);
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
