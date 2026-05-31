import type { AcrmDatabase, SqlValue } from "../db/types.js";
import { exec } from "../db/execute.js";
import {
  prepareValueInsert,
  type PreparedValueInsert,
} from "../db/value-row.js";
import {
  encode,
  normalizeUniqueKey,
  normalizeDomain,
  normalizePhoneNumber,
  domainFromEmail,
  type AttributeConfig,
  type AttributeType,
} from "../domain/values.js";
import {
  normalizeIdentifiers,
  resolvePersonByIdentifiers,
} from "../domain/resolve-person.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { loadAttribute } from "../workspace/catalog.js";
import type { Workspace } from "../workspace.js";

type CsvRow = Record<string, string>;
type LookupCache = Map<string, string | null>;

const DEFAULT_IMPORT_CONCURRENCY = 10;
const IMPORT_CONCURRENCY_ENV = "ACRM_IMPORT_CONCURRENCY";

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
    if (c === "\n" || c === "\r") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  // strip empty trailing rows produced by stray newlines
  while (rows.length && rows[rows.length - 1]!.every((c) => c === "")) {
    rows.pop();
  }
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const obj: CsvRow = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]!] = (r[j] ?? "").trim();
    }
    return obj;
  });
}

function pick(row: CsvRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v) return v;
  }
  return null;
}

