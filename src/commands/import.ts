import { readFileSync, openSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { AcrmError, ERR } from "../lib/errors.js";
import {
  encode,
  normalizeUniqueKey,
  normalizeDomain,
  domainFromEmail,
  type AttributeConfig,
  type AttributeType,
} from "../domain/values.js";
import { resolvePersonByIdentifiers } from "../domain/resolve-person.js";

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const out: CsvRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length === 1 && row[0] === "") continue;
    const obj: CsvRow = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = (row[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

function pick(row: CsvRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v && v.length) return v;
  }
  return null;
}

// Reject placeholder values masquerading as domains: "--", "n/a", "unknown",
// "tbd", random text without a dot, etc. A real domain has at least one dot
// with valid label chars on both sides and a 2+-char TLD. Without this, every
// row with a placeholder gets merged into a single bogus "company".
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function looksLikeDomain(d: string): boolean {
  if (!d || d.length < 4 || d.length > 253) return false;
  if (!DOMAIN_RE.test(d)) return false;
  // Reject TLDs shorter than 2 chars (rules out e.g. "a.b").
  const tld = d.slice(d.lastIndexOf(".") + 1);
  return tld.length >= 2;
}

// (object_slug, attribute_slug, normalized_key) → record_id.
// CSVs typically have far fewer unique companies than rows (Luis's 2.7k-row
// beauty list had ~310 unique domains), so caching collapses ~2,700 SELECTs
// into ~310. Only safe within a single import where we are also the writer.
type LookupCache = Map<string, string>;
function cacheKey(object_slug: string, attribute_slug: string, normalized_key: string) {
  return `${object_slug}\x00${attribute_slug}\x00${normalized_key}`;
}

async function findRecordByUnique(
  lix: Lix,
  cache: LookupCache,
  object_slug: string,
  attribute_slug: string,
  normalized_key: string,
): Promise<string | null> {
  // In-memory cache is authoritative for records inserted in this session
  // (every new record_id is cached when we generate its UUID). A cache miss
  // here means the record either exists in committed state or doesn't exist
  // at all — either way, the buffered inserts don't matter for the answer,
  // so no flush is required.
  const ck = cacheKey(object_slug, attribute_slug, normalized_key);
  const hit = cache.get(ck);
  if (hit) return hit;
  const r = await exec(
    lix,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2
       AND normalized_key = $3 AND active_until IS NULL
     LIMIT 1`,
    [object_slug, attribute_slug, normalized_key],
  );
  const id = (r.rows[0]?.record_id as string | undefined) ?? null;
  if (id) cache.set(ck, id);
  return id;
}

async function findCompanyByName(
  lix: Lix,
  cache: LookupCache,
  name: string,
): Promise<string | null> {
  const key = name.trim().toLowerCase();
  const ck = cacheKey("companies", "name__ci", key);
  const hit = cache.get(ck);
  if (hit) return hit;
  const r = await exec(
    lix,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = 'companies' AND attribute_slug = 'name'
       AND active_until IS NULL
       AND LOWER(normalized_key) = $1
     LIMIT 1`,
    [key],
  );
  const id = (r.rows[0]?.record_id as string | undefined) ?? null;
  if (id) cache.set(ck, id);
  return id;
}

// Each `lix.execute()` becomes its own Lix commit (with snapshot, change-set,
// version-ref bookkeeping). On a 376-row CSV that meant ~3,800 commits and a
// ~100MB file. DataFusion accepts multi-row `VALUES (...), (...), ...` and the
// whole statement collapses into a single commit — that's what this batcher
// exploits. We buffer record + value INSERTs in JS and flush them as one
// statement per table, either every FLUSH_EVERY_ROWS rows or before any
// operation (UPDATE / direct SELECT against committed state) that depends on
// the buffered rows being visible.
// Adaptive flush cadence: small CSVs flush once at the end (one Lix commit
// total, smallest file, fastest), large CSVs flush every N rows to bound
// memory + give the progress bar continuous motion. Threshold picked so the
// pending buffer stays well under ~100 MB resident.
const LARGE_CSV_THRESHOLD = 2000;
const LARGE_CSV_FLUSH_EVERY_ROWS = 50;
// Cap per-statement size as defense against DataFusion statement-length
// limits. 5,000 values × 12 placeholders = 60,000 params per statement;
// tested fine, leaves headroom.
const MAX_BATCH_VALUES = 5000;

