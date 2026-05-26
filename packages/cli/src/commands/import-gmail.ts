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
};

export function attachGmailSubcommand(parent: Command): void {
  parent
    .command("gmail")
    .description(
      "Connect Gmail through Agent CRM's hosted sync engine. Opens hosted Google OAuth and syncs people, email threads, and email messages into the cloud workspace.",
    )
    .option("--no-open", "print the OAuth URL without opening it in a browser")
    .option("--org-id <org-id>", "Cluster organization id for hosted Gmail sync")
    .action(async (opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);

      try {
        const result = await runImportGmail({
          workspace: root?.workspace,
          orgId: opts.orgId,
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

async function runImportGmail(opts: { workspace?: string; orgId?: string }): Promise<{
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
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
    }),
    workspace_id: metadata.workspaceId,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
  };
}

function gmailConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clusterOrgId?: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/gmail/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  if (input.clusterOrgId) url.searchParams.set("cluster_org_id", input.clusterOrgId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
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
};
