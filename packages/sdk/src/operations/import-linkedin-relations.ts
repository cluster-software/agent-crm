import type { SqlValue } from "../db/types.js";
import { exec } from "../db/execute.js";
import {
  prepareValueInsert,
  type PreparedValueInsert,
} from "../db/value-row.js";
import {
  encode,
  normalizeDomain,
  normalizeLinkedinUrl,
  type AttributeType,
  type ValueJson,
} from "../domain/values.js";
import { uuidv7 } from "../lib/uuidv7.js";
import { nowIso } from "../lib/time.js";
import type { Workspace } from "../workspace.js";
import { seedAttributes, seedObjects } from "../workspace/seeds.js";

export type LinkedinRelation = {
  object?: string;
  connection_urn?: string | null;
  created_at?: number | string | null;
  first_name?: string | null;
  last_name?: string | null;
  member_id?: string | null;
  member_urn?: string | null;
  headline?: string | null;
  public_identifier?: string | null;
  public_profile_url?: string | null;
  profile_picture_url?: string | null;
  [key: string]: unknown;
};

export type ImportLinkedinRelationsArgs = {
  relations: Iterable<LinkedinRelation>;
};

export type ImportLinkedinRelationsResult = {
  stats: {
    relations_seen: number;
    people_created: number;
    people_updated: number;
    companies_created: number;
    companies_updated: number;
    relations_skipped_no_key: number;
  };
};

type ObjectSlug = "people" | "companies";

type NormalizedCompany = {
  sourceKey: string;
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
};

type NormalizedRelation = {
  relation: LinkedinRelation;
  sourceKey: string;
  linkedinUrl: string | null;
  profilePictureUrl: string | null;
  fullName: string | null;
  headline: string | null;
  connectedAt: string | null;
  company: NormalizedCompany | null;
};

type RecordPlan = {
  objectSlug: ObjectSlug;
  recordId: string;
  created: boolean;
};

type ExistingValues = {
  singleValues: Map<string, ValueJson>;
  multiValues: Set<string>;
};

type ValueInput = {
  object_slug: ObjectSlug;
  record_id: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  value: ValueJson;
  provenance: Record<string, unknown>;
};

const SOURCE = "linkedin-relations-import";
const MAX_BATCH_ROWS = 5000;
const SELECT_CHUNK_SIZE = 500;

