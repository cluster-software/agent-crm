import { AcrmError, ERR } from "../../lib/errors.js";
import { PostgresDatabase, type PostgresConnectionOptions } from "../postgres.js";
import type { DatabaseProvider, DatabasePoolOptions, DatabaseProviderName } from "./types.js";

type PostgresCompatibleProviderOptions = {
  name: DatabaseProviderName;
  envKeys: readonly string[];
  hint: string;
  detect?: (url: URL) => boolean;
  sslByDefault?: boolean;
  poolDefaults?: DatabasePoolOptions;
};

const DEFAULT_POOL_OPTIONS: DatabasePoolOptions = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

export function createPostgresCompatibleProvider(
  options: PostgresCompatibleProviderOptions,
): DatabaseProvider {
  return {
    name: options.name,
    envKeys: options.envKeys,
    hint: options.hint,
    detect: (databaseUrl) => {
      const parsed = parseDatabaseUrl(databaseUrl);
      return options.detect?.(parsed) ?? true;
    },
    validate: (databaseUrl) => {
      parseDatabaseUrl(databaseUrl);
    },
    connectionOptions: ({ databaseUrl, pool }) => {
      const parsed = parseDatabaseUrl(databaseUrl);
      const connectionOptions: PostgresConnectionOptions = {
        ...DEFAULT_POOL_OPTIONS,
        ...options.poolDefaults,
        ...pool,
        connectionString: databaseUrl,
      };
      if (
        options.sslByDefault &&
        pool?.ssl === undefined &&
        !parsed.searchParams.has("sslmode")
      ) {
        connectionOptions.ssl = { rejectUnauthorized: false };
      }
      return connectionOptions;
    },
    connect: (config) => PostgresDatabase.connect(config.connectionOptions),
  };
}

export function isPostgresDatabaseUrl(databaseUrl: string): boolean {
  try {
    parseDatabaseUrl(databaseUrl);
    return true;
  } catch {
    return false;
  }
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw invalidDatabaseUrlError();
  }
  if (!/^postgres(?:ql)?:$/i.test(parsed.protocol)) {
    throw invalidDatabaseUrlError();
  }
  return parsed;
}

function invalidDatabaseUrlError(): AcrmError {
  return new AcrmError(
    "workspace database URL must be a Postgres-compatible connection string",
    ERR.INVALID_INPUT,
    "Expected a URL starting with postgres:// or postgresql://.",
  );
}
