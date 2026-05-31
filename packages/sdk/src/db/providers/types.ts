import type { PoolConfig } from "pg";
import type { AcrmDatabase } from "../types.js";
import type { PostgresConnectionOptions } from "../postgres.js";

export type DatabaseProviderName = "postgres" | "neon" | "supabase";

export type DatabaseProviderEnv = Record<string, string | undefined>;

export type DatabasePoolOptions = Omit<PoolConfig, "connectionString">;

export type DatabaseProviderResolveInput = {
  databaseUrl?: string;
  provider?: DatabaseProviderName | string;
  env?: DatabaseProviderEnv;
  pool?: DatabasePoolOptions;
};

export type ResolvedDatabaseProviderConfig = {
  provider: DatabaseProviderName;
  databaseUrl: string;
  source: string;
  connectionOptions: PostgresConnectionOptions;
  hint?: string;
};

export type DatabaseProvider = {
  name: DatabaseProviderName;
  envKeys: readonly string[];
  hint: string;
  detect(databaseUrl: string): boolean;
  validate(databaseUrl: string): void;
  connectionOptions(input: {
    databaseUrl: string;
    pool?: DatabasePoolOptions;
  }): PostgresConnectionOptions;
  connect(config: ResolvedDatabaseProviderConfig): AcrmDatabase;
};