function looksLikeDomain(d: string): boolean {
  if (!d) return false;
  if (d.length < 3 || d.length > 253) return false;
  if (!d.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(d);
}

function cacheKey(object_slug: string, attribute_slug: string, normalized_key: string) {
  return `${object_slug}\x00${attribute_slug}\x00${normalized_key}`;
}

type LookupKey = {
  object_slug: string;
  attribute_slug: string;
  normalized_key: string;
};

async function findRecordByUnique(
  db: AcrmDatabase,
  cache: LookupCache,
  object_slug: string,
  attribute_slug: string,
  normalized_key: string,
): Promise<string | null> {
  const ck = cacheKey(object_slug, attribute_slug, normalized_key);
  if (cache.has(ck)) return cache.get(ck) ?? null;
  const r = await exec(
    db,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2
       AND normalized_key = $3 AND active_until IS NULL
     LIMIT 1`,
    [object_slug, attribute_slug, normalized_key],
  );
  const id = (r.rows[0]?.record_id as string | undefined) ?? null;
  cache.set(ck, id);
  return id;
}

async function findCompanyByName(
  db: AcrmDatabase,
  cache: LookupCache,
  name: string,
): Promise<string | null> {
  const key = name.trim().toLowerCase();
  const ck = cacheKey("companies", "name__ci", key);
  if (cache.has(ck)) return cache.get(ck) ?? null;
  const r = await exec(
    db,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = 'companies' AND attribute_slug = 'name'
       AND active_until IS NULL
       AND LOWER(normalized_key) = $1
     LIMIT 1`,
    [key],
  );
  const id = (r.rows[0]?.record_id as string | undefined) ?? null;
  cache.set(ck, id);
  return id;
}

// Collapse inserts into multi-row VALUES statements. Adaptive cadence: small
// CSVs flush once at the end; large CSVs flush every N rows to bound memory.
const LARGE_CSV_THRESHOLD = 2000;
const LARGE_CSV_FLUSH_EVERY_ROWS = 50;
// 5,000 values × 12 placeholders = 60,000 params per statement; tested fine.
const MAX_BATCH_VALUES = 5000;

type PendingRecord = { object_slug: string; record_id: string };
type PendingValue = PreparedValueInsert;

class WriteBatcher {
  private records: PendingRecord[] = [];
  private values: PendingValue[] = [];
  private enqueuedMulti = new Set<string>();
  private mutex = new AsyncMutex();

  constructor(private db: AcrmDatabase) {}

  async enqueueRecord(r: PendingRecord): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.records.push(r);
    });
  }

  async enqueueValue(v: PendingValue): Promise<boolean> {
    return await this.mutex.runExclusive(() => {
      if (v.normalized_key) {
        const k = `${v.record_id}\x00${v.attribute_slug}\x00${v.normalized_key}`;
        if (this.enqueuedMulti.has(k)) return false;
        this.enqueuedMulti.add(k);
      }
      this.values.push(v);
      return true;
    });
  }

  get size(): number {
    return this.records.length + this.values.length;
  }

  async flush(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.records.length) await this.flushRecords();
      if (this.values.length) await this.flushValues();
      this.enqueuedMulti.clear();
    });
  }

  private async flushRecords(): Promise<void> {
    for (let i = 0; i < this.records.length; i += MAX_BATCH_VALUES) {
      const chunk = this.records.slice(i, i + MAX_BATCH_VALUES);
      const placeholders = chunk
        .map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`)
        .join(", ");
      const params: SqlValue[] = chunk.flatMap((r) => [r.object_slug, r.record_id]);
      await exec(
        this.db,
        `INSERT INTO acrm_record (object_slug, record_id) VALUES ${placeholders}`,
        params,
      );
    }
    this.records = [];
  }

  private async flushValues(): Promise<void> {
    const COLS = 11;
    for (let i = 0; i < this.values.length; i += MAX_BATCH_VALUES) {
      const chunk = this.values.slice(i, i + MAX_BATCH_VALUES);
      const placeholders = chunk
        .map((_, j) => {
          const base = j * COLS;
          return `(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(", ")})`;
        })
        .join(", ");
      const params: SqlValue[] = chunk.flatMap((v) => [
        v.id,
        v.object_slug,
        v.record_id,
        v.attribute_slug,
        v.value_json,
        v.active_from,
        v.normalized_key,
        v.ref_object,
        v.ref_record_id,
        v.source,
        v.provenance_json,
      ]);
      await exec(
        this.db,
        `INSERT INTO acrm_value
          (id, object_slug, record_id, attribute_slug, value_json,
           active_from, normalized_key, ref_object, ref_record_id, source, provenance_json)
         VALUES ${placeholders}`,
        params,
      );
    }
    this.values = [];
  }
}

class AsyncMutex {
  private current: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.current;
    this.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class KeyedLocks {
  private locks = new Map<string, AsyncMutex>();

  async runExclusive<T>(
    keys: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const unique = Array.from(new Set(keys)).sort();
    let run = fn;
    for (let i = unique.length - 1; i >= 0; i--) {
      const key = unique[i]!;
      const next = run;
      run = () => this.lockFor(key).runExclusive(next);
    }
    return await run();
  }

  private lockFor(key: string): AsyncMutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(key, lock);
    }
    return lock;
  }
}

async function insertRecord(
  batcher: WriteBatcher,
  object_slug: string,
  record_id: string,
): Promise<void> {
  await batcher.enqueueRecord({ object_slug, record_id });
}

async function setSingleValue(
  db: AcrmDatabase,
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
    isFresh?: boolean;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value, args.attribute_config);
  if (!args.isFresh) {
    await batcher.flush();
    await exec(
      db,
      `UPDATE acrm_value SET active_until = $1
       WHERE object_slug = $2 AND record_id = $3 AND attribute_slug = $4 AND active_until IS NULL`,
      [nowIso(), args.object_slug, args.record_id, args.attribute_slug],
    );
  }
  const id = await generateUuid(db);
  await batcher.enqueueValue(prepareValueInsert(id, { ...args, value_json }));
}

async function addMultiValue(
  db: AcrmDatabase,
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
    isFresh?: boolean;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value, args.attribute_config);
  const normalized = normalizeUniqueKey(args.attribute_type, value_json);
  if (!args.isFresh && normalized) {
    await batcher.flush();
    const exists = await exec(
      db,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
         AND normalized_key = $4 AND active_until IS NULL LIMIT 1`,
      [args.object_slug, args.record_id, args.attribute_slug, normalized],
    );
    if (exists.rows.length) return;
  }
  const id = await generateUuid(db);
  await batcher.enqueueValue(prepareValueInsert(id, { ...args, value_json }));
}

export type ImportCsvStats = {
  rows: number;
  companies_created: number;
  people_created: number;
  deals_created: number;
  people_skipped_no_identifier: number;
  warnings?: string[];
};

export type ImportCsvTouchedRecord = {
  object_slug: "people" | "companies";
  record_id: string;
};

