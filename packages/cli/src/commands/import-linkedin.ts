import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importCommunicationBatch,
  importLinkedinProfile,
  type CommunicationImportResult,
  type LinkedinImportResult,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  DEFAULT_SYNC_ENGINE_URL,
  ensureCloudWorkspaceMetadata,
  fetchCloudCommunicationExport,
  registerCloudWorkspace,
} from "../lib/cloud-workspace.js";
import { type BackgroundSignalRun, startMissingSignalsForRecords } from "../signals.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean; // commander negation: --no-cache → cache=false
  signals?: boolean;
  orgId?: string;
  sync?: boolean;
};

export function attachLinkedinSubcommand(parent: Command): void {
  parent
    .command("linkedin [url-or-slug]")
    .description(
      "With no URL, connect LinkedIn through Agent CRM's hosted sync engine. With a LinkedIn profile URL (or `/in/<slug>`), import one person locally via Apify. For a LinkedIn post URL instead, use `acrm import post`.",
    )
    .option("--org-id <org-id>", "Cluster organization id for hosted LinkedIn sync")
    .option("--sync", "pull LinkedIn messages from Agent CRM's hosted sync engine into this workspace")
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .option("--no-signals", "skip local signals after importing records")
    .action(async (urlOrSlug: string | undefined, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        if (opts.sync) {
          if (urlOrSlug) {
            throw new AcrmError("--sync does not accept a LinkedIn profile URL", ERR.INVALID_INPUT);
          }
          const result = await runSyncLinkedin({
            workspace: root?.workspace,
          });
          ok(result);
          return;
        }
        if (!urlOrSlug) {
          const result = await runConnectLinkedin({
            workspace: root?.workspace,
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
          return;
        }
        const result = await runImportLinkedin(urlOrSlug, {
          workspace: root?.workspace,
          refresh: opts.refresh,
          noCache: opts.cache === false,
          noSignals: opts.signals === false,
        });
        const json: LinkedinImportResult & {
          signals_background?: BackgroundSignalRun;
          signals_warning?: string;
        } = {
          ...result,
          cache_path: result.cache_path
            ? path.relative(process.cwd(), result.cache_path)
            : null,
        };
        ok(json);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runConnectLinkedin(opts: { workspace?: string; orgId?: string }): Promise<{
  auth_url: string;
  workspace_id: string;
  cluster_org_id: string;
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
  if (!metadata.clusterOrgId) {
    throw new AcrmError(
      "Cluster organization is not configured",
      ERR.INVALID_INPUT,
      "pass --org-id <cluster-org-id> once or set ACRM_CLOUD_CLUSTER_ORG_ID",
    );
  }
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
    cluster_org_id: metadata.clusterOrgId,
    sync_engine_url: syncEngineUrl,
  };
}

async function runSyncLinkedin(opts: { workspace?: string }): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  stats: CommunicationImportResult["stats"];
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = ensureCloudWorkspaceMetadata(workspaceDir, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const batch = await fetchCloudCommunicationExport({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    provider: "linkedin",
  });
  const ws = await Workspace.open(workspaceFile);
  try {
    const result = await importCommunicationBatch(ws, batch);
    return {
      workspace_id: metadata.workspaceId,
      sync_engine_url: syncEngineUrl,
      stats: result.stats,
    };
  } finally {
    await ws.close();
  }
}

async function runImportLinkedin(
  urlOrSlug: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean; noSignals?: boolean },
): Promise<LinkedinImportResult & { signals_background?: BackgroundSignalRun; signals_warning?: string }> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    const envFile = path.join(workspaceDir, ".env");
    throw new AcrmError(
      "APIFY_API_TOKEN is not set",
      ERR.INVALID_INPUT,
      `create a .env file at ${envFile} containing:\n  APIFY_API_TOKEN=<your-apify-token>\n(or export APIFY_API_TOKEN in your shell)`,
    );
  }

  const cacheDir = path.join(workspaceDir, ".cache", "linkedin");

  let result: LinkedinImportResult | null = null;
  const ws = await Workspace.open(workspaceFile);
  let records: Array<{ object_slug: "people" | "companies"; record_id: string }> = [];
  try {
    result = await importLinkedinProfile(ws, {
      urlOrSlug,
      token,
      cacheDir,
      refresh: opts.refresh,
      noCache: opts.noCache,
    });
    if (!opts.noSignals) {
      records = [
        { object_slug: "people" as const, record_id: result.person_record_id },
        ...(result.company_record_id
          ? [{ object_slug: "companies" as const, record_id: result.company_record_id }]
          : []),
      ];
    }
  } finally {
    await ws.close();
  }
  if (!result) throw new AcrmError("LinkedIn import did not return a result", ERR.UNHANDLED);
  if (opts.noSignals) return result;
  const signalRun = startMissingSignalsForRecords(workspaceFile, records);
  return {
    ...result,
    ...(signalRun?.background ? { signals_background: signalRun.background } : {}),
    ...(signalRun?.warning ? { signals_warning: signalRun.warning } : {}),
  };
}

function linkedinConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clusterOrgId: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/linkedin/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("cluster_org_id", input.clusterOrgId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

export const __test = {
  linkedinConnectUrl,
};
