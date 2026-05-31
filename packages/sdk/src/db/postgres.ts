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
  // Supported by node-postgres at runtime; older @types/pg releases do not
  // expose it yet.
  enableChannelBinding?: boolean;
};

type TransactionState = "root" | "active" | "passthrough";

export class PostgresDatabase implements AcrmDatabase {
  private static nextSavepointId = 1;

  private constructor(
    private readonly queryable: Queryable,
    private readonly closeFn: (() => Promise<void>) | null,
    private readonly transactionState: TransactionState = "root",
  ) {}

  static connect(options: string | PostgresConnectionOptions): PostgresDatabase {
    const pool = new Pool(
      typeof options === "string" ? connectionOptionsFromString(options) : options,
    );
    return new PostgresDatabase(pool, () => pool.end());
  }

  static fromClient(client: PoolClient): PostgresDatabase {
    return new PostgresDatabase(client, null, "passthrough");
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
    if (this.transactionState === "passthrough") {
      return await fn(this);
    }

    if (this.transactionState === "active") {
      return await this.savepoint(fn);
    }

    if (!("connect" in this.queryable)) {
      await this.queryable.query("BEGIN");
      const tx = new PostgresDatabase(this.queryable, null, "active");
      try {
        const result = await fn(tx);
        await this.queryable.query("COMMIT");
        return result;
      } catch (error) {
        await this.queryable.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    const pool = this.queryable as PgPool;
    const client = await pool.connect();
    const tx = new PostgresDatabase(client, null, "active");
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

  private async savepoint<T>(fn: (db: AcrmDatabase) => Promise<T>): Promise<T> {
    const name = `acrm_sp_${PostgresDatabase.nextSavepointId++}`;
    await this.queryable.query(`SAVEPOINT ${name}`);
    const tx = new PostgresDatabase(this.queryable, null, "active");
    try {
      const result = await fn(tx);
      await this.queryable.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.queryable.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      await this.queryable.query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined);
      throw error;
    }
  }
}

function connectionOptionsFromString(
  connectionString: string,
): PostgresConnectionOptions {
  const options: PostgresConnectionOptions = { connectionString };
  const channelBinding = channelBindingMode(connectionString);
  if (channelBinding === "require" || channelBinding === "prefer") {
    options.enableChannelBinding = true;
  }
  return options;
}

function channelBindingMode(connectionString: string): string | null {
  try {
    return (
      new URL(connectionString).searchParams.get("channel_binding")?.toLowerCase() ??
      null
    );
  } catch {
    return null;
  }
}