const DOMAIN_HEADERS = ["domain", "website", "company_domain"] as const;
const COMPANY_NAME_HEADERS = ["company", "company_name", "organization"] as const;

const EMAIL_HEADER_RE = /^(?:(?:work|personal|primary|business|other)_)?email(?:_address)?(?:es)?(?:_\d+)?$/;
const EMAIL_SPLIT_RE = /[,;]\s*/;
const LINKEDIN_HEADER_RE = /^(?:linkedin(?:_url|_profile)?|li_url)$/;
const TWITTER_HEADER_RE = /^(?:twitter(?:_url)?|x(?:_url)?)$/;
const PHONE_HEADER_RE = /^(?:(?:work|personal|primary|business|other|home|mobile|cell)_)?(?:phone|mobile|cell|tel|telephone)(?:_number)?(?:_\d+)?$/;
const PHONE_SPLIT_RE = /[,;]\s*/;

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

function collectPhones(row: CsvRow, defaultCountry?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of Object.keys(row)) {
    if (!PHONE_HEADER_RE.test(k)) continue;
    const raw = row[k];
    if (!raw) continue;
    for (const piece of raw.split(PHONE_SPLIT_RE)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const norm = normalizePhoneNumber(trimmed, defaultCountry);
      if (!norm) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(trimmed);
    }
  }
  return out;
}

function collectLookupKeysForRow(
  row: CsvRow,
  defaultCountry: string | undefined,
): LookupKey[] {
  const keys: LookupKey[] = [];
  const add = (
    object_slug: string,
    attribute_slug: string,
    normalized_key: string | null | undefined,
  ) => {
    if (!normalized_key) return;
    keys.push({ object_slug, attribute_slug, normalized_key });
  };

  const emails = collectEmails(row);
  const primaryEmail = emails[0] ?? null;
  const phones = collectPhones(row, defaultCountry);
  const domainRaw = pick(row, "domain", "website", "company_domain");
  const linkedin = findLinkedin(row);
  const twitter = findTwitter(row);

  let companyDomain: string | null = null;
  if (domainRaw) {
    const norm = normalizeDomain(domainRaw);
    if (looksLikeDomain(norm)) companyDomain = norm;
  }
  if (!companyDomain && primaryEmail) {
    const fromEmail = domainFromEmail(primaryEmail);
    if (fromEmail && looksLikeDomain(fromEmail)) companyDomain = fromEmail;
  }
  add("companies", "domains", companyDomain);

  const normalized = normalizeIdentifiers(
    {
      emails,
      linkedin_url: linkedin ?? undefined,
      twitter_url: twitter ?? undefined,
      phones,
    },
    { default_country: defaultCountry },
  );
  for (const email of normalized.emails) {
    add("people", "email_addresses", email);
  }
  add("people", "linkedin_url", normalized.linkedin_url);
  add("people", "twitter_url", normalized.twitter_url);
  for (const phone of normalized.phones) {
    add("people", "phone_numbers", phone);
  }
  return keys;
}

const LOOKUP_PREFETCH_CHUNK_SIZE = 500;

