import { AcrmError, ERR } from "../../lib/errors.js";
import type { AcrmDatabase } from "../types.js";
import { isPostgresDatabaseUrl } from "./common.js";
import { neonProvider } from "./neon.js";
import { postgresProvider } from "./postgres.js";
import { supabaseProvider } from "./supabase.js";
import type {
  DatabaseProvider,
  DatabaseProviderName,
  DatabaseProviderResolveInput,
  ResolvedDatabaseProviderConfig,
} from "./types.js";

export const DATABASE_PROVIDER_ENV_KEY = "ACRM_DATABASE_PROVIDER";

export const DATABASE_URL_ENV_KEYS = [
  "ACRM_DATABASE_URL",
  "NEON_DATABASE_URL",
  "SUPABASE_DATABASE_URL",
  "DATABASE_URL",
] as const;

const PROVIDERS = [
  neonProvider,
  supabaseProvider,
  postgresProvider,
] as const satisfies readonly DatabaseProvider[];

export function listDatabaseProviders(): readonly DatabaseProvider[] {
  return PROVIDERS;
}

export function getDatabaseProvider(name: DatabaseProviderName | string): DatabaseProvider {
  const provider = PROVIDERS.find((candidate) => candidate.name === name);
  if (!provider) {
    throw new AcrmError(
      `unsupported database provider: ${name}`,
      ERR.INVALID_INPUT,
      "Supported providers are postgres, neon, and supabase.",
    );
  }
  return provider;
}

export function detectDatabaseProvider(databaseUrl: string): DatabaseProvider {
  for (const provider of PROVIDERS) {
    if (provider.name !== "postgres" && provider.detect(databaseUrl)) {
      return provider;
    }
  }
  return postgresProvider;
}

export function resolveDatabaseProviderConfig(
  input: DatabaseProviderResolveInput = {},
): ResolvedDatabaseProviderConfig {
  const env = input.env ?? process.env;
  const requestedProvider = input.provider ?? (
    input.databaseUrl ? undefined : env[DATABASE_PROVIDER_ENV_KEY]
  );
  const provider = requestedProvider
    ? getDatabaseProvider(requestedProvider)
    : undefined;
  const resolved = resolveDatabaseUrl(input.databaseUrl, env, provider);
  const detectedProvider = provider ?? detectDatabaseProvider(resolved.databaseUrl);

  detectedProvider.validate(resolved.databaseUrl);

  return {
    provider: detectedProvider.name,
    databaseUrl: resolved.databaseUrl,
    source: resolved.source,
    connectionOptions: detectedProvider.connectionOptions({
      databaseUrl: resolved.databaseUrl,
      pool: input.pool,
    }),
    hint: detectedProvider.hint,
  };
}

export function connectDatabase(
  input: DatabaseProviderResolveInput | ResolvedDatabaseProviderConfig = {},
): AcrmDatabase {
  const config = isResolvedDatabaseProviderConfig(input)
    ? input
    : resolveDatabaseProviderConfig(input);
  return getDatabaseProvider(config.provider).connect(config);
}

export { isPostgresDatabaseUrl };

function resolveDatabaseUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  provider: DatabaseProvider | undefined,
): { databaseUrl: string; source: string } {
  if (explicit) return { databaseUrl: explicit, source: "input" };

  const envKeys = provider
    ? unique([...provider.envKeys, "ACRM_DATABASE_URL", "DATABASE_URL"])
    : DATABASE_URL_ENV_KEYS;
  for (const key of envKeys) {
    const value = env[key];
    if (value) return { databaseUrl: value, source: key };
  }

  throw new AcrmError(
    "missing Postgres-compatible database URL",
    ERR.NO_WORKSPACE,
    provider
      ? `${provider.hint} You can also pass --workspace <postgres-url>.`
      : "Pass --workspace <postgres-url> or set ACRM_DATABASE_URL / NEON_DATABASE_URL / SUPABASE_DATABASE_URL / DATABASE_URL.",
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isResolvedDatabaseProviderConfig(
  input: DatabaseProviderResolveInput | ResolvedDatabaseProviderConfig,
): input is ResolvedDatabaseProviderConfig {
  return (
    "connectionOptions" in input &&
    typeof input.databaseUrl === "string" &&
    typeof input.provider === "string"
  );
}
