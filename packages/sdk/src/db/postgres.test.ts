import { describe, expect, it } from "vitest";
import { PostgresDatabase, type Queryable } from "./postgres.js";
import type { AcrmDatabase, SqlValue } from "./types.js";

describe("PostgresDatabase", () => {
  it("maps direct connection string channel binding params into node-postgres options", async () => {
    const required = PostgresDatabase.connect(
      "postgresql://user:pass@example.com/db?channel_binding=require",
    );
    const preferred = PostgresDatabase.connect(
      "postgresql://user:pass@example.com/db?channel_binding=prefer",
    );
    const disabled = PostgresDatabase.connect(
      "postgresql://user:pass@example.com/db?channel_binding=disable",
    );
    try {
      expect(poolOptions(required).enableChannelBinding).toBe(true);
      expect(poolOptions(preferred).enableChannelBinding).toBe(true);
      expect(poolOptions(disabled).enableChannelBinding).toBeUndefined();
    } finally {
      await Promise.all([
        required.close(),
        preferred.close(),
        disabled.close(),
      ]);
    }
  });

  it("maps object-form connection string channel binding params without overriding explicit options", async () => {
    const required = PostgresDatabase.connect({
      connectionString: "postgresql://user:pass@example.com/db?channel_binding=require",
    });
    const explicit = PostgresDatabase.connect({
      connectionString: "postgresql://user:pass@example.com/db?channel_binding=require",
      enableChannelBinding: false,
    });
    try {
      expect(poolOptions(required).enableChannelBinding).toBe(true);
      expect(poolOptions(explicit).enableChannelBinding).toBe(false);
    } finally {
      await Promise.all([required.close(), explicit.close()]);
    }
  });

  it("rolls back failed pool-backed transactions", async () => {
    const pool = new TransactionalPool();
    const db = PostgresDatabase.fromQueryable(pool);

    await expectRollback(db);

    expect(pool.releaseCount).toBe(1);
    expect(pool.queries).toEqual([
      "CREATE TABLE tx_probe (value text)",
      "BEGIN",
      "INSERT INTO tx_probe (value) VALUES ($1)",
      "ROLLBACK",
      "SELECT value FROM tx_probe",
    ]);
  });

  it("rolls back failed queryable-backed transactions", async () => {
    const client = new TransactionalQueryable();
    const db = PostgresDatabase.fromQueryable(client);

    await expectRollback(db);

    expect(client.queries).toEqual([
      "CREATE TABLE tx_probe (value text)",
      "BEGIN",
      "INSERT INTO tx_probe (value) VALUES ($1)",
      "ROLLBACK",
      "SELECT value FROM tx_probe",
    ]);
  });

  it("does not commit an outer pool-backed transaction from a nested transaction", async () => {
    const pool = new TransactionalPool();
    const db = PostgresDatabase.fromQueryable(pool);

    await db.execute("CREATE TABLE tx_probe (value text)");

    await expect(db.transaction(async (tx) => {
      await tx.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["outer"]);
      await tx.transaction(async (nested) => {
        await nested.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["nested"]);
      });
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");

    const result = await db.execute("SELECT value FROM tx_probe");
    expect(result.rows).toEqual([]);
    expect(pool.queries).toEqual([
      "CREATE TABLE tx_probe (value text)",
      "BEGIN",
      "INSERT INTO tx_probe (value) VALUES ($1)",
      expect.stringMatching(/^SAVEPOINT acrm_sp_\d+$/),
      "INSERT INTO tx_probe (value) VALUES ($1)",
      expect.stringMatching(/^RELEASE SAVEPOINT acrm_sp_\d+$/),
      "ROLLBACK",
      "SELECT value FROM tx_probe",
    ]);
  });

  it("rolls back failed nested transactions to a savepoint", async () => {
    const pool = new TransactionalPool();
    const db = PostgresDatabase.fromQueryable(pool);

    await db.execute("CREATE TABLE tx_probe (value text)");

    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["outer"]);
      await expect(tx.transaction(async (nested) => {
        await nested.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["nested"]);
        throw new Error("nested rollback");
      })).rejects.toThrow("nested rollback");
      await tx.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["after"]);
    });

    const result = await db.execute("SELECT value FROM tx_probe");
    expect(result.rows).toEqual([{ value: "outer" }, { value: "after" }]);
    expect(pool.queries).toEqual([
      "CREATE TABLE tx_probe (value text)",
      "BEGIN",
      "INSERT INTO tx_probe (value) VALUES ($1)",
      expect.stringMatching(/^SAVEPOINT acrm_sp_\d+$/),
      "INSERT INTO tx_probe (value) VALUES ($1)",
      expect.stringMatching(/^ROLLBACK TO SAVEPOINT acrm_sp_\d+$/),
      expect.stringMatching(/^RELEASE SAVEPOINT acrm_sp_\d+$/),
      "INSERT INTO tx_probe (value) VALUES ($1)",
      "COMMIT",
      "SELECT value FROM tx_probe",
    ]);
  });
});

