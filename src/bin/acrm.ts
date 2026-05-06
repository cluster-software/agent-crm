#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "../commands/init.js";
import { registerExecute } from "../commands/execute.js";
import { registerImport } from "../commands/import.js";
import { registerUi } from "../commands/ui.js";
import { fail } from "../output/json.js";
import { ERR } from "../lib/errors.js";

const program = new Command();

program
  .name("acrm")
  .description(
    "Headless CRM for Claude Code. Stores people (keyed by email), companies (keyed by domain), and deals in a portable .acrm file.",
  )
  .version("0.0.1")
  .option("-w, --workspace <path>", "path to .acrm file (default: walk up from cwd)")
  .option("--json", "force JSON output (default when stdout is not a TTY)")
  .addHelpText(
    "after",
    `
Data model:
  people      contacts, identified by email
  companies   organizations, identified by domain
  deals       sales opportunities, created on demand

Typical flow:
  acrm init <name>.acrm           create a workspace
  acrm import csv ./leads.csv     load people + companies (and deals if columns present)
  acrm ui                         browse the workspace in a local UI
  acrm execute "SELECT ..."       run SQL against the workspace

SQL engine: DataFusion (NOT SQLite/Postgres)
  - Use $1, $2 placeholders. The '?' placeholder is rejected.
  - No sqlite_master — use information_schema for introspection.
  - For JSON columns, use lix_json_get / lix_json_get_text (NOT json_extract).
  - See \`acrm execute --help\` for the full dialect reference.

Introspection (run via \`acrm execute "<sql>"\`):
  SELECT table_name FROM information_schema.tables WHERE table_schema='public'
  SELECT column_name, data_type FROM information_schema.columns WHERE table_name='acrm_value'
  SELECT * FROM acrm_object                                     -- registered objects
  SELECT object_slug, attribute_slug, attribute_type FROM acrm_attribute
  SELECT object_slug, COUNT(*) FROM acrm_record GROUP BY object_slug
`,
  );

registerInit(program);
registerImport(program);
registerExecute(program);
registerUi(program);

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err), ERR.UNHANDLED);
  process.exit(1);
});
