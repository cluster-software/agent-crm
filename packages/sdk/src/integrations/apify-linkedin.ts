import path from "node:path";
import { AcrmError, ERR } from "../lib/errors.js";
import { callApifyDatasetItem } from "./apify-client.js";
import {
  readFreshJsonCache,
  writeJsonCache,
} from "./json-cache.js";

const ACTOR = "harvestapi~linkedin-profile-scraper";

export type LinkedInProfile = Record<string, unknown>;

export function normalizeLinkedinInput(arg: string): {
  url: string;
  publicId: string;
} {
  const trimmed = arg.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new AcrmError("linkedin url or slug is required", ERR.INVALID_INPUT);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(/\/in\/([^/?#]+)/);
    if (!m) {
      throw new AcrmError(
        `can't parse LinkedIn URL: ${trimmed} (expected /in/<slug>)`,
        ERR.INVALID_INPUT,
      );
    }
    return { url: trimmed, publicId: m[1]!.toLowerCase() };
  }
  const slug = trimmed.replace(/^@/, "");
  return {
    url: `https://www.linkedin.com/in/${slug}/`,
    publicId: slug.toLowerCase(),
  };
}

export async function fetchLinkedInProfile(
  url: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<LinkedInProfile> {
  return callApifyDatasetItem<LinkedInProfile>({
    actor: ACTOR,
    token,
    timeoutMs: opts.timeoutMs,
    body: {
      profileScraperMode: "Profile details no email ($4 per 1k)",
      queries: [url],
    },
    notFoundMessage:
      "apify returned no profile data (private profile or invalid URL?)",
  });
}

export type CacheLoadOptions = {
  cacheDir: string;
  publicId: string;
  url: string;
  token: string;
  refresh?: boolean;
  noCache?: boolean;
  timeoutMs?: number;
};

export type CacheLoadResult = {
  profile: LinkedInProfile;
  cachePath: string | null;
  cacheHit: boolean;
};

export async function loadFromCacheOrFetch(
  opts: CacheLoadOptions,
): Promise<CacheLoadResult> {
  const cachePath = path.join(opts.cacheDir, `${opts.publicId}.json`);

  if (!opts.refresh && !opts.noCache) {
    const cached = await readFreshJsonCache<LinkedInProfile>(cachePath);
    if (cached) return { profile: cached, cachePath, cacheHit: true };
  }

  const profile = await fetchLinkedInProfile(opts.url, opts.token, {
    timeoutMs: opts.timeoutMs,
  });

  if (!opts.noCache) {
    await writeJsonCache(cachePath, profile);
    return { profile, cachePath, cacheHit: false };
  }
  return { profile, cachePath: null, cacheHit: false };
}