async function prefetchUniqueLookups(
  db: AcrmDatabase,
  cache: LookupCache,
  rows: readonly CsvRow[],
  defaultCountry: string | undefined,
): Promise<void> {
  const candidates = new Map<string, LookupKey>();
  for (const row of rows) {
    for (const key of collectLookupKeysForRow(row, defaultCountry)) {
      const ck = cacheKey(key.object_slug, key.attribute_slug, key.normalized_key);
      if (!cache.has(ck)) candidates.set(ck, key);
    }
  }
  for (const [ck] of candidates) {
    cache.set(ck, null);
  }

  const groups = new Map<string, LookupKey[]>();
  for (const key of candidates.values()) {
    const groupKey = `${key.object_slug}\x00${key.attribute_slug}`;
    const group = groups.get(groupKey);
    if (group) group.push(key);
    else groups.set(groupKey, [key]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    for (let i = 0; i < group.length; i += LOOKUP_PREFETCH_CHUNK_SIZE) {
      const chunk = group.slice(i, i + LOOKUP_PREFETCH_CHUNK_SIZE);
      const placeholders = chunk.map((_, j) => `$${j + 3}`).join(", ");
      const result = await exec(
        db,
        `SELECT record_id, normalized_key FROM acrm_value
         WHERE object_slug = $1 AND attribute_slug = $2
           AND active_until IS NULL
           AND normalized_key IN (${placeholders})`,
        [
          first.object_slug,
          first.attribute_slug,
          ...chunk.map((key) => key.normalized_key),
        ],
      );
      for (const row of result.rows) {
        const normalizedKey = row.normalized_key as string | undefined;
        const recordId = row.record_id as string | undefined;
        if (!normalizedKey || !recordId) continue;
        cache.set(
          cacheKey(first.object_slug, first.attribute_slug, normalizedKey),
          recordId,
        );
      }
    }
  }
}

export type DetectedColumns = {
  email_headers: string[];
  linkedin_headers: string[];
  twitter_headers: string[];
  phone_headers: string[];
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
  const phone_headers = headers.filter((h) => PHONE_HEADER_RE.test(h));
  const domain_headers = headers.filter((h) => (DOMAIN_HEADERS as readonly string[]).includes(h));
  const company_name_headers = headers.filter((h) => (COMPANY_NAME_HEADERS as readonly string[]).includes(h));
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
    phone_headers,
    domain_headers,
    company_name_headers,
    linkedin_by_value,
    twitter_by_value,
  };
}

