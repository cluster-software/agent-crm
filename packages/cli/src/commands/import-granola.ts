import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  importTranscript,
  type AcrmDatabase,
  type TranscriptImportResult,
} from "@agent-crm/sdk";
import { localWorkspaceDir, openResolvedWorkspace, resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  DEFAULT_SYNC_ENGINE_URL,
  ensureCloudWorkspaceMetadataForWorkspace,
  fetchCloudGranolaTranscriptsExport,
  startCloudGranolaBackfill,
} from "../lib/cloud-workspace.js";

type Opts = {
  cutoffDate?: string;
  backfill?: boolean; // commander negation: --no-backfill -> backfill=false
};

export function attachGranolaSubcommand(parent: Command): void {
  parent
    .command("granola")
    .description("Import Granola transcripts synced by Agent CRM's hosted sync engine")
    .option("--cutoff-date <YYYY-MM-DD>", "only import Granola notes created on or after this date")
    .option("--no-backfill", "do not ask the sync engine to start a fresh Granola backfill first")
    .action(async (opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportGranola({
          workspace: root?.workspace,
          cutoffDate: opts.cutoffDate,
          startBackfill: opts.backfill !== false,
        });
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportGranola(opts: {
  workspace?: string;
  db?: AcrmDatabase;
  cutoffDate?: string;
  startBackfill?: boolean;
}): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  transcripts_seen: number;
  transcripts_created: number;
  transcripts_updated: number;
  participants_created: number;
  backfill?: {
    started: number;
    integration_account_ids: string[];
  };
  backfill_warning?: string;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = localWorkspaceDir(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_ORG_ID ?? process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  let backfill: { started: number; integration_account_ids: string[] } | undefined;
  let backfillWarning: string | undefined;
  if (opts.startBackfill) {
    try {
      backfill = await startCloudGranolaBackfill({
        syncEngineUrl,
        workspaceId: metadata.workspaceId,
        clientToken: metadata.clientToken,
        cutoffDate: opts.cutoffDate,
      });
    } catch (error) {
      backfillWarning = error instanceof Error ? error.message : String(error);
    }
  }

  const { transcripts } = await fetchCloudGranolaTranscriptsExport({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    cutoffDate: opts.cutoffDate,
  });
  const ws = await openResolvedWorkspace(workspaceFile, opts.db);
  try {
    const results: TranscriptImportResult[] = [];
    for (const transcript of transcripts) {
      results.push(await importTranscript(ws, transcript));
    }
    return {
      workspace_id: metadata.workspaceId,
      sync_engine_url: syncEngineUrl,
      transcripts_seen: transcripts.length,
      transcripts_created: results.filter((result) => result.created).length,
      transcripts_updated: results.filter((result) => !result.created).length,
      participants_created: results.reduce(
        (sum, result) => sum + result.participants.resolved.filter((participant) => participant.created).length,
        0,
      ),
      ...(backfill ? { backfill } : {}),
      ...(backfillWarning ? { backfill_warning: backfillWarning } : {}),
    };
  } finally {
    await ws.close();
  }
}

export const __test = {
  runImportGranola,
};
