#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerInit } from "../commands/init.js";
import { registerRecords } from "../commands/records.js";
import { registerSchema } from "../commands/schema.js";
import { registerDeals } from "../commands/deals.js";
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
    "Headless, cloud-first CRM for Claude Code. Stores people (keyed by email, LinkedIn URL, or Twitter/X URL), companies (keyed by domain), deals, posts (LinkedIn/X posts linked to their author), and transcripts (meeting/call transcripts linked to attendees by email) in Neon, Supabase, or Postgres.",
  )
  .version(pkg.version)
  .option("-w, --workspace <url>", "Postgres-compatible database URL (default: ACRM_DATABASE_URL, NEON_DATABASE_URL, SUPABASE_DATABASE_URL, or DATABASE_URL)")
  .option("--json", "force JSON output (default when stdout is not a TTY)")
  .addHelpText(
    "after",
    `
Storage model: EAV. There is no \`people\` / \`companies\` / \`transcripts\` SQL
table — those are \`object_slug\` values on \`acrm_record\`, and each field lives
as a row in \`acrm_value\` keyed by (object_slug, record_id, attribute_slug).
Use first-class \`acrm records\`, \`acrm object\`, and \`acrm attribute\`
commands instead of direct SQL.

Data model:
  people      contacts, identified by email / LinkedIn URL / X URL
  companies   organizations, identified by domain
  deals       sales opportunities, created on demand
  posts       LinkedIn/X posts the user wants to track, linked to author via \`posts.author\` + \`people.associated_posts\`
  transcripts meeting/call transcripts (e.g. Granola), linked to attendees via \`transcripts.participants\` + \`people.associated_transcripts\`

  Need a different shape (hiring pipeline, fundraising, projects, …)? Register
  a custom object: \`acrm object create candidates\`, then add fields with
  \`acrm attribute add\`. Don't coerce non-sales data into \`deals\`; use
  \`acrm deals pipeline set\` only for sales-opportunity workflows.

Typical flow:
  acrm init                       initialize the EAV schema in Neon, Supabase, or Postgres
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
  acrm records list people --search greg --json                 find record_ids for natural-language references
  acrm deals pipeline set --stage lead:Lead --stage closed_won:"Closed Won" --stage closed_lost:"Closed Lost"
  acrm records list companies --search Acme --limit 5  find existing record IDs
  acrm records create deals --field name=... --field stage=...  create a single record
  acrm records update candidates <id> --field stage=screen      advance / edit fields on an existing record
  acrm records dedupe people --keep <id> --discard <id>   collapse two duplicate records into one

Custom schema:
  acrm object create candidates                                  register a new object
  acrm attribute add candidates.stage --type status \\
      --option sourced --option screen --option onsite --option offer
  acrm attribute edit-options deals.stage add custom_value       extend a built-in enum

Field syntax:
  acrm records create <object> --field slug=value
  acrm records update <object> <record_id> --field slug=value
  For record-reference attributes, pass slug=<target_object>:<target_record_id>.
  Repeat --field for multivalued attributes.
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
registerRecords(program);
registerSchema(program);
registerDeals(program);
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
