import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcrmError,
  ERR,
  Workspace,
  ensureWorkspaceIdentity,
  type AcrmDatabase,
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
const CLOUD_METADATA_KEYS = {
  bundle: "cloud.workspace",
  workspaceId: "cloud.workspace_id",
  clientToken: "cloud.client_token",
  orgId: "cloud.org_id",
  localWorkspaceId: "cloud.local_workspace_id",
  createdAt: "cloud.created_at",
} as const;

export type CloudMetadata = {
  workspaceId?: string;
  clientToken?: string;
  orgId?: string;
  localWorkspaceId?: string;
  createdAt?: string;
};

export type CloudSessionContext = {
  syncEngineUrl: string;
  workspaceId: string;
  orgId: string;
  desktopSessionToken: string;
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

export function readCloudSessionContext(env: NodeJS.ProcessEnv = process.env): CloudSessionContext | null {
  const syncEngineUrl = env.ACRM_SYNC_ENGINE_URL?.trim() || DEFAULT_SYNC_ENGINE_URL;
  const workspaceId = env.ACRM_CLOUD_WORKSPACE_ID?.trim();
  const orgId = env.ACRM_CLOUD_ORG_ID?.trim();
  const desktopSessionToken = env.ACRM_DESKTOP_SESSION_TOKEN?.trim();
  if (!workspaceId || !orgId || !desktopSessionToken) return null;
  return {
    syncEngineUrl,
    workspaceId,
    orgId,
    desktopSessionToken,
  };
}

export function ensureCloudWorkspaceMetadata(
  db: AcrmDatabase,
  preferred: {
    workspaceId?: string;
    clientToken?: string;
    orgId?: string;
    localWorkspaceId?: string;
  } = {},
): Promise<{ workspaceId: string; clientToken: string; orgId?: string; localWorkspaceId?: string }> {
  return ensureCloudWorkspaceMetadataInDatabase(db, preferred);
}

export async function ensureCloudWorkspaceMetadataInDatabase(
  db: AcrmDatabase,
  preferred: {
    workspaceId?: string;
    clientToken?: string;
    orgId?: string;
    localWorkspaceId?: string;
  } = {},
  fallback: {
    workspaceId?: string;
    clientToken?: string;
    orgId?: string;
  } = {},
): Promise<{ workspaceId: string; clientToken: string; orgId?: string; localWorkspaceId?: string }> {
  return await db.transaction(async (tx) => {
    const existing = await readCloudMetadata(tx);
    const initial = {
      workspaceId: existing.workspaceId || preferred.workspaceId || fallback.workspaceId || randomUUID(),
      clientToken: existing.clientToken || preferred.clientToken || fallback.clientToken || randomUUID(),
      ...(preferred.orgId || existing.orgId || fallback.orgId
        ? { orgId: preferred.orgId || existing.orgId || fallback.orgId }
        : {}),
      ...(preferred.localWorkspaceId || existing.localWorkspaceId
        ? { localWorkspaceId: preferred.localWorkspaceId || existing.localWorkspaceId }
        : {}),
      createdAt: existing.createdAt ?? new Date().toISOString(),
    };

    await insertCloudMetadataBundleIfMissing(tx, initial);

    const canonical = await readCloudMetadata(tx);
    const workspaceId = canonical.workspaceId ?? initial.workspaceId;
    const clientToken = canonical.clientToken ?? initial.clientToken;
    const orgId = preferred.orgId || canonical.orgId || fallback.orgId;
    const nextLocalWorkspaceId = preferred.localWorkspaceId || canonical.localWorkspaceId;
    const createdAt = canonical.createdAt ?? initial.createdAt;

    await writeCloudMetadata(tx, {
      workspaceId,
      clientToken,
      ...(orgId ? { orgId } : {}),
      ...(nextLocalWorkspaceId ? { localWorkspaceId: nextLocalWorkspaceId } : {}),
      createdAt,
    });

    return {
      workspaceId,
      clientToken,
      ...(orgId ? { orgId } : {}),
      ...(nextLocalWorkspaceId ? { localWorkspaceId: nextLocalWorkspaceId } : {}),
    };
  });
}

export async function ensureCloudWorkspaceMetadataForWorkspace(
  workspacePath: string,
  preferred: { workspaceId?: string; clientToken?: string; orgId?: string } = {},
  options: { db?: AcrmDatabase; legacyMetadataDir?: string } = {},
): Promise<{ workspaceId: string; clientToken: string; orgId?: string; localWorkspaceId?: string }> {
  const workspace = options.db
    ? await Workspace.open({ db: options.db })
    : await Workspace.open(workspacePath);
  try {
    const legacy = options.legacyMetadataDir
      ? readLegacyCloudMetadata(options.legacyMetadataDir)
      : {};
    const localWorkspaceId = await ensureWorkspaceIdentity(workspace);
    return await ensureCloudWorkspaceMetadataInDatabase(databaseForWorkspace(workspace), {
      workspaceId: preferred.workspaceId,
      clientToken: preferred.clientToken,
      orgId: preferred.orgId,
      localWorkspaceId,
    }, legacy);
  } finally {
    await workspace.close();
  }
}

function databaseForWorkspace(workspace: Workspace): AcrmDatabase {
  return (workspace as unknown as { db: AcrmDatabase }).db;
}

async function readCloudMetadata(db: AcrmDatabase): Promise<CloudMetadata> {
  const keys = Object.values(CLOUD_METADATA_KEYS);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  const result = await db.execute(
    `SELECT key, value
     FROM acrm_metadata
     WHERE key IN (${placeholders})`,
    keys,
  );
  const values = new Map(result.rows.map((row) => [String(row.key), String(row.value)]));
  const legacy = metadataFromValues(values);
  const bundle = parseCloudMetadata(values.get(CLOUD_METADATA_KEYS.bundle));
  return {
    ...legacy,
    ...bundle,
  };
}

function metadataFromValues(values: Map<string, string>): CloudMetadata {
  return {
    ...(values.get(CLOUD_METADATA_KEYS.workspaceId) ? { workspaceId: values.get(CLOUD_METADATA_KEYS.workspaceId) } : {}),
    ...(values.get(CLOUD_METADATA_KEYS.clientToken) ? { clientToken: values.get(CLOUD_METADATA_KEYS.clientToken) } : {}),
    ...(values.get(CLOUD_METADATA_KEYS.orgId) ? { orgId: values.get(CLOUD_METADATA_KEYS.orgId) } : {}),
    ...(values.get(CLOUD_METADATA_KEYS.localWorkspaceId) ? { localWorkspaceId: values.get(CLOUD_METADATA_KEYS.localWorkspaceId) } : {}),
    ...(values.get(CLOUD_METADATA_KEYS.createdAt) ? { createdAt: values.get(CLOUD_METADATA_KEYS.createdAt) } : {}),
  };
}

async function insertCloudMetadataBundleIfMissing(
  db: AcrmDatabase,
  metadata: Required<Pick<CloudMetadata, "workspaceId" | "clientToken" | "createdAt">> & CloudMetadata,
): Promise<void> {
  await db.execute(
    `INSERT INTO acrm_metadata (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [CLOUD_METADATA_KEYS.bundle, serializeCloudMetadata(metadata)],
  );
}

async function writeCloudMetadata(db: AcrmDatabase, metadata: Required<Pick<CloudMetadata, "workspaceId" | "clientToken" | "createdAt">> & CloudMetadata): Promise<void> {
  await db.execute(
    `INSERT INTO acrm_metadata (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CLOUD_METADATA_KEYS.bundle, serializeCloudMetadata(metadata)],
  );

  const entries: Array<[string, string | undefined]> = [
    [CLOUD_METADATA_KEYS.workspaceId, metadata.workspaceId],
    [CLOUD_METADATA_KEYS.clientToken, metadata.clientToken],
    [CLOUD_METADATA_KEYS.orgId, metadata.orgId],
    [CLOUD_METADATA_KEYS.localWorkspaceId, metadata.localWorkspaceId],
    [CLOUD_METADATA_KEYS.createdAt, metadata.createdAt],
  ];
  for (const [key, value] of entries) {
    if (value == null) continue;
    await db.execute(
      `INSERT INTO acrm_metadata (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
}

function readLegacyCloudMetadata(metadataDir: string): CloudMetadata {
  try {
    return parseCloudMetadata(readFileSync(join(metadataDir, CLOUD_METADATA_FILENAME), "utf8"));
  } catch {
    return {};
  }
}

function serializeCloudMetadata(metadata: CloudMetadata): string {
  return JSON.stringify(metadata);
}

function parseCloudMetadata(value: string | undefined): CloudMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return cleanCloudMetadata(parsed);
  } catch {
    return {};
  }
}

function cleanCloudMetadata(parsed: Record<string, unknown>): CloudMetadata {
  return {
    ...(typeof parsed.workspaceId === "string" && parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    ...(typeof parsed.clientToken === "string" && parsed.clientToken ? { clientToken: parsed.clientToken } : {}),
    ...(typeof parsed.orgId === "string" && parsed.orgId ? { orgId: parsed.orgId } : {}),
    ...(typeof parsed.localWorkspaceId === "string" && parsed.localWorkspaceId ? { localWorkspaceId: parsed.localWorkspaceId } : {}),
    ...(typeof parsed.createdAt === "string" && parsed.createdAt ? { createdAt: parsed.createdAt } : {}),
  };
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

export async function createBrowserAuthHandoff(input: {
  syncEngineUrl: string;
  desktopSessionToken: string;
}): Promise<{ code: string; expires_at: string }> {
  const response = await fetch(new URL("/auth/browser-handoffs", input.syncEngineUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.desktopSessionToken}`,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; code?: unknown; expires_at?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true || typeof payload.code !== "string") {
    throw new AcrmError(
      "failed to create browser auth handoff",
      ERR.IMPORT,
      payloadError(payload) ?? `sync engine returned HTTP ${response.status}`,
    );
  }
  return {
    code: payload.code,
    expires_at: typeof payload.expires_at === "string" ? payload.expires_at : "",
  };
}

export function appendBrowserAuthHandoff(url: string, code: string): string {
  const parsed = new URL(url);
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  hash.set("auth_handoff", code);
  parsed.hash = hash.toString();
  return parsed.toString();
}

export async function fetchCloudCommunicationExport(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken?: string;
  sessionToken?: string;
  provider: "gmail" | "linkedin";
}): Promise<CommunicationImportBatch> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/${input.provider}/export`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${cloudAuthToken(input)}`,
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
  clientToken?: string;
  sessionToken?: string;
}): Promise<CloudIntegrationStatus> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/status`,
    input.syncEngineUrl,
  );
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${cloudAuthToken(input)}`,
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
  clientToken?: string;
  sessionToken?: string;
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
      authorization: `Bearer ${cloudAuthToken(input)}`,
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
  clientToken?: string;
  sessionToken?: string;
  scope?: CloudLinkedinMessageBackfillScope;
}): Promise<{ started: number; integration_account_ids: string[]; scoped?: boolean }> {
  const url = new URL(
    `/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/linkedin/messages/backfill`,
    input.syncEngineUrl,
  );
  const body = input.scope ? JSON.stringify({ scope: input.scope }) : undefined;
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${cloudAuthToken(input)}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
  };
  if (body) init.body = body;
  const response = await fetch(url.toString(), init);
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; started?: unknown; integration_account_ids?: unknown; scoped?: unknown; error?: unknown; code?: unknown }
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
    ...(typeof payload.scoped === "boolean" ? { scoped: payload.scoped } : {}),
  };
}

export type CloudLinkedinMessageBackfillScope = {
  providerPersonIds?: string[];
  linkedinUrls?: string[];
  publicIdentifiers?: string[];
};

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

function cloudAuthToken(input: { clientToken?: string; sessionToken?: string }): string {
  const token = input.sessionToken ?? input.clientToken;
  if (!token) {
    throw new AcrmError(
      "cloud workspace credentials are missing",
      ERR.INVALID_INPUT,
    );
  }
  return token;
}
