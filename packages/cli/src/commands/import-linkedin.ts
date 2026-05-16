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

type Opts = {
  refresh?: boolean;
  cache?: boolean; // commander negation: --no-cache → cache=false
};

export function attachLinkedinSubcommand(parent: Command): void {
  parent
    .command("linkedin <url-or-slug>")
    .description(
      "Import a person from a LinkedIn profile URL (or `/in/<slug>`). Use when the user shares a LinkedIn **profile** link (e.g. \"add this person\", \"import this LinkedIn\"). For a LinkedIn **post** URL instead, use `acrm import post`. Fetches the profile via Apify, upserts the person (deduped by linkedin_url), and creates/links their current employer as a company. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
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
        });
        const json: LinkedinImportResult = {
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
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean },
): Promise<LinkedinImportResult> {
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

  const ws = await Workspace.open(workspaceFile);
  try {
    return await importLinkedinProfile(ws, {
      urlOrSlug,
      token,
      cacheDir,
      refresh: opts.refresh,
      noCache: opts.noCache,
    });
  } finally {
    await ws.close();
  }
}
