import {
  findCompanyByName,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import { normalizeLinkedinUrl } from "../domain/values.js";
import {
  loadFromCacheOrFetch,
  normalizeLinkedinInput,
} from "../integrations/apify-linkedin.js";
import {
  mapProfile,
  type MappedProfile,
} from "../integrations/linkedin-mapping.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { generateUuid } from "../lib/ids.js";
import type { Workspace } from "../workspace.js";

const SOURCE = "linkedin-import";

export type LinkedinImportResult = {
  person_record_id: string;
  company_record_id: string | null;
  created: { person: boolean; company: boolean };
  cache_path: string | null;
  cache_hit: boolean;
  mapped: MappedProfile;
};

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
  const lix = workspace.lix;
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
    fetched_at: new Date().toISOString(),
    cache_hit: cacheHit,
  };

  // Company first so the person can reference it.
  let companyId: string | null = null;
  let companyCreated = false;
  if (mapped.company.name) {
    companyId = await findCompanyByName(lix, mapped.company.name);
    if (!companyId) {
      companyId = await generateUuid(lix);
      await insertRecord(lix, "companies", companyId);
      await setSingleValue(lix, {
        object_slug: "companies",
        record_id: companyId,
        attribute_slug: "name",
        attribute_type: "text",
        value: mapped.company.name,
        source: SOURCE,
        provenance,
      });
      companyCreated = true;
    }
    if (mapped.company.linkedin_url) {
      const cl = normalizeLinkedinUrl(mapped.company.linkedin_url);
      if (cl) {
        await setSingleValue(lix, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "linkedin_url",
          attribute_type: "url",
          value: cl,
          source: SOURCE,
          provenance,
        });
      }
    }
  }

  // Person — dedupe by LinkedIn URL.
  const linkedinKey = mapped.person.linkedin_url
    ? normalizeLinkedinUrl(mapped.person.linkedin_url)
    : normalizeLinkedinUrl(url);
  if (!linkedinKey) {
    throw new AcrmError(
      "could not derive a normalized LinkedIn URL from the profile",
      ERR.INVALID_INPUT,
    );
  }

  let personId = await findRecordByUnique(
    lix,
    "people",
    "linkedin_url",
    linkedinKey,
  );
  let personCreated = false;
  if (!personId) {
    personId = await generateUuid(lix);
    await insertRecord(lix, "people", personId);
    personCreated = true;
  }

  await setSingleValue(lix, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "linkedin_url",
    attribute_type: "url",
    value: linkedinKey,
    source: SOURCE,
    provenance,
  });

  if (mapped.person.name) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: mapped.person.name,
      source: SOURCE,
      provenance,
    });
  }

  if (mapped.person.job_title) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "job_title",
      attribute_type: "text",
      value: mapped.person.job_title,
      source: SOURCE,
      provenance,
    });
  }

  if (companyId) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "company",
      attribute_type: "record-reference",
      value: { target_object: "companies", target_record_id: companyId },
      source: SOURCE,
      provenance,
    });
  }

  return {
    person_record_id: personId,
    company_record_id: companyId,
    created: { person: personCreated, company: companyCreated },
    cache_path: cachePath,
    cache_hit: cacheHit,
    mapped,
  };
}
