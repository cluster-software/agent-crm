import { newDb } from "pg-mem";
import {
  registerAllSchemas,
  seedAttributes,
  seedObjects,
  uuidv7,
  type AcrmDatabase,
} from "@agent-crm/sdk";
import { PostgresDatabase } from "../../../sdk/src/db/postgres.js";

export async function openTestDatabase(): Promise<AcrmDatabase> {
  const mem = newDb({ noAstCoverageCheck: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: "text",
    implementation: () => uuidv7(),
  });
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  const db = PostgresDatabase.fromQueryable(pool, () => pool.end());
  await registerAllSchemas(db);
  return db;
}

// Same database as openTestDatabase plus the objects + attributes that `acrm init`
// seeds. Use this for tests that exercise import paths or any code that reads
// attribute config (encode/decode, status options, etc.).
export async function openTestWorkspace(): Promise<AcrmDatabase> {
  const db = await openTestDatabase();
  await seedObjects(db);
  await seedAttributes(db);
  return db;
}
