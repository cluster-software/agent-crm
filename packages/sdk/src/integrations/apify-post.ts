import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AcrmError, ERR } from "../lib/errors.js";

const LINKEDIN_ACTOR = "apimaestro~linkedin-post-detail";
const X_ACTOR = "apidojo~twitter-scraper-lite";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  const params = new URLSearchParams({ token, maxTotalChargeUsd: "1.00" });
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AcrmError(`apify network error: ${msg}`, ERR.UNHANDLED);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 500);
    throw new AcrmError(`apify http ${resp.status}: ${text}`, ERR.UNHANDLED);
  }
  const data = (await resp.json()) as RawPost[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new AcrmError(
      "apify returned no post data (private, deleted, or invalid URL?)",
      ERR.NOT_FOUND,
    );
  }
  return data[0]!;
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
    const cached = await readFreshCache(cachePath);
    if (cached) return { post: cached, cachePath, cacheHit: true };
  }

  const post = await fetcher(opts.url, opts.token, {
    timeoutMs: opts.timeoutMs,
  });

  if (!opts.noCache) {
    await mkdir(opts.cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(post, null, 2), "utf8");
    return { post, cachePath, cacheHit: false };
  }
  return { post, cachePath: null, cacheHit: false };
}

async function readFreshCache(cachePath: string): Promise<RawPost | null> {
  let s;
  try {
    s = await stat(cachePath);
  } catch {
    return null;
  }
  if (Date.now() - s.mtimeMs > TTL_MS) return null;
  const raw = await readFile(cachePath, "utf8");
  return JSON.parse(raw) as RawPost;
}
