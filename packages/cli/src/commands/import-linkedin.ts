import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importLinkedinProfile,
  type LinkedinImportResult,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import { type BackgroundSignalRun, startMissingSignalsForRecords } from "../signals.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean; // commander negation: --no-cache → cache=false
  signals?: boolean;
};

export function attachLinkedinSubcommand(parent: Command): void {
  parent
    .command("linkedin <url-or-slug>")
    .description(
      "Import a person from a LinkedIn profile URL (or `/in/<slug>`). Use when the user shares a LinkedIn **profile** link (e.g. \"add this person\", \"import this LinkedIn\"). For a LinkedIn **post** URL instead, use `acrm import post`. Fetches the profile via Apify, upserts the person (deduped by linkedin_url), and creates/links their current employer as a company. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .option("--no-signals", "skip local signals after importing records")
    .action(async (urlOrSlug: string, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
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
