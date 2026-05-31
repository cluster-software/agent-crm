import {
  loadFromCacheOrFetch,
  normalizeXInput,
} from "../integrations/apify-x.js";
import { mapProfile } from "../integrations/x-mapping.js";
import { nowIso } from "../lib/time.js";
import type { Workspace } from "../workspace.js";
import {
  normalizedXProfileKey,
  upsertMappedXProfile,
  type XProfileUpsertResult,
} from "./profile-upserts.js";

export type XImportResult = XProfileUpsertResult;

export type ImportXProfileArgs = {
  handleOrUrl: string;
  token: string;
  cacheDir: string;
  refresh?: boolean;
  noCache?: boolean;
};

// Fetch an X/Twitter profile (cached) and upsert a person, deduped by
// twitter_url normalized to x.com/<handle>. If the bio still contains
// role/company info the record is missing, returns a `needs_enrichment`
// payload so the caller can trigger an LLM extraction step.
export async function importXProfile(
  workspace: Workspace,
  args: ImportXProfileArgs,
): Promise<XImportResult> {
  const { handleOrUrl, token, cacheDir, refresh, noCache } = args;
  const { handle } = normalizeXInput(handleOrUrl);

  const { profile, cachePath, cacheHit } = await loadFromCacheOrFetch({
    cacheDir,
    handle,
    token,
    refresh,
    noCache,
  });

  const mapped = mapProfile(profile, handle);

  const provenance = {
    actor: "apidojo~twitter-user-scraper",
    handle: mapped.person.handle,
    fetched_at: nowIso(),
    cache_hit: cacheHit,
  };

  const twitterKey = normalizedXProfileKey(mapped);

  return await workspace.db.transaction((db) =>
    upsertMappedXProfile(db, {
      twitterKey,
      cachePath,
      cacheHit,
      mapped,
      profile,
      provenance,
    })
  );
}
