import type { Command } from "commander";
import type { LixRuntimeValue } from "@lix-js/sdk";
import { AcrmError, ERR, Workspace, dumpSchema, query } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";

export function registerExecute(program: Command): void {
  program
    .command("execute [sql] [params]")
    .description(
      "run a SQL query or mutation against the .acrm file; params is a JSON array. SHELL: SINGLE-QUOTE the SQL whenever it contains $1/$2/... placeholders (double quotes let zsh/bash expand $N to empty). Pass `--schema` instead of SQL to dump the EAV layout (objects, attributes, types). SQL dialect is DataFusion (NOT SQLite/Postgres) — see `acrm execute --help`.",
    )
    .option(
      "--schema",
      "dump the workspace's EAV layout (objects + attributes) instead of running SQL. Use this once at session start to see what's queryable.",
    )
    .addHelpText(
      "after",
      `
Storage model: EAV. Records are not stored in per-object SQL tables.

  Tables (the only three you query directly):
    acrm_record     (record_id, object_slug)              one row per record
    acrm_value      (id, record_id, object_slug,          one row per attribute
                     attribute_slug, value_json,           value (current OR
                     normalized_key, ref_object,           historical).
                     ref_record_id, active_from,           attribute_type is NOT
                     active_until, source, …)              here — JOIN acrm_attribute.
    acrm_attribute  (object_slug, attribute_slug,         schema: what fields
                     attribute_type, is_multivalued,       exist on each object
                     is_unique, config_json)

  There is NO per-object table:
    ❌ SELECT * FROM people
    ✅ SELECT record_id FROM acrm_record WHERE object_slug = 'people'

  Read all fields for one record (pivot from acrm_value):
    SELECT attribute_slug, value_json, normalized_key, ref_record_id
    FROM   acrm_value
    WHERE  object_slug = 'people' AND record_id = $1
           AND active_until IS NULL;

  Always filter \`active_until IS NULL\` for current values — historical rows
  are kept in the same table with a non-null active_until.

  For record-reference attributes, prefer the indexed columns:
    ref_object, ref_record_id        (use these for joins/filters)
  rather than digging into value_json.target_record_id.

SHELL QUOTING (read this first — it's the #1 footgun):
  - SINGLE-QUOTE any SQL that contains $1, $2, ... placeholders. In zsh/bash,
    double quotes expand $N to the shell's positional parameters (empty in an
    interactive shell), so the SQL that reaches acrm has bare gaps and the
    parser errors out with LIX_PARSE_ERROR at a random column.

      ❌ acrm execute "SELECT \$1"  '["hi"]'    # zsh eats $1 → "SELECT "
      ✅ acrm execute 'SELECT $1'   '["hi"]'    # single quotes pass it through
      ✅ acrm execute "SELECT \\$1" '["hi"]'    # or escape each $

  - The params argument is itself JSON, so single-quote it too. Inside, escape
    inner double-quotes with \\":
      acrm execute 'UPDATE t SET col = $1 WHERE id = $2' \\
        '["{\\"key\\":\\"value\\"}","row-id"]'

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

value_json shape by attribute_type (the key to use with lix_json_get_text):
  text / url                 {"value": "<string>"}
  number                     {"value": <number>}
  date                       {"date": "<YYYY-MM-DD>"}
  timestamp                  {"timestamp": "<ISO-8601>"}
  personal-name              {"full_name": "...", "first_name": "...", "last_name": "..."}
  email-address              {"email_address": "<lower>", "email_domain": "<lower>", ...}
  domain                     {"domain": "<lower>", "root_domain": "<lower>"}
  currency                   {"currency_value": <number>, "currency_code": "<USD>"}
  status / select            {"id": "<option_id>", "title": "<display>"}
  record-reference           {"target_object": "<slug>", "target_record_id": "<uuid>"}

  Why this matters: \`lix_json_get_text(value_json, 'value')\` returns NULL on
  status/currency/personal-name/email-address rows because those types don't
  use a "value" key. Pick the right key from the table above (or for
  record-reference attrs, prefer the indexed \`ref_record_id\` column over
  digging into value_json).

Custom schema (mutations work — there is no "last resort" warning):
  acrm object create <slug>                                       register a new object
  acrm attribute add <object>.<slug> --type <type> [...]          add a field
  acrm attribute edit-options <object>.<slug> add <id>[:<title>]  extend a status enum
  acrm records create <object> --field <slug>=<value> [...]       create one record

  If you need something the CLI doesn't expose, writing directly to
  \`acrm_object\` / \`acrm_attribute\` via \`acrm execute\` is supported and
  expected — see \`acrm execute --schema\` for the current layout, then
  INSERT with the standard columns (\`object_slug\`, \`singular_name\`,
  \`plural_name\` for objects; \`object_slug\`, \`attribute_slug\`, \`title\`,
  \`attribute_type\`, \`is_multivalued\`, \`is_unique\`, \`config_json\` for
  attributes). The CLI commands above just wrap those INSERTs with input
  validation.

Introspection (use these instead of sqlite_master):
  acrm execute --schema                                          # full EAV layout for this workspace
  acrm execute "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
  acrm execute "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='acrm_value'"
  acrm execute "SELECT * FROM acrm_object"                      # registered objects
  acrm execute "SELECT object_slug, attribute_slug, attribute_type, is_multivalued, is_unique FROM acrm_attribute ORDER BY object_slug"
  acrm execute "SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug"

Errors carry the lix engine code + hint when applicable
(e.g. LIX_SQL_PARSE_ERROR with hint: "Use $1 instead of ?").
`,
    )
    .action(
      async (
        sql: string | undefined,
        paramsJson: string | undefined,
        opts: { schema?: boolean },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        try {
          if (opts.schema) {
            if (sql) {
              throw new AcrmError(
                "--schema does not take a SQL argument",
                ERR.INVALID_INPUT,
              );
            }
            const ws = await Workspace.open(resolveWorkspacePath(root.workspace));
            try {
              ok(await dumpSchema(ws));
            } finally {
              await ws.close();
            }
            return;
          }

          if (!sql) {
            throw new AcrmError(
              "missing SQL argument (run `acrm execute --help` for the dialect; pass `--schema` to dump the EAV layout)",
              ERR.INVALID_INPUT,
            );
          }

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
              throw new AcrmError(
                "params must be a JSON array",
                ERR.INVALID_INPUT,
              );
            }
            params = parsed as LixRuntimeValue[];
          }
          if (params.length > 0 && !/\$\d+/.test(sql)) {
            throw new AcrmError(
              `params were passed but the SQL has no $1/$2/... placeholders — almost certainly the shell ate them. Use SINGLE quotes around the SQL: \`acrm execute 'SELECT $1' '["hi"]'\` (double quotes let zsh/bash expand $N to empty).`,
              ERR.INVALID_INPUT,
              `In zsh/bash, "$1" is the shell's first positional arg. Single-quote the SQL, or escape each $ as \\$. See \`acrm execute --help\`.`,
            );
          }
          const ws = await Workspace.open(resolveWorkspacePath(root.workspace));
          try {
            const result = await query(ws, sql, params);
            ok({ rows: result.rows, rows_affected: result.rowsAffected });
          } finally {
            await ws.close();
          }
        } catch (e) {
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.EXECUTE);
          process.exit(1);
        }
      },
    );
}

