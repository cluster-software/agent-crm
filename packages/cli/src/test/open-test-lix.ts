import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { registerAllSchemas, seedAttributes, seedObjects } from "@agent-crm/sdk";

export async function openTestLix(): Promise<Lix> {
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: ":memory:" }),
  });

  await registerAllSchemas(lix);
  return lix;
}

// Same lix as openTestLix plus the objects + attributes that `acrm init`
// seeds. Use this for tests that exercise import paths or any code that
// reads attribute config (encode/decode, status options, etc.).
export async function openTestWorkspace(): Promise<Lix> {
  const lix = await openTestLix();
  await seedObjects(lix);
  await seedAttributes(lix);
  return lix;
}
