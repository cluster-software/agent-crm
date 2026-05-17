import type { LixRuntimeValue } from "@lix-js/sdk";
import { exec, type Row } from "../db/execute.js";
import { parseAttributeConfig } from "../workspace/catalog.js";
import type { Workspace } from "../workspace.js";

export type QueryResult = {
  rows: Row[];
  rowsAffected: number;
};

export async function query(
  workspace: Workspace,
  sql: string,
  params: LixRuntimeValue[] = [],
): Promise<QueryResult> {
  const result = await exec(workspace.lix, sql, params);
  return { rows: result.rows, rowsAffected: result.rowsAffected };
}

export type SchemaAttribute = {
  attribute_slug: string;
  title: string;
  attribute_type: string;
  is_multivalued: boolean;
  is_unique: boolean;
  config?: unknown;
};

export type SchemaObject = {
  object_slug: string;
  singular_name: string;
  plural_name: string;
  attributes: SchemaAttribute[];
};

export type SchemaDump = {
  objects: SchemaObject[];
};

export async function dumpSchema(workspace: Workspace): Promise<SchemaDump> {
  const objects = await exec(
    workspace.lix,
    `SELECT object_slug, singular_name, plural_name
     FROM acrm_object
     ORDER BY object_slug`,
  );
  const attrs = await exec(
    workspace.lix,
    `SELECT object_slug, attribute_slug, title, attribute_type,
            is_multivalued, is_unique, config_json
     FROM acrm_attribute
     ORDER BY object_slug, attribute_slug`,
  );

  const byObject = new Map<string, SchemaAttribute[]>();
  for (const row of attrs.rows) {
    const slug = row.object_slug as string;
    const list = byObject.get(slug) ?? [];
    const config = parseAttributeConfig(row.config_json);
    list.push({
      attribute_slug: row.attribute_slug as string,
      title: row.title as string,
      attribute_type: row.attribute_type as string,
      is_multivalued: Boolean(row.is_multivalued),
      is_unique: Boolean(row.is_unique),
      ...(config !== undefined ? { config } : {}),
    });
    byObject.set(slug, list);
  }

  return {
    objects: objects.rows.map((row) => ({
      object_slug: row.object_slug as string,
      singular_name: row.singular_name as string,
      plural_name: row.plural_name as string,
      attributes: byObject.get(row.object_slug as string) ?? [],
    })),
  };
}
