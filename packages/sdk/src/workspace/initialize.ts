import type { Lix } from "@lix-js/sdk";
import { ensureWorkspaceIdentityForLix } from "./identity.js";
import { registerAllSchemas } from "./schemas/index.js";
import { seedAttributes, seedObjects } from "./seeds.js";

// Bring a newly-created Lix file to the Agent CRM baseline shape. This is the
// single initialization path used by Workspace.create() and test helpers.
export async function initializeWorkspace(lix: Lix): Promise<void> {
  await registerAllSchemas(lix);
  await seedObjects(lix);
  await seedAttributes(lix);
  await ensureWorkspaceIdentityForLix(lix);
}
