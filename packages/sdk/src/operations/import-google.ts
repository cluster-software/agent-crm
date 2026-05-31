import {
  addMultiValue,
  findCompanyByName,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  domainFromEmail,
  normalizeDomain,
  normalizeLinkedinUrl,
  normalizePhoneNumber,
  normalizeTwitterUrl,
} from "../domain/values.js";
import { resolvePersonByIdentifiers } from "../domain/resolve-person.js";
import { generateUuid } from "../lib/ids.js";
import type { Workspace } from "../workspace.js";

// Subset of the Google People API `Person` resource we care about for
// onboarding. The CLI shells out to `gws people ... --page-all` and flattens
// each page's connections / otherContacts into this shape before handing it
// to the SDK. Keeping the SDK pure (no child_process) makes it testable with
// in-memory fixtures.
export type GoogleContact = {
  resource_name: string;
  // Which People API list this contact came from. Written to acrm_value.source
  // as `google:connections` / `google:other-contacts` so provenance is clear.
  origin: "connections" | "other_contacts";
  display_name?: string | null;
  // Primary email first, then the rest. All lowercased upstream.
  emails?: readonly string[];
  phones?: readonly string[];
  // Current employer first; older roles are ignored for now.
  organizations?: ReadonlyArray<{
    name?: string | null;
    title?: string | null;
  }>;
  // Arbitrary URLs from the contact card; LinkedIn / X get sniffed out.
  urls?: readonly string[];
};

export type ImportGoogleContactsStats = {
  contacts_seen: number;
  people_created: number;
  companies_created: number;
  people_skipped_no_identifier: number;
};

export type ImportGoogleContactsArgs = {
  contacts: Iterable<GoogleContact> | AsyncIterable<GoogleContact>;
  // ISO country code (e.g. "US") used to parse locally-formatted phones into
  // E.164. Google often returns E.164 already, but contacts entered manually
  // can be locale-shaped.
  default_country?: string;
  onProgress?: (info: { seen: number; stats: ImportGoogleContactsStats }) => void;
};

export type ImportGoogleContactsResult = {
  stats: ImportGoogleContactsStats;
};

const LINKEDIN_RE = /(?:^|\/\/|\.)linkedin\.com\b/i;
const TWITTER_RE = /(?:^|\/\/|\.)(?:x\.com|twitter\.com)\b/i;

function pickLinkedin(urls: readonly string[] | undefined): string | null {
  if (!urls) return null;
  for (const u of urls) if (LINKEDIN_RE.test(u)) return normalizeLinkedinUrl(u);
  return null;
}

function pickTwitter(urls: readonly string[] | undefined): string | null {
  if (!urls) return null;
  for (const u of urls) if (TWITTER_RE.test(u)) return normalizeTwitterUrl(u);
  return null;
}

