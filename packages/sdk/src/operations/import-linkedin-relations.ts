import type { LixRuntimeValue } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import {
  prepareValueInsert,
  type PreparedValueInsert,
} from "../db/value-row.js";
import {
  encode,
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
};

export type ImportLinkedinRelationsArgs = {
  relations: Iterable<LinkedinRelation>;
};

export type ImportLinkedinRelationsResult = {
  stats: {
    relations_seen: number;
    people_created: number;
    people_updated: number;
    relations_skipped_no_key: number;
  };
};

type NormalizedRelation = {
  relation: LinkedinRelation;
  sourceKey: string;
  linkedinUrl: string | null;
  fullName: string | null;
  headline: string | null;
  connectedAt: string | null;
};

type RecordPlan = {
  recordId: string;
  created: boolean;
};

type ExistingValues = {
  singleValues: Map<string, ValueJson>;
  multiValues: Set<string>;
};

type ValueInput = {
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

  const lix = workspace.lix;
  const sourceIndex = await loadPeopleBySourceKeys(lix, relations.map((relation) => relation.sourceKey));
  const plannedSourceIndex = new Map(sourceIndex);
  const linkedinIndex = await loadPeopleByLinkedinUrl(
    lix,
    relations.map((relation) => relation.linkedinUrl).filter((url): url is string => Boolean(url)),
  );
  const plannedLinkedinIndex = new Map(linkedinIndex);

  const recordsToCreate: Array<{ object_slug: "people"; record_id: string }> = [];
  const plans: Array<{ relation: NormalizedRelation; plan: RecordPlan }> = [];
  const touchedRecordIds = new Set<string>();
  const createdRecordIds = new Set<string>();

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
    plans.push({ relation, plan: { recordId, created } });
  }

  stats.people_created = createdRecordIds.size;

  const existingValues = await loadExistingValues(lix, [...touchedRecordIds]);
  const writer = new LinkedinRelationWriteBatcher(lix);
  const changedExistingRecordIds = new Set<string>();

  for (const record of recordsToCreate) {
    writer.enqueueRecord(record);
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
    if (!createdRecordIds.has(plan.recordId) && changed) {
      changedExistingRecordIds.add(plan.recordId);
    }
  }

  stats.people_updated = changedExistingRecordIds.size;
  await writer.flush();
  return { stats };
}

async function ensurePeopleSchema(workspace: Workspace): Promise<void> {
  await seedObjects(workspace.lix);
  await seedAttributes(workspace.lix);
}

function normalizeRelation(relation: LinkedinRelation): NormalizedRelation | null {
  const sourceKey = relationSourceKey(relation);
  if (!sourceKey) return null;
  return {
    relation,
    sourceKey,
    linkedinUrl: relationLinkedinUrl(relation),
    fullName: relationFullName(relation),
    headline: cleanString(relation.headline),
    connectedAt: relationConnectedAt(relation.created_at),
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

async function loadPeopleBySourceKeys(
  lix: Workspace["lix"],
  sourceKeys: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(sourceKeys), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      lix,
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
  lix: Workspace["lix"],
  linkedinUrls: string[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const chunk of chunks(unique(linkedinUrls), SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      lix,
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

async function loadExistingValues(
  lix: Workspace["lix"],
  recordIds: string[],
): Promise<ExistingValues> {
  const existing: ExistingValues = {
    singleValues: new Map(),
    multiValues: new Set(),
  };
  for (const chunk of chunks(recordIds, SELECT_CHUNK_SIZE)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    const result = await exec(
      lix,
      `SELECT record_id, attribute_slug, value_json, normalized_key
       FROM acrm_value
       WHERE active_until IS NULL
         AND object_slug = 'people'
         AND record_id IN (${placeholders})`,
      chunk,
    );
    for (const row of result.rows) {
      if (typeof row.record_id !== "string" || typeof row.attribute_slug !== "string") continue;
      const valueJson = parseValueJson(row.value_json);
      if (valueJson) {
        existing.singleValues.set(singleValueKey(row.record_id, row.attribute_slug), valueJson);
      }
      if (typeof row.normalized_key === "string") {
        existing.multiValues.add(normalizedValueKey(row.record_id, row.attribute_slug, row.normalized_key));
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
  const key = singleValueKey(plan.recordId, attributeSlug);
  if (!plan.created && existing.singleValues.has(key)) return false;
  if (existing.singleValues.has(key)) return false;
  const valueJson = encode(attributeType, rawValue);
  existing.singleValues.set(key, valueJson);
  writer.enqueueValue({
    record_id: plan.recordId,
    attribute_slug: attributeSlug,
    attribute_type: attributeType,
    value: valueJson,
    provenance,
  });
  return true;
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
    record_id: plan.recordId,
    attribute_slug: attributeSlug,
    attribute_type: attributeType,
    value: valueJson,
    provenance,
  });
  const key = prepared.normalized_key
    ? normalizedValueKey(plan.recordId, attributeSlug, prepared.normalized_key)
    : null;
  if (key) {
    if (existing.multiValues.has(key)) return false;
    existing.multiValues.add(key);
  }
  writer.enqueuePreparedValue(prepared);
  return true;
}

class LinkedinRelationWriteBatcher {
  private records: Array<{ object_slug: "people"; record_id: string }> = [];
  private values: PreparedValueInsert[] = [];

  constructor(private readonly lix: Workspace["lix"]) {}

  enqueueRecord(record: { object_slug: "people"; record_id: string }): void {
    this.records.push(record);
  }

  prepareValue(input: ValueInput): PreparedValueInsert {
    return prepareValueInsert(uuidv7(), {
      object_slug: "people",
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
      const params: LixRuntimeValue[] = chunk.flatMap((record) => [record.object_slug, record.record_id]);
      await exec(
        this.lix,
        `INSERT INTO acrm_record (object_slug, record_id) VALUES ${placeholders}`,
        params,
      );
    }
    this.records = [];
  }

  private async flushValues(): Promise<void> {
    const COLS = 10;
    for (const chunk of chunks(this.values, MAX_BATCH_ROWS)) {
      const placeholders = chunk
        .map((_, index) => {
          const base = index * COLS;
          return `(${Array.from({ length: COLS }, (_, offset) => `$${base + offset + 1}`).join(", ")})`;
        })
        .join(", ");
      const params: LixRuntimeValue[] = chunk.flatMap((value) => [
        value.id,
        value.object_slug,
        value.record_id,
        value.attribute_slug,
        value.value_json,
        value.normalized_key,
        value.ref_object,
        value.ref_record_id,
        value.source,
        value.provenance_json,
      ]);
      await exec(
        this.lix,
        `INSERT INTO acrm_value
          (id, object_slug, record_id, attribute_slug, value_json,
           normalized_key, ref_object, ref_record_id, source, provenance_json)
         VALUES ${placeholders}`,
        params,
      );
    }
    this.values = [];
  }
}

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function singleValueKey(recordId: string, attributeSlug: string): string {
  return `${recordId}\0${attributeSlug}`;
}

function normalizedValueKey(recordId: string, attributeSlug: string, normalizedKey: string): string {
  return `${singleValueKey(recordId, attributeSlug)}\0normalized\0${normalizedKey}`;
}

function parseValueJson(value: unknown): ValueJson | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is ValueJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