type PendingRecord = { object_slug: string; record_id: string };
type PendingValue = {
  id: string;
  object_slug: string;
  record_id: string;
  attribute_slug: string;
  value_json: string;
  attribute_type: AttributeType;
  active_from: string;
  normalized_key: string | null;
  ref_object: string | null;
  ref_record_id: string | null;
  source: string;
  provenance_json: string;
};

class WriteBatcher {
  private records: PendingRecord[] = [];
  private values: PendingValue[] = [];
  // Dedupe within a session: (record_id|attribute|normalized) for values we've
  // already enqueued. Prevents the same (person, email) being queued twice
  // when the same row references already-queued data.
  private enqueuedMulti = new Set<string>();

  constructor(private lix: Lix) {}

  enqueueRecord(r: PendingRecord) {
    this.records.push(r);
  }

  /**
   * Enqueue a value. Returns false if a value with this normalized_key already
   * exists for this record in the pending buffer (caller can skip).
   */
  enqueueValue(v: PendingValue): boolean {
    if (v.normalized_key) {
      const k = `${v.record_id}\x00${v.attribute_slug}\x00${v.normalized_key}`;
      if (this.enqueuedMulti.has(k)) return false;
      this.enqueuedMulti.add(k);
    }
    this.values.push(v);
    return true;
  }

  get size(): number {
    return this.records.length + this.values.length;
  }

  async flush(): Promise<void> {
    if (this.records.length) await this.flushRecords();
    if (this.values.length) await this.flushValues();
    this.enqueuedMulti.clear();
  }

  private async flushRecords(): Promise<void> {
    for (let i = 0; i < this.records.length; i += MAX_BATCH_VALUES) {
      const chunk = this.records.slice(i, i + MAX_BATCH_VALUES);
      const placeholders = chunk
        .map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`)
        .join(", ");
      const params: LixRuntimeValue[] = chunk.flatMap((r) => [r.object_slug, r.record_id]);
      await exec(
        this.lix,
        `INSERT INTO acrm_record (object_slug, record_id) VALUES ${placeholders}`,
        params,
      );
    }
    this.records = [];
  }

  private async flushValues(): Promise<void> {
    const COLS = 12;
    for (let i = 0; i < this.values.length; i += MAX_BATCH_VALUES) {
      const chunk = this.values.slice(i, i + MAX_BATCH_VALUES);
      const placeholders = chunk
        .map((_, j) => {
          const base = j * COLS;
          return `(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(", ")})`;
        })
        .join(", ");
      const params: LixRuntimeValue[] = chunk.flatMap((v) => [
        v.id,
        v.object_slug,
        v.record_id,
        v.attribute_slug,
        v.value_json,
        v.attribute_type,
        v.active_from,
        v.normalized_key,
        v.ref_object,
        v.ref_record_id,
        v.source,
        v.provenance_json,
      ]);
      await exec(
        this.lix,
        `INSERT INTO acrm_value
          (id, object_slug, record_id, attribute_slug, value_json, attribute_type,
           active_from, normalized_key, ref_object, ref_record_id, source, provenance_json)
         VALUES ${placeholders}`,
        params,
      );
    }
    this.values = [];
  }
}

async function insertRecord(
  batcher: WriteBatcher,
  object_slug: string,
  record_id: string,
): Promise<void> {
  batcher.enqueueRecord({ object_slug, record_id });
}

function buildValueRow(
  id: string,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value_json: Record<string, unknown>;
    source: string;
    provenance: Record<string, unknown>;
  },
): PendingValue {
  const normalized = normalizeUniqueKey(args.attribute_type, args.value_json);
  const ref =
    args.attribute_type === "record-reference"
      ? {
          ref_object: (args.value_json.target_object as string) ?? null,
          ref_record_id: (args.value_json.target_record_id as string) ?? null,
        }
      : { ref_object: null, ref_record_id: null };
  return {
    id,
    object_slug: args.object_slug,
    record_id: args.record_id,
    attribute_slug: args.attribute_slug,
    value_json: JSON.stringify(args.value_json),
    attribute_type: args.attribute_type,
    active_from: nowIso(),
    normalized_key: normalized,
    ref_object: ref.ref_object,
    ref_record_id: ref.ref_record_id,
    source: args.source,
    provenance_json: JSON.stringify(args.provenance),
  };
}

async function getAttribute(
  lix: Lix,
  object_slug: string,
  attribute_slug: string,
): Promise<{ attribute_type: AttributeType; config?: AttributeConfig } | null> {
  const r = await exec(
    lix,
    "SELECT attribute_type, config_json FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [object_slug, attribute_slug],
  );
  const row = r.rows[0];
  if (!row) return null;
  let config: AttributeConfig | undefined;
  const raw = row.config_json as string | null | undefined;
  if (raw) {
    try {
      config = JSON.parse(raw) as AttributeConfig;
    } catch {
      config = undefined;
    }
  }
  return { attribute_type: row.attribute_type as AttributeType, config };
}

async function setSingleValue(
  lix: Lix,
  batcher: WriteBatcher,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
    attribute_config?: AttributeConfig;
    // When true, the record was created in this import and cannot have
    // pre-existing active values — skip the closing UPDATE round-trip and
    // enqueue the INSERT into the batch.
    isFresh?: boolean;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value, args.attribute_config);
  if (!args.isFresh) {
    // The record may have pre-existing values that need to be closed before
    // we insert the replacement. Flush pending INSERTs first so the UPDATE
    // sees a consistent view, then run UPDATE + INSERT immediately.
    await batcher.flush();
    await exec(
      lix,
      `UPDATE acrm_value SET active_until = $1
       WHERE object_slug = $2 AND record_id = $3 AND attribute_slug = $4 AND active_until IS NULL`,
      [nowIso(), args.object_slug, args.record_id, args.attribute_slug],
    );
  }
  const id = await generateUuid(lix);
  batcher.enqueueValue(buildValueRow(id, { ...args, value_json }));
}

async function addMultiValue(
  lix: Lix,
  batcher: WriteBatcher,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
    attribute_config?: AttributeConfig;
    // When true, the record was created in this import — skip the dedupe
    // SELECT (it cannot have pre-existing values).
    isFresh?: boolean;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value, args.attribute_config);
  const normalized = normalizeUniqueKey(args.attribute_type, value_json);
  if (!args.isFresh && normalized) {
    // Existing record — flush so the SELECT sees in-flight inserts (the same
    // (record, attr, value) might have been added earlier in this session and
    // still be in the buffer), then dedupe against committed state.
    await batcher.flush();
    const exists = await exec(
      lix,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
         AND normalized_key = $4 AND active_until IS NULL LIMIT 1`,
      [args.object_slug, args.record_id, args.attribute_slug, normalized],
    );
    if (exists.rows.length) return;
  }
  const id = await generateUuid(lix);
  batcher.enqueueValue(buildValueRow(id, { ...args, value_json }));
}