async function expectRollback(db: AcrmDatabase): Promise<void> {
  await db.execute("CREATE TABLE tx_probe (value text)");

  await expect(db.transaction(async (tx) => {
    await tx.execute("INSERT INTO tx_probe (value) VALUES ($1)", ["rolled back"]);
    throw new Error("forced rollback");
  })).rejects.toThrow("forced rollback");

  const result = await db.execute("SELECT value FROM tx_probe");
  expect(result.rows).toEqual([]);
}

function poolOptions(db: PostgresDatabase): { enableChannelBinding?: boolean } {
  return (db as unknown as {
    queryable: { options: { enableChannelBinding?: boolean } };
  }).queryable.options;
}

class TransactionalQueryable implements Queryable {
  readonly queries: string[] = [];
  private rows: string[] = [];
  private transactionRows: string[] | null = null;
  private readonly savepoints = new Map<string, string[]>();

  async query(
    sql: string,
    params: ReadonlyArray<SqlValue> = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.queries.push(sql);

    if (sql === "BEGIN") {
      this.transactionRows = [...this.rows];
      return { rows: [], rowCount: null };
    }
    if (sql === "COMMIT") {
      if (this.transactionRows) this.rows = this.transactionRows;
      this.transactionRows = null;
      this.savepoints.clear();
      return { rows: [], rowCount: null };
    }
    if (sql === "ROLLBACK") {
      this.transactionRows = null;
      this.savepoints.clear();
      return { rows: [], rowCount: null };
    }
    const savepoint = sql.match(/^SAVEPOINT ([a-zA-Z0-9_]+)$/);
    if (savepoint) {
      this.savepoints.set(savepoint[1]!, [...this.activeRows()]);
      return { rows: [], rowCount: null };
    }
    const rollbackToSavepoint = sql.match(/^ROLLBACK TO SAVEPOINT ([a-zA-Z0-9_]+)$/);
    if (rollbackToSavepoint) {
      this.transactionRows = [...(this.savepoints.get(rollbackToSavepoint[1]!) ?? [])];
      return { rows: [], rowCount: null };
    }
    const releaseSavepoint = sql.match(/^RELEASE SAVEPOINT ([a-zA-Z0-9_]+)$/);
    if (releaseSavepoint) {
      this.savepoints.delete(releaseSavepoint[1]!);
      return { rows: [], rowCount: null };
    }
    if (/^CREATE TABLE tx_probe\b/i.test(sql)) {
      return { rows: [], rowCount: null };
    }
    if (/^INSERT INTO tx_probe\b/i.test(sql)) {
      this.activeRows().push(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT value FROM tx_probe\b/i.test(sql)) {
      const rows = this.activeRows();
      return {
        rows: rows.map((value) => ({ value })),
        rowCount: rows.length,
      };
    }

    throw new Error(`unexpected SQL: ${sql}`);
  }

  private activeRows(): string[] {
    return this.transactionRows ?? this.rows;
  }
}

class TransactionalPool extends TransactionalQueryable {
  releaseCount = 0;

  async connect(): Promise<Queryable & { release(): void }> {
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {
        this.releaseCount++;
      },
    };
  }
}
