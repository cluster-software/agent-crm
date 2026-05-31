import type { AcrmDatabase } from "../db/types.js";
import { exec } from "../db/execute.js";
import type { AttributeConfig, AttributeType } from "../domain/values.js";
import { AcrmError, ERR } from "../lib/errors.js";

export type ObjectDefinition = {
  object_slug: string;
  singular_name: string;
  plural_name: string;
};

export type AttributeDefinition = {
  object_slug: string;
  attribute_slug: string;
  attribute_type: AttributeType;
  is_multivalued: boolean;
  is_unique: boolean;
  config?: AttributeConfig;
};

export function parseAttributeConfig(raw: unknown): AttributeConfig | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as AttributeConfig;
  }
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AttributeConfig;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function loadObject(
  db: AcrmDatabase,
  object_slug: string,
): Promise<ObjectDefinition | null> {
  const r = await exec(
    db,
    "SELECT object_slug, singular_name, plural_name FROM acrm_object WHERE object_slug = $1",
    [object_slug],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    object_slug: row.object_slug as string,
    singular_name: row.singular_name as string,
    plural_name: row.plural_name as string,
  };
}

export async function assertObjectExists(
  db: AcrmDatabase,
  object_slug: string,
  message?: string,
): Promise<void> {
  const obj = await loadObject(db, object_slug);
  if (obj) return;
  throw new AcrmError(
    message ?? `unknown object: ${object_slug}. Register it first via createObject().`,
    ERR.NOT_FOUND,
  );
}

export async function loadAttribute(
  db: AcrmDatabase,
  object_slug: string,
  attribute_slug: string,
): Promise<AttributeDefinition | null> {
  const r = await exec(
    db,
    `SELECT object_slug, attribute_slug, attribute_type,
            is_multivalued, is_unique, config_json
     FROM acrm_attribute
     WHERE object_slug = $1 AND attribute_slug = $2`,
    [object_slug, attribute_slug],
  );
  const row = r.rows[0];
  if (!row) return null;
  const config = parseAttributeConfig(row.config_json);
  return {
    object_slug: row.object_slug as string,
    attribute_slug: row.attribute_slug as string,
    attribute_type: row.attribute_type as AttributeType,
    is_multivalued: Boolean(row.is_multivalued),
    is_unique: Boolean(row.is_unique),
    ...(config ? { config } : {}),
  };
}

export async function loadAttributeConfig(
  db: AcrmDatabase,
  object_slug: string,
  attribute_slug: string,
): Promise<AttributeConfig | undefined> {
  return (await loadAttribute(db, object_slug, attribute_slug))?.config;
}
