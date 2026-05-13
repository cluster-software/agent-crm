import { describe, expect, it } from "vitest";
import { exec } from "../../db/execute.js";
import { openTestLix } from "../../test/open-test-lix.js";
import { ALL_SCHEMAS, registerAllSchemas } from "./index.js";

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
});
