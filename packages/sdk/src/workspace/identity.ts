import { randomUUID } from "node:crypto";
import type { AcrmDatabase } from "../db/types.js";
import { exec } from "../db/execute.js";
import { workspaceDatabase, type Workspace } from "../workspace.js";
import { registerAllSchemas } from "./schemas/index.js";

const LOCAL_WORKSPACE_ID_KEY = "local_workspace_id";

export async function ensureWorkspaceIdentity(workspace: Workspace): Promise<string> {
  return ensureWorkspaceIdentityForDatabase(workspaceDatabase(workspace));
}

export async function ensureWorkspaceIdentityForDatabase(db: AcrmDatabase): Promise<string> {
  await registerAllSchemas(db);

  const existing = await readMetadataValue(db, LOCAL_WORKSPACE_ID_KEY);
  if (existing) return existing;

  const localWorkspaceId = randomUUID();
  try {
    await exec(
      db,
      "INSERT INTO acrm_metadata (key, value) VALUES ($1, $2)",
      [LOCAL_WORKSPACE_ID_KEY, localWorkspaceId],
    );
    return localWorkspaceId;
  } catch (error) {
    const reread = await readMetadataValue(db, LOCAL_WORKSPACE_ID_KEY);
    if (reread) return reread;
    throw error;
  }
}

async function readMetadataValue(db: AcrmDatabase, key: string): Promise<string | null> {
  const result = await exec(
    db,
    "SELECT value FROM acrm_metadata WHERE key = $1 LIMIT 1",
    [key],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const value = result.rows[0]?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}
