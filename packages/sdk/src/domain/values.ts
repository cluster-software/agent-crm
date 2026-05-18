import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";
import { AcrmError, ERR } from "../lib/errors.js";

export type AttributeType =
  | "text"
  | "personal-name"
  | "email-address"
  | "phone-number"
  | "domain"
  | "url"
  | "number"
  | "currency"
  | "date"
  | "timestamp"
  | "select"
  | "status"
  | "record-reference";

export type ValueJson = Record<string, unknown>;

export type StatusOption = { id: string; title: string };

export type AttributeConfig = {
  options?: StatusOption[];
  // Other config keys (target_object, inverse, currency_code, ...) are
  // intentionally not typed here — they're consumed elsewhere.
  [key: string]: unknown;
};

export function resolveStatusOption(
  raw: string,
  options: StatusOption[] | undefined,
): StatusOption | null {
  if (!options || options.length === 0) return null;
  const needle = raw.trim().toLowerCase();
  for (const o of options) {
    if (o.id.toLowerCase() === needle || o.title.toLowerCase() === needle) {
      return { id: o.id, title: o.title };
    }
  }
  return null;
}

export function encode(
  type: AttributeType,
  input: unknown,
  config?: AttributeConfig,
): ValueJson {
  if (input === null || input === undefined) {
    throw new Error(`cannot encode null/undefined for ${type}`);
  }
  switch (type) {
    case "text":
    case "url":
      return { value: String(input).trim() };
    case "personal-name": {
      if (typeof input === "object") return input as ValueJson;
      const full = String(input).trim();
      const parts = full.split(/\s+/);
      const first_name = parts[0] ?? "";
      const last_name = parts.length > 1 ? parts.slice(1).join(" ") : "";
      return { full_name: full, first_name, last_name };
    }
    case "email-address": {
      const raw = String(input).trim();
      const lower = raw.toLowerCase();
      const at = lower.indexOf("@");
      if (at < 0) throw new Error(`invalid email: ${raw}`);
      const local = lower.slice(0, at);
      const domain = lower.slice(at + 1);
      return {
        email_address: lower,
        original_email_address: raw,
        email_domain: domain,
        email_root_domain: rootDomain(domain),
        email_local_specifier: local,
      };
    }
    case "phone-number": {
      const raw = String(input).trim();
      const defaultCountry = config?.default_country as string | undefined;
      const normalized = normalizePhoneNumber(raw, defaultCountry);
      if (!normalized) throw new Error(`invalid phone number: ${raw}`);
      return { phone_number: normalized, original_phone_number: raw };
    }
    case "domain": {
      const d = normalizeDomain(String(input));
      return { domain: d, root_domain: rootDomain(d) };
    }
    case "number":
      return { value: Number(input) };
    case "currency": {
      if (typeof input === "object") return input as ValueJson;
      return { currency_value: Number(input), currency_code: "USD" };
    }
    case "date":
      return { date: String(input).trim() };
    case "timestamp":
      return { timestamp: String(input).trim() };
    case "select":
    case "status": {
      if (typeof input === "object" && input !== null) return input as ValueJson;
      const raw = String(input).trim();
      const match = resolveStatusOption(raw, config?.options);
      if (match) return { id: match.id, title: match.title };
      // If options are configured, reject unknown values rather than silently
      // creating a "free-text" option that can't be filtered with `WHERE
      // id=...`. Pre-0.11 builds coerced into
      // `{title: raw}`, which made `acrm import csv` accept e.g.
      // `deal_stage,sourced` against the locked sales enum without complaint —
      // see the ax-eval write-up.
      if (config?.options && config.options.length > 0) {
        const labels = config.options.map((o) => o.id).join(", ");
        throw new AcrmError(
          `invalid ${type} value: "${raw}" — expected one of: ${labels}`,
          ERR.INVALID_INPUT,
          `To add a new option, run \`acrm attribute edit-options <object>.<slug> add ${raw}\`.`,
        );
      }
      return { title: raw };
    }
    case "record-reference": {
      const v = input as { target_object?: string; target_record_id?: string };
      if (!v?.target_object || !v?.target_record_id) {
        throw new Error("record-reference requires target_object + target_record_id");
      }
      return { target_object: v.target_object, target_record_id: v.target_record_id };
    }
  }
}

export function normalizeUniqueKey(
  type: AttributeType,
  value: ValueJson,
): string | null {
  switch (type) {
    case "email-address":
      return (value.email_address as string | undefined)?.toLowerCase() ?? null;
    case "phone-number":
      return (value.phone_number as string | undefined) ?? null;
    case "domain":
      return (value.domain as string | undefined)?.toLowerCase() ?? null;
    case "url":
      return (value.value as string | undefined)?.toLowerCase() ?? null;
    case "text":
      return (value.value as string | undefined) ?? null;
    default:
      return null;
  }
}

export function recordReferenceTarget(
  value: ValueJson,
): { object: string; record_id: string } | null {
  const t = value.target_object as string | undefined;
  const r = value.target_record_id as string | undefined;
  if (!t || !r) return null;
  return { object: t, record_id: r };
}

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0]!;
  return d;
}

export function rootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

export function domainFromEmail(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

// Parse to E.164 via libphonenumber-js. With `defaultCountry`, a local-format
// number ("(415) 555-1234") resolves to E.164 ("+14155551234"); without it,
// only numbers that already carry a "+<dial-code>" prefix parse cleanly. When
// the parser can't make sense of the input we fall back to a digit-strip
// (preserving a leading `+`) so short codes, extensions, and other oddities
// still produce a stable dedup key instead of getting silently dropped.
export function normalizePhoneNumber(
  input: string,
  defaultCountry?: string,
): string | null {
  const s = input.trim();
  if (!s) return null;
  const country = (defaultCountry?.toUpperCase() || undefined) as
    | CountryCode
    | undefined;
  try {
    const parsed = parsePhoneNumberFromString(s, country);
    if (parsed?.number) return parsed.number;
  } catch {
    // libphonenumber-js can throw on malformed input — fall through.
  }
  const hasPlus = s.startsWith("+");
  const digits = s.replace(/\D+/g, "");
  if (!digits) return null;
  return hasPlus ? `+${digits}` : digits;
}

export function normalizeLinkedinUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  s = s.toLowerCase();
  return s.length ? s : null;
}

export function normalizeTwitterUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  // bare handle: "@foo" or "foo" (no slashes) → x.com/foo
  if (!s.includes("/")) {
    const handle = s.replace(/^@/, "").trim();
    return handle.length ? `x.com/${handle.toLowerCase()}` : null;
  }
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/^twitter\.com\b/i, "x.com");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  s = s.toLowerCase();
  return s.length ? s : null;
}

export type PostPlatform = "linkedin" | "x";

export function sniffPostPlatform(input: string): PostPlatform | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/(?:^|\/\/|\.)linkedin\.com\b/.test(s)) return "linkedin";
  if (/(?:^|\/\/|\.)(?:x\.com|twitter\.com)\b/.test(s)) return "x";
  return null;
}

export function normalizeLinkedinPostUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  s = s.toLowerCase();
  return s.length ? s : null;
}

export function normalizeXPostUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/^twitter\.com\b/i, "x.com");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  s = s.toLowerCase();
  return s.length ? s : null;
}

export function normalizePostUrl(input: string): {
  platform: PostPlatform;
  url: string;
} | null {
  const platform = sniffPostPlatform(input);
  if (!platform) return null;
  const url =
    platform === "linkedin"
      ? normalizeLinkedinPostUrl(input)
      : normalizeXPostUrl(input);
  if (!url) return null;
  return { platform, url };
}
