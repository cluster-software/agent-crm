import { describe, expect, it } from "vitest";
import { exec, registerAllSchemas } from "@agent-crm/sdk";
import { openTestDatabase, openTestWorkspace } from "../../test/open-test-db.js";

describe("registerAllSchemas", () => {
  it("creates the Agent CRM EAV tables", async () => {
    const db = await openTestDatabase();

    for (const tableName of [
      "acrm_object",
      "acrm_attribute",
      "acrm_record",
      "acrm_value",
      "acrm_metadata",
    ]) {
      await expect(exec(db, `SELECT * FROM ${tableName} LIMIT 0`)).resolves
        .toMatchObject({ rows: [] });
    }
    await db.close();
  });

  it("can be called twice without duplicate errors", async () => {
    const db = await openTestDatabase();

    await expect(registerAllSchemas(db)).resolves.toBeUndefined();
    await expect(registerAllSchemas(db)).resolves.toBeUndefined();

    const result = await exec(db, "SELECT COUNT(*) AS count FROM acrm_schema_migrations");
    expect(Number(result.rows[0]?.count ?? 0)).toBe(1);
    await db.close();
  });

  it("creates Postgres jsonb columns for flexible EAV values", async () => {
    const db = await openTestDatabase();

    const columns = await exec(
      db,
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name IN ('acrm_value', 'acrm_attribute')
         AND column_name IN ('value_json', 'provenance_json', 'config_json')
       ORDER BY table_name, column_name`,
    );

    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["value_json", "provenance_json", "config_json"]),
    );
    await db.close();
  });

  it("makes generated tables queryable after registration", async () => {
    const db = await openTestDatabase();

    for (const tableName of [
      "acrm_object",
      "acrm_attribute",
      "acrm_record",
      "acrm_value",
    ]) {
      await expect(exec(db, `SELECT * FROM ${tableName} LIMIT 0`)).resolves
        .toMatchObject({ rows: [] });
    }
    await db.close();
  });

  // Issue #51: a developer who knows the EAV layout should be able to write a
  // value with only the four logical columns. id + active_from are defaulted;
  // attribute_type must not be required (it lives on acrm_attribute).
  it("accepts the minimal acrm_value insert from issue #51", async () => {
    const db = await openTestWorkspace();

    await exec(
      db,
      "INSERT INTO acrm_record (object_slug, record_id) VALUES ($1, $2)",
      ["people", "person_1"],
    );

    await exec(
      db,
      `INSERT INTO acrm_value (object_slug, record_id, attribute_slug, value_json)
       VALUES ($1, $2, $3, $4)`,
      ["people", "person_1", "name", '{"full_name":"Ada Lovelace"}'],
    );

    const r = await exec(
      db,
      `SELECT v.value_json, a.attribute_type, v.id, v.active_from
       FROM acrm_value v
       JOIN acrm_attribute a
         ON a.object_slug = v.object_slug AND a.attribute_slug = v.attribute_slug
       WHERE v.object_slug = 'people' AND v.record_id = 'person_1'
         AND v.active_until IS NULL`,
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(parseJsonColumn(row.value_json)).toMatchObject({
      full_name: "Ada Lovelace",
    });
    expect(row.attribute_type).toBe("personal-name");
    expect(row.id).toBeTruthy();
    expect(row.active_from).toBeTruthy();
    await db.close();
  });
});

function parseJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
