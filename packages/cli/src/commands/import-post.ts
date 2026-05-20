import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importPost,
  normalizePostUrl,
  type PostImportResult,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { loadDotenv } from "../lib/dotenv.js";
import { type BackgroundSignalRun, startMissingSignalsForRecords } from "../signals.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean;
  signals?: boolean;
};

export function attachPostSubcommand(parent: Command): void {
  parent
    .command("post <url>")
    .description(
      "Import a LinkedIn or X post by URL. Use when the user shares a post link they want to track (e.g. \"import this post\", \"save this tweet\", \"add this person from their post\"). Auto-detects platform from the URL. Upserts the post author as a person (deduped by LinkedIn URL or X handle), creates a `posts` record (deduped by URL), and links them via `posts.author` + `people.associated_posts`. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .option("--no-signals", "skip local signals after importing records")
    .addHelpText(
      "after",
      `
Accepted URL formats:
  LinkedIn   https://www.linkedin.com/posts/<slug>_<activity-id>
             https://www.linkedin.com/feed/update/urn:li:activity:<id>/
  X / Twitter  https://x.com/<handle>/status/<id>
               https://twitter.com/<handle>/status/<id>

Examples:
  acrm import post https://x.com/jack/status/20
  acrm import post 'https://www.linkedin.com/feed/update/urn:li:activity:7458176780059897856/'

What gets written:
  people     author upserted (deduped by linkedin_url or twitter_url)
  companies  for LinkedIn posts only — author's current employer (deduped by name)
  posts      one record per unique post URL with: url, platform, author, posted_at, content

Re-running the same URL is safe — dedup keeps one post record and one author
record; cached Apify responses (14-day TTL in .cache/{linkedin,x}-posts/) make
repeat runs free.
`,
    )
    .action(async (url: string, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportPost(url, {
          workspace: root?.workspace,
          refresh: opts.refresh,
          noCache: opts.cache === false,
          noSignals: opts.signals === false,
        });
        ok({
          ...result,
          cache_paths: {
            post: result.cache_paths.post
              ? path.relative(process.cwd(), result.cache_paths.post)
              : null,
            profile: result.cache_paths.profile
              ? path.relative(process.cwd(), result.cache_paths.profile)
              : null,
          },
        });
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportPost(
  rawUrl: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean; noSignals?: boolean },
): Promise<PostImportResult & { signals_background?: BackgroundSignalRun; signals_warning?: string }> {
  const sniffed = normalizePostUrl(rawUrl);
  if (!sniffed) {
    throw new AcrmError(
      `unrecognized post URL: ${rawUrl} (expected linkedin.com, x.com, or twitter.com)`,
      ERR.INVALID_INPUT,
    );
  }
  const { platform } = sniffed;

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

  const postCacheDir = path.join(
    workspaceDir,
    ".cache",
    platform === "linkedin" ? "linkedin-posts" : "x-posts",
  );
  const profileCacheDir = path.join(
    workspaceDir,
    ".cache",
    platform === "linkedin" ? "linkedin" : "x",
  );

  let result: PostImportResult | null = null;
  let records: Array<{ object_slug: "people" | "companies"; record_id: string }> = [];
  const ws = await Workspace.open(workspaceFile);
  try {
    result = await importPost(ws, {
      rawUrl,
      token,
      postCacheDir,
      profileCacheDir,
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
  if (!result) throw new AcrmError("Post import did not return a result", ERR.UNHANDLED);
  if (opts.noSignals) return result;
  const signalRun = startMissingSignalsForRecords(workspaceFile, records);
  return {
    ...result,
    ...(signalRun?.background ? { signals_background: signalRun.background } : {}),
    ...(signalRun?.warning ? { signals_warning: signalRun.warning } : {}),
  };
}
