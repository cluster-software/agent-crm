import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { exec } from "../db/execute.js";
import { PostgresDatabase } from "../db/postgres.js";
import type { AcrmDatabase, ExecuteResult, SqlValue } from "../db/types.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { Workspace } from "../workspace.js";
import { importCommunicationBatch, type CommunicationImportBatch } from "./import-communication.js";

describe("importCommunicationBatch", () => {
  it("deduplicates duplicate fresh batch records by source key", async () => {
    await withWorkspace(async (workspace) => {
      const batch = duplicateCommunicationBatch();

      const result = await importCommunicationBatch(workspace, batch);
      await importCommunicationBatch(workspace, batch);

      expect(result.stats).toMatchObject({
        people_seen: 1,
        people_created: 1,
        companies_seen: 1,
        companies_created: 1,
        communication_threads_seen: 1,
        communication_threads_created: 1,
        communication_messages_seen: 1,
        communication_messages_created: 1,
      });
      await expect(recordCount(workspace, "people")).resolves.toBe(1);
      await expect(recordCount(workspace, "companies")).resolves.toBe(1);
      await expect(recordCount(workspace, "communication_threads")).resolves.toBe(1);
      await expect(recordCount(workspace, "communication_messages")).resolves.toBe(1);

      await expect(activeValueCount(workspace, "communication_messages", "provider")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "channel")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "subject")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "thread")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "body_preview")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "body_render_json")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_messages", "attachments_json")).resolves.toBe(1);
      await expect(singleJsonValue(workspace, "communication_messages", "body_render_json")).resolves.toEqual({
        version: 1,
        source: "gmail",
        blocks: [{ type: "paragraph", text: "Hello Alice" }],
      });
      await expect(activeValueCount(workspace, "communication_threads", "provider")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_threads", "channel")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "communication_threads", "subject")).resolves.toBe(1);
    });
  });

  it("keeps one active single value when different source keys resolve to one fresh record", async () => {
    await withWorkspace(async (workspace) => {
      await importCommunicationBatch(workspace, {
        people: [
          {
            sourceKey: "gmail:me@example.com:email:alice@example.com",
            email: "alice@example.com",
            displayName: "Alice A",
            profilePictureUrl: "https://media.example.com/alice-a.jpg",
          },
          {
            sourceKey: "gmail:other@example.com:email:alice@example.com",
            email: "alice@example.com",
            displayName: "Alice B",
            profilePictureUrl: "https://media.example.com/alice-b.jpg",
          },
        ],
        communicationThreads: [],
        communicationMessages: [],
      });

      await expect(recordCount(workspace, "people")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "name")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "profile_picture_url")).resolves.toBe(1);
      await expect(activeValueCount(workspace, "people", "source_keys")).resolves.toBe(2);
      await expect(singleDisplayValue(workspace, "people", "name")).resolves.toBe("Alice B");
      await expect(singleDisplayValue(workspace, "people", "profile_picture_url")).resolves.toBe("https://media.example.com/alice-b.jpg");
    });
  });

  it("does not index long text values as normalized keys", async () => {
    await withWorkspace(async (workspace) => {
      const batch = duplicateCommunicationBatch();
      batch.communicationMessages = [{
        ...batch.communicationMessages[0]!,
        bodyText: "x".repeat(6_000),
      }];

      await importCommunicationBatch(workspace, batch);

      await expect(
        activeValueCount(workspace, "communication_messages", "body_text"),
      ).resolves.toBe(1);
      await expect(
        normalizedKeyFor(workspace, "communication_messages", "body_text"),
      ).resolves.toBeNull();
    });
  });

  it("rolls back record shells if value insertion fails", async () => {
    await withWorkspace(
      async (workspace) => {
        await expect(importCommunicationBatch(workspace, duplicateCommunicationBatch()))
          .rejects
          .toThrow("forced value insert failure");

        await expect(recordCount(workspace, "people")).resolves.toBe(0);
        await expect(recordCount(workspace, "companies")).resolves.toBe(0);
        await expect(recordCount(workspace, "communication_threads")).resolves.toBe(0);
        await expect(recordCount(workspace, "communication_messages")).resolves.toBe(0);
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
      // pg-mem does not model rollback for these writes; postgres.test covers
      // adapter rollback, and this keeps the operation-level assertion stable.
      for (const record of createdRecords.reverse()) {
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

function duplicateCommunicationBatch(): CommunicationImportBatch {
  const person = {
    sourceKey: "gmail:me@example.com:email:alice@example.com",
    email: "alice@example.com",
    displayName: "Alice",
    companySourceKey: "gmail:me@example.com:company_domain:example.com",
  };
  const company = {
    sourceKey: "gmail:me@example.com:company_domain:example.com",
    domain: "example.com",
    name: "Example",
  };
  const thread = {
    sourceKey: "gmail:me@example.com:thread:thread-1",
    provider: "gmail",
    channel: "email" as const,
    providerAccountId: "me@example.com",
    providerThreadId: "thread-1",
    subject: "Hello",
    participantSourceKeys: [person.sourceKey],
  };
  const message = {
    sourceKey: "gmail:me@example.com:message:msg-1",
    provider: "gmail",
    channel: "email" as const,
    providerAccountId: "me@example.com",
    providerMessageId: "msg-1",
    providerThreadId: "thread-1",
    threadSourceKey: thread.sourceKey,
    subject: "Hello",
    bodyPreview: "Hello Alice",
    bodyRenderJson: {
      version: 1,
      source: "gmail",
      blocks: [{ type: "paragraph", text: "Hello Alice" }],
    },
    attachmentsJson: [],
    senderSourceKey: person.sourceKey,
    participantSourceKeys: [person.sourceKey],
  };
  return {
    people: [person, { ...person }],
    companies: [company, { ...company }],
    communicationThreads: [thread, { ...thread }],
    communicationMessages: [message, { ...message }],
  };
}

async function recordCount(workspace: Workspace, objectSlug: string): Promise<number> {
  const result = await exec(
    workspace.db,
    "SELECT COUNT(*) AS count FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function activeValueCount(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<number> {
  const result = await exec(
    workspace.db,
    `SELECT COUNT(*) AS count
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2`,
    [objectSlug, attributeSlug],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function normalizedKeyFor(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<string | null> {
  const result = await exec(
    workspace.db,
    `SELECT normalized_key
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  return (result.rows[0]?.normalized_key as string | null | undefined) ?? null;
}

async function singleDisplayValue(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<string | null> {
  const result = await exec(
    workspace.db,
    `SELECT value_json
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const value = result.rows[0]?.value_json;
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed && typeof parsed === "object" && "full_name" in parsed) {
    const fullName = (parsed as { full_name?: unknown }).full_name;
    return typeof fullName === "string" ? fullName : null;
  }
  if (parsed && typeof parsed === "object" && "value" in parsed) {
    const display = (parsed as { value?: unknown }).value;
    return typeof display === "string" ? display : null;
  }
  return typeof parsed === "string" ? parsed : null;
}

async function singleJsonValue(
  workspace: Workspace,
  objectSlug: string,
  attributeSlug: string,
): Promise<unknown> {
  const result = await exec(
    workspace.db,
    `SELECT value_json
     FROM acrm_value
     WHERE active_until IS NULL
       AND object_slug = $1
       AND attribute_slug = $2
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const value = result.rows[0]?.value_json;
  return typeof value === "string" ? JSON.parse(value) : value;
}
