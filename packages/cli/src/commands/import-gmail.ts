import type { Command } from "commander";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  DEFAULT_SYNC_ENGINE_URL,
  ensureCloudWorkspaceMetadataForWorkspace,
  registerCloudWorkspace,
} from "../lib/cloud-workspace.js";

type Opts = {
  open?: boolean;
  orgId?: string;
  backfillDays?: string;
  backfillSince?: string;
  excludeNewsletters?: boolean;
  includeNewsletters?: boolean;
};

type GmailSyncPreferences = {
  backfillDays?: 30 | 90;
  backfillSince?: string;
  excludeNewsletters?: boolean;
};

export function attachGmailSubcommand(parent: Command): void {
  parent
    .command("gmail")
    .description(
      "Connect Gmail through Agent CRM's hosted sync engine. Opens hosted Google OAuth and syncs people, email threads, and email messages into the cloud workspace.",
    )
    .option("--no-open", "print the OAuth URL without opening the browser")
    .option("--org-id <org-id>", "Cluster organization id for hosted Gmail sync")
    .option("--backfill-days <days>", "Gmail backfill window in days. Supported values: 30, 90")
    .option("--backfill-since <YYYY-MM-DD>", "Gmail backfill start date")
    .option("--exclude-newsletters", "filter newsletters and marketing emails out of the Gmail sync")
    .option("--include-newsletters", "include newsletters and marketing emails in the Gmail sync")
    .action(async (opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);

      try {
        const preferences = parseGmailSyncPreferences(opts);
        const result = await runImportGmail({
          workspace: root?.workspace,
          orgId: opts.orgId,
          ...preferences,
        });

        if (opts.open !== false) openInBrowser(result.auth_url);

        if (!isJson()) {
          process.stdout.write(
            [
              opts.open === false
                ? "Open this URL to connect Gmail:"
                : "Opening browser to connect Gmail. If it doesn't open, paste this URL:",
              result.auth_url,
              "",
              "After OAuth, Gmail sync runs in the background through Agent CRM's hosted sync engine.",
              "",
            ].join("\n")
          );
          return;
        }

        ok(result);
      } catch (error) {
        if (error instanceof AcrmError) fail(error.message, error.code, error.hint);
        else fail(error instanceof Error ? error.message : String(error), ERR.IMPORT);
        process.exit(1);
      }
    });
}

async function runImportGmail(opts: { workspace?: string; orgId?: string } & GmailSyncPreferences): Promise<{
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
  gmail_sync_preferences?: GmailSyncPreferences;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = dirname(workspaceFile);
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
    workspaceName: basename(workspaceDir),
  });
  return {
    auth_url: gmailConnectUrl({
      syncEngineUrl,
      workspaceId: metadata.workspaceId,
      clusterOrgId: metadata.clusterOrgId,
      workspaceName: basename(workspaceDir),
      backfillDays: opts.backfillDays,
      backfillSince: opts.backfillSince,
      excludeNewsletters: opts.excludeNewsletters,
    }),
    workspace_id: metadata.workspaceId,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
    ...(hasGmailSyncPreferences(opts)
      ? {
          gmail_sync_preferences: {
            ...(opts.backfillDays ? { backfillDays: opts.backfillDays } : {}),
            ...(opts.backfillSince ? { backfillSince: opts.backfillSince } : {}),
            ...(opts.excludeNewsletters != null ? { excludeNewsletters: opts.excludeNewsletters } : {}),
          },
        }
      : {}),
  };
}

function gmailConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clusterOrgId?: string;
  workspaceName: string;
  backfillDays?: 30 | 90;
  backfillSince?: string;
  excludeNewsletters?: boolean;
}): string {
  const url = new URL("/integrations/gmail/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  if (input.clusterOrgId) url.searchParams.set("cluster_org_id", input.clusterOrgId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  if (input.backfillDays) url.searchParams.set("backfill_days", String(input.backfillDays));
  if (input.backfillSince) url.searchParams.set("backfill_since", input.backfillSince);
  if (input.excludeNewsletters != null) {
    url.searchParams.set("exclude_newsletters", String(input.excludeNewsletters));
  }
  return url.toString();
}

function parseGmailSyncPreferences(opts: Opts): GmailSyncPreferences {
  if (opts.backfillDays && opts.backfillSince) {
    throw new AcrmError(
      "--backfill-days and --backfill-since cannot be used together",
      ERR.INVALID_INPUT,
    );
  }
  if (opts.excludeNewsletters && opts.includeNewsletters) {
    throw new AcrmError(
      "--exclude-newsletters and --include-newsletters cannot be used together",
      ERR.INVALID_INPUT,
    );
  }

  return {
    ...(opts.backfillDays ? { backfillDays: parseBackfillDays(opts.backfillDays) } : {}),
    ...(opts.backfillSince ? { backfillSince: parseBackfillSince(opts.backfillSince) } : {}),
    ...(opts.excludeNewsletters
      ? { excludeNewsletters: true }
      : opts.includeNewsletters
        ? { excludeNewsletters: false }
        : {}),
  };
}

function parseBackfillDays(value: string): 30 | 90 {
  const days = Number(value);
  if (days === 30 || days === 90) return days;
  throw new AcrmError(
    "--backfill-days must be 30 or 90",
    ERR.INVALID_INPUT,
  );
}

function parseBackfillSince(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new AcrmError(
      "--backfill-since must use YYYY-MM-DD format",
      ERR.INVALID_INPUT,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AcrmError(
      "--backfill-since must be a valid calendar date",
      ERR.INVALID_INPUT,
    );
  }

  return trimmed;
}

function hasGmailSyncPreferences(opts: GmailSyncPreferences): boolean {
  return Boolean(opts.backfillDays || opts.backfillSince || opts.excludeNewsletters != null);
}

function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function openInBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL remains the fallback when the shell cannot open a browser.
  }
}

export const __test = {
  runImportGmail,
  browserOpenCommand,
  gmailConnectUrl,
  parseGmailSyncPreferences,
};