function diagnoseEmptyImport(
  rows: CsvRow[],
  detected: DetectedColumns,
  stats: ImportCsvStats,
): string[] {
  const warnings: string[] = [];
  const hasPersonHeader =
    detected.email_headers.length > 0 ||
    detected.linkedin_headers.length > 0 ||
    detected.twitter_headers.length > 0 ||
    detected.phone_headers.length > 0 ||
    detected.linkedin_by_value ||
    detected.twitter_by_value;
  const hasCompanyHeader =
    detected.domain_headers.length > 0 ||
    detected.email_headers.length > 0 ||
    detected.company_name_headers.length > 0;
  if (!hasPersonHeader) {
    warnings.push(
      `no person-identifier column found — people not created. Accepted: email | email_address | work_email[_N] | personal_email[_N] | primary_email[_N] | other_emails | linkedin_url | linkedin | twitter_url | x_url | phone | mobile | phone_number | work_phone[_N] | personal_phone[_N] (or any column whose values are linkedin.com / x.com URLs).`,
    );
  } else if (stats.people_created === 0 && stats.people_skipped_no_identifier === rows.length) {
    warnings.push(
      `person-identifier columns were present (${[
        ...detected.email_headers,
        ...detected.linkedin_headers,
        ...detected.twitter_headers,
        ...detected.phone_headers,
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
  db: AcrmDatabase,
  batcher: WriteBatcher,
  cache: LookupCache,
  row: CsvRow,
  source: string,
  rowIndex: number,
  stats: ImportCsvStats,
  defaultCountry: string | undefined,
): Promise<ImportCsvTouchedRecord[]> {
  const provenance = { row: rowIndex };
  const touched: ImportCsvTouchedRecord[] = [];

  const emails = collectEmails(row);
  const primaryEmail = emails[0] ?? null;
  const phones = collectPhones(row, defaultCountry);
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
  }
  if (!companyDomain && primaryEmail) {
    const fromEmail = domainFromEmail(primaryEmail);
    if (fromEmail && looksLikeDomain(fromEmail)) companyDomain = fromEmail;
  }

  if (companyDomain) {
    const existing = await findRecordByUnique(db, cache, "companies", "domains", companyDomain);
    if (existing) {
      companyId = existing;
    } else {
      companyId = await generateUuid(db);
      await insertRecord(batcher, "companies", companyId);
      await addMultiValue(db, batcher, {
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
        await setSingleValue(db, batcher, {
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
    const existing = await findCompanyByName(db, cache, companyName);
    if (existing) {
      companyId = existing;
    } else {
      companyId = await generateUuid(db);
      await insertRecord(batcher, "companies", companyId);
      await setSingleValue(db, batcher, {
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
  if (companyId) {
    touched.push({ object_slug: "companies", record_id: companyId });
  }

  // person
  let personId: string | null = null;
  const personLookup = await resolvePersonByIdentifiers(
    (attr, key) => findRecordByUnique(db, cache, "people", attr, key),
    {
      emails,
      linkedin_url: linkedin ?? undefined,
      twitter_url: twitter ?? undefined,
      phones,
    },
    { default_country: defaultCountry },
  );
  const linkedinKey = personLookup.normalized.linkedin_url;
  const twitterKey = personLookup.normalized.twitter_url;
  const phoneKeys = personLookup.normalized.phones;
  if (emails.length || linkedinKey || twitterKey || phoneKeys.length) {
    personId = personLookup.person_record_id;
    let personIsFresh = false;
    if (!personId) {
      personIsFresh = true;
      personId = await generateUuid(db);
      await insertRecord(batcher, "people", personId);
      for (const e of emails) {
        await addMultiValue(db, batcher, {
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
      for (const p of phones) {
        const normalized = normalizePhoneNumber(p, defaultCountry);
        if (!normalized) continue;
        await addMultiValue(db, batcher, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "phone_numbers",
          attribute_type: "phone-number",
          attribute_config: { default_country: defaultCountry },
          value: p,
          source,
          provenance,
          isFresh: true,
        });
        cache.set(cacheKey("people", "phone_numbers", normalized), personId);
      }
      if (linkedinKey) {
        await setSingleValue(db, batcher, {
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
        await setSingleValue(db, batcher, {
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
        await setSingleValue(db, batcher, {
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
        await setSingleValue(db, batcher, {
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
      await setSingleValue(db, batcher, {
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
  if (personId) {
    touched.push({ object_slug: "people", record_id: personId });
  }

  // deal (optional)
  const dealName = pick(row, "deal_name", "deal");
  if (dealName) {
    const dealId = await generateUuid(db);
    await insertRecord(batcher, "deals", dealId);
    await setSingleValue(db, batcher, {
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
      const attr = await loadAttribute(db, "deals", "stage");
      if (attr) {
        await setSingleValue(db, batcher, {
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
      await setSingleValue(db, batcher, {
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
      await setSingleValue(db, batcher, {
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
      await setSingleValue(db, batcher, {
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
      await setSingleValue(db, batcher, {
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
      await addMultiValue(db, batcher, {
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
  return touched;
}

function rowLockKeys(
  row: CsvRow,
  defaultCountry: string | undefined,
): string[] {
  const keys: string[] = [];
  const emails = collectEmails(row);
  const primaryEmail = emails[0] ?? null;
  const phones = collectPhones(row, defaultCountry);
  const linkedin = findLinkedin(row);
  const twitter = findTwitter(row);
  const normalized = normalizeIdentifiers(
    {
      emails,
      linkedin_url: linkedin ?? undefined,
      twitter_url: twitter ?? undefined,
      phones,
    },
    { default_country: defaultCountry },
  );

  for (const email of normalized.emails) keys.push(`people:email:${email}`);
  if (normalized.linkedin_url) keys.push(`people:linkedin:${normalized.linkedin_url}`);
  if (normalized.twitter_url) keys.push(`people:twitter:${normalized.twitter_url}`);
  for (const phone of normalized.phones) keys.push(`people:phone:${phone}`);

  const companyName = pick(row, "company", "company_name", "organization");
  const domainRaw = pick(row, "domain", "website", "company_domain");
  let companyDomain: string | null = null;
  if (domainRaw) {
    const norm = normalizeDomain(domainRaw);
    if (looksLikeDomain(norm)) companyDomain = norm;
  }
  if (!companyDomain && primaryEmail) {
    const fromEmail = domainFromEmail(primaryEmail);
    if (fromEmail && looksLikeDomain(fromEmail)) companyDomain = fromEmail;
  }
  if (companyDomain) {
    keys.push(`companies:domain:${companyDomain}`);
  } else if (companyName) {
    keys.push(`companies:name:${companyName.trim().toLowerCase()}`);
  }
  return keys;
}

function importConcurrency(args: ImportCsvArgs): number {
  return normalizePositiveInt(
    args.concurrency ?? process.env[IMPORT_CONCURRENCY_ENV],
    DEFAULT_IMPORT_CONCURRENCY,
  );
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

async function runWithConcurrency(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, total)) },
    async () => {
      while (next < total) {
        const index = next++;
        await worker(index);
      }
    },
  );
  await Promise.all(workers);
}

export type ImportCsvArgs = {
  // Raw CSV text. Caller is responsible for file I/O.
  csvText: string;
  // Source string written to every value's `source` column (typically
  // `csv:<basename>`).
  source: string;

  // ISO country code (e.g. "US") used to parse locally-formatted phone
  // numbers into E.164. Without it, "(415) 555-1234" stays as digits-only
  // and won't dedupe against "+14155551234".
  default_country?: string;

  // Optional progress callbacks. The SDK never writes to process.stderr —
  // these hooks let CLI consumers report progress in their own form.
  onStart?: (info: { total: number; detected: DetectedColumns }) => void;
  onProgress?: (info: { current: number; total: number; stats: ImportCsvStats }) => void;
  onBeforeFinalFlush?: (info: { pending_count: number }) => void;
  onAfterFinalFlush?: (info: { duration_ms: number }) => void;

  // Defaults to 10. Can also be set with ACRM_IMPORT_CONCURRENCY.
  concurrency?: number;
};

export type ImportCsvResult = {
  stats: ImportCsvStats;
  warnings: string[];
  pending_at_final_flush: number;
  touched_records: ImportCsvTouchedRecord[];
};

// Import a CSV string into the workspace. Creates one person per email /
// LinkedIn URL / Twitter URL / phone number, one company per domain (or per
// name when no domain is available), and one deal per row that has
// `deal_name` / `deal`. All writes are batched into multi-row INSERTs and
// flushed adaptively (once-at-end for small CSVs, every-N-rows for large
// CSVs) so file size and memory stay bounded.
export async function importCsv(
  workspace: Workspace,
  args: ImportCsvArgs,
): Promise<ImportCsvResult> {
  const rows = parseCsv(args.csvText);
  const detected = detectColumns(rows);
  args.onStart?.({ total: rows.length, detected });

  return await workspace.db.transaction((db) =>
    importCsvRowsInDatabase(db, rows, detected, args)
  );
}

async function importCsvRowsInDatabase(
  db: Workspace["db"],
  rows: CsvRow[],
  detected: DetectedColumns,
  args: ImportCsvArgs,
): Promise<ImportCsvResult> {
  const stats: ImportCsvStats = {
    rows: rows.length,
    companies_created: 0,
    people_created: 0,
    deals_created: 0,
    people_skipped_no_identifier: 0,
  };
  const cache: LookupCache = new Map();
  await prefetchUniqueLookups(db, cache, rows, args.default_country);
  const batcher = new WriteBatcher(db);
  const rowLocks = new KeyedLocks();
  const touchedRecords = new Map<string, ImportCsvTouchedRecord>();
  const flushEvery =
    rows.length > LARGE_CSV_THRESHOLD
      ? LARGE_CSV_FLUSH_EVERY_ROWS
      : Number.POSITIVE_INFINITY;
  const concurrency = importConcurrency(args);
  let completed = 0;

  await runWithConcurrency(rows.length, concurrency, async (i) => {
    const row = rows[i]!;
    const touched = await rowLocks.runExclusive(
      rowLockKeys(row, args.default_country),
      () =>
        importRow(
          db,
          batcher,
          cache,
          row,
          args.source,
          i + 1,
          stats,
          args.default_country,
        ),
    );
    for (const record of touched) {
      touchedRecords.set(`${record.object_slug}:${record.record_id}`, record);
    }
    completed++;
    if (completed % flushEvery === 0) {
      await batcher.flush();
    }
    args.onProgress?.({ current: completed, total: rows.length, stats });
  });

  const pendingAtFlush = batcher.size;
  args.onBeforeFinalFlush?.({ pending_count: pendingAtFlush });
  const flushStart = Date.now();
  await batcher.flush();
  args.onAfterFinalFlush?.({ duration_ms: Date.now() - flushStart });

  const warnings = diagnoseEmptyImport(rows, detected, stats);
  if (warnings.length) stats.warnings = warnings;

  return {
    stats,
    warnings,
    pending_at_final_flush: pendingAtFlush,
    touched_records: Array.from(touchedRecords.values()),
  };
}
