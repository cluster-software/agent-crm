import type { AcrmDatabase, SqlValue } from "./types.js";
import { exec } from "./execute.js";
import { prepareValueInsert } from "./value-row.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import {
  encode,
  normalizeLookupKey,
  normalizeUniqueKey,
  type AttributeType,
  type ValueJson,
} from "../domain/values.js";
import { loadAttributeConfig } from "../workspace/catalog.js";

function needsConfig(type: AttributeType): boolean {
  return type === "status" || type === "select";
}

export async function findRecordByUnique(
  db: AcrmDatabase,
  object_slug: string,
  attribute_slug: string,
  normalized_key: string,
): Promise<string | null> {
  const lookupKey = normalizeLookupKey(normalized_key);
  if (!lookupKey) return null;
  const r = await exec(
    db,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2
       AND normalized_key = $3 AND active_until IS NULL
     LIMIT 1`,
    [object_slug, attribute_slug, lookupKey],
  );
  return (r.rows[0]?.record_id as string | undefined) ?? null;
}

export async function findCompanyByName(
  db: AcrmDatabase,
  name: string,
): Promise<string | null> {
  const r = await exec(
    db,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = 'companies' AND attribute_slug = 'name'
       AND active_until IS NULL
       AND LOWER(normalized_key) = $1
     LIMIT 1`,
    [name.trim().toLowerCase()],
  );
  return (r.rows[0]?.record_id as string | undefined) ?? null;
}

export async function insertRecord(
  db: AcrmDatabase,
  object_slug: string,
  record_id: string,
): Promise<void> {
  await exec(
    db,
    "INSERT INTO acrm_record (object_slug, record_id) VALUES ($1, $2)",
    [object_slug, record_id],
  );
}

export async function insertValue(
  db: AcrmDatabase,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value_json: ValueJson;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const row = prepareValueInsert(await generateUuid(db), args);
  const params: SqlValue[] = [
    row.id,
    row.object_slug,
    row.record_id,
    row.attribute_slug,
    row.value_json,
    row.active_from,
    row.normalized_key,
    row.ref_object,
    row.ref_record_id,
    row.source,
    row.provenance_json,
  ];
  await exec(
    db,
    `INSERT INTO acrm_value
      (id, object_slug, record_id, attribute_slug, value_json,
       active_from, normalized_key, ref_object, ref_record_id, source, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    params,
  );
}

export async function setSingleValue(
  db: AcrmDatabase,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const config = needsConfig(args.attribute_type)
    ? await loadAttributeConfig(db, args.object_slug, args.attribute_slug)
    : undefined;
  const value_json = encode(args.attribute_type, args.value, config);
  await exec(
    db,
    `UPDATE acrm_value SET active_until = $1
     WHERE object_slug = $2 AND record_id = $3 AND attribute_slug = $4 AND active_until IS NULL`,
    [nowIso(), args.object_slug, args.record_id, args.attribute_slug],
  );
  await insertValue(db, { ...args, value_json });
}

export async function addMultiValue(
  db: AcrmDatabase,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const config = needsConfig(args.attribute_type)
    ? await loadAttributeConfig(db, args.object_slug, args.attribute_slug)
    : undefined;
  const value_json = encode(args.attribute_type, args.value, config);
  const normalized = normalizeUniqueKey(args.attribute_type, value_json);
  if (normalized) {
    const exists = await exec(
      db,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
         AND normalized_key = $4 AND active_until IS NULL LIMIT 1`,
      [args.object_slug, args.record_id, args.attribute_slug, normalized],
    );
    if (exists.rows.length) return;
  }
  await insertValue(db, { ...args, value_json });
}
