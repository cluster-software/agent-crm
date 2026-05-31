import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { exec } from "../db/execute.js";
import { PostgresDatabase } from "../db/postgres.js";
import type { AcrmDatabase, ExecuteResult, SqlValue } from "../db/types.js";
import { setSingleValue } from "../db/upsert.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { Workspace } from "../workspace.js";
import { importCsv } from "./import-csv.js";
import { importGoogleContacts } from "./import-google.js";
import { importPost } from "./import-post.js";
import { importTranscript } from "./import-transcript.js";
import { importXProfile } from "./import-x.js";
import { createRecord, dedupeRecords } from "./records.js";
import {
  ensureSignalAttributes,
  runSignals,
  type SignalDefinition,
  type SignalRunner,
} from "./signals.js";

describe("transactional SDK writes", () => {
  it("rolls back createRecord record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(createRecord(workspace, {
          object_slug: "people",
          fields: ["name=Alice"],
        })).rejects.toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(valueCount(workspace)).resolves.toBe(0);
      },
      { wrapDb: (db) => new FailingValueInsertDatabase(db) },
    );
  });

  it("rolls back CSV import record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(importCsv(workspace, {
          csvText: "name,email\nAlice,alice@example.com\n",
          source: "test-csv",
        })).rejects.toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(recordCount(workspace, "companies")).resolves.toBe(0);
        await expect(valueCount(workspace)).resolves.toBe(0);
      },
      { wrapDb: (db) => new FailingValueInsertDatabase(db) },
    );
  });

  it("rolls back Google contact record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(importGoogleContacts(workspace, {
          contacts: [{
            resource_name: "people/c1",
            origin: "connections",
            display_name: "Alice",
            emails: ["alice@example.com"],
          }],
        })).rejects.toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(recordCount(workspace, "companies")).resolves.toBe(0);
        await expect(valueCount(workspace)).resolves.toBe(0);
      },
      { wrapDb: (db) => new FailingValueInsertDatabase(db) },
    );
  });

  it("rolls back transcript import record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(importTranscript(workspace, {
          source: "manual",
          source_id: "transcript-1",
          title: "Intro",
          participants: [{ email: "alice@example.com" }],
        })).rejects.toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(recordCount(workspace, "transcripts")).resolves.toBe(0);
        await expect(valueCount(workspace)).resolves.toBe(0);
      },
      { wrapDb: (db) => new FailingValueInsertDatabase(db) },
    );
  });

  it("rolls back X profile record shells if value insertion fails", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "acrm-x-profile-"));
    try {
      await writeFile(
        path.join(cacheDir, "alice.json"),
        JSON.stringify({ username: "alice", name: "Alice" }),
        "utf8",
      );

      await withWorkspace(
        async (workspace) => {
          await expect(importXProfile(workspace, {
            handleOrUrl: "alice",
            token: "unused",
            cacheDir,
          })).rejects.toThrow("forced value insert failure");

          await expect(recordCount(workspace, "people")).resolves.toBe(0);
          await expect(valueCount(workspace)).resolves.toBe(0);
        },
        { wrapDb: (db) => new FailingValueInsertDatabase(db) },
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("rolls back post author records if post insertion fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acrm-post-import-"));
    const postCacheDir = path.join(root, "posts");
    const profileCacheDir = path.join(root, "profiles");
    try {
      await mkdir(postCacheDir);
      await mkdir(profileCacheDir);
      await writeFile(
        path.join(postCacheDir, "1234567890.json"),
        JSON.stringify({
          url: "https://x.com/alice/status/1234567890",
          author: { username: "alice" },
          createdAt: "2026-01-15T12:00:00.000Z",
          text: "hello from x",
        }),
        "utf8",
      );
      await writeFile(
        path.join(profileCacheDir, "alice.json"),
        JSON.stringify({ username: "alice", name: "Alice" }),
        "utf8",
      );

      await withWorkspace(
        async (workspace) => {
          await expect(importPost(workspace, {
            rawUrl: "https://x.com/alice/status/1234567890",
            token: "unused",
            postCacheDir,
            profileCacheDir,
          })).rejects.toThrow("forced value insert failure");

          await expect(recordCount(workspace, "people")).resolves.toBe(0);
          await expect(recordCount(workspace, "posts")).resolves.toBe(0);
          await expect(valueCount(workspace)).resolves.toBe(0);
        },
        {
          wrapDb: (db) =>
            new FailingValueInsertDatabase(db, {
              shouldFail: (sql, params) =>
                /\bINSERT\s+INTO\s+acrm_value\b/i.test(sql) &&
                params?.[1] === "posts",
            }),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back dedupe rewrites if deleting the discard record fails", async () => {
    await withWorkspace(
      async (workspace) => {
        const keeper = await createRecord(workspace, {
          object_slug: "people",
          fields: ["email_addresses=keeper@example.com"],
        });
        const discard = await createRecord(workspace, {
          object_slug: "people",
          fields: ["email_addresses=discard@example.com"],
        });

        await expect(dedupeRecords(workspace, {
          object_slug: "people",
          keep_record_id: keeper.record_id,
          discard_record_id: discard.record_id,
          prefer: "keep",
          dryRun: false,
        })).rejects.toThrow("forced value insert failure");

        await expect(recordExists(workspace, "people", discard.record_id)).resolves.toBe(true);
        await expect(
          activeValueRecordId(workspace, "people", "email_addresses", "discard@example.com"),
        ).resolves.toBe(discard.record_id);
      },
      {
        wrapDb: (db) =>
          new FailingValueInsertDatabase(db, {
            shouldFail: (sql) => /\bDELETE\s+FROM\s+acrm_record\b/i.test(sql),
          }),
      },
    );
  });

  it("rolls back partial signal output writes if one output fails", async () => {
    const { dir, cleanup } = await withSignalDir();
    let signalValueInserts = 0;
    try {
      await withWorkspace(
        async (workspace) => {
          const company = await createRecord(workspace, {
            object_slug: "companies",
            fields: ["name=Example Co"],
          });
          const runner: SignalRunner = async () =>
            JSON.stringify({
              outputs: [
                {
                  key: "operator_status",
                  value: "owner_identified",
                  confidence: "high",
                  citations: [],
                  reasoning: "status",
                },
                {
                  key: "operator_name",
                  value: "Example Holdings",
                  confidence: "high",
                  citations: [],
                  reasoning: "name",
                },
              ],
            });

          const result = await runSignals(workspace, {
            signalsDir: dir,
            records: [{ object_slug: "companies", record_id: company.record_id }],
            mode: "force",
            runner,
          });

          expect(result.runs_failed).toBe(1);
          expect(result.values_written).toBe(0);
          await expect(
            activeAttributeCount(workspace, company.record_id, [
              "operator_status",
              "operator_name",
            ]),
          ).resolves.toBe(0);
        },
        {
          wrapDb: (db) =>
            new FailingValueInsertDatabase(db, {
              shouldFail: (sql, params) => {
                if (
                  !/\bINSERT\s+INTO\s+acrm_value\b/i.test(sql) ||
                  params?.[9] !== "signal:rollback_signal"
                ) {
                  return false;
                }
                signalValueInserts++;
                return signalValueInserts === 2;
              },
            }),
        },
      );
    } finally {
      await cleanup();
    }
  });

  it("rolls back signal attribute sync if a type-change update fails", async () => {
    let failAttributeUpdate = false;
    await withWorkspace(
      async (workspace) => {
        const textDefinition = signalDefinition({
          type: "text",
          options: undefined,
        });
        const statusDefinition = signalDefinition({
          type: "status",
          options: [{ id: "owner_identified", title: "Owner identified" }],
        });
        const company = await createRecord(workspace, {
          object_slug: "companies",
          fields: ["name=Example Co"],
        });
        await ensureSignalAttributes(workspace, [textDefinition]);
        await setSingleValue(workspace.db, {
          object_slug: "companies",
          record_id: company.record_id,
          attribute_slug: "operator_signal",
          attribute_type: "text",
          value: "Example Holdings",
          source: "signal:sync_rollback",
          provenance: { signal_slug: "sync_rollback" },
        });

        failAttributeUpdate = true;
        await expect(ensureSignalAttributes(workspace, [statusDefinition]))
          .rejects
          .toThrow("forced value insert failure");

        await expect(
          activeAttributeCount(workspace, company.record_id, ["operator_signal"]),
        ).resolves.toBe(1);
        await expect(attributeType(workspace, "companies", "operator_signal"))
          .resolves
          .toBe("text");
      },
      {
        wrapDb: (db) =>
          new FailingValueInsertDatabase(db, {
            shouldFail: (sql) =>
              failAttributeUpdate &&
              /\bUPDATE\s+acrm_attribute\b/i.test(sql),
          }),
      },
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

async function withSignalDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acrm-signal-rollback-"));
  const dir = path.join(root, "signals");
  await mkdir(dir);
  await writeFile(
    path.join(dir, "rollback_signal.md"),
    `---
slug: rollback_signal
title: Rollback Signal
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "operator_status",
      "attribute": "operator_status",
      "title": "Operator status",
      "type": "status",
      "options": ["owner_identified:Owner identified", "unclear:Unclear"]
    },
    {
      "key": "operator_name",
      "attribute": "operator_name",
      "title": "Operator name",
      "type": "text"
    }
  ]
}
\`\`\`

Find the operator.
`,
    "utf8",
  );
  return {
    dir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function signalDefinition(output: {
  type: "text" | "status";
  options: SignalDefinition["outputs"][number]["options"];
}): SignalDefinition {
  return {
    slug: "sync_rollback",
    title: "Sync Rollback",
    object_slug: "companies",
    outputs: [{
      key: "operator",
      attribute: "operator_signal",
      title: "Operator signal",
      type: output.type,
      ...(output.options ? { options: output.options } : {}),
    }],
    prompt: "Find the operator.",
    definition_hash: "sync-rollback",
    path: "/tmp/sync_rollback.md",
  };
}

type FailingDatabaseOptions = {
  shouldFail?: (
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ) => boolean;
};

class FailingValueInsertDatabase implements AcrmDatabase {
  private readonly shouldFail: (
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ) => boolean;

  constructor(
    private readonly inner: AcrmDatabase,
    options: FailingDatabaseOptions = {},
    private readonly inTransaction = false,
  ) {
    this.shouldFail =
      options.shouldFail ??
      ((sql) => /\bINSERT\s+INTO\s+acrm_value\b/i.test(sql));
  }

  async execute(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ): Promise<ExecuteResult> {
    if (this.shouldFail(sql, params)) {
      throw new Error("forced value insert failure");
    }
    return await this.inner.execute(sql, params);
  }

  async transaction<T>(fn: (db: AcrmDatabase) => Promise<T>): Promise<T> {
    const snapshot = await snapshotRecordsAndValues(this.inner);
    if (this.inTransaction) {
      try {
        return await fn(new FailingValueInsertDatabase(
          this.inner,
          { shouldFail: this.shouldFail },
          true,
        ));
      } catch (error) {
        await restoreRecordsAndValues(this.inner, snapshot);
        throw error;
      }
    }

    try {
      return await this.inner.transaction((db) =>
        fn(new FailingValueInsertDatabase(
          db,
          { shouldFail: this.shouldFail },
          true,
        ))
      );
    } catch (error) {
      await restoreRecordsAndValues(this.inner, snapshot);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

type DatabaseSnapshot = {
  records: Array<Record<string, SqlValue>>;
  values: Array<Record<string, SqlValue>>;
};

async function snapshotRecordsAndValues(db: AcrmDatabase): Promise<DatabaseSnapshot> {
  const records = await db.execute(
    "SELECT object_slug, record_id, archived FROM acrm_record",
  );
  const values = await db.execute(
    `SELECT id, object_slug, record_id, attribute_slug, value_json,
            active_from, active_until, normalized_key, ref_object, ref_record_id,
            source, provenance_json
       FROM acrm_value`,
  );
  return {
    records: records.rows as Array<Record<string, SqlValue>>,
    values: values.rows as Array<Record<string, SqlValue>>,
  };
}

async function restoreRecordsAndValues(
  db: AcrmDatabase,
  snapshot: DatabaseSnapshot,
): Promise<void> {
  await db.execute("DELETE FROM acrm_value");
  await db.execute("DELETE FROM acrm_record");
  for (const record of snapshot.records) {
    await db.execute(
      `INSERT INTO acrm_record (object_slug, record_id, archived)
       VALUES ($1, $2, $3)`,
      [record.object_slug, record.record_id, record.archived ?? null],
    );
  }
  for (const value of snapshot.values) {
    await db.execute(
      `INSERT INTO acrm_value
         (id, object_slug, record_id, attribute_slug, value_json,
          active_from, active_until, normalized_key, ref_object, ref_record_id,
          source, provenance_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        value.id,
        value.object_slug,
        value.record_id,
        value.attribute_slug,
        value.value_json,
        value.active_from,
        value.active_until ?? null,
        value.normalized_key ?? null,
        value.ref_object ?? null,
        value.ref_record_id ?? null,
        value.source ?? null,
        value.provenance_json ?? null,
      ],
    );
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

async function recordExists(
  workspace: Workspace,
  objectSlug: string,
  recordId: string,
): Promise<boolean> {
  const result = await exec(
    workspace.db,
    "SELECT 1 FROM acrm_record WHERE object_slug = $1 AND record_id = $2",
    [objectSlug, recordId],
  );
  return result.rows.length > 0;
}

async function valueCount(workspace: Workspace): Promise<number> {
  const result = await exec(workspace.db, "SELECT COUNT(*) AS count FROM acrm_value");
  return Number(result.rows[0]?.count ?? 0);
}

async function activeValueRecordId(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
  normalizedKey: string,
): Promise<string | null> {
  const result = await exec(
    workspace.db,
    `SELECT record_id
       FROM acrm_value
      WHERE object_slug = $1
        AND attribute_slug = $2
        AND normalized_key = $3
        AND active_until IS NULL
      LIMIT 1`,
    [objectSlug, attributeSlug, normalizedKey],
  );
  return (result.rows[0]?.record_id as string | undefined) ?? null;
}

async function activeAttributeCount(
  workspace: Workspace,
  recordId: string,
  attributeSlugs: string[],
): Promise<number> {
  const placeholders = attributeSlugs.map((_, index) => `$${index + 2}`).join(", ");
  const result = await exec(
    workspace.db,
    `SELECT COUNT(*) AS count
       FROM acrm_value
      WHERE object_slug = 'companies'
        AND record_id = $1
        AND attribute_slug IN (${placeholders})
        AND active_until IS NULL`,
    [recordId, ...attributeSlugs],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function attributeType(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<string | null> {
  const result = await exec(
    workspace.db,
    `SELECT attribute_type
       FROM acrm_attribute
      WHERE object_slug = $1
        AND attribute_slug = $2
      LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  return (result.rows[0]?.attribute_type as string | undefined) ?? null;
}
