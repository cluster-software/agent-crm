import type { Lix } from "@lix-js/sdk";
import { exec } from "../../db/execute.js";

const draft = "https://json-schema.org/draft/2020-12/schema";

type PropType = string | string[];
type Property = { type: PropType; "x-lix-default"?: string };

export type LixSchema = {
  $schema: string;
  "x-lix-key": string;
  "x-lix-primary-key": string[];
  type: "object";
  required: string[];
  properties: Record<string, Property>;
  additionalProperties: false;
};

const nullable = (t: string): Property => ({ type: [t, "null"] });

export const SCHEMA_OBJECT: LixSchema = {
  $schema: draft,
  "x-lix-key": "acrm_object",
  "x-lix-primary-key": ["/object_slug"],
  type: "object",
  required: ["object_slug", "singular_name", "plural_name"],
  properties: {
    object_slug: { type: "string" },
    singular_name: { type: "string" },
    plural_name: { type: "string" },
    archived: nullable("boolean"),
  },
  additionalProperties: false,
};

export const SCHEMA_ATTRIBUTE: LixSchema = {
  $schema: draft,
  "x-lix-key": "acrm_attribute",
  "x-lix-primary-key": ["/object_slug", "/attribute_slug"],
  type: "object",
  required: [
    "object_slug",
    "attribute_slug",
    "title",
    "attribute_type",
    "is_multivalued",
    "is_unique",
  ],
  properties: {
    object_slug: { type: "string" },
    attribute_slug: { type: "string" },
    title: { type: "string" },
    attribute_type: { type: "string" },
    is_multivalued: { type: "boolean" },
    is_unique: { type: "boolean" },
    config_json: nullable("string"),
    archived: nullable("boolean"),
  },
  additionalProperties: false,
};

export const SCHEMA_RECORD: LixSchema = {
  $schema: draft,
  "x-lix-key": "acrm_record",
  "x-lix-primary-key": ["/object_slug", "/record_id"],
  type: "object",
  required: ["object_slug", "record_id"],
  properties: {
    object_slug: { type: "string" },
    record_id: { type: "string" },
    archived: nullable("boolean"),
  },
  additionalProperties: false,
};

export const SCHEMA_VALUE: LixSchema = {
  $schema: draft,
  "x-lix-key": "acrm_value",
  "x-lix-primary-key": ["/id"],
  type: "object",
  required: [
    "id",
    "object_slug",
    "record_id",
    "attribute_slug",
    "value_json",
  ],
  properties: {
    id: { type: "string", "x-lix-default": "lix_uuid_v7()" },
    object_slug: { type: "string" },
    record_id: { type: "string" },
    attribute_slug: { type: "string" },
    value_json: { type: "string" },
    active_from: { type: "string", "x-lix-default": "lix_timestamp()" },
    active_until: nullable("string"),
    normalized_key: nullable("string"),
    ref_object: nullable("string"),
    ref_record_id: nullable("string"),
    source: nullable("string"),
    provenance_json: nullable("string"),
  },
  additionalProperties: false,
};

export const SCHEMA_METADATA: LixSchema = {
  $schema: draft,
  "x-lix-key": "acrm_metadata",
  "x-lix-primary-key": ["/key"],
  type: "object",
  required: ["key", "value"],
  properties: {
    key: { type: "string" },
    value: { type: "string" },
  },
  additionalProperties: false,
};

export const ALL_SCHEMAS: LixSchema[] = [
  SCHEMA_OBJECT,
  SCHEMA_ATTRIBUTE,
  SCHEMA_RECORD,
  SCHEMA_VALUE,
  SCHEMA_METADATA,
];

export async function registerAllSchemas(lix: Lix): Promise<void> {
  const existing = await exec(
    lix,
    "SELECT value FROM lix_registered_schema",
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const have = new Set<string>();
  for (const row of existing.rows) {
    const v = row.value;
    const parsed =
      typeof v === "string" ? JSON.parse(v) : (v as Record<string, unknown>);
    const key = parsed?.["x-lix-key"];
    if (typeof key === "string") {
      have.add(key);
    }
  }
  for (const schema of ALL_SCHEMAS) {
    const tag = schema["x-lix-key"];
    if (have.has(tag)) continue;
    try {
      await exec(
        lix,
        "INSERT INTO lix_registered_schema (value) VALUES (lix_json($1))",
        [JSON.stringify(schema)],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already|exists|duplicate|unique/i.test(msg)) continue;
      throw e;
    }
  }
}
