import { readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importCsv,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

// Exposed so other import subcommands (e.g. `import linkedin`, `import x`)
// can attach themselves to the same `import` parent without redefining it.
export function getOrCreateImportCommand(program: Command): Command {
  const existing = program.commands.find((c) => c.name() === "import");
  if (existing) return existing;
  return program
    .command("import")
    .description(
      "import data into the .acrm file (creates people + companies; deals only when the CSV has deal columns)",
    );
}

export function registerImport(program: Command): void {
  const importCmd = getOrCreateImportCommand(program);

  importCmd
    .command("csv <path>")
    .description(
      "import a CSV. Creates one person per email, LinkedIn URL, Twitter/X URL, or phone number, and one company per domain. Creates a deal only when the CSV has a 'deal_name' or 'deal' column — leads alone do not become deals.",
    )
    .option(
      "--default-country <iso>",
      "ISO country code (e.g. US, GB, DE) used to parse locally-formatted phone numbers into E.164. Numbers that already include '+<dial-code>' are unaffected.",
      "US",
    )
    .addHelpText(
      "after",
      `
Recognized columns (header is trim+lowercase only — use snake_case, not "Company Name"):

  Person     email | email_address | email_addresses
             work_email[_N] | personal_email[_N] | primary_email[_N]
             other_emails  (comma/semicolon-separated)
             name | full_name | person_name | who | contact | contact_name
                 (or first_name + last_name)
             job_title | title | role
             linkedin_url | linkedin | linkedin_profile | li_url
                 (or any column whose values are linkedin.com URLs)
             twitter_url | twitter | x_url | x
                 (or any column whose values are x.com / twitter.com URLs)
             phone | mobile | cell | telephone | tel | phone_number
             work_phone[_N] | personal_phone[_N] | home_phone | mobile_number
                 (comma/semicolon-separated; parsed to E.164 using
                 --default-country if no '+' prefix is present)

  Company    company | company_name | organization
             domain | website | company_domain

  Deal       deal_name | deal                 (presence triggers deal creation)
             deal_stage | stage
             deal_value | value
             close_date | deal_close_date
             next_step | deal_next_step

Identity:
  - companies are deduplicated by normalized domain (or domain-from-email).
    When a row has a company name but no domain/email, the company is
    deduplicated by case-insensitive name instead.
  - people are deduplicated in priority order: lowercased email, then canonical
    LinkedIn URL, then canonical Twitter/X URL, then E.164 phone number.
    URLs are normalized by stripping protocol/www/query/fragment/trailing-slash;
    twitter.com is unified to x.com; bare handles ("@foo") are accepted for
    twitter and become "x.com/foo". Phone numbers are parsed via libphonenumber
    using --default-country (defaults to US) — "(415) 555-1234" and
    "+14155551234" dedupe to the same person. Numbers that already start with
    "+" are parsed independent of the default country. Pass
    --default-country=GB (etc.) when importing contacts from another locale.
  - rows with none of email/linkedin/twitter/phone skip person creation
  - rows without a domain, email, or company name skip company creation
`,
    )
    .action(
      async (csvPath: string, options: { defaultCountry?: string }) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        let ws: Workspace | null = null;
        try {
          const abs = path.resolve(csvPath);
          const csvText = readFileSync(abs, "utf8");
          const source = `csv:${path.basename(abs)}`;

          const stderrTty = process.stderr.isTTY === true;
          const progressThrottleMs = stderrTty ? 300 : 1500;
          const writeProgress = (line: string, final: boolean) => {
            if (stderrTty) {
              process.stderr.write(`\r${line}`);
              if (final) process.stderr.write("\n");
            } else {
              process.stderr.write(`${line}\n`);
            }
          };

          ws = await Workspace.open(resolveWorkspacePath(root.workspace));

          let lastTick = 0;
          let pendingAtFlush = 0;
          const result = await importCsv(ws, {
            csvText,
            source,
            default_country: options.defaultCountry,
            onStart: ({ total, detected }) => {
              const personHints = [
                ...detected.email_headers,
                ...detected.linkedin_headers,
                ...detected.twitter_headers,
                ...detected.phone_headers,
                ...(detected.linkedin_by_value ? ["<linkedin-by-value>"] : []),
                ...(detected.twitter_by_value ? ["<twitter-by-value>"] : []),
              ];
              const companyHints = [
                ...detected.domain_headers,
                ...detected.company_name_headers,
              ];
              process.stderr.write(
                `parsed ${total} rows from ${path.basename(abs)}\n`,
              );
              process.stderr.write(
                `  person identifiers: ${personHints.length ? personHints.join(", ") : "(none — people will be skipped)"}\n`,
              );
              process.stderr.write(
                `  company identifiers: ${companyHints.length ? companyHints.join(", ") : "(none — companies will be skipped)"}\n`,
              );
            },
            onProgress: ({ current, total, stats }) => {
              const now = Date.now();
              const isLast = current === total;
              if (lastTick === 0 || now - lastTick > progressThrottleMs || isLast) {
                writeProgress(
                  `importing… ${current} / ${total} rows  (people: ${stats.people_created}, companies: ${stats.companies_created}, deals: ${stats.deals_created})`,
                  isLast,
                );
                lastTick = now;
              }
            },
            onBeforeFinalFlush: ({ pending_count }) => {
              pendingAtFlush = pending_count;
              if (pending_count > 100) {
                process.stderr.write(
                  `finalizing ${pending_count.toLocaleString()} records (this can take a few seconds)…\n`,
                );
              }
            },
            onAfterFinalFlush: ({ duration_ms }) => {
              if (pendingAtFlush > 100) {
                process.stderr.write(
                  `  done in ${(duration_ms / 1000).toFixed(1)}s\n`,
                );
              }
            },
          });

          if (result.warnings.length && !isJson()) {
            for (const w of result.warnings) {
              process.stderr.write(`warning: ${w}\n`);
            }
          }

          await ws.close();
          ws = null;

          ok({ ...result.stats });
        } catch (e) {
          if (ws) {
            try {
              await ws.close();
            } catch {
              // ignore
            }
          }
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.IMPORT);
          process.exit(1);
        }
      },
    );
}
