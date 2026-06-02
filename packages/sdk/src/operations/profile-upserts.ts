import type { AcrmDatabase } from "../db/types.js";
import { exec } from "../db/execute.js";
import {
  findCompanyByName,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  normalizeLinkedinUrl,
  normalizeTwitterUrl,
} from "../domain/values.js";
import type { XProfile } from "../integrations/apify-x.js";
import type { MappedProfile } from "../integrations/linkedin-mapping.js";
import type { MappedXProfile } from "../integrations/x-mapping.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { generateUuid } from "../lib/ids.js";

const LINKEDIN_SOURCE = "linkedin-import";
const X_SOURCE = "x-import";
const X_ENRICHABLE = ["job_title", "company"] as const;

export type LinkedinProfileUpsertResult = {
  person_record_id: string;
  company_record_id: string | null;
  created: { person: boolean; company: boolean };
  cache_path: string | null;
  cache_hit: boolean;
  mapped: MappedProfile;
};

export async function upsertMappedLinkedinProfile(
  db: AcrmDatabase,
  args: {
    url: string;
    cachePath: string | null;
    cacheHit: boolean;
    mapped: MappedProfile;
    provenance: Record<string, unknown>;
  },
): Promise<LinkedinProfileUpsertResult> {
  const { url, cachePath, cacheHit, mapped, provenance } = args;

  let companyId: string | null = null;
  let companyCreated = false;
  if (mapped.company.name) {
    companyId = await findCompanyByName(db, mapped.company.name);
    if (!companyId) {
      companyId = await generateUuid(db);
      await insertRecord(db, "companies", companyId);
      await setSingleValue(db, {
        object_slug: "companies",
        record_id: companyId,
        attribute_slug: "name",
        attribute_type: "text",
        value: mapped.company.name,
        source: LINKEDIN_SOURCE,
        provenance,
      });
      companyCreated = true;
    }
    if (mapped.company.linkedin_url) {
      const cl = normalizeLinkedinUrl(mapped.company.linkedin_url);
      if (cl) {
        await setSingleValue(db, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "linkedin_url",
          attribute_type: "url",
          value: cl,
          source: LINKEDIN_SOURCE,
          provenance,
        });
      }
    }
  }

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
    db,
    "people",
    "linkedin_url",
    linkedinKey,
  );
  let personCreated = false;
  if (!personId) {
    personId = await generateUuid(db);
    await insertRecord(db, "people", personId);
    personCreated = true;
  }

  await setSingleValue(db, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "linkedin_url",
    attribute_type: "url",
    value: linkedinKey,
    source: LINKEDIN_SOURCE,
    provenance,
  });

  if (mapped.person.name) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: mapped.person.name,
      source: LINKEDIN_SOURCE,
      provenance,
    });
  }

  if (mapped.person.profile_picture_url) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "profile_picture_url",
      attribute_type: "url",
      value: mapped.person.profile_picture_url,
      source: LINKEDIN_SOURCE,
      provenance,
    });
  }

  if (mapped.person.job_title) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "job_title",
      attribute_type: "text",
      value: mapped.person.job_title,
      source: LINKEDIN_SOURCE,
      provenance,
    });
  }

  if (companyId) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "company",
      attribute_type: "record-reference",
      value: { target_object: "companies", target_record_id: companyId },
      source: LINKEDIN_SOURCE,
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

export type XProfileUpsertResult = {
  person_record_id: string;
  created: { person: boolean };
  cache_path: string | null;
  cache_hit: boolean;
  mapped: MappedXProfile;
  bio: string | null;
  needs_enrichment: {
    person_record_id: string;
    bio: string;
    missing: string[];
    instructions: string;
  } | null;
};

export async function upsertMappedXProfile(
  db: AcrmDatabase,
  args: {
    twitterKey: string;
    cachePath: string | null;
    cacheHit: boolean;
    mapped: MappedXProfile;
    profile: XProfile;
    provenance: Record<string, unknown>;
  },
): Promise<XProfileUpsertResult> {
  const { twitterKey, cachePath, cacheHit, mapped, profile, provenance } = args;

  let personId = await findRecordByUnique(
    db,
    "people",
    "twitter_url",
    twitterKey,
  );
  let personCreated = false;
  if (!personId) {
    personId = await generateUuid(db);
    await insertRecord(db, "people", personId);
    personCreated = true;
  }

  await setSingleValue(db, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "twitter_url",
    attribute_type: "url",
    value: twitterKey,
    source: X_SOURCE,
    provenance,
  });

  if (mapped.person.name) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: mapped.person.name,
      source: X_SOURCE,
      provenance,
    });
  }

  const bio = pickBio(profile);
  const missing: string[] = [];
  for (const attr of X_ENRICHABLE) {
    if (!(await hasActiveValue(db, "people", personId, attr))) {
      missing.push(attr);
    }
  }

  const needsEnrichment =
    bio && missing.length > 0
      ? {
          person_record_id: personId,
          bio,
          missing,
          instructions:
            "Extract role/company from `bio`. For each slug in `missing`, use first-class `acrm records` commands only. For `job_title`, update the people record with `--field job_title=<title>`. For `company`, create or reuse a companies record when you have one, then update people.company with `--field company=companies:<company_record_id>`. Only write what's clearly stated; skip if uncertain. Source: 'x-bio-enrichment'.",
        }
      : null;

  return {
    person_record_id: personId,
    created: { person: personCreated },
    cache_path: cachePath,
    cache_hit: cacheHit,
    mapped,
    bio,
    needs_enrichment: needsEnrichment,
  };
}

export function normalizedXProfileKey(mapped: MappedXProfile): string {
  const twitterKey = normalizeTwitterUrl(mapped.person.twitter_url);
  if (!twitterKey) {
    throw new AcrmError(
      "could not derive a normalized X URL from the profile",
      ERR.INVALID_INPUT,
    );
  }
  return twitterKey;
}

function pickBio(profile: XProfile): string | null {
  let raw: string | null = null;
  for (const k of ["description", "bio", "about"]) {
    const v = (profile as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim().length) {
      raw = v.trim();
      break;
    }
  }
  if (!raw) return null;
  return expandTcoUrls(raw, profile);
}

function expandTcoUrls(bio: string, profile: XProfile): string {
  const entities = (profile as Record<string, unknown>).entities as
    | { description?: { urls?: Array<Record<string, unknown>> } }
    | undefined;
  const urls = entities?.description?.urls;
  if (!Array.isArray(urls) || urls.length === 0) return bio;
  let out = bio;
  for (const u of urls) {
    const tco = typeof u.url === "string" ? u.url : null;
    const display =
      typeof u.display_url === "string"
        ? u.display_url
        : typeof u.expanded_url === "string"
          ? u.expanded_url.replace(/^https?:\/\//i, "")
          : null;
    if (tco && display) out = out.split(tco).join(display);
  }
  return out;
}

async function hasActiveValue(
  db: AcrmDatabase,
  object_slug: string,
  record_id: string,
  attribute_slug: string,
): Promise<boolean> {
  const r = await exec(
    db,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
       AND active_until IS NULL LIMIT 1`,
    [object_slug, record_id, attribute_slug],
  );
  return r.rows.length > 0;
}
