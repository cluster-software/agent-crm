import type { AcrmDatabase } from "../db/types.js";
import { ensureWorkspaceIdentityForDatabase } from "./identity.js";
import { registerAllSchemas } from "./schemas/index.js";
import { seedAttributes, seedObjects } from "./seeds.js";

// Bring a database to the Agent CRM baseline shape. This is the
// single initialization path used by Workspace.create() and test helpers.
export async function initializeWorkspace(db: AcrmDatabase): Promise<void> {
  await registerAllSchemas(db);
  await seedObjects(db);
  await seedAttributes(db);
  await ensureWorkspaceIdentityForDatabase(db);
}
