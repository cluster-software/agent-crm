import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importGoogleContacts,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { isJson, fail, ok, setJsonMode } from "../output/json.js";
import {
  checkGwsInstalled,
  checkGwsAuthed,
  streamGoogleContacts,
} from "../lib/gws-contacts.js";
import {
  ensureBundledClientSecret,
  runGwsAuthLogin,
} from "../lib/gws-bootstrap.js";

type Opts = {
  otherContacts?: boolean; // commander negation: --no-other-contacts → false
  defaultCountry?: string;
};

export function attachGmailSubcommand(parent: Command): void {
  parent
    .command("gmail")
    .description(
      "Sync Google contacts into the workspace via the `gws` CLI (https://github.com/googleworkspace/cli). Pulls People API connections by default, plus auto-created `otherContacts` (everyone you've ever emailed) unless --no-other-contacts is passed. Creates one person per primary email and one company per email domain (matching `import csv` dedup). Requires `gws` on PATH; handles OAuth bootstrap (writing the bundled client_secret.json and driving `gws auth login` if needed) on first run.",
    )
    .option(
      "--no-other-contacts",
      "skip the auto-created 'other contacts' bucket (My Contacts only)",
    )
    .option(
      "--default-country <iso>",
      "ISO country code (e.g. US, GB, DE) used to parse locally-formatted phone numbers into E.164",
      "US",
    )
    .action(async (opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      let ws: Workspace | null = null;
      try {
        const workspaceFile = resolveWorkspacePath(root?.workspace);

        // Step 1: gws binary must be on PATH.
        const installed = await checkGwsInstalled();
        if (!installed.ok) {
          throw new AcrmError(
            "the `gws` CLI is required to import from Gmail",
            ERR.INVALID_INPUT,
            "install it with:\n  npm install -g @googleworkspace/cli",
          );
        }

        // Step 2: bundled OAuth client_secret.json — write it if missing so
        // the user never has to create their own OAuth client.
        const seeded = ensureBundledClientSecret();
        if (seeded.wrote && !isJson()) {
          process.stderr.write(
            `wrote bundled OAuth client to ${seeded.path}\n`,
          );
        }

        // Step 3: if not authed, drive `gws auth login -s people` ourselves
        // so the user sees one browser pop-up rather than a CLI error.
        const authed = await checkGwsAuthed();
        if (!authed.ok) {
          if (!isJson()) {
            process.stderr.write(
              `not authenticated with Google — opening browser for OAuth consent...\n`,
            );
          }
          await runGwsAuthLogin();
        }

        ws = await Workspace.open(workspaceFile);

        const includeOtherContacts = opts.otherContacts !== false;
        const startedAt = Date.now();
        const stderrTty = process.stderr.isTTY === true;
        let lastTick = 0;

        const stream = streamGoogleContacts({ includeOtherContacts });
        const result = await importGoogleContacts(ws, {
          contacts: stream,
          default_country: opts.defaultCountry,
          onProgress: ({ seen, stats }) => {
            if (isJson()) return;
            const now = Date.now();
            if (now - lastTick < 250 && seen % 50 !== 0) return;
            lastTick = now;
            const line = `synced ${seen} contacts  (people: ${stats.people_created}, companies: ${stats.companies_created})`;
            if (stderrTty) {
              process.stderr.write(`\r${line}`);
            } else {
              process.stderr.write(`${line}\n`);
            }
          },
        });

        if (stderrTty && !isJson()) process.stderr.write("\n");

        await ws.close();
        ws = null;

        ok({
          ...result.stats,
          duration_ms: Date.now() - startedAt,
          included_other_contacts: includeOtherContacts,
        });
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
    });
}
