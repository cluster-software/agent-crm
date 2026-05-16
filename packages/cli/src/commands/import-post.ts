import path from "node:path";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "@agent-crm/sdk";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { loadDotenv } from "../lib/dotenv.js";
import { normalizePostUrl, type PostPlatform } from "@agent-crm/sdk";
import { exec } from "@agent-crm/sdk";
import {
  addMultiValue,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "@agent-crm/sdk";
import {
  extractLinkedinPostId,
  extractXPostId,
  loadLinkedinPost,
  loadXPost,
} from "@agent-crm/sdk";
import { mapLinkedinPost, mapXPost, type MappedPost } from "@agent-crm/sdk";
import { importLinkedinProfile } from "./import-linkedin.js";
import { importXProfile } from "./import-x.js";

type Opts = {
  refresh?: boolean;
  cache?: boolean;
};

export function attachPostSubcommand(parent: Command): void {
  parent
    .command("post <url>")
    .description(
      "Import a LinkedIn or X post by URL. Use when the user shares a post link they want to track (e.g. \"import this post\", \"save this tweet\", \"add this person from their post\"). Auto-detects platform from the URL. Upserts the post author as a person (deduped by LinkedIn URL or X handle), creates a `posts` record (deduped by URL), and links them via `posts.author` + `people.associated_posts`. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
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
        });
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportPost(
  rawUrl: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean },
) {
  const sniffed = normalizePostUrl(rawUrl);
  if (!sniffed) {
    throw new AcrmError(
      `unrecognized post URL: ${rawUrl} (expected linkedin.com, x.com, or twitter.com)`,
      ERR.INVALID_INPUT,
    );
  }
  const { platform, url: normalizedUrl } = sniffed;

  const workspaceFile = opts.workspace
    ? path.resolve(
        opts.workspace.endsWith(".acrm")
          ? opts.workspace
          : opts.workspace + ".acrm",
      )
    : findWorkspace();
  if (!workspaceFile) {
    throw new AcrmError(
      "no .acrm file found (run `acrm init <name>.acrm` to create one)",
      ERR.NO_WORKSPACE,
    );
  }
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

  // 1. Fetch the post (with cache).
  const postId =
    platform === "linkedin"
      ? extractLinkedinPostId(rawUrl)
      : extractXPostId(rawUrl);
  const postLoad =
    platform === "linkedin"
      ? await loadLinkedinPost({
          cacheDir: postCacheDir,
          postId,
          url: rawUrl,
          token,
          refresh: opts.refresh,
          noCache: opts.noCache,
        })
      : await loadXPost({
          cacheDir: postCacheDir,
          postId,
          url: rawUrl,
          token,
          refresh: opts.refresh,
          noCache: opts.noCache,
        });

  // 2. Map post + extract author profile URL.
  const mapped: MappedPost =
    platform === "linkedin"
      ? mapLinkedinPost(postLoad.post)
      : mapXPost(postLoad.post);

  if (!mapped.author_profile_url) {
    throw new AcrmError(
      "could not extract author profile URL from the post",
      ERR.UNHANDLED,
    );
  }

  const lix = await openWorkspace({ workspace: workspaceFile });
  try {
    // 3. Import the author via the existing profile flow.
    let personId: string;
    let companyId: string | null = null;
    let personCreated = false;
    let companyCreated = false;
    let profileCachePath: string | null = null;
    let profileCacheHit = false;

    if (platform === "linkedin") {
      const r = await importLinkedinProfile({
        lix,
        urlOrSlug: mapped.author_profile_url,
        token,
        cacheDir: profileCacheDir,
        refresh: opts.refresh,
        noCache: opts.noCache,
      });
      personId = r.person_record_id;
      companyId = r.company_record_id;
      personCreated = r.created.person;
      companyCreated = r.created.company;
      profileCachePath = r.cache_path;
      profileCacheHit = r.cache_hit;
    } else {
      const r = await importXProfile({
        lix,
        handleOrUrl: mapped.author_profile_url,
        token,
        cacheDir: profileCacheDir,
        refresh: opts.refresh,
        noCache: opts.noCache,
      });
      personId = r.person_record_id;
      personCreated = r.created.person;
      profileCachePath = r.cache_path;
      profileCacheHit = r.cache_hit;
    }

    // 4. Upsert the post record (dedup by normalized URL).
    const postRecord = await upsertPost({
      lix,
      platform,
      normalizedUrl,
      rawUrl,
      mapped,
      personId,
      postCacheHit: postLoad.cacheHit,
      apifyActor:
        platform === "linkedin"
          ? "apimaestro~linkedin-post-detail"
          : "apidojo~twitter-scraper-lite",
    });

    // 5. Link person → post (skip if already linked).
    await linkPersonToPost(lix, personId, postRecord.postRecordId, platform);

    return {
      post_record_id: postRecord.postRecordId,
      person_record_id: personId,
      company_record_id: companyId,
      created: {
        post: postRecord.created,
        person: personCreated,
        company: companyCreated,
      },
      platform,
      post_url: normalizedUrl,
      cache_paths: {
        post: postLoad.cachePath
          ? path.relative(process.cwd(), postLoad.cachePath)
          : null,
        profile: profileCachePath
          ? path.relative(process.cwd(), profileCachePath)
          : null,
      },
      cache_hits: {
        post: postLoad.cacheHit,
        profile: profileCacheHit,
      },
      mapped,
    };
  } finally {
    await lix.close();
  }
}

