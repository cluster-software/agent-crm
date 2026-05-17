import { describe, expect, it } from "vitest";
import { exec } from "@agent-crm/sdk";
import { openTestLix, openTestWorkspace } from "../../test/open-test-lix.js";
import { ALL_SCHEMAS, registerAllSchemas } from "@agent-crm/sdk";

describe("registerAllSchemas", () => {
  it("registers the Agent CRM schemas", async () => {
    const lix = await openTestLix();

    const result = await exec(
      lix,
      "SELECT value FROM lix_registered_schema ORDER BY lixcol_entity_id",
    );
    const registeredKeys = result.rows
      .map((row) => {
        const value = row.value;
        const schema =
          typeof value === "string" ? JSON.parse(value) : value;
        return (schema as Record<string, unknown>)["x-lix-key"];
      })
      .filter((key): key is string => typeof key === "string");

    expect(registeredKeys).toEqual(
      expect.arrayContaining([
        "acrm_object",
        "acrm_attribute",
        "acrm_record",
        "acrm_value",
      ]),
    );
  });

  it("can be called twice without duplicate errors", async () => {
    const lix = await openTestLix();

    await expect(registerAllSchemas(lix)).resolves.toBeUndefined();

    for (const schema of ALL_SCHEMAS) {
      const result = await exec(
        lix,
        `SELECT COUNT(*) AS count
         FROM lix_registered_schema
         WHERE lix_json_get_text(value, 'x-lix-key') = $1`,
        [schema["x-lix-key"]],
      );
      expect(result.rows[0]?.count).toBe(1);
    }
  });

  it("does not register schemas with x-lix-version", async () => {
    const lix = await openTestLix();

    const result = await exec(
      lix,
      `SELECT value
       FROM lix_registered_schema
       WHERE lix_json_get_text(value, 'x-lix-key') IN
         ('acrm_object', 'acrm_attribute', 'acrm_record', 'acrm_value')`,
    );

    expect(result.rows).toHaveLength(4);
    for (const row of result.rows) {
      const schema =
        typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      expect(schema).not.toHaveProperty("x-lix-version");
    }
  });

  it("makes generated tables queryable after registration", async () => {
    const lix = await openTestLix();

    for (const tableName of [
      "acrm_object",
      "acrm_attribute",
      "acrm_record",
      "acrm_value",
    ]) {
      await expect(exec(lix, `SELECT * FROM ${tableName} LIMIT 0`)).resolves
        .toMatchObject({ rows: [], rowsAffected: 0 });
    }
  });

  // Issue #51: a developer who knows the EAV layout should be able to write a
  // value with only the four logical columns. id + active_from must be filled
  // by Lix defaults; attribute_type must not be required (it lives on
  // acrm_attribute).
  it("accepts the minimal acrm_value insert from issue #51", async () => {
    const lix = await openTestWorkspace();

    await exec(
      lix,
      "INSERT INTO acrm_record (object_slug, record_id) VALUES ($1, $2)",
      ["people", "person_1"],
    );

    await exec(
      lix,
      `INSERT INTO acrm_value (object_slug, record_id, attribute_slug, value_json)
       VALUES ($1, $2, $3, $4)`,
      ["people", "person_1", "name", '{"full_name":"Ada Lovelace"}'],
    );

    const r = await exec(
      lix,
      `SELECT v.value_json, a.attribute_type, v.id, v.active_from
       FROM acrm_value v
       JOIN acrm_attribute a
         ON a.object_slug = v.object_slug AND a.attribute_slug = v.attribute_slug
       WHERE v.object_slug = 'people' AND v.record_id = 'person_1'
         AND v.active_until IS NULL`,
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.value_json).toContain("Ada Lovelace");
    expect(row.attribute_type).toBe("personal-name");
    expect(row.id).toBeTruthy();
    expect(row.active_from).toBeTruthy();
  });
});