type Stats = {
  rows: number;
  companies_created: number;
  people_created: number;
  deals_created: number;
  people_skipped_no_identifier: number;
  warnings?: string[];
};

const DOMAIN_HEADERS = ["domain", "website", "company_domain"] as const;
const COMPANY_NAME_HEADERS = ["company", "company_name", "organization"] as const;

// Email column matcher. Accepts:
//   email, email_address, email_addresses
//   work_email, work_email_1, work_email_2, ...
//   personal_email, personal_email_1, ...
//   primary_email[_N], email_N, other_emails
// other_emails (and the *_addresses plural) may be comma/semicolon-separated.
const EMAIL_HEADER_RE = /^(?:(?:work|personal|primary|business|other)_)?email(?:_address)?(?:es)?(?:_\d+)?$/;
const EMAIL_SPLIT_RE = /[,;]\s*/;

// Linkedin column matcher (header-based). We also probe values for
// linkedin.com when the header didn't match — covers `profile_url` etc.
const LINKEDIN_HEADER_RE = /^(?:linkedin(?:_url|_profile)?|li_url)$/;
const TWITTER_HEADER_RE = /^(?:twitter(?:_url)?|x(?:_url)?)$/;

function collectEmails(row: CsvRow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of Object.keys(row)) {
    if (!EMAIL_HEADER_RE.test(k)) continue;
    const raw = row[k];
    if (!raw) continue;
    for (const piece of raw.split(EMAIL_SPLIT_RE)) {
      const e = piece.trim();
      if (!e || e.indexOf("@") < 0) continue;
      const lower = e.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(e);
    }
  }
  return out;
}

function findLinkedin(row: CsvRow): string | null {
  for (const k of Object.keys(row)) {
    if (LINKEDIN_HEADER_RE.test(k) && row[k]) return row[k]!;
  }
  // value-based fallback: any column whose value looks like a linkedin URL.
  // Handles arbitrary header names like `profile_url`, `li`, `social_link`.
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && /(?:^|[/.@])linkedin\.com\//i.test(v)) return v;
  }
  return null;
}

