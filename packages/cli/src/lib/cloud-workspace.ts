import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AcrmError,
  ERR,
  Workspace,
  ensureWorkspaceIdentity,
  type CommunicationImportBatch,
  type LinkedinRelation,
  type TranscriptPayload,
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
export const GRANOLA_NOT_CONNECTED_MESSAGE = "Granola is not connected for this workspace.";
export const GRANOLA_NOT_CONNECTED_HINT = [
  "Run:",
  "  acrm connect granola",
  "",
  "Then re-run:",
  "  acrm import granola",
].join("\n");

const CLOUD_METADATA_FILENAME = ".agent-crm-cloud.json";

export type CloudMetadata = {
  workspaceId?: string;
  clientToken?: string;
  clusterOrgId?: string;
  localWorkspaceId?: string;
  createdAt?: string;
};

export type CloudIntegrationAccountStatus = {
  id: string;
  providerAccountId: string;
  accountEmail?: string;
  displayName?: string;
  status: string;
  providerStatus?: string;
  syncStatus?: string;
  lastSyncedAt?: string;
};

export type CloudIntegrationProviderStatus = {
  connected: boolean;
  accountEmail?: string;
  displayName?: string;
  providerAccountId?: string;
  lastSyncedAt?: string;
  accounts?: CloudIntegrationAccountStatus[];
  sync?: Record<string, unknown>;
};

export type CloudIntegrationStatus = {
  gmail: CloudIntegrationProviderStatus;
  linkedin: CloudIntegrationProviderStatus;
  granola: CloudIntegrationProviderStatus;
};

