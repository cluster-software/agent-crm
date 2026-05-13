import { normalizeLinkedinUrl, normalizeTwitterUrl } from "./values.js";

export type PersonIdentifiers = {
  emails?: readonly string[];
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
};

export type IdentifierAttribute =
  | "email_addresses"
  | "linkedin_url"
  | "twitter_url";

export type NormalizedIdentifiers = {
  emails: string[];
  linkedin_url: string | null;
  twitter_url: string | null;
};

export type Lookup = (
  attribute_slug: IdentifierAttribute,
  normalized_key: string,
) => Promise<string | null>;

export type ResolveResult = {
  person_record_id: string | null;
  matched_by: IdentifierAttribute | null;
  matched_key: string | null;
  tried: IdentifierAttribute[];
  normalized: NormalizedIdentifiers;
};

// Why this exists: both /post-call (transcript import) and `acrm import csv`
// resolve people by the same priority — email → linkedin → twitter — but they
// used to implement the cascade independently. The CSV path had all three; the
// transcript path was email-only, so a meeting attendee whose record carried
// only a LinkedIn URL would silently land in `unresolved`. Funnel both through
// this so the next identifier added (phone, handle, …) lands in one place.
export function normalizeIdentifiers(
  ids: PersonIdentifiers,
): NormalizedIdentifiers {
  const seen = new Set<string>();
  const emails: string[] = [];
  const candidates: string[] = [];
  if (ids.email != null) candidates.push(ids.email);
  if (ids.emails) for (const e of ids.emails) candidates.push(e);
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toLowerCase();
    if (!s || !s.includes("@")) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    emails.push(s);
  }
  return {
    emails,
    linkedin_url: ids.linkedin_url
      ? normalizeLinkedinUrl(ids.linkedin_url)
      : null,
    twitter_url: ids.twitter_url
      ? normalizeTwitterUrl(ids.twitter_url)
      : null,
  };
}

export async function resolvePersonByIdentifiers(
  lookup: Lookup,
  ids: PersonIdentifiers,
): Promise<ResolveResult> {
  const normalized = normalizeIdentifiers(ids);
  const tried: IdentifierAttribute[] = [];

  if (normalized.emails.length) {
    for (const email of normalized.emails) {
      const hit = await lookup("email_addresses", email);
      if (hit) {
        return {
          person_record_id: hit,
          matched_by: "email_addresses",
          matched_key: email,
          tried: ["email_addresses"],
          normalized,
        };
      }
    }
    tried.push("email_addresses");
  }

  if (normalized.linkedin_url) {
    const hit = await lookup("linkedin_url", normalized.linkedin_url);
    tried.push("linkedin_url");
    if (hit) {
      return {
        person_record_id: hit,
        matched_by: "linkedin_url",
        matched_key: normalized.linkedin_url,
        tried,
        normalized,
      };
    }
  }

  if (normalized.twitter_url) {
    const hit = await lookup("twitter_url", normalized.twitter_url);
    tried.push("twitter_url");
    if (hit) {
      return {
        person_record_id: hit,
        matched_by: "twitter_url",
        matched_key: normalized.twitter_url,
        tried,
        normalized,
      };
    }
  }

  return {
    person_record_id: null,
    matched_by: null,
    matched_key: null,
    tried,
    normalized,
  };
}