async function upsertPost(args: {
  lix: Lix;
  platform: PostPlatform;
  normalizedUrl: string;
  rawUrl: string;
  mapped: MappedPost;
  personId: string;
  postCacheHit: boolean;
  apifyActor: string;
}): Promise<{ postRecordId: string; created: boolean }> {
  const { lix, platform, normalizedUrl, rawUrl, mapped, personId, apifyActor } =
    args;
  const source =
    platform === "linkedin" ? "linkedin-post-import" : "x-post-import";
  const provenance = {
    actor: apifyActor,
    post_url: rawUrl,
    fetched_at: new Date().toISOString(),
    cache_hit: args.postCacheHit,
  };

  let postRecordId = await findRecordByUnique(
    lix,
    "posts",
    "url",
    normalizedUrl,
  );
  let created = false;
  if (!postRecordId) {
    postRecordId = await generateUuid(lix);
    await insertRecord(lix, "posts", postRecordId);
    created = true;
  }

  await setSingleValue(lix, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "url",
    attribute_type: "url",
    value: normalizedUrl,
    source,
    provenance,
  });

  await setSingleValue(lix, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "platform",
    attribute_type: "status",
    value: platform,
    source,
    provenance,
  });

  await setSingleValue(lix, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "author",
    attribute_type: "record-reference",
    value: { target_object: "people", target_record_id: personId },
    source,
    provenance,
  });

  if (mapped.posted_at) {
    await setSingleValue(lix, {
      object_slug: "posts",
      record_id: postRecordId,
      attribute_slug: "posted_at",
      attribute_type: "date",
      value: mapped.posted_at,
      source,
      provenance,
    });
  }

  if (mapped.content) {
    await setSingleValue(lix, {
      object_slug: "posts",
      record_id: postRecordId,
      attribute_slug: "content",
      attribute_type: "text",
      value: mapped.content,
      source,
      provenance,
    });
  }

  return { postRecordId, created };
}

async function linkPersonToPost(
  lix: Lix,
  personId: string,
  postRecordId: string,
  platform: PostPlatform,
): Promise<void> {
  const existing = await exec(
    lix,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = 'associated_posts'
       AND ref_object = 'posts' AND ref_record_id = $2
       AND active_until IS NULL LIMIT 1`,
    [personId, postRecordId],
  );
  if (existing.rows.length) return;

  const source =
    platform === "linkedin" ? "linkedin-post-import" : "x-post-import";
  await addMultiValue(lix, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "associated_posts",
    attribute_type: "record-reference",
    value: { target_object: "posts", target_record_id: postRecordId },
    source,
    provenance: { linked_at: new Date().toISOString() },
  });
}
