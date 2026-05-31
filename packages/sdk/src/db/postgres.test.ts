import { describe, expect, it } from "vitest";
import { PostgresDatabase, type Queryable } from "./postgres.js";
import type { AcrmDatabase, SqlValue } from "./types.js";

describe("PostgresDatabase", () => {
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

  it("rolls back failed client-backed transactions", async () => {
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

class TransactionalQueryable implements Queryable {
  readonly queries: string[] = [];
  private rows: string[] = [];
  private transactionRows: string[] | null = null;

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
      return { rows: [], rowCount: null };
    }
    if (sql === "ROLLBACK") {
      this.transactionRows = null;
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
      return {
        rows: this.rows.map((value) => ({ value })),
        rowCount: this.rows.length,
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