export function ensureCloudWorkspaceMetadata(
  workspaceDir: string,
  preferred: {
    workspaceId?: string;
    clientToken?: string;
    clusterOrgId?: string;
    localWorkspaceId?: string;
    workspacePath?: string;
  } = {},
): { workspaceId: string; clientToken: string; clusterOrgId?: string; localWorkspaceId?: string } {
  const metadataPath = join(workspaceDir, CLOUD_METADATA_FILENAME);
  let existing = readCloudMetadata(metadataPath);
  const localWorkspaceId = preferred.localWorkspaceId || existing.localWorkspaceId;

  if (existing.workspaceId && existing.clientToken && localWorkspaceId) {
    if (existing.localWorkspaceId && existing.localWorkspaceId !== localWorkspaceId) {
      archiveCloudMetadata(metadataPath);
      existing = {};
    } else if (!existing.localWorkspaceId && shouldRotateLegacySidecar(existing, metadataPath, preferred.workspacePath)) {
      archiveCloudMetadata(metadataPath);
      existing = {};
    }
  }

  const workspaceId = existing.workspaceId || preferred.workspaceId || randomUUID();
  const clientToken = existing.clientToken || preferred.clientToken || randomUUID();
  const clusterOrgId = preferred.clusterOrgId || existing.clusterOrgId;
  const nextLocalWorkspaceId = localWorkspaceId || existing.localWorkspaceId;

  if (
    workspaceId !== existing.workspaceId ||
    clientToken !== existing.clientToken ||
    clusterOrgId !== existing.clusterOrgId ||
    nextLocalWorkspaceId !== existing.localWorkspaceId
  ) {
    writeFileSync(
      metadataPath,
      `${JSON.stringify({
        ...existing,
        workspaceId,
        clientToken,
        ...(clusterOrgId ? { clusterOrgId } : {}),
        ...(nextLocalWorkspaceId ? { localWorkspaceId: nextLocalWorkspaceId } : {}),
        createdAt: existing.createdAt ?? new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8"
    );
  }

  return {
    workspaceId,
    clientToken,
    ...(clusterOrgId ? { clusterOrgId } : {}),
    ...(nextLocalWorkspaceId ? { localWorkspaceId: nextLocalWorkspaceId } : {}),
  };
}

export async function ensureCloudWorkspaceMetadataForWorkspace(
  workspacePath: string,
  preferred: { workspaceId?: string; clientToken?: string; clusterOrgId?: string } = {},
): Promise<{ workspaceId: string; clientToken: string; clusterOrgId?: string; localWorkspaceId?: string }> {
  const workspace = await Workspace.open(workspacePath);
  try {
    const localWorkspaceId = await ensureWorkspaceIdentity(workspace);
    return ensureCloudWorkspaceMetadata(dirname(workspacePath), {
      ...preferred,
      localWorkspaceId,
      workspacePath,
    });
  } finally {
    await workspace.close();
  }
}

function readCloudMetadata(metadataPath: string): CloudMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as CloudMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function shouldRotateLegacySidecar(
  existing: CloudMetadata,
  metadataPath: string,
  workspacePath: string | undefined,
): boolean {
  if (existing.localWorkspaceId || !workspacePath || !existsSync(metadataPath) || !existsSync(workspacePath)) {
    return false;
  }
  const sidecarCreatedAt = sidecarTimestamp(existing, metadataPath);
  if (sidecarCreatedAt == null) return false;
  const workspaceStat = statSync(workspacePath);
  const workspaceCreatedAt = Math.max(workspaceStat.birthtimeMs, workspaceStat.mtimeMs);
  return workspaceCreatedAt > sidecarCreatedAt;
}

function sidecarTimestamp(existing: CloudMetadata, metadataPath: string): number | null {
  const createdAt = Date.parse(existing.createdAt ?? "");
  if (!Number.isNaN(createdAt)) return createdAt;
  const stat = statSync(metadataPath);
  const timestamp = Math.max(stat.birthtimeMs, stat.mtimeMs);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function archiveCloudMetadata(metadataPath: string): void {
  if (!existsSync(metadataPath)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${metadataPath}.stale-${timestamp}`;
  let target = base;
  let suffix = 1;
  while (existsSync(target)) {
    target = `${base}-${suffix}`;
    suffix++;
  }
  renameSync(metadataPath, target);
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
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  return payload.data as CommunicationImportBatch;
}

export async function fetchCloudIntegrationStatus(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
}): Promise<CloudIntegrationStatus> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/status`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; integrations?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true || !payload.integrations || typeof payload.integrations !== "object") {
    throw new AcrmError(
      "failed to fetch integration status",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  const integrations = payload.integrations as { gmail?: unknown; linkedin?: unknown; granola?: unknown };
  return {
    gmail: parseProviderStatus(integrations.gmail),
    linkedin: parseProviderStatus(integrations.linkedin),
    granola: parseProviderStatus(integrations.granola),
  };
}

export async function connectCloudGranola(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  apiKey: string;
  cutoffDate?: string;
}): Promise<{ account: unknown; cutoff_date?: string }> {
  const url = new URL("/integrations/granola/connect", input.syncEngineUrl);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      workspace_id: input.workspaceId,
      api_key: input.apiKey,
      ...(input.cutoffDate ? { cutoff_date: input.cutoffDate } : {}),
    }),
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; account?: unknown; cutoff_date?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true) {
    throw new AcrmError(
      "failed to connect Granola",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  return {
    account: payload.account,
    ...(typeof payload.cutoff_date === "string" ? { cutoff_date: payload.cutoff_date } : {}),
  };
}

export async function fetchCloudGranolaTranscriptsExport(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  cutoffDate?: string;
}): Promise<{ transcripts: TranscriptPayload[] }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/granola/export`,
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
  if (isGranolaNotConnected(payload)) {
    throw new AcrmError(
      GRANOLA_NOT_CONNECTED_MESSAGE,
      ERR.INVALID_INPUT,
      GRANOLA_NOT_CONNECTED_HINT,
    );
  }
  if (!response.ok || payload?.ok !== true || !payload.data || typeof payload.data !== "object") {
    throw new AcrmError(
      "failed to export Granola transcripts",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  const data = payload.data as { transcripts?: unknown };
  if (!Array.isArray(data.transcripts)) {
    throw new AcrmError(
      "failed to export Granola transcripts",
      ERR.IMPORT,
      "sync engine response did not include a transcripts array",
    );
  }
  return { transcripts: data.transcripts as TranscriptPayload[] };
}

export async function startCloudGranolaBackfill(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  cutoffDate?: string;
}): Promise<{ started: number; integration_account_ids: string[] }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/granola/backfill`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...(input.cutoffDate ? { cutoff_date: input.cutoffDate } : {}),
    }),
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; started?: unknown; integration_account_ids?: unknown; error?: unknown; code?: unknown }
    | undefined;
  if (isGranolaNotConnected(payload)) {
    throw new AcrmError(
      GRANOLA_NOT_CONNECTED_MESSAGE,
      ERR.INVALID_INPUT,
      GRANOLA_NOT_CONNECTED_HINT,
    );
  }
  if (!response.ok || payload?.ok !== true) {
    throw new AcrmError(
      "failed to start Granola backfill",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  return {
    started: typeof payload.started === "number" ? payload.started : 0,
    integration_account_ids: Array.isArray(payload.integration_account_ids)
      ? payload.integration_account_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export async function fetchCloudLinkedinRelationsExport(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  cutoffDate?: string;
  enrichCompanies?: boolean;
}): Promise<{ relations: LinkedinRelation[]; company_enrichment?: unknown }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/linkedin/relations/export`,
    input.syncEngineUrl,
  );
  if (input.cutoffDate) url.searchParams.set("cutoff_date", input.cutoffDate);
  if (input.enrichCompanies) url.searchParams.set("enrich_companies", "1");
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
  const data = payload.data as { relations?: unknown; company_enrichment?: unknown };
  if (!Array.isArray(data.relations)) {
    throw new AcrmError(
      "failed to export LinkedIn relations",
      ERR.IMPORT,
      "sync engine response did not include a relations array",
    );
  }
  return {
    relations: data.relations as LinkedinRelation[],
    ...(data.company_enrichment ? { company_enrichment: data.company_enrichment } : {}),
  };
}

