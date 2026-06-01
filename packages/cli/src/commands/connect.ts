import { spawn } from "node:child_process";
import type { Command } from "commander";
import { AcrmError, ERR, type AcrmDatabase } from "@agent-crm/sdk";
import { resolveWorkspacePath, workspaceDisplayName } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import {
  type CloudIntegrationProviderStatus,
  DEFAULT_SYNC_ENGINE_URL,
  appendBrowserAuthHandoff,
  connectCloudGranola,
  createBrowserAuthHandoff,
  ensureCloudWorkspaceMetadataForWorkspace,
  fetchCloudIntegrationStatus,
  readCloudSessionContext,
  registerCloudWorkspace,
} from "../lib/cloud-workspace.js";

const CONNECTED_PROVIDER_ACCOUNT_STATUSES = new Set([
  "active",
  "creation_success",
  "ok",
  "reconnected",
  "sync_success",
]);

type LinkedinConnectOpts = {
  orgId?: string;
  open?: boolean;
  status?: boolean;
};

type GranolaConnectOpts = {
  apiKey?: string;
  apiKeyStdin?: boolean;
  cutoffDate?: string;
  open?: boolean;
  status?: boolean;
};

type CommandWorkspaceOpts = {
  workspace?: string;
  db?: AcrmDatabase;
  workspaceName?: string;
};