export async function importLinkedinRelations(
  workspace: Workspace,
  args: ImportLinkedinRelationsArgs,
): Promise<ImportLinkedinRelationsResult> {
  await ensurePeopleSchema(workspace);

  const stats: ImportLinkedinRelationsResult["stats"] = {
    relations_seen: 0,
    people_created: 0,
    people_updated: 0,
    companies_created: 0,
    companies_updated: 0,
    relations_skipped_no_key: 0,
  };

  const relations: NormalizedRelation[] = [];
  for (const relation of args.relations) {
    stats.relations_seen++;
    const normalized = normalizeRelation(relation);
    if (!normalized) {
      stats.relations_skipped_no_key++;
      continue;
    }
    relations.push(normalized);
  }

  const db = workspace.db;
  const sourceIndex = await loadPeopleBySourceKeys(db, relations.map((relation) => relation.sourceKey));
  const plannedSourceIndex = new Map(sourceIndex);
  const linkedinIndex = await loadPeopleByLinkedinUrl(
    db,
    relations.map((relation) => relation.linkedinUrl).filter((url): url is string => Boolean(url)),
  );
  const plannedLinkedinIndex = new Map(linkedinIndex);
  const companies = uniqueCompanies(relations.map((relation) => relation.company).filter((company): company is NormalizedCompany => Boolean(company)));
  const companySourceIndex = await loadCompaniesBySourceKeys(db, companies.map((company) => company.sourceKey));
  const plannedCompanySourceIndex = new Map(companySourceIndex);
  const companyLinkedinIndex = await loadCompaniesByLinkedinUrl(
    db,
    companies.map((company) => company.linkedinUrl).filter((url): url is string => Boolean(url)),
  );
  const plannedCompanyLinkedinIndex = new Map(companyLinkedinIndex);
  const companyDomainIndex = await loadCompaniesByDomain(
    db,
    companies.map((company) => company.domain).filter((domain): domain is string => Boolean(domain)),
  );
  const plannedCompanyDomainIndex = new Map(companyDomainIndex);
  const companyNameIndex = await loadCompaniesByName(db, companies.map((company) => company.name));
  const plannedCompanyNameIndex = new Map(companyNameIndex);

  const recordsToCreate: Array<{ object_slug: ObjectSlug; record_id: string }> = [];
  const companyPlans = new Map<string, { company: NormalizedCompany; plan: RecordPlan }>();
  const plans: Array<{ relation: NormalizedRelation; plan: RecordPlan }> = [];
  const touchedRecordIds = new Set<string>();
  const touchedCompanyIds = new Set<string>();
  const createdRecordIds = new Set<string>();
  const createdCompanyIds = new Set<string>();

  for (const company of companies) {
    const existingRecordId =
      (company.linkedinUrl ? plannedCompanyLinkedinIndex.get(company.linkedinUrl) : undefined) ??
      (company.domain ? plannedCompanyDomainIndex.get(company.domain) : undefined) ??
      plannedCompanySourceIndex.get(company.sourceKey) ??
      plannedCompanyNameIndex.get(company.name.toLowerCase());
    const recordId = existingRecordId ?? uuidv7();
    const created = existingRecordId == null;
    if (created) {
      recordsToCreate.push({ object_slug: "companies", record_id: recordId });
      createdCompanyIds.add(recordId);
    }
    plannedCompanySourceIndex.set(company.sourceKey, recordId);
    if (company.linkedinUrl) plannedCompanyLinkedinIndex.set(company.linkedinUrl, recordId);
    if (company.domain) plannedCompanyDomainIndex.set(company.domain, recordId);
    plannedCompanyNameIndex.set(company.name.toLowerCase(), recordId);
    touchedCompanyIds.add(recordId);
    companyPlans.set(company.sourceKey, {
      company,
      plan: { objectSlug: "companies", recordId, created },
    });
  }

  for (const relation of relations) {
    const existingRecordId =
      (relation.linkedinUrl ? plannedLinkedinIndex.get(relation.linkedinUrl) : undefined) ??
      plannedSourceIndex.get(relation.sourceKey);
    const recordId = existingRecordId ?? uuidv7();
    const created = existingRecordId == null;
    if (created) {
      recordsToCreate.push({ object_slug: "people", record_id: recordId });
      createdRecordIds.add(recordId);
    }
    plannedSourceIndex.set(relation.sourceKey, recordId);
    if (relation.linkedinUrl) plannedLinkedinIndex.set(relation.linkedinUrl, recordId);
    touchedRecordIds.add(recordId);
    plans.push({ relation, plan: { objectSlug: "people", recordId, created } });
  }

  stats.people_created = createdRecordIds.size;
  stats.companies_created = createdCompanyIds.size;

  const existingValues = await loadExistingValues(db, {
    people: [...touchedRecordIds],
    companies: [...touchedCompanyIds],
  });
  const writer = new LinkedinRelationWriteBatcher(db);
  const changedExistingRecordIds = new Set<string>();
  const changedExistingCompanyIds = new Set<string>();

  for (const record of recordsToCreate) {
    writer.enqueueRecord(record);
  }

  for (const { company, plan } of companyPlans.values()) {
    const provenance = companyProvenance(company);
    let changed = false;
    changed = enqueueMulti(writer, existingValues, plan, "source_keys", "text", company.sourceKey, provenance) || changed;
    changed = enqueueSingleIfMissing(writer, existingValues, plan, "name", "text", company.name, provenance) || changed;
    if (company.domain) {
      changed = enqueueMulti(writer, existingValues, plan, "domains", "domain", company.domain, provenance) || changed;
    }
    if (company.linkedinUrl) {
      changed = enqueueSingleIfMissing(writer, existingValues, plan, "linkedin_url", "url", company.linkedinUrl, provenance) || changed;
    }
    if (!createdCompanyIds.has(plan.recordId) && changed) {
      changedExistingCompanyIds.add(plan.recordId);
    }
  }

  for (const { relation, plan } of plans) {
    const provenance = relationProvenance(relation.relation);
    let changed = false;
    changed = enqueueMulti(writer, existingValues, plan, "source_keys", "text", relation.sourceKey, provenance) || changed;
    if (relation.linkedinUrl) {
      changed = enqueueSingleIfMissing(writer, existingValues, plan, "linkedin_url", "url", relation.linkedinUrl, provenance) || changed;
    }
    if (relation.fullName) {
      changed = enqueueSingleIfMissing(writer, existingValues, plan, "name", "personal-name", relation.fullName, provenance) || changed;
    }
    if (relation.profilePictureUrl) {
      changed = enqueueSingleIfMissing(writer, existingValues, plan, "profile_picture_url", "url", relation.profilePictureUrl, provenance) || changed;
    }
    if (relation.headline) {
      changed = enqueueSingleIfMissing(writer, existingValues, plan, "job_title", "text", relation.headline, provenance) || changed;
    }
    if (relation.connectedAt) {
      changed = enqueueSingleIfMissing(
        writer,
        existingValues,
        plan,
        "linkedin_connected_at",
        "timestamp",
        relation.connectedAt,
        provenance,
      ) || changed;
    }
    if (relation.company) {
      const companyPlan = companyPlans.get(relation.company.sourceKey)?.plan;
      if (companyPlan) {
        changed = enqueueSingleReferenceIfMissing(
          writer,
          existingValues,
          plan,
          "company",
          "companies",
          companyPlan.recordId,
          provenance,
        ) || changed;
        const companyChanged = enqueueReference(
          writer,
          existingValues,
          companyPlan,
          "team",
          "people",
          plan.recordId,
          provenance,
        );
        if (!createdCompanyIds.has(companyPlan.recordId) && companyChanged) {
          changedExistingCompanyIds.add(companyPlan.recordId);
        }
      }
    }
    if (!createdRecordIds.has(plan.recordId) && changed) {
      changedExistingRecordIds.add(plan.recordId);
    }
  }

  stats.people_updated = changedExistingRecordIds.size;
  stats.companies_updated = changedExistingCompanyIds.size;
  await writer.flush();
  return { stats };
}

