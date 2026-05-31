import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { exec } from "../db/execute.js";
import { PostgresDatabase } from "../db/postgres.js";
import type { AcrmDatabase, ExecuteResult, SqlValue } from "../db/types.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { Workspace } from "../workspace.js";
import { importLinkedinProfile } from "./import-linkedin.js";
import { importLinkedinRelations } from "./import-linkedin-relations.js";

describe("LinkedIn imports", () => {
  it("rolls back profile record shells if value insertion fails", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "acrm-linkedin-profile-"));
    try {
      await writeFile(
        path.join(cacheDir, "alice.json"),
        JSON.stringify({
          firstName: "Alice",
          lastName: "Profile",
          publicIdentifier: "alice",
          linkedinUrl: "https://www.linkedin.com/in/alice/",
        }),
        "utf8",
      );

      await withWorkspace(
        async (workspace) => {
          await expect(importLinkedinProfile(workspace, {
            urlOrSlug: "alice",
            token: "unused",
            cacheDir,
          })).rejects.toThrow("forced value insert failure");

          await expect(recordCount(workspace, "people")).resolves.toBe(0);
          await expect(recordCount(workspace, "companies")).resolves.toBe(0);
          await expect(valueCount(workspace)).resolves.toBe(0);
        },
        { wrapDb: (db) => new FailingValueInsertDatabase(db) },
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rolls back relation record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(importLinkedinRelations(workspace, {
          relations: [{
            member_id: "member-1",
            first_name: "Alice",
            last_name: "Relation",
            public_identifier: "alice-relation",
            company_name: "Example Co",
          }],
        })).rejects.toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(recordCount(workspace, "companies")).resolves.toBe(0);
        await expect(valueCount(workspace)).resolves.toBe(0);
      },
      { wrapDb: (db) => new FailingValueInsertDatabase(db) },
    );
  });
});

async function withWorkspace(
  run: (workspace: Workspace) => Promise<void>,
  options: { wrapDb?: (db: AcrmDatabase) => AcrmDatabase } = {},
): Promise<void> {
  const mem = newDb({ noAstCoverageCheck: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: "text",
    implementation: () => uuidv7(),
  });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const baseDb = PostgresDatabase.fromQueryable(pool, () => pool.end());
  const db = options.wrapDb?.(baseDb) ?? baseDb;
  const workspace = await Workspace.create({ db });
  try {
    await run(workspace);
  } finally {
    await workspace.close();
    await db.close();
  }
}

class FailingValueInsertDatabase implements AcrmDatabase {
  private readonly createdRecords: Array<{ object_slug: string; record_id: string }>;

  constructor(
    private readonly inner: AcrmDatabase,
    private readonly trackRecordInserts = false,
    createdRecords: Array<{ object_slug: string; record_id: string }> = [],
  ) {
    this.createdRecords = createdRecords;
  }

  async execute(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ): Promise<ExecuteResult> {
    if (this.trackRecordInserts && /\bINSERT\s+INTO\s+acrm_record\b/i.test(sql)) {
      for (let index = 0; index < (params?.length ?? 0); index += 2) {
        this.createdRecords.push({
          object_slug: String(params?.[index]),
          record_id: String(params?.[index + 1]),
        });
      }
    }
    if (/\bINSERT\s+INTO\s+acrm_value\b/i.test(sql)) {
      throw new Error("forced value insert failure");
    }
    return await this.inner.execute(sql, params);
  }

  async transaction<T>(fn: (db: AcrmDatabase) => Promise<T>): Promise<T> {
    const createdRecords: Array<{ object_slug: string; record_id: string }> = [];
    try {
      return await this.inner.transaction((db) =>
        fn(new FailingValueInsertDatabase(db, true, createdRecords))
      );
    } catch (error) {
      for (const record of createdRecords.reverse()) {
        await this.inner.execute(
          "DELETE FROM acrm_value WHERE object_slug = $1 AND record_id = $2",
          [record.object_slug, record.record_id],
        ).catch(() => undefined);
        await this.inner.execute(
          "DELETE FROM acrm_record WHERE object_slug = $1 AND record_id = $2",
          [record.object_slug, record.record_id],
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

async function recordCount(workspace: Workspace, objectSlug: string): Promise<number> {
  const result = await exec(
    workspace.db,
    "SELECT COUNT(*) AS count FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function valueCount(workspace: Workspace): Promise<number> {
  const result = await exec(workspace.db, "SELECT COUNT(*) AS count FROM acrm_value");
  return Number(result.rows[0]?.count ?? 0);
}
