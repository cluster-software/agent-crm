import { exec } from "../../db/execute.js";
import type { AcrmDatabase } from "../../db/types.js";

const OPTIONAL_SCHEMA_SQL = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
];

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS acrm_schema_migrations (
     version integer PRIMARY KEY,
     applied_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS acrm_object (
     object_slug text PRIMARY KEY,
     singular_name text NOT NULL,
     plural_name text NOT NULL,
     archived boolean
   )`,
  `CREATE TABLE IF NOT EXISTS acrm_attribute (
     object_slug text NOT NULL REFERENCES acrm_object(object_slug) ON DELETE CASCADE,
     attribute_slug text NOT NULL,
     title text NOT NULL,
     attribute_type text NOT NULL,
     is_multivalued boolean NOT NULL,
     is_unique boolean NOT NULL,
     config_json jsonb,
     archived boolean,
     PRIMARY KEY (object_slug, attribute_slug)
   )`,
  `CREATE TABLE IF NOT EXISTS acrm_record (
     object_slug text NOT NULL REFERENCES acrm_object(object_slug) ON DELETE CASCADE,
     record_id text NOT NULL,
     archived boolean,
     PRIMARY KEY (object_slug, record_id)
   )`,
  `CREATE TABLE IF NOT EXISTS acrm_value (
     id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
     object_slug text NOT NULL,
     record_id text NOT NULL,
     attribute_slug text NOT NULL,
     value_json jsonb NOT NULL,
     active_from text NOT NULL DEFAULT CURRENT_TIMESTAMP,
     active_until text,
     normalized_key text,
     ref_object text,
     ref_record_id text,
     source text,
     provenance_json jsonb,
     FOREIGN KEY (object_slug, record_id)
       REFERENCES acrm_record(object_slug, record_id)
       ON DELETE CASCADE,
     FOREIGN KEY (object_slug, attribute_slug)
       REFERENCES acrm_attribute(object_slug, attribute_slug)
       ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS acrm_metadata (
     key text PRIMARY KEY,
     value text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS acrm_record_object_idx
     ON acrm_record(object_slug)`,
  `CREATE INDEX IF NOT EXISTS acrm_value_current_record_idx
     ON acrm_value(object_slug, record_id, attribute_slug)
     WHERE active_until IS NULL`,
  `CREATE INDEX IF NOT EXISTS acrm_value_current_normalized_idx
     ON acrm_value(object_slug, attribute_slug, normalized_key)
     WHERE active_until IS NULL AND normalized_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS acrm_value_current_ref_idx
     ON acrm_value(ref_object, ref_record_id)
     WHERE active_until IS NULL AND ref_object IS NOT NULL AND ref_record_id IS NOT NULL`,
  `INSERT INTO acrm_schema_migrations (version)
     VALUES (1)
     ON CONFLICT (version) DO NOTHING`,
];

export async function registerAllSchemas(db: AcrmDatabase): Promise<void> {
  for (const sql of OPTIONAL_SCHEMA_SQL) {
    await exec(db, sql).catch(() => undefined);
  }
  for (const sql of SCHEMA_SQL) {
    await exec(db, sql);
  }
}
