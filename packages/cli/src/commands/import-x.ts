import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importXProfile,
  type XImportResult,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean;
};

export function attachXSubcommand(parent: Command): void {
  parent
    .command("x <handle-or-url>")
    .description(
      "Import a person from an X/Twitter profile (`@handle`, `handle`, or `https://x.com/handle`). Use when the user shares an X **profile** (e.g. \"add @jack\", \"import this X profile\"). For an X **post/tweet** URL instead, use `acrm import post`. Fetches the profile via Apify, upserts the person (deduped by twitter_url normalized to x.com/<handle>). If the bio contains role/company info, returns a `needs_enrichment` payload — trigger the `enrich-x-bio` skill on it. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .action(async (handleOrUrl: string, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportX(handleOrUrl, {
          workspace: root?.workspace,
          refresh: opts.refresh,
          noCache: opts.cache === false,
        });
        ok({
          ...result,
          cache_path: result.cache_path
            ? path.relative(process.cwd(), result.cache_path)
            : null,
        });
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportX(
  handleOrUrl: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean },
): Promise<XImportResult> {
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

  const cacheDir = path.join(workspaceDir, ".cache", "x");

  const ws = await Workspace.open(workspaceFile);
  try {
    return await importXProfile(ws, {
      handleOrUrl,
      token,
      cacheDir,
      refresh: opts.refresh,
      noCache: opts.noCache,
    });
  } finally {
    await ws.close();
  }
}
