import type { AcrmDatabase } from "../db/types.js";
import { exec } from "../db/execute.js";
import {
  addMultiValue,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import { normalizePostUrl, type PostPlatform } from "../domain/values.js";
import {
  extractLinkedinPostId,
  extractXPostId,
  loadLinkedinPost,
  loadXPost,
} from "../integrations/apify-post.js";
import {
  mapLinkedinPost,
  mapXPost,
  type MappedPost,
} from "../integrations/post-mapping.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import type { Workspace } from "../workspace.js";
import { importLinkedinProfile } from "./import-linkedin.js";
import { importXProfile } from "./import-x.js";

export type PostImportResult = {
  post_record_id: string;
  person_record_id: string;
  company_record_id: string | null;
  created: { post: boolean; person: boolean; company: boolean };
  platform: PostPlatform;
  post_url: string;
  cache_paths: { post: string | null; profile: string | null };
  cache_hits: { post: boolean; profile: boolean };
  mapped: MappedPost;
};

export type ImportPostArgs = {
  rawUrl: string;
  token: string;
  postCacheDir: string;
  profileCacheDir: string;
  refresh?: boolean;
  noCache?: boolean;
};

// Import a LinkedIn or X post by URL. Auto-detects platform, upserts the
// post author as a person via the profile-import flow, upserts the post
// record (deduped by normalized URL), and links them via `posts.author` +
// `people.associated_posts`. Caller supplies Apify token and two cache dirs
// (one for the post, one for the author's profile).
export async function importPost(
  workspace: Workspace,
  args: ImportPostArgs,
): Promise<PostImportResult> {
  const sniffed = normalizePostUrl(args.rawUrl);
  if (!sniffed) {
    throw new AcrmError(
      `unrecognized post URL: ${args.rawUrl} (expected linkedin.com, x.com, or twitter.com)`,
      ERR.INVALID_INPUT,
    );
  }
  const { platform, url: normalizedUrl } = sniffed;
  const db = workspace.db;

  // 1. Fetch the post (with cache).
  const postId =
    platform === "linkedin"
      ? extractLinkedinPostId(args.rawUrl)
      : extractXPostId(args.rawUrl);
  const postLoad =
    platform === "linkedin"
      ? await loadLinkedinPost({
          cacheDir: args.postCacheDir,
          postId,
          url: args.rawUrl,
          token: args.token,
          refresh: args.refresh,
          noCache: args.noCache,
        })
      : await loadXPost({
          cacheDir: args.postCacheDir,
          postId,
          url: args.rawUrl,
          token: args.token,
          refresh: args.refresh,
          noCache: args.noCache,
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

  // 3. Import the author via the existing profile flow.
  let personId: string;
  let companyId: string | null = null;
  let personCreated = false;
  let companyCreated = false;
  let profileCachePath: string | null = null;
  let profileCacheHit = false;

  if (platform === "linkedin") {
    const r = await importLinkedinProfile(workspace, {
      urlOrSlug: mapped.author_profile_url,
      token: args.token,
      cacheDir: args.profileCacheDir,
      refresh: args.refresh,
      noCache: args.noCache,
    });
    personId = r.person_record_id;
    companyId = r.company_record_id;
    personCreated = r.created.person;
    companyCreated = r.created.company;
    profileCachePath = r.cache_path;
    profileCacheHit = r.cache_hit;
  } else {
    const r = await importXProfile(workspace, {
      handleOrUrl: mapped.author_profile_url,
      token: args.token,
      cacheDir: args.profileCacheDir,
      refresh: args.refresh,
      noCache: args.noCache,
    });
    personId = r.person_record_id;
    personCreated = r.created.person;
    profileCachePath = r.cache_path;
    profileCacheHit = r.cache_hit;
  }

  // 4. Upsert the post record (dedup by normalized URL).
  const postRecord = await upsertPost({
    db,
    platform,
    normalizedUrl,
    rawUrl: args.rawUrl,
    mapped,
    personId,
    postCacheHit: postLoad.cacheHit,
    apifyActor:
      platform === "linkedin"
        ? "apimaestro~linkedin-post-detail"
        : "apidojo~twitter-scraper-lite",
  });

  // 5. Link person → post (skip if already linked).
  await linkPersonToPost(db, personId, postRecord.postRecordId, platform);

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
      post: postLoad.cachePath,
      profile: profileCachePath,
    },
    cache_hits: {
      post: postLoad.cacheHit,
      profile: profileCacheHit,
    },
    mapped,
  };
}

async function upsertPost(args: {
  db: AcrmDatabase;
  platform: PostPlatform;
  normalizedUrl: string;
  rawUrl: string;
  mapped: MappedPost;
  personId: string;
  postCacheHit: boolean;
  apifyActor: string;
}): Promise<{ postRecordId: string; created: boolean }> {
  const { db, platform, normalizedUrl, rawUrl, mapped, personId, apifyActor } =
    args;
  const source =
    platform === "linkedin" ? "linkedin-post-import" : "x-post-import";
  const provenance = {
    actor: apifyActor,
    post_url: rawUrl,
    fetched_at: nowIso(),
    cache_hit: args.postCacheHit,
  };

  let postRecordId = await findRecordByUnique(
    db,
    "posts",
    "url",
    normalizedUrl,
  );
  let created = false;
  if (!postRecordId) {
    postRecordId = await generateUuid(db);
    await insertRecord(db, "posts", postRecordId);
    created = true;
  }

  await setSingleValue(db, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "url",
    attribute_type: "url",
    value: normalizedUrl,
    source,
    provenance,
  });

  await setSingleValue(db, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "platform",
    attribute_type: "status",
    value: platform,
    source,
    provenance,
  });

  await setSingleValue(db, {
    object_slug: "posts",
    record_id: postRecordId,
    attribute_slug: "author",
    attribute_type: "record-reference",
    value: { target_object: "people", target_record_id: personId },
    source,
    provenance,
  });

  if (mapped.posted_at) {
    await setSingleValue(db, {
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
    await setSingleValue(db, {
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
  db: AcrmDatabase,
  personId: string,
  postRecordId: string,
  platform: PostPlatform,
): Promise<void> {
  const existing = await exec(
    db,
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
  await addMultiValue(db, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "associated_posts",
    attribute_type: "record-reference",
    value: { target_object: "posts", target_record_id: postRecordId },
    source,
    provenance: { linked_at: nowIso() },
  });
}
