import pg, {
  type Pool as PgPool,
  type PoolClient,
  type PoolConfig,
} from "pg";
import type { AcrmDatabase, ExecuteResult, SqlValue } from "./types.js";

const { Pool } = pg;

export type Queryable = {
  query(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

export type PostgresConnectionOptions = PoolConfig & {
  connectionString: string;
};

export class PostgresDatabase implements AcrmDatabase {
  private constructor(
    private readonly queryable: Queryable,
    private readonly closeFn: (() => Promise<void>) | null,
  ) {}

  static connect(options: string | PostgresConnectionOptions): PostgresDatabase {
    const pool = new Pool(
      typeof options === "string" ? { connectionString: options } : options,
    );
    return new PostgresDatabase(pool, () => pool.end());
  }

  static fromClient(client: PoolClient): PostgresDatabase {
    return new PostgresDatabase(client, null);
  }

  static fromQueryable(
    queryable: Queryable,
    closeFn: (() => Promise<void>) | null = null,
  ): PostgresDatabase {
    return new PostgresDatabase(queryable, closeFn);
  }

  async execute(
    sql: string,
    params: ReadonlyArray<SqlValue> = [],
  ): Promise<ExecuteResult> {
    const result = await this.queryable.query(sql, params);
    return {
      rows: result.rows,
      rowsAffected: result.rowCount ?? 0,
    };
  }

  async transaction<T>(fn: (db: AcrmDatabase) => Promise<T>): Promise<T> {
    if (!("connect" in this.queryable)) {
      await this.queryable.query("BEGIN");
      try {
        const result = await fn(this);
        await this.queryable.query("COMMIT");
        return result;
      } catch (error) {
        await this.queryable.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    const pool = this.queryable as PgPool;
    const client = await pool.connect();
    const tx = PostgresDatabase.fromClient(client);
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.closeFn?.();
  }
}