function findTwitter(row: CsvRow): string | null {
  for (const k of Object.keys(row)) {
    if (TWITTER_HEADER_RE.test(k) && row[k]) return row[k]!;
  }
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && /(?:^|[/.@])(?:twitter\.com|x\.com)\//i.test(v)) return v;
  }
  return null;
}

type DetectedColumns = {
  email_headers: string[];
  linkedin_headers: string[];
  twitter_headers: string[];
  domain_headers: string[];
  company_name_headers: string[];
  linkedin_by_value: boolean;
  twitter_by_value: boolean;
};

function detectColumns(rows: CsvRow[]): DetectedColumns {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const email_headers = headers.filter((h) => EMAIL_HEADER_RE.test(h));
  const linkedin_headers = headers.filter((h) => LINKEDIN_HEADER_RE.test(h));
  const twitter_headers = headers.filter((h) => TWITTER_HEADER_RE.test(h));
  const domain_headers = headers.filter((h) => (DOMAIN_HEADERS as readonly string[]).includes(h));
  const company_name_headers = headers.filter((h) => (COMPANY_NAME_HEADERS as readonly string[]).includes(h));
  // Sniff first ~50 rows for value-based fallbacks
  const sample = rows.slice(0, 50);
  const linkedin_by_value =
    linkedin_headers.length === 0 &&
    sample.some((r) => Object.values(r).some((v) => v && /(?:^|[/.@])linkedin\.com\//i.test(v)));
  const twitter_by_value =
    twitter_headers.length === 0 &&
    sample.some((r) => Object.values(r).some((v) => v && /(?:^|[/.@])(?:twitter\.com|x\.com)\//i.test(v)));
  return {
    email_headers,
    linkedin_headers,
    twitter_headers,
    domain_headers,
    company_name_headers,
    linkedin_by_value,
    twitter_by_value,
  };
}

function diagnoseEmptyImport(
  rows: CsvRow[],
  detected: DetectedColumns,
  stats: Stats,
): string[] {
  const warnings: string[] = [];
  const hasPersonHeader =
    detected.email_headers.length > 0 ||
    detected.linkedin_headers.length > 0 ||
    detected.twitter_headers.length > 0 ||
    detected.linkedin_by_value ||
    detected.twitter_by_value;
  const hasCompanyHeader =
    detected.domain_headers.length > 0 ||
    detected.email_headers.length > 0 ||
    detected.company_name_headers.length > 0;
  if (!hasPersonHeader) {
    warnings.push(
      `no person-identifier column found — people not created. Accepted: email | email_address | work_email[_N] | personal_email[_N] | primary_email[_N] | other_emails | linkedin_url | linkedin | twitter_url | x_url (or any column whose values are linkedin.com / x.com URLs).`,
    );
  } else if (stats.people_created === 0 && stats.people_skipped_no_identifier === rows.length) {
    warnings.push(
      `person-identifier columns were present (${[
        ...detected.email_headers,
        ...detected.linkedin_headers,
        ...detected.twitter_headers,
        ...(detected.linkedin_by_value ? ["<linkedin-by-value>"] : []),
        ...(detected.twitter_by_value ? ["<twitter-by-value>"] : []),
      ].join(", ")}) but every row had empty values for them — people not created.`,
    );
  }
  if (!hasCompanyHeader) {
    warnings.push(
      `no company-identifier column found — companies not created. Accepted: ${DOMAIN_HEADERS.join(" | ")} | ${COMPANY_NAME_HEADERS.join(" | ")}.`,
    );
  }
  if (warnings.length === 0 && stats.companies_created + stats.people_created + stats.deals_created === 0) {
    warnings.push(
      `0 records created from ${rows.length} rows — recognized columns were present but yielded no usable values`,
    );
  }
  return warnings;
}

async function importRow(
  lix: Lix,
  batcher: WriteBatcher,
  cache: LookupCache,
  row: CsvRow,
  source: string,
  rowIndex: number,
  stats: Stats,
): Promise<void> {
  const provenance = { row: rowIndex };

  const emails = collectEmails(row);
  const primaryEmail = emails[0] ?? null;
  const composed = [pick(row, "first_name"), pick(row, "last_name")]
    .filter(Boolean)
    .join(" ")
    .trim();
  const fullName =
    pick(row, "name", "full_name", "person_name", "who", "contact", "contact_name") ??
    (composed.length ? composed : null);
  const companyName = pick(row, "company", "company_name", "organization");
  const domainRaw = pick(row, "domain", "website", "company_domain");
  const jobTitle = pick(row, "job_title", "title", "role");
  const linkedin = findLinkedin(row);
  const twitter = findTwitter(row);

  // company
  let companyId: string | null = null;
  let companyDomain: string | null = null;
  if (domainRaw) {
    const norm = normalizeDomain(domainRaw);
    if (looksLikeDomain(norm)) companyDomain = norm;
    // Otherwise it's a placeholder like "--", "n/a", "unknown" — fall through
    // and try the email or company-name path. The first time we saw this bug,
    // 18 rows in a CSV had `company_domain = "--"`; all 18 got merged into one
    // company because "--" passed as a dedup key.
  }
  if (!companyDomain && primaryEmail) {
    const fromEmail = domainFromEmail(primaryEmail);
    if (fromEmail && looksLikeDomain(fromEmail)) companyDomain = fromEmail;
  }

  if (companyDomain) {
    const existing = await findRecordByUnique(lix, cache, "companies", "domains", companyDomain);
    if (existing) {
      companyId = existing;
    } else {
      companyId = await generateUuid(lix);
      await insertRecord(batcher, "companies", companyId);
      await addMultiValue(lix, batcher, {
        object_slug: "companies",
        record_id: companyId,
        attribute_slug: "domains",
        attribute_type: "domain",
        value: companyDomain,
        source,
        provenance,
        isFresh: true,
      });
      cache.set(cacheKey("companies", "domains", companyDomain), companyId);
      if (companyName) {
        await setSingleValue(lix, batcher, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "name",
          attribute_type: "text",
          value: companyName,
          source,
          provenance,
          isFresh: true,
        });
      }
      stats.companies_created++;
    }
  } else if (companyName) {
    // no domain on this row — dedupe by case-insensitive name
    const existing = await findCompanyByName(lix, cache, companyName);
    if (existing) {
      companyId = existing;
    } else {
      companyId = await generateUuid(lix);
      await insertRecord(batcher, "companies", companyId);
      await setSingleValue(lix, batcher, {
        object_slug: "companies",
        record_id: companyId,
        attribute_slug: "name",
        attribute_type: "text",
        value: companyName,
        source,
        provenance,
        isFresh: true,
      });
      cache.set(cacheKey("companies", "name__ci", companyName.trim().toLowerCase()), companyId);
      stats.companies_created++;
    }
  }

  // person — identified by email, then LinkedIn URL, then Twitter/X URL.
  // Cascade lives in resolvePersonByIdentifiers (shared with transcript import).
  let personId: string | null = null;
  const personLookup = await resolvePersonByIdentifiers(
    (attr, key) => findRecordByUnique(lix, cache, "people", attr, key),
    {
      emails,
      linkedin_url: linkedin ?? undefined,
      twitter_url: twitter ?? undefined,
    },
  );
  const linkedinKey = personLookup.normalized.linkedin_url;
  const twitterKey = personLookup.normalized.twitter_url;
  if (emails.length || linkedinKey || twitterKey) {
    personId = personLookup.person_record_id;
    let personIsFresh = false;
    if (!personId) {
      personIsFresh = true;
      personId = await generateUuid(lix);
      await insertRecord(batcher, "people", personId);
      for (const e of emails) {
        await addMultiValue(lix, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "email_addresses",
          attribute_type: "email-address",
          value: e,
          source,
          provenance,
          isFresh: true,
        });
        cache.set(cacheKey("people", "email_addresses", e.trim().toLowerCase()), personId);
      }
      if (linkedinKey) {
        await setSingleValue(lix, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "linkedin_url",
          attribute_type: "url",
          value: linkedinKey,
          source,
          provenance,
          isFresh: true,
        });
        cache.set(cacheKey("people", "linkedin_url", linkedinKey), personId);
      }
      if (twitterKey) {
        await setSingleValue(lix, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "twitter_url",
          attribute_type: "url",
          value: twitterKey,
          source,
          provenance,
          isFresh: true,
        });
        cache.set(cacheKey("people", "twitter_url", twitterKey), personId);
      }
      if (fullName) {
        await setSingleValue(lix, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "name",
          attribute_type: "personal-name",
          value: fullName,
          source,
          provenance,
          isFresh: true,
        });
      }
      if (jobTitle) {
        await setSingleValue(lix, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "job_title",
          attribute_type: "text",
          value: jobTitle,
          source,
          provenance,
          isFresh: true,
        });
      }
      stats.people_created++;
    }

    if (companyId) {
      await setSingleValue(lix, batcher, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source,
        provenance,
        isFresh: personIsFresh,
      });
    }
  } else {
    stats.people_skipped_no_identifier++;
  }

  // deal (optional)
  const dealName = pick(row, "deal_name", "deal");
  if (dealName) {
    const dealId = await generateUuid(lix);
    await insertRecord(batcher, "deals", dealId);
    await setSingleValue(lix, batcher, {
      object_slug: "deals",
      record_id: dealId,
      attribute_slug: "name",
      attribute_type: "text",
      value: dealName,
      source,
      provenance,
      isFresh: true,
    });
    const stage = pick(row, "deal_stage", "stage");
    if (stage) {
      const attr = await getAttribute(lix, "deals", "stage");
      if (attr) {
        await setSingleValue(lix, batcher, {
          object_slug: "deals",
          record_id: dealId,
          attribute_slug: "stage",
          attribute_type: attr.attribute_type,
          attribute_config: attr.config,
          value: stage,
          source,
          provenance,
          isFresh: true,
        });
      }
    }
    const dealValue = pick(row, "deal_value", "value");
    if (dealValue) {
      await setSingleValue(lix, batcher, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "value",
        attribute_type: "currency",
        value: dealValue,
        source,
        provenance,
        isFresh: true,
      });
    }
    const closeDate = pick(row, "close_date", "deal_close_date");
    if (closeDate) {
      await setSingleValue(lix, batcher, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "close_date",
        attribute_type: "date",
        value: closeDate,
        source,
        provenance,
        isFresh: true,
      });
    }
    const nextStep = pick(row, "next_step", "deal_next_step");
    if (nextStep) {
      await setSingleValue(lix, batcher, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "next_step",
        attribute_type: "text",
        value: nextStep,
        source,
        provenance,
        isFresh: true,
      });
    }
    if (companyId) {
      await setSingleValue(lix, batcher, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "associated_company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source,
        provenance,
        isFresh: true,
      });
    }
    if (personId) {
      await addMultiValue(lix, batcher, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "associated_people",
        attribute_type: "record-reference",
        value: { target_object: "people", target_record_id: personId },
        source,
        provenance,
        isFresh: true,
      });
    }
    stats.deals_created++;
  }
}

