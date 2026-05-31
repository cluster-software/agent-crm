import { describe, expect, it } from "vitest";
import {
  connectDatabase,
  detectDatabaseProvider,
  getDatabaseProvider,
  isPostgresDatabaseUrl,
  resolveDatabaseProviderConfig,
} from "./registry.js";
import { ERR } from "../../lib/errors.js";

describe("database provider registry", () => {
  it("detects Neon and Supabase URLs before falling back to generic Postgres", () => {
    expect(detectDatabaseProvider("postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db").name).toBe("neon");
    expect(detectDatabaseProvider("postgres://postgres:pass@db.project.supabase.co/postgres").name).toBe("supabase");
    expect(detectDatabaseProvider("postgres://postgres:pass@aws-0-us-east-1.pooler.supabase.com/postgres").name).toBe("supabase");
    expect(detectDatabaseProvider("postgres://user:pass@localhost:5432/db").name).toBe("postgres");
  });

  it("resolves database URLs from provider-specific environment variables", () => {
    const config = resolveDatabaseProviderConfig({
      provider: "supabase",
      env: {
        SUPABASE_DATABASE_URL: "postgres://postgres:pass@db.project.supabase.co/postgres",
        NEON_DATABASE_URL: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db",
      },
    });

    expect(config.provider).toBe("supabase");
    expect(config.source).toBe("SUPABASE_DATABASE_URL");
    expect(config.databaseUrl).toContain("supabase.co");
  });

  it("lets ACRM_DATABASE_URL act as a provider-neutral override", () => {
    const config = resolveDatabaseProviderConfig({
      env: {
        ACRM_DATABASE_URL: "postgres://postgres:pass@db.project.supabase.co/postgres",
        NEON_DATABASE_URL: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db",
      },
    });

    expect(config.provider).toBe("supabase");
    expect(config.source).toBe("ACRM_DATABASE_URL");
  });

  it("supports ACRM_DATABASE_PROVIDER when the URL comes from DATABASE_URL", () => {
    const config = resolveDatabaseProviderConfig({
      env: {
        ACRM_DATABASE_PROVIDER: "neon",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      },
    });

    expect(config.provider).toBe("neon");
    expect(config.source).toBe("DATABASE_URL");
  });

  it("detects an explicit URL instead of applying ACRM_DATABASE_PROVIDER from the environment", () => {
    const config = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      env: {
        ACRM_DATABASE_PROVIDER: "supabase",
      },
    });

    expect(config.provider).toBe("postgres");
    expect(config.source).toBe("input");
    expect(config.connectionOptions.ssl).toBeUndefined();
  });

  it("applies provider SSL defaults without duplicating SQL adapters", async () => {
    const neon = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db",
    });
    const supabase = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://postgres:pass@db.project.supabase.co/postgres",
    });
    const postgres = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@localhost:5432/db",
    });

    expect(neon.connectionOptions.ssl).toEqual({ rejectUnauthorized: false });
    expect(supabase.connectionOptions.ssl).toEqual({ rejectUnauthorized: false });
    expect(postgres.connectionOptions.ssl).toBeUndefined();
    const neonDb = connectDatabase(neon);
    const supabaseDb = connectDatabase(supabase);
    const postgresDb = connectDatabase(postgres);
    try {
      expect(neonDb.constructor.name).toBe("PostgresDatabase");
      expect(supabaseDb.constructor.name).toBe("PostgresDatabase");
      expect(postgresDb.constructor.name).toBe("PostgresDatabase");
    } finally {
      await Promise.all([
        neonDb.close(),
        supabaseDb.close(),
        postgresDb.close(),
      ]);
    }
  });

  it("does not override explicit sslmode or pool ssl options", () => {
    const sslmode = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db?sslmode=require",
    });
    const poolSsl = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://postgres:pass@db.project.supabase.co/postgres",
      pool: { ssl: true },
    });

    expect(sslmode.connectionOptions.ssl).toBeUndefined();
    expect(poolSsl.connectionOptions.ssl).toBe(true);
  });

  it("maps channel binding URL params into node-postgres options", () => {
    const required = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db?sslmode=require&channel_binding=require",
    });
    const preferred = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db?channel_binding=prefer",
    });
    const disabled = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db?channel_binding=disable",
    });
    const poolOverride = resolveDatabaseProviderConfig({
      databaseUrl: "postgres://user:pass@ep-blue-1.us-east-1.aws.neon.tech/db?channel_binding=require",
      pool: { enableChannelBinding: false },
    });

    expect(required.connectionOptions.enableChannelBinding).toBe(true);
    expect(preferred.connectionOptions.enableChannelBinding).toBe(true);
    expect(disabled.connectionOptions.enableChannelBinding).toBeUndefined();
    expect(poolOverride.connectionOptions.enableChannelBinding).toBe(false);
  });

  it("rejects unsupported providers and non-Postgres URLs", () => {
    expect(() => getDatabaseProvider("mysql")).toThrow("unsupported database provider");
    expect(() => resolveDatabaseProviderConfig({
      databaseUrl: "mysql://user:pass@localhost/db",
    })).toThrowError(expect.objectContaining({
      code: ERR.INVALID_INPUT,
    }));
    expect(isPostgresDatabaseUrl("postgres://user:pass@localhost/db")).toBe(true);
    expect(isPostgresDatabaseUrl("https://example.com")).toBe(false);
  });
});