async function ensurePeopleSchema(workspace: Workspace): Promise<void> {
  await seedObjects(workspace.db);
  await seedAttributes(workspace.db);
}

function normalizeRelation(relation: LinkedinRelation): NormalizedRelation | null {
  const sourceKey = relationSourceKey(relation);
  if (!sourceKey) return null;
  return {
    relation,
    sourceKey,
    linkedinUrl: relationLinkedinUrl(relation),
    profilePictureUrl: relationProfilePictureUrl(relation),
    fullName: relationFullName(relation),
    headline: cleanString(relation.headline),
    connectedAt: relationConnectedAt(relation.created_at),
    company: relationCompany(relation),
  };
}

function relationSourceKey(relation: LinkedinRelation): string | null {
  const key =
    cleanString(relation.member_id) ??
    cleanString(relation.member_urn) ??
    cleanString(relation.connection_urn) ??
    cleanString(relation.public_profile_url) ??
    cleanString(relation.public_identifier);
  return key ? `linkedin:relation:${key}` : null;
}

function relationLinkedinUrl(relation: LinkedinRelation): string | null {
  const explicit = cleanString(relation.public_profile_url);
  if (explicit) return normalizeLinkedinUrl(explicit);
  const publicIdentifier = cleanString(relation.public_identifier);
  return publicIdentifier
    ? normalizeLinkedinUrl(`https://www.linkedin.com/in/${publicIdentifier}/`)
    : null;
}

function relationFullName(relation: LinkedinRelation): string | null {
  const full = [cleanString(relation.first_name), cleanString(relation.last_name)]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  return full || null;
}

function relationProfilePictureUrl(relation: LinkedinRelation): string | null {
  return stringField(relation, [
    "profile_picture_url",
    "profilePictureUrl",
    "profile_image_url",
    "profileImageUrl",
    "picture_url",
    "pictureUrl",
    "avatar_url",
    "avatarUrl",
  ]);
}

function relationConnectedAt(value: LinkedinRelation["created_at"]): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return relationConnectedAt(Number(trimmed));
  const millis = Date.parse(trimmed);
  if (Number.isNaN(millis)) return null;
  return new Date(millis).toISOString();
}

