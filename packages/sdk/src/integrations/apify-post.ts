import path from "node:path";
import { createHash } from "node:crypto";
import { callApifyDatasetItem } from "./apify-client.js";
import {
  readFreshJsonCache,
  writeJsonCache,
} from "./json-cache.js";

const LINKEDIN_ACTOR = "apimaestro~linkedin-post-detail";
const X_ACTOR = "apidojo~twitter-scraper-lite";

export type RawPost = Record<string, unknown>;

export function extractLinkedinPostId(url: string): string {
  const activity = url.match(/activity[-:](\d{10,})/i);
  if (activity) return activity[1]!;
  const urn = url.match(/urn:li:activity:(\d{10,})/i);
  if (urn) return urn[1]!;
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

export function extractXPostId(url: string): string {
  const m = url.match(/\/status(?:es)?\/(\d{6,})/i);
  if (m) return m[1]!;
  return createHash("sha1").update(url).digest("hex").slice(0, 16);
}

async function callApify(
  actor: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<RawPost> {
  return callApifyDatasetItem<RawPost>({
    actor,
    token,
    body,
    timeoutMs,
    notFoundMessage:
      "apify returned no post data (private, deleted, or invalid URL?)",
  });
}

export async function fetchLinkedinPost(
  url: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<RawPost> {
  return callApify(
    LINKEDIN_ACTOR,
    token,
    { post_urls: [url] },
    opts.timeoutMs,
  );
}

export async function fetchXPost(
  url: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<RawPost> {
  return callApify(X_ACTOR, token, { startUrls: [url] }, opts.timeoutMs);
}

export type PostCacheOptions = {
  cacheDir: string;
  postId: string;
  url: string;
  token: string;
  refresh?: boolean;
  noCache?: boolean;
  timeoutMs?: number;
};

export type PostCacheResult = {
  post: RawPost;
  cachePath: string | null;
  cacheHit: boolean;
};

export async function loadLinkedinPost(
  opts: PostCacheOptions,
): Promise<PostCacheResult> {
  return loadOrFetch(opts, fetchLinkedinPost);
}

export async function loadXPost(
  opts: PostCacheOptions,
): Promise<PostCacheResult> {
  return loadOrFetch(opts, fetchXPost);
}

async function loadOrFetch(
  opts: PostCacheOptions,
  fetcher: (
    url: string,
    token: string,
    o?: { timeoutMs?: number },
  ) => Promise<RawPost>,
): Promise<PostCacheResult> {
  const cachePath = path.join(opts.cacheDir, `${opts.postId}.json`);

  if (!opts.refresh && !opts.noCache) {
    const cached = await readFreshJsonCache<RawPost>(cachePath);
    if (cached) return { post: cached, cachePath, cacheHit: true };
  }

  const post = await fetcher(opts.url, opts.token, {
    timeoutMs: opts.timeoutMs,
  });

  if (!opts.noCache) {
    await writeJsonCache(cachePath, post);
    return { post, cachePath, cacheHit: false };
  }
  return { post, cachePath: null, cacheHit: false };
}
