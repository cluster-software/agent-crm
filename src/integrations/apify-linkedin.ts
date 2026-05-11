import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AcrmError, ERR } from "../lib/errors.js";

const ACTOR = "harvestapi~linkedin-profile-scraper";
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
  const params = new URLSearchParams({ token, maxTotalChargeUsd: "1.00" });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 180_000,
  );
  let resp: Response;
  try {
    resp = await fetch(`${ENDPOINT}?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileScraperMode: "Profile details no email ($4 per 1k)",
        queries: [url],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AcrmError(`apify network error: ${msg}`, ERR.UNHANDLED);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 500);
    throw new AcrmError(
      `apify http ${resp.status}: ${body}`,
      ERR.UNHANDLED,
    );
  }
  const data = (await resp.json()) as LinkedInProfile[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new AcrmError(
      "apify returned no profile data (private profile or invalid URL?)",
      ERR.NOT_FOUND,
    );
  }
  return data[0]!;
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
    const cached = await readFreshCache(cachePath);
    if (cached) return { profile: cached, cachePath, cacheHit: true };
  }

  const profile = await fetchLinkedInProfile(opts.url, opts.token, {
    timeoutMs: opts.timeoutMs,
  });

  if (!opts.noCache) {
    await mkdir(opts.cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(profile, null, 2), "utf8");
    return { profile, cachePath, cacheHit: false };
  }
  return { profile, cachePath: null, cacheHit: false };
}

async function readFreshCache(
  cachePath: string,
): Promise<LinkedInProfile | null> {
  let s;
  try {
    s = await stat(cachePath);
  } catch {
    return null;
  }
  if (Date.now() - s.mtimeMs > TTL_MS) return null;
  const raw = await readFile(cachePath, "utf8");
  return JSON.parse(raw) as LinkedInProfile;
}
