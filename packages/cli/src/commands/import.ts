import { readFileSync, openSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importCsv,
} from "@agent-crm/sdk";
import { findWorkspace, resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

// Test whether a TCP port is free on 127.0.0.1 by attempting to bind a
// throwaway server. Returns true if bind succeeded (and we then released it).
async function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

// Find the first free port starting at `start`, searching up to `range` ports.
// Returns null if every candidate is busy.
async function findOpenPort(start: number, range: number): Promise<number | null> {
  for (let p = start; p < start + range; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

// Poll http://127.0.0.1:port/ until it responds or we hit the deadline.
// Returns true if the server became reachable within `timeoutMs`.
async function waitForUiReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 500 },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

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
      "import a CSV. Creates one person per email, LinkedIn URL, or Twitter/X URL, and one company per domain. Creates a deal only when the CSV has a 'deal_name' or 'deal' column — leads alone do not become deals.",
    )
    .option("-p, --port <port>", "port for the UI server", "3737")
    .option("--no-ui", "do not launch the UI after import")
    .option("--no-open", "do not auto-open the browser when launching the UI")
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
    LinkedIn URL, then canonical Twitter/X URL. URLs are normalized by stripping
    protocol/www/query/fragment/trailing-slash; twitter.com is unified to x.com;
    bare handles ("@foo") are accepted for twitter and become "x.com/foo"
  - rows with none of email/linkedin/twitter skip person creation
  - rows without a domain, email, or company name skip company creation
`,
    )
    .action(
      async (
        csvPath: string,
        opts: { port: string; ui: boolean; open: boolean },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        const port = Number(opts.port);
        if (opts.ui && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
          fail(`invalid port: ${opts.port}`, ERR.IMPORT);
          process.exit(1);
        }
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
            onStart: ({ total, detected }) => {
              const personHints = [
                ...detected.email_headers,
                ...detected.linkedin_headers,
                ...detected.twitter_headers,
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

          // Close the parent's workspace before spawning the UI child so the
          // SQLite file isn't held open by two processes.
          await ws.close();
          ws = null;

          let ui: { pid: number; url: string; stop: string } | null = null;
          let uiError: string | null = null;
          if (opts.ui) {
            const resolved = root.workspace
              ? root.workspace.endsWith(".acrm")
                ? root.workspace
                : root.workspace + ".acrm"
              : (findWorkspace() ?? "workspace.acrm");
            const absWorkspace = path.resolve(resolved);

            // If the requested port is busy, walk up a small range so a
            // forgotten earlier UI doesn't silently swallow this one.
            let effectivePort = port;
            if (!(await isPortFree(port))) {
              const fallback = await findOpenPort(port + 1, 20);
              if (fallback === null) {
                uiError = `port ${port} and ${port + 1}..${port + 20} are all busy — UI not started. Stop the existing server (e.g. lsof -nP -iTCP:${port} -sTCP:LISTEN) or rerun with -p <port>.`;
              } else {
                process.stderr.write(
                  `UI: port ${port} busy, starting on ${fallback} instead\n`,
                );
                effectivePort = fallback;
              }
            }

            if (uiError === null) {
              const url = `http://localhost:${effectivePort}`;
              const errLogPath = path.join(
                tmpdir(),
                `acrm-ui-${process.pid}-${effectivePort}.err.log`,
              );
              const errFd = openSync(errLogPath, "w");
              const args = [
                ...process.execArgv,
                process.argv[1]!,
                "-w",
                absWorkspace,
                "ui",
                "-p",
                String(effectivePort),
              ];
              if (!opts.open) args.push("--no-open");
              const child = spawn(process.execPath, args, {
                detached: true,
                stdio: ["ignore", "ignore", errFd],
              });
              child.unref();
              process.stderr.write(`UI: starting at ${url} …\n`);
              const ready = await waitForUiReady(effectivePort, 5000);
              if (ready) {
                ui = {
                  pid: child.pid ?? -1,
                  url,
                  stop: `kill ${child.pid ?? "<pid-unknown>"}`,
                };
                try {
                  unlinkSync(errLogPath);
                } catch {
                  /* ignore */
                }
              } else {
                let detail = "";
                try {
                  const log = readFileSync(errLogPath, "utf8").trim();
                  if (log) detail = `\n  child stderr: ${log.split("\n").slice(-5).join(" / ")}`;
                } catch {
                  /* ignore */
                }
                uiError = `UI didn't respond on ${url} within 5s — child likely crashed.${detail}\n  full log: ${errLogPath}`;
              }
            }

            if (uiError) {
              process.stderr.write(`warning: ${uiError}\n`);
            }
          }

          const payload: Record<string, unknown> = { ...result.stats };
          if (ui) payload.ui = ui;
          if (uiError) payload.ui_error = uiError;
          ok(payload);
          if (!isJson()) {
            const bold = process.env.NO_COLOR ? "" : "\x1b[1m";
            const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
            if (ui) {
              process.stdout.write(
                `\nUI server started in background (pid ${ui.pid}) — ${bold}${ui.url}${reset}\n`,
              );
              process.stdout.write(`  to stop: ${bold}${ui.stop}${reset}\n`);
            } else {
              process.stdout.write(
                `\nNext: ${bold}acrm ui${reset} to validate the import in your browser\n`,
              );
            }
          }
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
