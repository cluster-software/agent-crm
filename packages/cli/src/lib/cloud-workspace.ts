import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcrmError, ERR, type CommunicationImportBatch } from "@agent-crm/sdk";

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

export async function registerCloudWorkspace(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  workspaceName: string;
}): Promise<void> {
  const url = new URL(`/workspaces/${encodeURIComponent(input.workspaceId)}/register`, input.syncEngineUrl);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true) {
    throw new AcrmError(
      "failed to register cloud workspace",
      ERR.IMPORT,
      typeof payload?.error === "string" ? payload.error : `sync engine returned HTTP ${response.status}`,
    );
  }
}

export async function fetchCloudCommunicationExport(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  provider: "gmail" | "linkedin";
}): Promise<CommunicationImportBatch> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/${input.provider}/export`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; data?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new AcrmError(
      `failed to export ${input.provider} communication data`,
      ERR.IMPORT,
      typeof payload?.error === "string" ? payload.error : `sync engine returned HTTP ${response.status}`,
    );
  }
  return payload.data as CommunicationImportBatch;
}
