import { describe, expect, it } from "vitest";
import { connectDatabase } from "./registry.js";
import type { AcrmDatabase } from "../types.js";
import type { DatabaseProviderName } from "./types.js";

describeLiveProviderContract("neon", "ACRM_TEST_NEON_DATABASE_URL");
describeLiveProviderContract("supabase", "ACRM_TEST_SUPABASE_DATABASE_URL");

function describeLiveProviderContract(
  provider: DatabaseProviderName,
  envKey: string,
): void {
  const databaseUrl = process.env[envKey];
  const run = databaseUrl ? describe : describe.skip;

  run(`live ${provider} provider contract`, () => {
    it("executes SQL and runs transactions through AcrmDatabase", async () => {
      const db = connectDatabase({ provider, databaseUrl });
      try {
        await expectAcrmDatabaseContract(db);
      } finally {
        await db.close();
      }
    });
  });
}

async function expectAcrmDatabaseContract(db: AcrmDatabase): Promise<void> {
  const selected = await db.execute("SELECT 1::int AS ok");
  expect(selected.rows).toEqual([{ ok: 1 }]);

  const committed = await db.transaction(async (tx) => {
    await tx.execute("CREATE TEMP TABLE acrm_provider_contract_commit (value text)");
    await tx.execute("INSERT INTO acrm_provider_contract_commit (value) VALUES ($1)", ["ok"]);
    return await tx.execute("SELECT value FROM acrm_provider_contract_commit");
  });
  expect(committed.rows).toEqual([{ value: "ok" }]);

  await expect(db.transaction(async (tx) => {
    await tx.execute("CREATE TEMP TABLE acrm_provider_contract_rollback (value text)");
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
}
