import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SYNC_ENGINE_URL = "https://agent-crm-sync-engine.onrender.com";
const CLOUD_METADATA_FILENAME = ".agent-crm-cloud.json";

export type CloudMetadata = {
  workspaceId?: string;
  clientToken?: string;
  clusterOrgId?: string;
  createdAt?: string;
};

export function ensureCloudWorkspaceMetadata(
  workspaceDir: string,
  preferred: { workspaceId?: string; clientToken?: string; clusterOrgId?: string } = {},
): { workspaceId: string; clientToken: string; clusterOrgId?: string } {
  const metadataPath = join(workspaceDir, CLOUD_METADATA_FILENAME);
  const existing = readCloudMetadata(metadataPath);
  const workspaceId = existing.workspaceId || preferred.workspaceId || randomUUID();
  const clientToken = existing.clientToken || preferred.clientToken || randomUUID();
  const clusterOrgId = preferred.clusterOrgId || existing.clusterOrgId;

  if (
    workspaceId !== existing.workspaceId ||
    clientToken !== existing.clientToken ||
    clusterOrgId !== existing.clusterOrgId
  ) {
    writeFileSync(
      metadataPath,
      `${JSON.stringify({
        ...existing,
        workspaceId,
        clientToken,
        ...(clusterOrgId ? { clusterOrgId } : {}),
        createdAt: existing.createdAt ?? new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8"
    );
  }

  return {
    workspaceId,
    clientToken,
    ...(clusterOrgId ? { clusterOrgId } : {}),
  };
}

function readCloudMetadata(metadataPath: string): CloudMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as CloudMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
