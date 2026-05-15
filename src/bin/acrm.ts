#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { registerInit } from "../commands/init.js";
import { registerExecute } from "../commands/execute.js";
import { registerRecords } from "../commands/records.js";
import { registerImport, getOrCreateImportCommand } from "../commands/import.js";
import { attachLinkedinSubcommand } from "../commands/import-linkedin.js";
import { attachXSubcommand } from "../commands/import-x.js";
import { attachPostSubcommand } from "../commands/import-post.js";
import { attachTranscriptSubcommand } from "../commands/import-transcript.js";
import { registerUi } from "../commands/ui.js";
import { registerSkills } from "../commands/skills.js";
import { registerAuth } from "../commands/auth.js";
import { PROVIDERS } from "../integrations/providers.js";
import { fail } from "../output/json.js";
import { ERR } from "../lib/errors.js";
import {
  notifyIfOutdated,
  scheduleBackgroundRefreshIfStale,
} from "../lib/update-check.js";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

// Print a stderr warning if a newer published version is cached, then kick
// off a detached worker to refresh the cache for next time. Both calls are
// non-blocking and swallow all errors — see src/lib/update-check.ts.
notifyIfOutdated(pkg.version);
scheduleBackgroundRefreshIfStale(pkg.version);

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

Typical flow:
  acrm init <name>.acrm           create a workspace
  acrm import csv ./leads.csv     load people + companies (and deals if columns present)
  acrm import linkedin <url>      add one person from a LinkedIn profile (creates person + company)
  acrm import x <handle>          add one person from an X/Twitter profile
  acrm import post <url>          add a LinkedIn or X **post** by URL — upserts the author as a person and stores the post (use when a user shares a post link they want to track)
  acrm import transcript          import a meeting transcript — use \`--from <provider>\` for the fast path, or pipe JSON via stdin / \`--file\`
  acrm ui                         browse the workspace in a local UI
  acrm execute "SELECT ..."       run SQL against the workspace
  acrm records dedupe people --keep <id> --discard <id>   collapse two duplicate records into one

Provider auth (one-time, for \`acrm import transcript --from <provider>\`):
${PROVIDERS.filter((p) => p.oauth)
  .map(
    (p) =>
      `  acrm auth ${p.name.padEnd(22)}cache ${p.label} OAuth token at ~/.config/acrm/${p.name}.json`,
  )
  .join("\n")}

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
attachLinkedinSubcommand(getOrCreateImportCommand(program));
attachXSubcommand(getOrCreateImportCommand(program));
attachPostSubcommand(getOrCreateImportCommand(program));
attachTranscriptSubcommand(getOrCreateImportCommand(program));
registerExecute(program);
registerRecords(program);
registerUi(program);
registerSkills(program);
registerAuth(program);

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err), ERR.UNHANDLED);
  process.exit(1);
});