function relationCompany(relation: LinkedinRelation): NormalizedCompany | null {
  const nested =
    objectField(relation, ["company", "organization", "current_company", "currentCompany", "employer"]) ??
    positionObject(relation);
  const explicitName =
    stringField(relation, ["company_name", "companyName", "organization_name", "organizationName", "employer_name", "employerName"]) ??
    (typeof relation.company === "string" ? relation.company : null) ??
    (typeof relation.organization === "string" ? relation.organization : null);
  const name =
    cleanString(explicitName) ??
    stringField(nested, ["name", "company_name", "companyName", "organization_name", "organizationName"]);
  if (!name) return null;

  const explicitLinkedinUrl = stringField(relation, [
    "company_linkedin_url",
    "companyLinkedinUrl",
    "company_url",
    "companyUrl",
    "organization_url",
    "organizationUrl",
  ]);
  const nestedLinkedinUrl = stringField(nested, [
    "linkedin_url",
    "linkedinUrl",
    "company_linkedin_url",
    "companyLinkedinUrl",
    "public_profile_url",
    "publicProfileUrl",
    "url",
  ]);
  const publicIdentifier = stringField(nested, ["public_identifier", "publicIdentifier"]);
  const linkedinUrl = normalizeLinkedinUrl(
    explicitLinkedinUrl ??
    nestedLinkedinUrl ??
    (publicIdentifier ? `https://www.linkedin.com/company/${publicIdentifier}/` : ""),
  );
  const domain = relationCompanyDomain(relation, nested);
  const id = stringField(nested, ["id", "company_id", "companyId", "urn", "entity_urn", "entityUrn"]);
  const sourceKey = id
    ? `linkedin:company:${id}`
    : linkedinUrl
      ? `linkedin:company:${linkedinUrl}`
      : domain
        ? `linkedin:company_domain:${domain}`
      : `linkedin:company_name:${name.toLowerCase()}`;

  return {
    sourceKey,
    name,
    domain,
    linkedinUrl,
  };
}

function relationCompanyDomain(
  relation: LinkedinRelation,
  nested: Record<string, unknown> | null,
): string | null {
  const raw = stringField(relation, [
    "company_domain",
    "companyDomain",
    "company_website",
    "companyWebsite",
    "organization_domain",
    "organizationDomain",
    "organization_website",
    "organizationWebsite",
    "website",
  ]) ?? stringField(nested, [
    "domain",
    "website",
    "company_domain",
    "companyDomain",
    "company_website",
    "companyWebsite",
    "organization_domain",
    "organizationDomain",
    "organization_website",
    "organizationWebsite",
  ]);
  if (!raw) return null;
  const domain = normalizeDomain(raw);
  if (domain === "linkedin.com" || domain.endsWith(".linkedin.com")) return null;
  return domain.includes(".") && !domain.includes("@") ? domain : null;
}

function positionObject(relation: LinkedinRelation): Record<string, unknown> | null {
  return objectField(relation, ["current_position", "currentPosition", "position"]) ??
    firstObjectItem(relation.currentPosition) ??
    firstObjectItem(relation.current_position) ??
    firstObjectItem(relation.positions) ??
    firstObjectItem(relation.experience);
}

function relationProvenance(relation: LinkedinRelation): Record<string, unknown> {
  return {
    provider: "unipile",
    imported_at: nowIso(),
    member_id: relation.member_id ?? null,
    member_urn: relation.member_urn ?? null,
    connection_urn: relation.connection_urn ?? null,
    public_identifier: relation.public_identifier ?? null,
    profile_picture_url: relation.profile_picture_url ?? null,
    raw_relation: relation,
  };
}

function companyProvenance(company: NormalizedCompany): Record<string, unknown> {
  return {
    provider: "unipile",
    imported_at: nowIso(),
    source_key: company.sourceKey,
  };
}

