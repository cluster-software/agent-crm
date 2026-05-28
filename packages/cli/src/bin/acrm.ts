#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerInit } from "../commands/init.js";
import { registerExecute } from "../commands/execute.js";
import { registerRecords } from "../commands/records.js";
import { registerSchema } from "../commands/schema.js";
import { registerSignals } from "../commands/signals.js";
import { registerImport, getOrCreateImportCommand } from "../commands/import.js";
import { registerConnect } from "../commands/connect.js";
import { attachLinkedinSubcommand } from "../commands/import-linkedin.js";
import { attachXSubcommand } from "../commands/import-x.js";
import { attachPostSubcommand } from "../commands/import-post.js";
import { attachGmailSubcommand } from "../commands/import-gmail.js";
import { attachGranolaSubcommand } from "../commands/import-granola.js";
import { attachTranscriptSubcommand } from "../commands/import-transcript.js";
import { registerSkills } from "../commands/skills.js";
import { fail } from "../output/json.js";
import { ERR } from "@agent-crm/sdk";
import {
  promptIfOutdated,
  scheduleBackgroundRefreshIfStale,
} from "../lib/update-check.js";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export function createAcrmProgram(): Command {
const program = new Command();

program
  .name("acrm")
  .description(
    "Headless CRM for Claude Code. Stores people (keyed by email, LinkedIn URL, or Twitter/X URL), companies (keyed by domain), deals, posts (LinkedIn/X posts linked to their author), and transcripts (meeting/call transcripts linked to attendees by email) in a portable .acrm file.",
  )
  .version(pkg.version)
  .option("-w, --workspace <path>", "path to .acrm file (default: walk up from cwd)")
  .option("--json", "force JSON output (default when stdout is not a TTY)")
  .addHelpText(
    "after",
    `
Storage model: EAV. There is no \`people\` / \`companies\` / \`transcripts\` SQL
table — those are \`object_slug\` values on \`acrm_record\`, and each field lives
as a row in \`acrm_value\` keyed by (object_slug, record_id, attribute_slug).
\`SELECT * FROM people\` will fail. See \`acrm execute --help\` for the EAV
query patterns.

Data model:
  people      contacts, identified by email / LinkedIn URL / X URL
  companies   organizations, identified by domain
  deals       sales opportunities, created on demand
  posts       LinkedIn/X posts the user wants to track, linked to author via \`posts.author\` + \`people.associated_posts\`
  transcripts meeting/call transcripts (e.g. Granola), linked to attendees via \`transcripts.participants\` + \`people.associated_transcripts\`

  Need a different shape (hiring pipeline, fundraising, projects, …)? Register
  a custom object: \`acrm object create candidates\`, then add fields with
  \`acrm attribute add\`. Don't coerce non-sales data into \`deals\` — the
  \`deals.stage\` enum is locked to sales values (lead/in_progress/won/lost).

Typical flow:
  acrm init <name>.acrm           create a workspace
  acrm connect linkedin           connect LinkedIn through Agent CRM's hosted sync engine
  acrm import csv ./leads.csv     load people + companies (and deals if columns present)
  acrm import gmail               connect Gmail through Agent CRM's hosted sync engine
  acrm connect granola            connect Granola through Agent CRM's hosted sync engine
  acrm import granola             import synced Granola transcripts
  acrm import linkedin            import existing LinkedIn contacts from the connected account
  acrm import linkedin <url>      add one person from a LinkedIn profile (creates person + company)
  acrm import x <handle>          add one person from an X/Twitter profile
  acrm import post <url>          add a LinkedIn or X **post** by URL — upserts the author as a person and stores the post (use when a user shares a post link they want to track)
  acrm import transcript          import a meeting transcript — use \`--from <provider>\` for the fast path, or pipe JSON via stdin / \`--file\`
  acrm execute "SELECT ..."       run SQL against the workspace
  acrm records create deals --field name=... --field stage=...  create a single record
  acrm records update candidates <id> --field stage=screen      advance / edit fields on an existing record
  acrm records dedupe people --keep <id> --discard <id>   collapse two duplicate records into one

Custom schema:
  acrm object create candidates                                  register a new object
  acrm attribute add candidates.stage --type status \\
      --option sourced --option screen --option onsite --option offer
  acrm attribute edit-options deals.stage add custom_value       extend a built-in enum

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

JSON value shapes per attribute_type (key for lix_json_get_text):
  text / url / number   {"value": ...}
  date                  {"date": ...}        timestamp     {"timestamp": ...}
  personal-name         {"full_name": ..., "first_name": ..., "last_name": ...}
  email-address         {"email_address": ..., "email_domain": ..., ...}
  domain                {"domain": ..., "root_domain": ...}
  currency              {"currency_value": ..., "currency_code": ...}
  json                  any JSON object/array/scalar
  status / select       {"id": ..., "title": ...}
  record-reference      {"target_object": ..., "target_record_id": ...}
  (for record-references, prefer the indexed \`ref_record_id\` column)
`,
  );

registerInit(program);
registerConnect(program);
registerImport(program);
attachLinkedinSubcommand(getOrCreateImportCommand(program));
attachXSubcommand(getOrCreateImportCommand(program));
attachPostSubcommand(getOrCreateImportCommand(program));
attachGmailSubcommand(getOrCreateImportCommand(program));
attachGranolaSubcommand(getOrCreateImportCommand(program));
attachTranscriptSubcommand(getOrCreateImportCommand(program));
registerExecute(program);
registerRecords(program);
registerSchema(program);
registerSignals(program);
registerSkills(program);

return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  // Interactive TTYs get a Codex-style update prompt; non-TTY callers (agents,
  // pipes, CI) get a plain stderr warning. Either way, kick off a detached
  // worker to refresh the version cache for next time. All update-check
  // failures are swallowed — see src/lib/update-check.ts.
  await promptIfOutdated(pkg.version);
  scheduleBackgroundRefreshIfStale(pkg.version);
  await createAcrmProgram().parseAsync(argv);
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err), ERR.UNHANDLED);
    process.exit(1);
  });
}
