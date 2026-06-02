import {
  loadFromCacheOrFetch,
  normalizeLinkedinInput,
} from "../integrations/apify-linkedin.js";
import { mapProfile } from "../integrations/linkedin-mapping.js";
import { nowIso } from "../lib/time.js";
import { workspaceDatabase, type Workspace } from "../workspace.js";
import {
  upsertMappedLinkedinProfile,
  type LinkedinProfileUpsertResult,
} from "./profile-upserts.js";

export type LinkedinImportResult = LinkedinProfileUpsertResult;

export type ImportLinkedinProfileArgs = {
  urlOrSlug: string;
  token: string;
  cacheDir: string;
  refresh?: boolean;
  noCache?: boolean;
};

// Fetch a LinkedIn profile (cached) and upsert a person + their current
// employer as a company. Person is deduped by linkedin_url; company is
// deduped by name. Caller supplies the Apify token + cache dir.
export async function importLinkedinProfile(
  workspace: Workspace,
  args: ImportLinkedinProfileArgs,
): Promise<LinkedinImportResult> {
  const { urlOrSlug, token, cacheDir, refresh, noCache } = args;
  const { url, publicId } = normalizeLinkedinInput(urlOrSlug);

  const { profile, cachePath, cacheHit } = await loadFromCacheOrFetch({
    cacheDir,
    publicId,
    url,
    token,
    refresh,
    noCache,
  });

  const mapped = mapProfile(profile);

  const provenance = {
    actor: "harvestapi~linkedin-profile-scraper",
    public_id: publicId,
    fetched_at: nowIso(),
    cache_hit: cacheHit,
  };

  return await workspaceDatabase(workspace).transaction((db) =>
    upsertMappedLinkedinProfile(db, {
      url,
      cachePath,
      cacheHit,
      mapped,
      provenance,
    })
  );
}
