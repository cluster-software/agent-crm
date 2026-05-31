import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";
import { exec } from "./db/execute.js";
import { PostgresDatabase } from "./db/postgres.js";
import type { AcrmDatabase } from "./db/types.js";
import { ERR } from "./lib/errors.js";
import { uuidv7 } from "./lib/uuidv7.js";
import { Workspace } from "./workspace.js";
import { ensureWorkspaceIdentity } from "./workspace/identity.js";

function openTestDatabase(): AcrmDatabase {
  const mem = newDb({ noAstCoverageCheck: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: "text",
    implementation: () => uuidv7(),
  });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  return PostgresDatabase.fromQueryable(pool, () => pool.end());
}

describe("Workspace", () => {
  it("rejects non-Postgres workspace strings", async () => {
    await expect(Workspace.open("relative.db")).rejects.toMatchObject({
      code: ERR.INVALID_INPUT,
      message: "workspace database URL must be a Postgres-compatible connection string",
    });
  });

  it("rejects missing database URLs", async () => {
    const oldAcrm = process.env.ACRM_DATABASE_URL;
    const oldNeon = process.env.NEON_DATABASE_URL;
    const oldDatabase = process.env.DATABASE_URL;
    delete process.env.ACRM_DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(Workspace.open()).rejects.toMatchObject({
        code: ERR.NO_WORKSPACE,
      });
    } finally {
      restoreEnv("ACRM_DATABASE_URL", oldAcrm);
      restoreEnv("NEON_DATABASE_URL", oldNeon);
      restoreEnv("DATABASE_URL", oldDatabase);
    }
  });

  it("creates and initializes a workspace on an injected database", async () => {
    const db = openTestDatabase();
    const workspace = await Workspace.create({ db });
    try {
      const objects = await exec(
        workspace.db,
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
        workspace.db,
        "SELECT attribute_type FROM acrm_attribute WHERE object_slug = 'people' AND attribute_slug = 'email_addresses'",
      );
      expect(emailAttr.rows[0]?.attribute_type).toBe("email-address");

      const identity = await ensureWorkspaceIdentity(workspace);
      expect(identity).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await workspace.close();
      await db.close();
    }
  });

  it("allows concurrent initialization on the same empty database", async () => {
    const db = openTestDatabase();
    const workspaces = await Promise.all([
      Workspace.create({ db }),
      Workspace.create({ db }),
    ]);
    try {
      const objects = await exec(db, "SELECT COUNT(*) AS count FROM acrm_object");
      const attrs = await exec(db, "SELECT COUNT(*) AS count FROM acrm_attribute");

      expect(Number(objects.rows[0]?.count)).toBeGreaterThan(0);
      expect(Number(attrs.rows[0]?.count)).toBeGreaterThan(0);
      await expect(ensureWorkspaceIdentity(workspaces[0]!)).resolves.toBe(
        await ensureWorkspaceIdentity(workspaces[1]!),
      );
    } finally {
      for (const workspace of workspaces) {
        await workspace.close();
      }
      await db.close();
    }
  });

  it("closes an owned database when initialization fails", async () => {
    const error = new Error("schema failed");
    const close = vi.fn(async () => undefined);
    const db: AcrmDatabase = {
      execute: vi.fn(async () => {
        throw error;
      }),
      transaction: vi.fn(async () => {
        throw new Error("transaction not expected");
      }),
      close,
    };

    await expect(Workspace.open({ db, closeDatabaseOnClose: true })).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not close an injected database by default", async () => {
    const db = openTestDatabase();
    const owner = await Workspace.create({ db });
    const borrowed = Workspace.fromDatabase(owner.db);
    await borrowed.close();
    const result = await exec(owner.db, "SELECT object_slug FROM acrm_object LIMIT 1");
    expect(result.rows).toHaveLength(1);
    await owner.close();
    await db.close();
  });

  it("preserves the workspace identity on the same database", async () => {
    const db = openTestDatabase();
    const created = await Workspace.create({ db });
    const firstIdentity = await ensureWorkspaceIdentity(created);
    await created.close();

    const reopened = await Workspace.open({ db });
    try {
      await expect(ensureWorkspaceIdentity(reopened)).resolves.toBe(firstIdentity);
    } finally {
      await reopened.close();
      await db.close();
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