async function loadPeopleBySourceKeys(
  db: Workspace["db"],
  sourceKeys: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(sourceKeys), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'people'
         AND attribute_slug = 'source_keys'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadPeopleByLinkedinUrl(
  db: Workspace["db"],
  linkedinUrls: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(linkedinUrls), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'people'
         AND attribute_slug = 'linkedin_url'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadCompaniesBySourceKeys(
  db: Workspace["db"],
  sourceKeys: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(sourceKeys), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'companies'
         AND attribute_slug = 'source_keys'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadCompaniesByLinkedinUrl(
  db: Workspace["db"],
  linkedinUrls: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(linkedinUrls), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'companies'
         AND attribute_slug = 'linkedin_url'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadCompaniesByDomain(
  db: Workspace["db"],
  domains: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(domains), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'companies'
         AND attribute_slug = 'domains'
         AND normalized_key IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadCompaniesByName(
  db: Workspace["db"],
  names: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(names.map((name) => name.toLowerCase())), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      db,
      `SELECT record_id, LOWER(normalized_key) AS normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'companies'
         AND attribute_slug = 'name'
         AND LOWER(normalized_key) IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id === "string" && typeof row.normalized_key === "string") {
        index.set(row.normalized_key, row.record_id);
      }
    }
  }
  return index;
}

async function loadExistingValues(
  db: Workspace["db"],
  records: Record<ObjectSlug, string[]>,
): Promise<ExistingValues> {
  const existing: ExistingValues = {
    singleValues: new Map(),
    multiValues: new Set(),
  };
  for (const objectSlug of Object.keys(records) as ObjectSlug[]) {
    for (const chunk of chunks(records[objectSlug], SELECT_CHUNK_SIZE)) {
      const placeholders = chunk.map((_, index) => `$${index + 2}`).join(", ");
      const result = await exec(
        db,
        `SELECT object_slug, record_id, attribute_slug, value_json,
                normalized_key, ref_object, ref_record_id
         FROM acrm_value
         WHERE active_until IS NULL
           AND object_slug = $1
           AND record_id IN (${placeholders})`,
        [objectSlug, ...chunk],
      );
      for (const row of result.rows) {
        if (typeof row.object_slug !== "string" || typeof row.record_id !== "string" || typeof row.attribute_slug !== "string") {
          continue;
        }
        const valueJson = parseValueJson(row.value_json);
        if (valueJson) {
          existing.singleValues.set(singleValueKey(row.object_slug, row.record_id, row.attribute_slug), valueJson);
        }
        if (typeof row.normalized_key === "string") {
          existing.multiValues.add(normalizedValueKey(row.object_slug, row.record_id, row.attribute_slug, row.normalized_key));
        }
        if (typeof row.ref_object === "string" && typeof row.ref_record_id === "string") {
          existing.multiValues.add(referenceValueKey(row.object_slug, row.record_id, row.attribute_slug, row.ref_object, row.ref_record_id));
        }
      }
    }
  }
  return existing;
}

function enqueueSingleIfMissing(
  writer: LinkedinRelationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  attributeType: AttributeType,
  rawValue: unknown,
  provenance: Record<string, unknown>,
): boolean {
  const key = singleValueKey(plan.objectSlug, plan.recordId, attributeSlug);
  if (!plan.created && existing.singleValues.has(key)) return false;
  if (existing.singleValues.has(key)) return false;
  const valueJson = encode(attributeType, rawValue);
  existing.singleValues.set(key, valueJson);
  writer.enqueueValue({
    object_slug: plan.objectSlug,
    record_id: plan.recordId,
    attribute_slug: attributeSlug,
    attribute_type: attributeType,
    value: valueJson,
    provenance,
  });
  return true;
}

function enqueueSingleReferenceIfMissing(
  writer: LinkedinRelationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  targetObject: ObjectSlug,
  targetRecordId: string,
  provenance: Record<string, unknown>,
): boolean {
  return enqueueSingleIfMissing(
    writer,
    existing,
    plan,
    attributeSlug,
    "record-reference",
    { target_object: targetObject, target_record_id: targetRecordId },
    provenance,
  );
}

function enqueueMulti(
  writer: LinkedinRelationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  attributeType: AttributeType,
  rawValue: unknown,
  provenance: Record<string, unknown>,
): boolean {
  const valueJson = encode(attributeType, rawValue);
  const prepared = writer.prepareValue({
    object_slug: plan.objectSlug,
    record_id: plan.recordId,
    attribute_slug: attributeSlug,
    attribute_type: attributeType,
    value: valueJson,
    provenance,
  });
  const key = preparedValueKey(prepared);
  if (key) {
    if (existing.multiValues.has(key)) return false;
    existing.multiValues.add(key);
  }
  writer.enqueuePreparedValue(prepared);
  return true;
}

function enqueueReference(
  writer: LinkedinRelationWriteBatcher,
  existing: ExistingValues,
  plan: RecordPlan,
  attributeSlug: string,
  targetObject: ObjectSlug,
  targetRecordId: string,
  provenance: Record<string, unknown>,
): boolean {
  return enqueueMulti(
    writer,
    existing,
    plan,
    attributeSlug,
    "record-reference",
    { target_object: targetObject, target_record_id: targetRecordId },
    provenance,
  );
}

class LinkedinRelationWriteBatcher {
  private records: Array<{ object_slug: ObjectSlug; record_id: string }> = [];
  private values: PreparedValueInsert[] = [];

  constructor(private readonly db: Workspace["db"]) {}

  enqueueRecord(record: { object_slug: ObjectSlug; record_id: string }): void {
    this.records.push(record);
  }

  prepareValue(input: ValueInput): PreparedValueInsert {
    return prepareValueInsert(uuidv7(), {
      object_slug: input.object_slug,
      record_id: input.record_id,
      attribute_slug: input.attribute_slug,
      attribute_type: input.attribute_type,
      value_json: input.value,
      source: SOURCE,
      provenance: input.provenance,
    });
  }

  enqueueValue(input: ValueInput): void {
    this.values.push(this.prepareValue(input));
  }

  enqueuePreparedValue(value: PreparedValueInsert): void {
    this.values.push(value);
  }

  async flush(): Promise<void> {
    if (this.records.length > 0) await this.flushRecords();
    if (this.values.length > 0) await this.flushValues();
  }

  private async flushRecords(): Promise<void> {
    for (const chunk of chunks(this.records, MAX_BATCH_ROWS)) {
      const placeholders = chunk
        .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
        .join(", ");
      const params: SqlValue[] = chunk.flatMap((record) => [record.object_slug, record.record_id]);
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
    for (const chunk of chunks(this.values, MAX_BATCH_ROWS)) {
      const placeholders = chunk
        .map((_, index) => {
          const base = index * COLS;
          return `(${Array.from({ length: COLS }, (_, offset) => `$${base + offset + 1}`).join(", ")})`;
        })
        .join(", ");
      const params: SqlValue[] = chunk.flatMap((value) => [
        value.id,
        value.object_slug,
        value.record_id,
        value.attribute_slug,
        value.value_json,
        value.active_from,
        value.normalized_key,
        value.ref_object,
        value.ref_record_id,
        value.source,
        value.provenance_json,
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

function preparedValueKey(value: PreparedValueInsert): string | null {
  if (value.ref_object && value.ref_record_id) {
    return referenceValueKey(value.object_slug, value.record_id, value.attribute_slug, value.ref_object, value.ref_record_id);
  }
  if (value.normalized_key) {
    return normalizedValueKey(value.object_slug, value.record_id, value.attribute_slug, value.normalized_key);
  }
  return null;
}

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function singleValueKey(objectSlug: string, recordId: string, attributeSlug: string): string {
  return `${objectSlug}\0${recordId}\0${attributeSlug}`;
}

function normalizedValueKey(objectSlug: string, recordId: string, attributeSlug: string, normalizedKey: string): string {
  return `${singleValueKey(objectSlug, recordId, attributeSlug)}\0normalized\0${normalizedKey}`;
}

function referenceValueKey(objectSlug: string, recordId: string, attributeSlug: string, refObject: string, refRecordId: string): string {
  return `${singleValueKey(objectSlug, recordId, attributeSlug)}\0ref\0${refObject}\0${refRecordId}`;
}

function parseValueJson(value: unknown): ValueJson | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isJsonValue(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isJsonValue(value) ? value : null;
}

function isJsonValue(value: unknown): value is ValueJson {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function objectField(source: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function firstObjectItem(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : null;
}

function stringField(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function uniqueCompanies(companies: NormalizedCompany[]): NormalizedCompany[] {
  return [...new Map(companies.map((company) => [company.sourceKey, company])).values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
