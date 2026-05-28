import {
  normalizeLinkedinUrl,
  normalizePhoneNumber,
  normalizeTwitterUrl,
} from "./values.js";

export type PersonIdentifiers = {
  emails?: readonly string[];
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
  phones?: readonly string[];
  phone?: string;
};

export type IdentifierAttribute =
  | "email_addresses"
  | "linkedin_url"
  | "twitter_url"
  | "phone_numbers";

export type NormalizedIdentifiers = {
  emails: string[];
  linkedin_url: string | null;
  twitter_url: string | null;
  phones: string[];
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

// Why this exists: both transcript import and `acrm import csv`
// resolve people by the same priority — email → linkedin → twitter → phone —
// but they used to implement the cascade independently. The CSV path had
// email/linkedin/twitter; the transcript path was email-only, so a meeting
// attendee whose record carried only a LinkedIn URL would silently land in
// `unresolved`. Funnel both through this so the next identifier added (handle,
// …) lands in one place.
export type ResolveOptions = {
  // ISO country code (e.g. "US") used to parse locally-formatted phone
  // numbers into E.164. Without it, only numbers that already include a
  // "+<dial-code>" prefix will dedupe correctly.
  default_country?: string;
};

export function normalizeIdentifiers(
  ids: PersonIdentifiers,
  opts: ResolveOptions = {},
): NormalizedIdentifiers {
  const seenEmail = new Set<string>();
  const emails: string[] = [];
  const emailCandidates: string[] = [];
  if (ids.email != null) emailCandidates.push(ids.email);
  if (ids.emails) for (const e of ids.emails) emailCandidates.push(e);
  for (const raw of emailCandidates) {
    if (typeof raw !== "string") continue;
    const s = raw.trim().toLowerCase();
    if (!s || !s.includes("@")) continue;
    if (seenEmail.has(s)) continue;
    seenEmail.add(s);
    emails.push(s);
  }
  const seenPhone = new Set<string>();
  const phones: string[] = [];
  const phoneCandidates: string[] = [];
  if (ids.phone != null) phoneCandidates.push(ids.phone);
  if (ids.phones) for (const p of ids.phones) phoneCandidates.push(p);
  for (const raw of phoneCandidates) {
    if (typeof raw !== "string") continue;
    const n = normalizePhoneNumber(raw, opts.default_country);
    if (!n) continue;
    if (seenPhone.has(n)) continue;
    seenPhone.add(n);
    phones.push(n);
  }
  return {
    emails,
    linkedin_url: ids.linkedin_url
      ? normalizeLinkedinUrl(ids.linkedin_url)
      : null,
    twitter_url: ids.twitter_url
      ? normalizeTwitterUrl(ids.twitter_url)
      : null,
    phones,
  };
}

export async function resolvePersonByIdentifiers(
  lookup: Lookup,
  ids: PersonIdentifiers,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const normalized = normalizeIdentifiers(ids, opts);
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

  if (normalized.phones.length) {
    for (const phone of normalized.phones) {
      const hit = await lookup("phone_numbers", phone);
      if (hit) {
        if (!tried.includes("phone_numbers")) tried.push("phone_numbers");
        return {
          person_record_id: hit,
          matched_by: "phone_numbers",
          matched_key: phone,
          tried,
          normalized,
        };
      }
    }
    tried.push("phone_numbers");
  }

  return {
    person_record_id: null,
    matched_by: null,
    matched_key: null,
    tried,
    normalized,
  };
}
