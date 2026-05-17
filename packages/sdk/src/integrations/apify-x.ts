import path from "node:path";
import { AcrmError, ERR } from "../lib/errors.js";
import { callApifyDatasetItem } from "./apify-client.js";
import {
  readFreshJsonCache,
  writeJsonCache,
} from "./json-cache.js";

const ACTOR = "apidojo~twitter-user-scraper";

export type XProfile = Record<string, unknown>;

export function normalizeXInput(arg: string): { handle: string } {
  const trimmed = arg.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new AcrmError("x handle or url is required", ERR.INVALID_INPUT);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(
      /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)/i,
    );
    if (!m) {
      throw new AcrmError(
        `can't parse X URL: ${trimmed} (expected https://x.com/<handle>)`,
        ERR.INVALID_INPUT,
      );
    }
    return { handle: m[1]!.toLowerCase() };
  }
  return { handle: trimmed.replace(/^@/, "").toLowerCase() };
}

export async function fetchXProfile(
  handle: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<XProfile> {
  return callApifyDatasetItem<XProfile>({
    actor: ACTOR,
    token,
    timeoutMs: opts.timeoutMs,
    body: {
      twitterHandles: [handle],
      maxItems: 1,
      getAbout: true,
      getFollowers: false,
      getFollowing: false,
      getRetweeters: false,
    },
    notFoundMessage:
      `no profile data returned for @${handle} (private, suspended, or invalid handle?)`,
  });
}

export type CacheLoadOptions = {
  cacheDir: string;
  handle: string;
  token: string;
  refresh?: boolean;
  noCache?: boolean;
  timeoutMs?: number;
};

export type CacheLoadResult = {
  profile: XProfile;
  cachePath: string | null;
  cacheHit: boolean;
};

export async function loadFromCacheOrFetch(
  opts: CacheLoadOptions,
): Promise<CacheLoadResult> {
  const cachePath = path.join(opts.cacheDir, `${opts.handle}.json`);

  if (!opts.refresh && !opts.noCache) {
    const cached = await readFreshJsonCache<XProfile>(cachePath);
    if (cached) return { profile: cached, cachePath, cacheHit: true };
  }

  const profile = await fetchXProfile(opts.handle, opts.token, {
    timeoutMs: opts.timeoutMs,
  });

  if (!opts.noCache) {
    await writeJsonCache(cachePath, profile);
    return { profile, cachePath, cacheHit: false };
  }
  return { profile, cachePath: null, cacheHit: false };
}