function looksLikeDomain(d: string): boolean {
  if (!d) return false;
  if (d.length < 3 || d.length > 253) return false;
  if (!d.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(d);
}

async function* asAsync<T>(
  it: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  // Iterable<T> is structurally compatible — yield each item, awaiting if the
  // source is async.
  for await (const v of it as AsyncIterable<T>) yield v;
}

// Upsert one contact. Mirrors importCsv's row logic — company first (by
// email domain, then by name), then person (deduped via the standard
// email → linkedin → twitter → phone cascade), then link person → company.
export async function importGoogleContacts(
  workspace: Workspace,
  args: ImportGoogleContactsArgs,
): Promise<ImportGoogleContactsResult> {
  return await workspace.db.transaction((db) => importGoogleContactsInDatabase(db, args));
}

async function importGoogleContactsInDatabase(
  db: Workspace["db"],
  args: ImportGoogleContactsArgs,
): Promise<ImportGoogleContactsResult> {
  const stats: ImportGoogleContactsStats = {
    contacts_seen: 0,
    people_created: 0,
    companies_created: 0,
    people_skipped_no_identifier: 0,
  };

  for await (const c of asAsync(args.contacts)) {
    stats.contacts_seen++;
    const source =
      c.origin === "other_contacts"
        ? "google:other-contacts"
        : "google:connections";
    const provenance = { resource_name: c.resource_name, origin: c.origin };

    const emails = (c.emails ?? []).filter((e) => e && e.includes("@"));
    const primaryEmail = emails[0] ?? null;
    const phones = (c.phones ?? []).slice();
    const orgs = c.organizations ?? [];
    const currentOrg = orgs[0];
    const companyName = currentOrg?.name?.trim() || null;
    const jobTitle = currentOrg?.title?.trim() || null;
    const fullName = c.display_name?.trim() || null;
    const linkedin = pickLinkedin(c.urls);
    const twitter = pickTwitter(c.urls);

    // Company: domain from primary email first (matches importCsv), then
    // fall back to organization name.
    let companyId: string | null = null;
    let companyDomain: string | null = null;
    if (primaryEmail) {
      const d = domainFromEmail(primaryEmail);
      if (d) {
        const norm = normalizeDomain(d);
        if (looksLikeDomain(norm)) companyDomain = norm;
      }
    }

    if (companyDomain) {
      const existing = await findRecordByUnique(
        db,
        "companies",
        "domains",
        companyDomain,
      );
      if (existing) {
        companyId = existing;
      } else {
        companyId = await generateUuid(db);
        await insertRecord(db, "companies", companyId);
        await addMultiValue(db, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "domains",
          attribute_type: "domain",
          value: companyDomain,
          source,
          provenance,
        });
        if (companyName) {
          await setSingleValue(db, {
            object_slug: "companies",
            record_id: companyId,
            attribute_slug: "name",
            attribute_type: "text",
            value: companyName,
            source,
            provenance,
          });
        }
        stats.companies_created++;
      }
    } else if (companyName) {
      const existing = await findCompanyByName(db, companyName);
      if (existing) {
        companyId = existing;
      } else {
        companyId = await generateUuid(db);
        await insertRecord(db, "companies", companyId);
        await setSingleValue(db, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "name",
          attribute_type: "text",
          value: companyName,
          source,
          provenance,
        });
        stats.companies_created++;
      }
    }

    // Person — resolve via the standard cascade.
    const lookup = await resolvePersonByIdentifiers(
      (attr, key) => findRecordByUnique(db, "people", attr, key),
      {
        emails,
        linkedin_url: linkedin ?? undefined,
        twitter_url: twitter ?? undefined,
        phones,
      },
      { default_country: args.default_country },
    );

    const linkedinKey = lookup.normalized.linkedin_url;
    const twitterKey = lookup.normalized.twitter_url;
    const phoneKeys = lookup.normalized.phones;
    const hasIdentifier =
      emails.length > 0 || !!linkedinKey || !!twitterKey || phoneKeys.length > 0;
    if (!hasIdentifier) {
      stats.people_skipped_no_identifier++;
      args.onProgress?.({ seen: stats.contacts_seen, stats });
      continue;
    }

    let personId = lookup.person_record_id;
    if (!personId) {
      personId = await generateUuid(db);
      await insertRecord(db, "people", personId);
      for (const e of emails) {
        await addMultiValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "email_addresses",
          attribute_type: "email-address",
          value: e,
          source,
          provenance,
        });
      }
      for (const p of phones) {
        const normalized = normalizePhoneNumber(p, args.default_country);
        if (!normalized) continue;
        await addMultiValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "phone_numbers",
          attribute_type: "phone-number",
          value: p,
          source,
          provenance,
        });
      }
      if (linkedinKey) {
        await setSingleValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "linkedin_url",
          attribute_type: "url",
          value: linkedinKey,
          source,
          provenance,
        });
      }
      if (twitterKey) {
        await setSingleValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "twitter_url",
          attribute_type: "url",
          value: twitterKey,
          source,
          provenance,
        });
      }
      if (fullName) {
        await setSingleValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "name",
          attribute_type: "personal-name",
          value: fullName,
          source,
          provenance,
        });
      }
      if (jobTitle) {
        await setSingleValue(db, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "job_title",
          attribute_type: "text",
          value: jobTitle,
          source,
          provenance,
        });
      }
      stats.people_created++;
    }

    // Always link person → company when we have one, even on an existing
    // person — matches importCsv. The existing person may have been
    // created without company info (CSV with name+email only), and the
    // Google `organizations[]` field is the canonical source.
    if (companyId) {
      await setSingleValue(db, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source,
        provenance,
      });
    }

    args.onProgress?.({ seen: stats.contacts_seen, stats });
  }

  return { stats };
}
