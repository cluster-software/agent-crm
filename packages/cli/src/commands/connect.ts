import path from "node:path";
import type { Command } from "commander";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  DEFAULT_SYNC_ENGINE_URL,
  ensureCloudWorkspaceMetadata,
  registerCloudWorkspace,
} from "../lib/cloud-workspace.js";

type LinkedinConnectOpts = {
  orgId?: string;
};

export function registerConnect(program: Command): void {
  const connectCmd = getOrCreateConnectCommand(program);
  connectCmd
    .command("linkedin")
    .description("connect LinkedIn through Agent CRM's hosted sync engine")
    .option("--org-id <org-id>", "Cluster organization id for hosted LinkedIn sync")
    .action(async (opts: LinkedinConnectOpts) => {
      const root = program.opts() as { workspace?: string; json?: boolean };
      setJsonMode(root.json);
      try {
        const result = await runConnectLinkedin({
          workspace: root.workspace,
          orgId: opts.orgId,
        });
        if (!isJson()) {
          process.stdout.write(
            [
              "Open this URL to connect LinkedIn:",
              result.auth_url,
              "",
              "After login, LinkedIn sync runs in the background through Agent CRM's hosted sync engine.",
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

async function runConnectLinkedin(opts: { workspace?: string; orgId?: string }): Promise<{
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string | null;
  sync_engine_url: string;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = ensureCloudWorkspaceMetadata(workspaceDir, {
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
  return {
    auth_url: linkedinConnectUrl({
      syncEngineUrl,
      workspaceId: metadata.workspaceId,
      clusterOrgId: metadata.clusterOrgId,
      workspaceName: path.basename(workspaceDir),
    }),
    workspace_id: metadata.workspaceId,
    cluster_org_id: metadata.clusterOrgId ?? null,
    sync_engine_url: syncEngineUrl,
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

export const __test = {
  linkedinConnectUrl,
  runConnectLinkedin,
};