export function registerConnect(program: Command): void {
  const connectCmd = getOrCreateConnectCommand(program);
  connectCmd
    .command("linkedin")
    .description("connect LinkedIn through Agent CRM's hosted sync engine")
    .option("--org-id <org-id>", "organization id for hosted LinkedIn sync")
    .option("--no-open", "print the hosted connect URL without opening it in a browser")
    .option("--status", "show LinkedIn connection status without starting a new connect flow")
    .action(async (opts: LinkedinConnectOpts) => {
      const root = program.opts() as { workspace?: string; json?: boolean };
      setJsonMode(root.json);
      try {
        if (opts.status) {
          const result = await runConnectLinkedinStatus({
            workspace: root.workspace,
          });
          if (!isJson()) {
            process.stdout.write(linkedinStatusMessage(result.linkedin));
            return;
          }
          ok(result);
          return;
        }
        const result = await runConnectLinkedin({
          workspace: root.workspace,
          orgId: opts.orgId,
        });
        if (!isJson()) {
          if (result.connected) {
            process.stdout.write(`${result.message}\n`);
          } else {
            if (opts.open !== false) openInBrowser(result.auth_url);
            process.stdout.write(
              [
                opts.open === false
                  ? "Open this URL to connect LinkedIn:"
                  : "Opening browser to connect LinkedIn. If it doesn't open, paste this URL:",
                result.auth_url,
                "",
                "After login, LinkedIn sync runs in the background through Agent CRM's hosted sync engine.",
                "",
              ].join("\n")
            );
          }
          return;
        }
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });

  connectCmd
    .command("granola")
    .description("connect Granola through Agent CRM's hosted sync engine")
    .option("--api-key <api-key>", "connect by sending this Granola API key to the hosted sync engine")
    .option("--api-key-stdin", "read the Granola API key from stdin")
    .option("--cutoff-date <YYYY-MM-DD>", "only backfill Granola notes created on or after this date")
    .option("--no-open", "print the hosted connect URL without opening it in a browser")
    .option("--status", "show Granola connection status without starting a new connect flow")
    .action(async (opts: GranolaConnectOpts) => {
      const root = program.opts() as { workspace?: string; json?: boolean };
      setJsonMode(root.json);
      try {
        if (opts.status) {
          const result = await runConnectGranolaStatus({
            workspace: root.workspace,
          });
          if (!isJson()) {
            process.stdout.write(granolaStatusMessage(result.granola));
            return;
          }
          ok(result);
          return;
        }
        const result = await runConnectGranola({
          workspace: root.workspace,
          apiKey: opts.apiKey,
          apiKeyStdin: opts.apiKeyStdin,
          cutoffDate: opts.cutoffDate,
        });
        if (!isJson()) {
          if (result.connected) {
            process.stdout.write("Granola is connected. Backfill is running in the background.\n");
            return;
          }
          if (opts.open !== false) openInBrowser(result.auth_url);
          process.stdout.write(
            [
              opts.open === false
                ? "Open this URL to connect Granola:"
                : "Opening browser to connect Granola. If it doesn't open, paste this URL:",
              result.auth_url,
              "",
              "Create a Granola API key with Personal notes and Public notes access, then paste it on that page.",
              "",
            ].join("\n")
          );
          return;
        }
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

function getOrCreateConnectCommand(program: Command): Command {
  const existing = program.commands.find((c) => c.name() === "connect");
  if (existing) return existing;
  return program
    .command("connect")
    .description("connect external accounts to this Postgres workspace");
}

type LinkedinConnectResult = {
  connected: false;
  auth_url: string;
  workspace_id: string;
  org_id: string | null;
  cluster_org_id: string | null;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
} | {
  connected: true;
  message: string;
  workspace_id: string;
  org_id: string | null;
  cluster_org_id: string | null;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
};

async function runConnectLinkedin(opts: CommandWorkspaceOpts & { orgId?: string }): Promise<LinkedinConnectResult> {
  const workspaceName = workspaceDisplayName(opts.workspaceName);
  const cloudSession = readCloudSessionContext();
  if (cloudSession) {
    const orgId = cloudSessionOrgId(cloudSession.orgId, opts.orgId);
    const status = await fetchCloudIntegrationStatus({
      syncEngineUrl: cloudSession.syncEngineUrl,
      workspaceId: cloudSession.workspaceId,
      sessionToken: cloudSession.desktopSessionToken,
    });
    const linkedin = toCliProviderStatus(status.linkedin, {
      requireActiveAccount: true,
    });
    if (linkedin.connected) {
      return {
        connected: true,
        message: linkedinAlreadyConnectedMessage(linkedin),
        workspace_id: cloudSession.workspaceId,
        org_id: orgId,
        cluster_org_id: orgId,
        sync_engine_url: cloudSession.syncEngineUrl,
        linkedin,
      };
    }
    const handoff = await createBrowserAuthHandoff({
      syncEngineUrl: cloudSession.syncEngineUrl,
      desktopSessionToken: cloudSession.desktopSessionToken,
    });
    return {
      connected: false,
      auth_url: appendBrowserAuthHandoff(linkedinConnectUrl({
        syncEngineUrl: cloudSession.syncEngineUrl,
        workspaceId: cloudSession.workspaceId,
        orgId,
        workspaceName,
      }), handoff.code),
      workspace_id: cloudSession.workspaceId,
      org_id: orgId,
      cluster_org_id: orgId,
      sync_engine_url: cloudSession.syncEngineUrl,
      linkedin,
    };
  }

  const workspaceFile = resolveWorkspacePath(opts.workspace);

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: opts.orgId ?? process.env.ACRM_CLOUD_ORG_ID ?? process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  await registerCloudWorkspace({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName,
  });
  const status = await fetchCloudIntegrationStatus({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
  });
  const linkedin = toCliProviderStatus(status.linkedin, {
    requireActiveAccount: true,
  });
  if (linkedin.connected) {
    return {
      connected: true,
      message: linkedinAlreadyConnectedMessage(linkedin),
      workspace_id: metadata.workspaceId,
      org_id: metadata.clusterOrgId ?? null,
      cluster_org_id: metadata.clusterOrgId ?? null,
      sync_engine_url: syncEngineUrl,
      linkedin,
    };
  }
  return {
    connected: false,
    auth_url: linkedinConnectUrl({
      syncEngineUrl,
      workspaceId: metadata.workspaceId,
      orgId: metadata.clusterOrgId,
      workspaceName,
    }),
    workspace_id: metadata.workspaceId,
    org_id: metadata.clusterOrgId ?? null,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
    linkedin,
  };
}

function cloudSessionOrgId(sessionOrgId: string, requestedOrgId?: string): string {
  if (requestedOrgId && requestedOrgId !== sessionOrgId) {
    throw new AcrmError(
      `--org-id ${requestedOrgId} does not match the active desktop session org ${sessionOrgId}`,
      ERR.INVALID_INPUT,
    );
  }
  return sessionOrgId;
}

async function runConnectLinkedinStatus(opts: CommandWorkspaceOpts): Promise<{
  workspace_id: string;
  org_id?: string | null;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
}> {
  const cloudSession = readCloudSessionContext();
  if (cloudSession) {
    const status = await fetchCloudIntegrationStatus({
      syncEngineUrl: cloudSession.syncEngineUrl,
      workspaceId: cloudSession.workspaceId,
      sessionToken: cloudSession.desktopSessionToken,
    });
    return {
      workspace_id: cloudSession.workspaceId,
      org_id: cloudSession.orgId,
      sync_engine_url: cloudSession.syncEngineUrl,
      linkedin: toCliProviderStatus(status.linkedin, {
        requireActiveAccount: true,
      }),
    };
  }

  const workspaceFile = resolveWorkspacePath(opts.workspace);

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_ORG_ID ?? process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const status = await fetchCloudIntegrationStatus({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
  });
  return {
    workspace_id: metadata.workspaceId,
    org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
    linkedin: toCliProviderStatus(status.linkedin, {
      requireActiveAccount: true,
    }),
  };
}

function linkedinConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  orgId?: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/linkedin/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  if (input.orgId) url.searchParams.set("org_id", input.orgId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

async function runConnectGranola(opts: {
  workspace?: string;
  db?: AcrmDatabase;
  workspaceName?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  cutoffDate?: string;
}): Promise<{
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
  connected: boolean;
  account?: unknown;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceName = workspaceDisplayName(opts.workspaceName);

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  await registerCloudWorkspace({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName,
  });
  const apiKey = opts.apiKeyStdin ? await readStdinSecret() : opts.apiKey;
  const auth_url = granolaConnectUrl({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName,
  });
  if (!apiKey) {
    return {
      auth_url,
      workspace_id: metadata.workspaceId,
      cluster_org_id: metadata.clusterOrgId ?? null,
      sync_engine_url: syncEngineUrl,
      connected: false,
    };
  }
  const connected = await connectCloudGranola({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    apiKey,
    cutoffDate: opts.cutoffDate,
  });
  return {
    auth_url,
    workspace_id: metadata.workspaceId,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
    connected: true,
    account: connected.account,
  };
}

async function runConnectGranolaStatus(opts: CommandWorkspaceOpts): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  granola: CliProviderStatus;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_ORG_ID ?? process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const status = await fetchCloudIntegrationStatus({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
  });
  return {
    workspace_id: metadata.workspaceId,
    sync_engine_url: syncEngineUrl,
    granola: toCliProviderStatus(status.granola),
  };
}

function granolaConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/granola/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("client_token", input.clientToken);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

type CliProviderStatus = {
  connected: boolean;
  account_email?: string;
  display_name?: string;
  provider_account_id?: string;
  last_synced_at?: string;
  sync?: Record<string, unknown>;
  accounts?: Array<{
    id: string;
    provider_account_id: string;
    account_email?: string;
    display_name?: string;
    status: string;
    provider_status?: string;
    sync_status?: string;
    last_synced_at?: string;
  }>;
};

function toCliProviderStatus(
  provider: CloudIntegrationProviderStatus,
  options: { requireActiveAccount?: boolean } = {},
): CliProviderStatus {
  const accounts = provider.accounts?.map((account) => ({
    id: account.id,
    provider_account_id: account.providerAccountId,
    ...(account.accountEmail ? { account_email: account.accountEmail } : {}),
    ...(account.displayName ? { display_name: account.displayName } : {}),
    status: account.status,
    ...(account.providerStatus ? { provider_status: account.providerStatus } : {}),
    ...(account.syncStatus ? { sync_status: account.syncStatus } : {}),
    ...(account.lastSyncedAt ? { last_synced_at: account.lastSyncedAt } : {}),
  }));
  const hasConnectedAccount = accounts?.some((account) => {
    const status = (account.provider_status ?? account.status).toLowerCase();
    return CONNECTED_PROVIDER_ACCOUNT_STATUSES.has(status);
  }) ?? false;
  return {
    connected: options.requireActiveAccount && accounts
      ? hasConnectedAccount
      : provider.connected,
    ...(provider.accountEmail ? { account_email: provider.accountEmail } : {}),
    ...(provider.displayName ? { display_name: provider.displayName } : {}),
    ...(provider.providerAccountId ? { provider_account_id: provider.providerAccountId } : {}),
    ...(provider.lastSyncedAt ? { last_synced_at: provider.lastSyncedAt } : {}),
    ...(provider.sync ? { sync: provider.sync } : {}),
    ...(accounts && accounts.length > 0 ? { accounts } : {}),
  };
}

function linkedinStatusMessage(status: CliProviderStatus): string {
  if (!status.connected) return "LinkedIn is not connected yet.\n";
  const label = status.display_name ?? status.account_email ?? status.provider_account_id;
  return label ? `LinkedIn is connected: ${label}\n` : "LinkedIn is connected.\n";
}

function linkedinAlreadyConnectedMessage(status: CliProviderStatus): string {
  const label = status.display_name ?? status.account_email ?? status.provider_account_id;
  return label
    ? `This workspace is already connected with LinkedIn: ${label}`
    : "This workspace is already connected with LinkedIn.";
}

function granolaStatusMessage(status: CliProviderStatus): string {
  if (!status.connected) return "Granola is not connected yet.\n";
  const label = status.display_name ?? status.account_email ?? status.provider_account_id;
  return label ? `Granola is connected: ${label}\n` : "Granola is connected.\n";
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed URL remains the fallback.
  }
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export const __test = {
  linkedinConnectUrl,
  granolaConnectUrl,
  runConnectLinkedin,
  runConnectLinkedinStatus,
  runConnectGranola,
  runConnectGranolaStatus,
  toCliProviderStatus,
};
