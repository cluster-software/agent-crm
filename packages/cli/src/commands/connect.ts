import path from "node:path";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  type CloudIntegrationProviderStatus,
  DEFAULT_SYNC_ENGINE_URL,
  connectCloudGranola,
  ensureCloudWorkspaceMetadataForWorkspace,
  fetchCloudIntegrationStatus,
  registerCloudWorkspace,
} from "../lib/cloud-workspace.js";

type LinkedinConnectOpts = {
  orgId?: string;
  status?: boolean;
};

type GranolaConnectOpts = {
  apiKey?: string;
  apiKeyStdin?: boolean;
  cutoffDate?: string;
  open?: boolean;
  status?: boolean;
};

export function registerConnect(program: Command): void {
  const connectCmd = getOrCreateConnectCommand(program);
  connectCmd
    .command("linkedin")
    .description("connect LinkedIn through Agent CRM's hosted sync engine")
    .option("--org-id <org-id>", "Cluster organization id for hosted LinkedIn sync")
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
            process.stdout.write(
              [
                "Open this URL to connect LinkedIn:",
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
    .description("connect external accounts to this .acrm workspace");
}

type LinkedinConnectResult = {
  connected: false;
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
} | {
  connected: true;
  message: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
};

async function runConnectLinkedin(opts: { workspace?: string; orgId?: string }): Promise<LinkedinConnectResult> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: opts.orgId ?? process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  await registerCloudWorkspace({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName: path.basename(workspaceDir),
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
      clusterOrgId: metadata.clusterOrgId,
      workspaceName: path.basename(workspaceDir),
    }),
    workspace_id: metadata.workspaceId,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
    linkedin,
  };
}

async function runConnectLinkedinStatus(opts: { workspace?: string }): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  linkedin: CliProviderStatus;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const status = await fetchCloudIntegrationStatus({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
  });
  return {
    workspace_id: metadata.workspaceId,
    sync_engine_url: syncEngineUrl,
    linkedin: toCliProviderStatus(status.linkedin, {
      requireActiveAccount: true,
    }),
  };
}

function linkedinConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clusterOrgId?: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/linkedin/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  if (input.clusterOrgId) url.searchParams.set("cluster_org_id", input.clusterOrgId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

async function runConnectGranola(opts: {
  workspace?: string;
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
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
  });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  await registerCloudWorkspace({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName: path.basename(workspaceDir),
  });
  const apiKey = opts.apiKeyStdin ? await readStdinSecret() : opts.apiKey;
  const auth_url = granolaConnectUrl({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    workspaceName: path.basename(workspaceDir),
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

async function runConnectGranolaStatus(opts: { workspace?: string }): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  granola: CliProviderStatus;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  });
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
  accounts?: Array<{
    id: string;
    provider_account_id: string;
    account_email?: string;
    display_name?: string;
    status: string;
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
    ...(account.lastSyncedAt ? { last_synced_at: account.lastSyncedAt } : {}),
  }));
  const hasActiveAccount = accounts?.some((account) => account.status === "active") ?? false;
  return {
    connected: options.requireActiveAccount && accounts
      ? hasActiveAccount
      : provider.connected,
    ...(provider.accountEmail ? { account_email: provider.accountEmail } : {}),
    ...(provider.displayName ? { display_name: provider.displayName } : {}),
    ...(provider.providerAccountId ? { provider_account_id: provider.providerAccountId } : {}),
    ...(provider.lastSyncedAt ? { last_synced_at: provider.lastSyncedAt } : {}),
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