// Test whether a TCP port is free on 127.0.0.1 by attempting to bind a
// throwaway server. Returns true if bind succeeded (and we then released it).
async function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

// Find the first free port starting at `start`, searching up to `range` ports.
// Returns null if every candidate is busy.
async function findOpenPort(start: number, range: number): Promise<number | null> {
  for (let p = start; p < start + range; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

// Poll http://127.0.0.1:port/ until it responds or we hit the deadline.
// Returns true if the server became reachable within `timeoutMs`.
async function waitForUiReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 500 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Exposed so other import subcommands (e.g. `import linkedin`, `import x`)
// can attach themselves to the same `import` parent without redefining it.
export function getOrCreateImportCommand(program: Command): Command {
  const existing = program.commands.find((c) => c.name() === "import");
  if (existing) return existing;
  return program
    .command("import")
    .description(
      "import data into the .acrm file (creates people + companies; deals only when the CSV has deal columns)",
    );
}

export function registerImport(program: Command): void {
  const importCmd = getOrCreateImportCommand(program);

  importCmd
    .command("csv <path>")
    .description(
      "import a CSV. Creates one person per email, LinkedIn URL, or Twitter/X URL, and one company per domain. Creates a deal only when the CSV has a 'deal_name' or 'deal' column — leads alone do not become deals.",
    )
    .option("-p, --port <port>", "port for the UI server", "3737")
    .option("--no-ui", "do not launch the UI after import")
    .option("--no-open", "do not auto-open the browser when launching the UI")
    .addHelpText(
      "after",
      `
Recognized columns (header is trim+lowercase only — use snake_case, not "Company Name"):

  Person     email | email_address | email_addresses
             work_email[_N] | personal_email[_N] | primary_email[_N]
             other_emails  (comma/semicolon-separated)
             name | full_name | person_name | who | contact | contact_name
                 (or first_name + last_name)
             job_title | title | role
             linkedin_url | linkedin | linkedin_profile | li_url
                 (or any column whose values are linkedin.com URLs)
             twitter_url | twitter | x_url | x
                 (or any column whose values are x.com / twitter.com URLs)

  Company    company | company_name | organization
             domain | website | company_domain

  Deal       deal_name | deal                 (presence triggers deal creation)
             deal_stage | stage
             deal_value | value
             close_date | deal_close_date
             next_step | deal_next_step

Identity:
  - companies are deduplicated by normalized domain (or domain-from-email).
    When a row has a company name but no domain/email, the company is
    deduplicated by case-insensitive name instead.
  - people are deduplicated in priority order: lowercased email, then canonical
    LinkedIn URL, then canonical Twitter/X URL. URLs are normalized by stripping
    protocol/www/query/fragment/trailing-slash; twitter.com is unified to x.com;
    bare handles ("@foo") are accepted for twitter and become "x.com/foo"
  - rows with none of email/linkedin/twitter skip person creation
  - rows without a domain, email, or company name skip company creation
`,
    )
    .action(
      async (
        csvPath: string,
        opts: { port: string; ui: boolean; open: boolean },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        const port = Number(opts.port);
        if (opts.ui && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
          fail(`invalid port: ${opts.port}`, ERR.IMPORT);
          process.exit(1);
        }
        let lix: Awaited<ReturnType<typeof openWorkspace>> | null = null;
        try {
          const abs = path.resolve(csvPath);
          const text = readFileSync(abs, "utf8");
          const rows = parseCsv(text);
          const source = `csv:${path.basename(abs)}`;
          const detected = detectColumns(rows);
          // Progress always goes to stderr; the final structured result goes
          // to stdout. Gating progress on `process.stderr.isTTY` hid all
          // output when acrm was invoked from Claude Code / CI / piped
          // shells, where stderr is captured but is not a TTY. Format adapts
          // instead: \r-overwrite when stderr is a real terminal, newline
          // lines (throttled) when it's a pipe.
          const stderrTty = process.stderr.isTTY === true;
          const showProgress = true;
          const progressThrottleMs = stderrTty ? 300 : 1500;
          const writeProgress = (line: string, final: boolean) => {
            if (stderrTty) {
              process.stderr.write(`\r${line}`);
              if (final) process.stderr.write("\n");
            } else {
              process.stderr.write(`${line}\n`);
            }
          };
          if (showProgress) {
            const personHints = [
              ...detected.email_headers,
              ...detected.linkedin_headers,
              ...detected.twitter_headers,
              ...(detected.linkedin_by_value ? ["<linkedin-by-value>"] : []),
              ...(detected.twitter_by_value ? ["<twitter-by-value>"] : []),
            ];
            const companyHints = [...detected.domain_headers, ...detected.company_name_headers];
            process.stderr.write(
              `parsed ${rows.length} rows from ${path.basename(abs)}\n`,
            );
            process.stderr.write(
              `  person identifiers: ${personHints.length ? personHints.join(", ") : "(none — people will be skipped)"}\n`,
            );
            process.stderr.write(
              `  company identifiers: ${companyHints.length ? companyHints.join(", ") : "(none — companies will be skipped)"}\n`,
            );
            process.stderr.write(`opening workspace…\n`);
          }
          lix = await openWorkspace({ workspace: root.workspace });
          const stats: Stats = {
            rows: rows.length,
            companies_created: 0,
            people_created: 0,
            deals_created: 0,
            people_skipped_no_identifier: 0,
          };
          const cache: LookupCache = new Map();
          const batcher = new WriteBatcher(lix);
          // Small CSVs accumulate everything and flush once at the end (one
          // Lix commit, smallest file, fastest). Large CSVs flush every N
          // rows to bound memory + keep the progress bar advancing.
          const flushEvery =
            rows.length > LARGE_CSV_THRESHOLD
              ? LARGE_CSV_FLUSH_EVERY_ROWS
              : Number.POSITIVE_INFINITY;
          let lastTick = 0;
          for (let i = 0; i < rows.length; i++) {
            await importRow(lix, batcher, cache, rows[i]!, source, i + 1, stats);
            if ((i + 1) % flushEvery === 0) {
              await batcher.flush();
            }
            // First row prints immediately so the user sees something within
            // ~100ms; after that we throttle.
            const now = Date.now();
            const isLast = i === rows.length - 1;
            if (showProgress && (lastTick === 0 || now - lastTick > progressThrottleMs || isLast)) {
              writeProgress(
                `importing… ${i + 1} / ${rows.length} rows  (people: ${stats.people_created}, companies: ${stats.companies_created}, deals: ${stats.deals_created})`,
                isLast,
              );
              lastTick = now;
            }
          }
          // Final flush. When we deferred everything to the end (one-commit
          // mode), the buffer is large and this can take several seconds —
          // print a status line so the user doesn't see a silent stall.
          const pendingAtFlush = batcher.size;
          if (showProgress && pendingAtFlush > 100) {
            process.stderr.write(
              `finalizing ${pendingAtFlush.toLocaleString()} records (this can take a few seconds)…\n`,
            );
          }
          const flushStart = Date.now();
          await batcher.flush();
          if (showProgress && pendingAtFlush > 100) {
            process.stderr.write(
              `  done in ${((Date.now() - flushStart) / 1000).toFixed(1)}s\n`,
            );
          }
          const warnings = diagnoseEmptyImport(rows, detected, stats);
          if (warnings.length) {
            stats.warnings = warnings;
            if (!isJson()) {
              for (const w of warnings) {
                process.stderr.write(`warning: ${w}\n`);
              }
            }
          }
          // close the parent's lix handle before spawning the UI child so the
          // SQLite file isn't held open by two processes.
          await lix.close();
          lix = null;
          let ui: { pid: number; url: string; stop: string } | null = null;
          let uiError: string | null = null;
          if (opts.ui) {
            const resolved = root.workspace
              ? root.workspace.endsWith(".acrm")
                ? root.workspace
                : root.workspace + ".acrm"
              : (findWorkspace() ?? "workspace.acrm");
            const absWorkspace = path.resolve(resolved);

            // If the requested port is busy, walk up a small range so a
            // forgotten earlier UI doesn't silently swallow this one.
            let effectivePort = port;
            if (!(await isPortFree(port))) {
              const fallback = await findOpenPort(port + 1, 20);
              if (fallback === null) {
                uiError = `port ${port} and ${port + 1}..${port + 20} are all busy — UI not started. Stop the existing server (e.g. lsof -nP -iTCP:${port} -sTCP:LISTEN) or rerun with -p <port>.`;
              } else {
                if (showProgress) {
                  process.stderr.write(
                    `UI: port ${port} busy, starting on ${fallback} instead\n`,
                  );
                }
                effectivePort = fallback;
              }
            }

            if (uiError === null) {
              const url = `http://localhost:${effectivePort}`;
              // Capture child stderr to a temp file so we can surface real
              // errors if the server crashes during startup (the old code
              // used stdio: "ignore" and silently lost everything).
              const errLogPath = path.join(
                tmpdir(),
                `acrm-ui-${process.pid}-${effectivePort}.err.log`,
              );
              const errFd = openSync(errLogPath, "w");
              const args = [
                ...process.execArgv,
                process.argv[1]!,
                "-w",
                absWorkspace,
                "ui",
                "-p",
                String(effectivePort),
              ];
              if (!opts.open) args.push("--no-open");
              const child = spawn(process.execPath, args, {
                detached: true,
                stdio: ["ignore", "ignore", errFd],
              });
              child.unref();
              if (showProgress) {
                process.stderr.write(`UI: starting at ${url} …\n`);
              }
              const ready = await waitForUiReady(effectivePort, 5000);
              if (ready) {
                ui = {
                  pid: child.pid ?? -1,
                  url,
                  stop: `kill ${child.pid ?? "<pid-unknown>"}`,
                };
                // Server is up — we don't need the stderr log; clean up.
                try {
                  unlinkSync(errLogPath);
                } catch {
                  /* ignore */
                }
              } else {
                let detail = "";
                try {
                  const log = readFileSync(errLogPath, "utf8").trim();
                  if (log) detail = `\n  child stderr: ${log.split("\n").slice(-5).join(" / ")}`;
                } catch {
                  /* ignore */
                }
                uiError = `UI didn't respond on ${url} within 5s — child likely crashed.${detail}\n  full log: ${errLogPath}`;
              }
            }

            if (uiError && showProgress) {
              process.stderr.write(`warning: ${uiError}\n`);
            }
          }
          const payload: Record<string, unknown> = { ...stats };
          if (ui) payload.ui = ui;
          if (uiError) payload.ui_error = uiError;
          ok(payload);
          if (!isJson()) {
            const bold = process.env.NO_COLOR ? "" : "\x1b[1m";
            const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
            if (ui) {
              process.stdout.write(
                `\nUI server started in background (pid ${ui.pid}) — ${bold}${ui.url}${reset}\n`,
              );
              process.stdout.write(`  to stop: ${bold}${ui.stop}${reset}\n`);
            } else {
              process.stdout.write(
                `\nNext: ${bold}acrm ui${reset} to validate the import in your browser\n`,
              );
            }
          }
        } catch (e) {
          if (lix) {
            try {
              await lix.close();
            } catch {
              // ignore
            }
          }
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.IMPORT);
          process.exit(1);
        }
      },
    );
}
