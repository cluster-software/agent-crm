import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { registerAllSchemas } from "../workspace/schemas/index.js";

export async function openTestLix(): Promise<Lix> {
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: ":memory:" }),
  });

  await registerAllSchemas(lix);
  return lix;
}
