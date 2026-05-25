import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcrmError,
  ERR,
  type CommunicationImportBatch,
  type LinkedinRelation,
} from "@agent-crm/sdk";

export const DEFAULT_SYNC_ENGINE_URL = "https://agent-crm-sync-engine.onrender.com";
export const LINKEDIN_NOT_CONNECTED_MESSAGE = "LinkedIn is not connected for this workspace.";
export const LINKEDIN_NOT_CONNECTED_HINT = [
  "Run:",
  "  acrm connect linkedin",
  "",
  "Then re-run:",
  "  acrm import linkedin",
].join("\n");

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

export async function fetchCloudLinkedinRelationsExport(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  cutoffDate?: string;
}): Promise<{ relations: LinkedinRelation[] }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/linkedin/relations/export`,
    input.syncEngineUrl,
  );
  if (input.cutoffDate) url.searchParams.set("cutoff_date", input.cutoffDate);
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; data?: unknown; error?: unknown; code?: unknown }
    | undefined;
  if (isLinkedinNotConnected(payload)) {
    throw new AcrmError(
      LINKEDIN_NOT_CONNECTED_MESSAGE,
      ERR.INVALID_INPUT,
      LINKEDIN_NOT_CONNECTED_HINT,
    );
  }
  if (!response.ok || payload?.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new AcrmError(
      "failed to export LinkedIn relations",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  const data = payload.data as { relations?: unknown };
  if (!Array.isArray(data.relations)) {
    throw new AcrmError(
      "failed to export LinkedIn relations",
      ERR.IMPORT,
      "sync engine response did not include a relations array",
    );
  }
  return { relations: data.relations as LinkedinRelation[] };
}

function isLinkedinNotConnected(payload: { error?: unknown; code?: unknown } | undefined): boolean {
  const candidates = [
    payload?.code,
    typeof payload?.error === "object" && payload.error !== null
      ? (payload.error as { code?: unknown }).code
      : undefined,
    typeof payload?.error === "string" ? payload.error : undefined,
  ];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return (
      normalized === "linkedin_not_connected" ||
      normalized === "not_connected" ||
      (normalized.includes("linkedin") && normalized.includes("not_connected"))
    );
  });
}

function payloadError(payload: { error?: unknown } | undefined): string | undefined {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error === "object" && payload.error !== null) {
    const message = (payload.error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}
