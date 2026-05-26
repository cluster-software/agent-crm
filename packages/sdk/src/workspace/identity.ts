import { randomUUID } from "node:crypto";
import type { Lix } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import type { Workspace } from "../workspace.js";
import { registerAllSchemas } from "./schemas/index.js";

const LOCAL_WORKSPACE_ID_KEY = "local_workspace_id";

export async function ensureWorkspaceIdentity(workspace: Workspace): Promise<string> {
  return ensureWorkspaceIdentityForLix(workspace.lix);
}

export async function ensureWorkspaceIdentityForLix(lix: Lix): Promise<string> {
  await registerAllSchemas(lix);

  const existing = await readMetadataValue(lix, LOCAL_WORKSPACE_ID_KEY);
  if (existing) return existing;

  const localWorkspaceId = randomUUID();
  try {
    await exec(
      lix,
      "INSERT INTO acrm_metadata (key, value) VALUES ($1, $2)",
      [LOCAL_WORKSPACE_ID_KEY, localWorkspaceId],
    );
    return localWorkspaceId;
  } catch (error) {
    const reread = await readMetadataValue(lix, LOCAL_WORKSPACE_ID_KEY);
    if (reread) return reread;
    throw error;
  }
}

async function readMetadataValue(lix: Lix, key: string): Promise<string | null> {
  const result = await exec(
    lix,
    "SELECT value FROM acrm_metadata WHERE key = $1 LIMIT 1",
    [key],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const value = result.rows[0]?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}