export async function startCloudLinkedinMessageBackfill(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
}): Promise<{ started: number; integration_account_ids: string[] }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/linkedin/messages/backfill`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; started?: unknown; integration_account_ids?: unknown; error?: unknown; code?: unknown }
    | undefined;
  if (isLinkedinNotConnected(payload)) {
    throw new AcrmError(
      LINKEDIN_NOT_CONNECTED_MESSAGE,
      ERR.INVALID_INPUT,
      LINKEDIN_NOT_CONNECTED_HINT,
    );
  }
  if (!response.ok || payload?.ok !== true) {
    throw new AcrmError(
      "failed to start LinkedIn message backfill",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  return {
    started: typeof payload.started === "number" ? payload.started : 0,
    integration_account_ids: Array.isArray(payload.integration_account_ids)
      ? payload.integration_account_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function parseProviderStatus(value: unknown): CloudIntegrationProviderStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { connected: false };
  }
  const status = value as Record<string, unknown>;
  const accounts = Array.isArray(status.accounts)
    ? status.accounts
      .map(parseAccountStatus)
      .filter((account): account is CloudIntegrationAccountStatus => Boolean(account))
    : undefined;
  return {
    connected: status.connected === true,
    ...(stringValue(status.accountEmail) ? { accountEmail: stringValue(status.accountEmail) } : {}),
    ...(stringValue(status.displayName) ? { displayName: stringValue(status.displayName) } : {}),
    ...(stringValue(status.providerAccountId) ? { providerAccountId: stringValue(status.providerAccountId) } : {}),
    ...(stringValue(status.lastSyncedAt) ? { lastSyncedAt: stringValue(status.lastSyncedAt) } : {}),
    ...(accounts && accounts.length > 0 ? { accounts } : {}),
    ...(recordValue(status.sync) ? { sync: recordValue(status.sync) } : {}),
  };
}

function parseAccountStatus(value: unknown): CloudIntegrationAccountStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const account = value as Record<string, unknown>;
  const id = stringValue(account.id);
  const providerAccountId = stringValue(account.providerAccountId);
  const status = stringValue(account.status);
  if (!id || !providerAccountId || !status) return null;
  const providerStatus = stringValue(account.providerStatus) ?? stringValue(account.provider_status);
  const syncStatus = stringValue(account.syncStatus) ?? stringValue(account.sync_status);
  return {
    id,
    providerAccountId,
    status,
    ...(stringValue(account.accountEmail) ? { accountEmail: stringValue(account.accountEmail) } : {}),
    ...(stringValue(account.displayName) ? { displayName: stringValue(account.displayName) } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(syncStatus ? { syncStatus } : {}),
    ...(stringValue(account.lastSyncedAt) ? { lastSyncedAt: stringValue(account.lastSyncedAt) } : {}),
  };
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

function isGranolaNotConnected(payload: { error?: unknown; code?: unknown } | undefined): boolean {
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
      normalized === "granola_not_connected" ||
      normalized === "not_connected" ||
      (normalized.includes("granola") && normalized.includes("not_connected"))
    );
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function payloadError(payload: { error?: unknown } | undefined): string | undefined {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error === "object" && payload.error !== null) {
    const message = (payload.error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}
