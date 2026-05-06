import type { Command } from "commander";
import type { LixRuntimeValue } from "@lix-js/sdk";
import { openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";

export function registerExecute(program: Command): void {
  program
    .command("execute <sql> [params]")
    .description(
      "run a SQL query or mutation against the .acrm file; params is a JSON array. SQL dialect is DataFusion (NOT SQLite/Postgres) — see `acrm execute --help`.",
    )
    .addHelpText(
      "after",
      `
SQL dialect: DataFusion (NOT SQLite, NOT Postgres)
  - Placeholders are $1, $2, ...   The '?' placeholder is rejected.
  - No sqlite_master — use information_schema.tables / .columns.
  - Single statement per call.

JSON projection (json_extract is NOT available; use the lix UDFs instead):
  lix_json_get(json, key_or_index, ...)        returns a JSON value
  lix_json_get_text(json, key_or_index, ...)   returns text
  Example:
    SELECT lix_json_get_text(value_json, 'value') AS company_name
    FROM acrm_value
    WHERE object_slug = 'companies' AND attribute_slug = 'name'
      AND active_until IS NULL;

JSON columns to be aware of:
  acrm_value.value_json        the typed payload for an attribute value
  acrm_value.provenance_json   import row index, source metadata
  acrm_attribute.config_json   per-attribute config (status options, ref target, ...)

Introspection (use these instead of sqlite_master):
  acrm execute "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
  acrm execute "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='acrm_value'"
  acrm execute "SELECT * FROM acrm_object"                      # registered objects
  acrm execute "SELECT object_slug, attribute_slug, attribute_type, is_multivalued, is_unique FROM acrm_attribute ORDER BY object_slug"
  acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug"

Errors carry the lix engine code + hint when applicable
(e.g. LIX_SQL_PARSE_ERROR with hint: "Use $1 instead of ?").
`,
    )
    .action(async (sql: string, paramsJson: string | undefined) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        let params: LixRuntimeValue[] = [];
        if (paramsJson) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(paramsJson);
          } catch {
            throw new AcrmError(
              `params must be a JSON array, got: ${paramsJson}`,
              ERR.INVALID_INPUT,
            );
          }
          if (!Array.isArray(parsed)) {
            throw new AcrmError("params must be a JSON array", ERR.INVALID_INPUT);
          }
          params = parsed as LixRuntimeValue[];
        }
        const lix = await openWorkspace({ workspace: root.workspace });
        try {
          const result = await exec(lix, sql, params);
          ok({ rows: result.rows, rows_affected: result.rowsAffected });
        } finally {
          await lix.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.EXECUTE);
        process.exit(1);
      }
    });
}
