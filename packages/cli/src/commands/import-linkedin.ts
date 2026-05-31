import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  importCommunicationBatch,
  importLinkedinRelations,
  importLinkedinProfile,
  normalizeLinkedinUrl,
  type AcrmDatabase,
  type CommunicationImportResult,
  type ImportLinkedinRelationsResult,
  type LinkedinImportResult,
  type LinkedinRelation,
} from "@agent-crm/sdk";
import { localWorkspaceDir, openResolvedWorkspace, resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import {
  DEFAULT_SYNC_ENGINE_URL,
  ensureCloudWorkspaceMetadataForWorkspace,
  fetchCloudCommunicationExport,
  fetchCloudLinkedinRelationsExport,
  startCloudLinkedinMessageBackfill,
} from "../lib/cloud-workspace.js";
import { type BackgroundSignalRun, startMissingSignalsForRecords } from "../signals.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean; // commander negation: --no-cache → cache=false
  signals?: boolean;
  sync?: boolean;
  cutoffDate?: string;
};

export function attachLinkedinSubcommand(parent: Command): void {
  parent
    .command("linkedin [url-or-slug]")
    .description(
      "With no URL, import existing LinkedIn contacts from the connected account. With a LinkedIn profile URL (or `/in/<slug>`), import one person locally via Apify. For a LinkedIn post URL instead, use `acrm import post`.",
    )
    .option("--sync", "pull LinkedIn messages from Agent CRM's hosted sync engine into this workspace")
    .option("--cutoff-date <YYYY-MM-DD>", "only import LinkedIn contacts connected on or after this date")
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
          if (opts.cutoffDate) {
            throw new AcrmError("--sync does not accept --cutoff-date", ERR.INVALID_INPUT);
          }
          const result = await runSyncLinkedin({
            workspace: root?.workspace,
          });
          ok(result);
          return;
        }
        if (!urlOrSlug) {
          const result = await runImportLinkedinNetwork({
            workspace: root?.workspace,
            cutoffDate: opts.cutoffDate,
          });
          ok(result);
          return;
        }
        if (opts.cutoffDate) {
          throw new AcrmError("--cutoff-date does not accept a LinkedIn profile URL", ERR.INVALID_INPUT);
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

async function runImportLinkedinNetwork(opts: { workspace?: string; db?: AcrmDatabase; cutoffDate?: string }): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  stats: ImportLinkedinRelationsResult["stats"];
  company_enrichment?: unknown;
  company_enrichment_warning?: string;
  message_backfill?: {
    started: number;
    integration_account_ids: string[];
    scoped?: boolean;
  };
  message_backfill_warning?: string;
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = localWorkspaceDir(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const { relations } = await fetchCloudLinkedinRelationsExport({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    cutoffDate: opts.cutoffDate,
  });
  const ws = await openResolvedWorkspace(workspaceFile, opts.db);
  try {
    const result = await importLinkedinRelations(ws, { relations });
    let stats = result.stats;
    let companyEnrichment: unknown;
    let companyEnrichmentWarning: string | undefined;
    let messageBackfill: { started: number; integration_account_ids: string[]; scoped?: boolean } | undefined;
    let messageBackfillWarning: string | undefined;
    if (relations.length > 0) {
      try {
        messageBackfill = await startCloudLinkedinMessageBackfill({
          syncEngineUrl,
          workspaceId: metadata.workspaceId,
          clientToken: metadata.clientToken,
          scope: linkedinMessageBackfillScope(relations),
        });
      } catch (error) {
        messageBackfillWarning = error instanceof Error ? error.message : String(error);
      }
      try {
        const enriched = await fetchCloudLinkedinRelationsExport({
          syncEngineUrl,
          workspaceId: metadata.workspaceId,
          clientToken: metadata.clientToken,
          cutoffDate: opts.cutoffDate,
          enrichCompanies: true,
        });
        companyEnrichment = enriched.company_enrichment;
        const enrichedResult = await importLinkedinRelations(ws, { relations: enriched.relations });
        stats = mergeLinkedinRelationStats(stats, enrichedResult.stats);
      } catch (error) {
        companyEnrichmentWarning = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      workspace_id: metadata.workspaceId,
      sync_engine_url: syncEngineUrl,
      stats,
      ...(companyEnrichment ? { company_enrichment: companyEnrichment } : {}),
      ...(companyEnrichmentWarning ? { company_enrichment_warning: companyEnrichmentWarning } : {}),
      ...(messageBackfill ? { message_backfill: messageBackfill } : {}),
      ...(messageBackfillWarning ? { message_backfill_warning: messageBackfillWarning } : {}),
    };
  } finally {
    await ws.close();
  }
}

function mergeLinkedinRelationStats(
  left: ImportLinkedinRelationsResult["stats"],
  right: ImportLinkedinRelationsResult["stats"],
): ImportLinkedinRelationsResult["stats"] {
  return {
    relations_seen: left.relations_seen,
    people_created: left.people_created + right.people_created,
    people_updated: left.people_updated + right.people_updated,
    companies_created: left.companies_created + right.companies_created,
    companies_updated: left.companies_updated + right.companies_updated,
    relations_skipped_no_key: left.relations_skipped_no_key,
  };
}

function linkedinMessageBackfillScope(relations: LinkedinRelation[]): {
  providerPersonIds?: string[];
  linkedinUrls?: string[];
  publicIdentifiers?: string[];
} | undefined {
  const providerPersonIds = uniqueStrings(relations.map((relation) => cleanString(relation.member_id)));
  const linkedinUrls = uniqueStrings(relations.map((relation) => {
    const explicit = cleanString(relation.public_profile_url);
    if (explicit) return normalizeLinkedinUrl(explicit) ?? explicit;
    const publicIdentifier = cleanString(relation.public_identifier);
    return publicIdentifier ? `linkedin.com/in/${publicIdentifier}` : null;
  }));
  const publicIdentifiers = uniqueStrings(relations.map((relation) => cleanString(relation.public_identifier)));
  if (!providerPersonIds.length && !linkedinUrls.length && !publicIdentifiers.length) return undefined;
  return {
    ...(providerPersonIds.length ? { providerPersonIds } : {}),
    ...(linkedinUrls.length ? { linkedinUrls } : {}),
    ...(publicIdentifiers.length ? { publicIdentifiers } : {}),
  };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text ? text : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function runSyncLinkedin(opts: { workspace?: string; db?: AcrmDatabase }): Promise<{
  workspace_id: string;
  sync_engine_url: string;
  stats: CommunicationImportResult["stats"];
}> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = localWorkspaceDir(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const metadata = await ensureCloudWorkspaceMetadataForWorkspace(workspaceFile, {
    workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
    clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
    clusterOrgId: process.env.ACRM_CLOUD_CLUSTER_ORG_ID,
  }, { db: opts.db });
  const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
  const batch = await fetchCloudCommunicationExport({
    syncEngineUrl,
    workspaceId: metadata.workspaceId,
    clientToken: metadata.clientToken,
    provider: "linkedin",
  });
  const ws = await openResolvedWorkspace(workspaceFile, opts.db);
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
  opts: { workspace?: string; db?: AcrmDatabase; refresh?: boolean; noCache?: boolean; noSignals?: boolean },
): Promise<LinkedinImportResult & { signals_background?: BackgroundSignalRun; signals_warning?: string }> {
  const workspaceFile = resolveWorkspacePath(opts.workspace);
  const workspaceDir = localWorkspaceDir(workspaceFile);
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
  const ws = await openResolvedWorkspace(workspaceFile, opts.db);
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

export const __test = {
  runImportLinkedinNetwork,
};
